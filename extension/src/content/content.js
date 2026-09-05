/* eslint-env browser */
/**
 * Content-Script: erkennt Fahrzeugseiten + PDF-Links, lädt die PDFs mit der
 * Session der Seite herunter und zeigt das Ergebnis in einem Panel oben rechts.
 */
(() => {
  if (window.__vmsInjected) return;
  window.__vmsInjected = true;

  const MAX_DOCS = 8;
  const VIN_RE = /\b[A-Z0-9]{17}\b/;

  /**
   * Portal-Profile. BCA nennt den Zustandsbericht "Appraisal" bzw. "Fahrzeug PDF"
   * und listet Schäden zusätzlich direkt auf der Seite.
   */
  const PORTALS = [
    {
      id: 'bca',
      hosts: ['bca.com', 'bca.de', 'bca.co.uk', 'bca-europe.com', 'bcaeurope.com', 'bca-autoauktionen.de'],
      words: [
        'appraisal', 'fahrzeug pdf', 'vehicle pdf', 'zustandsbericht', 'schadenaufstellung',
        'schadensaufstellung', 'damage list', 'vehicle report', 'fahrzeugbericht', 'inspection'
      ],
      damageHeadings: ['schäden', 'schaden', 'damages', 'damage', 'mängel', 'appraisal', 'zustand']
    }
  ];

  const CONDITION_WORDS = [
    'zustandsbericht', 'zustandsberichte', 'appraisal', 'gutachten', 'prüfbericht',
    'pruefbericht', 'schadenbericht', 'schadensbericht', 'condition report',
    'inspection report', 'damage report', 'schadensgutachten', 'fahrzeug pdf',
    'fahrzeug-pdf', 'fahrzeugpdf', 'inspection', 'befund'
  ];
  const DATASHEET_WORDS = [
    'vehicle pdf', 'datenblatt', 'exposé', 'expose',
    'fahrzeugdaten', 'car pdf', 'fahrzeugschein'
  ];

  function portalFor(hostname) {
    const host = (hostname || '').toLowerCase();
    return (
      PORTALS.find((p) => p.hosts.some((h) => host === h || host.endsWith('.' + h))) || null
    );
  }

  const state = {
    settings: null,
    portal: null,
    pageDamages: [],
    docs: [],
    context: {},
    status: 'idle',
    result: null,
    error: null,
    steps: [],
    pageKey: '',
    filter: 'alle',
    dismissed: new Set(),
    openDefects: new Set(),
    expandAll: false,
    progressPct: null,
    search: '',
    sort: 'schwere',
    tab: 'maengel',
    showAllPageDamages: false,
    scrolled: false,
    closed: false,
    theme: 'auto',
    view: 'main',
    debugLogs: [],
    apiDiagnosis: null,
    pdfDiagnosis: null,
    isDiagnosingApi: false,
    isDiagnosingPdf: false
  };

  function logDebug(tag, message, data = null) {
    const time = new Date().toLocaleTimeString('de-DE');
    const entry = { time, tag, message, data };
    state.debugLogs.push(entry);
    if (state.debugLogs.length > 80) state.debugLogs.shift();
    if (state.view === 'debug' && ui) render();
  }

  let ui = null;
  let scanTimer = null;

  /* ------------------------------------------------------------ Utilities */

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();

  function fmtNumber(n) {
    return typeof n === 'number' ? n.toLocaleString('de-DE') : '';
  }

  function fmtCost(n) {
    if (typeof n !== 'number') return null;
    return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  }

  /** "18.900 EUR" / "1.830,50 €" -> 18900 / 1830.5 */
  function parseEuro(value) {
    if (typeof value === 'number') return value;
    if (!value) return null;
    const m = String(value).match(/(\d[\d.,\s']*)/);
    if (!m) return null;
    let raw = m[1].replace(/[\s']/g, '');
    if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
    else if (/\.\d{3}(\D|$)/.test(raw + ' ')) raw = raw.replace(/\./g, '');
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Rechnet aus den belegten Angaben - ohne Schätzungen der KI.
   * Alles hier ist nachvollziehbar aus dem Dokument bzw. der Seite abgeleitet.
   */
  function computeNumbers(r, ctx) {
    const defects = r.defects || [];
    const withAmount = defects.filter((d) => typeof d.estimated_cost_eur === 'number');
    const documented = withAmount.reduce((a, d) => a + d.estimated_cost_eur, 0);
    const urgent = defects
      .filter((d) => d.affects_roadworthiness && typeof d.estimated_cost_eur === 'number')
      .reduce((a, d) => a + d.estimated_cost_eur, 0);
    const urgentOpen = defects.filter(
      (d) => d.affects_roadworthiness && typeof d.estimated_cost_eur !== 'number'
    ).length;

    const v = r.verdict || {};
    const negotiation = (v.negotiation_points || []).reduce((a, p) => a + (p.amount_eur || 0), 0);
    const price = parseEuro(ctx.preis);
    const reportTotal =
      typeof r.total_estimated_repair_cost_eur === 'number' ? r.total_estimated_repair_cost_eur : null;
    const repair = documented || reportTotal || 0;

    return {
      documented: withAmount.length ? documented : null,
      documentedCount: withAmount.length,
      totalCount: defects.length,
      withoutAmount: defects.length - withAmount.length,
      urgent: urgent || null,
      urgentOpen,
      reportTotal,
      budgetMax: typeof v.repair_budget_max_eur === 'number' ? v.repair_budget_max_eur : null,
      negotiation: negotiation || null,
      price,
      effective: price !== null && repair ? price + repair : null,
      target: price !== null && negotiation ? price - negotiation : null
    };
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'Keine Antwort vom Hintergrunddienst.' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  /* ------------------------------------------------------------ Erkennung */

  function candidateElements() {
    const nodes = [...document.querySelectorAll('a[href], [data-href], [data-url], [role="button"], button')];
    return nodes.slice(0, 4000);
  }

  function resolveUrl(el) {
    let raw =
      el.getAttribute('href') ||
      el.dataset?.href ||
      el.dataset?.url ||
      el.getAttribute('data-download-url') ||
      '';

    // Falls href javascript:window.open(...) oder onclick="..." enthält:
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) {
      const onclick = el.getAttribute('onclick') || '';
      const winOpenMatch = (raw + ' ' + onclick).match(/window\.open\s*\(\s*['"]([^'"]+)['"]/i);
      if (winOpenMatch) {
        raw = winOpenMatch[1];
      } else {
        return null;
      }
    }

    try {
      const url = new URL(raw, location.href);
      if (!/^https?:$/.test(url.protocol)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  const CATALOG_WORDS = [
    'detailkatalog', 'kurzübersicht', 'detailedsalecatalogue', 'salecatalogue',
    'auktionskatalog', 'fahrzeugkatalog'
  ];

  function classify(el, url) {
    const haystack = lower(
      [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.className, url].join(' ')
    ).slice(0, 400);

    // Ausschließen von allgemeinen Auktions-Katalogen (Detailkatalog, Kurzübersicht etc.)
    if (CATALOG_WORDS.some((w) => haystack.includes(w) || url.toLowerCase().includes(w))) {
      return null;
    }

    // Wenn die URL direkt VehId enthält (z.B. ViewPDF.aspx?VehId=...), ist das exakt das Fahrzeug-PDF!
    if (/VehId=/i.test(url)) {
      return { kind: 'condition', score: 200, word: 'Fahrzeug PDF' };
    }

    // BCA Image / Document Endpoints (bcaimage.com/GetDoc.aspx etc.)
    if (/GetDoc\.aspx/i.test(url) || /InspectionBase/i.test(url)) {
      return { kind: 'condition', score: 180, word: 'Zustandsbericht' };
    }

    // Wenn die URL direkt ViewPDF.aspx heißt, ist das die primäre BCA-Viewer-Seite
    if (/ViewPDF\.aspx/i.test(url)) {
      return { kind: 'condition', score: 150, word: 'ViewPDF' };
    }

    // Wenn die URL explizit ein Thumbnail-Bild ist (z.B. width=96), abwerten
    const isThumbnail = /([?&])(?:width|height)=[1-9]\d{0,2}\b/i.test(url) || /\.(?:jpg|jpeg|png|webp|gif)(?:\?|$)/i.test(url);
    const scoreMod = isThumbnail ? -40 : 0;

    for (const w of CONDITION_WORDS) if (haystack.includes(w)) return { kind: 'condition', score: 100 + scoreMod, word: w };
    for (const w of DATASHEET_WORDS) if (haystack.includes(w)) return { kind: 'datasheet', score: 80 + scoreMod, word: w };

    for (const w of state.portal?.words || []) {
      if (haystack.includes(w)) return { kind: 'condition', score: 90 + scoreMod, word: w };
    }

    const extra = (state.settings?.keywords || []).filter(
      (k) => k && ![...CONDITION_WORDS, ...DATASHEET_WORDS].includes(k)
    );
    for (const w of extra) if (w && haystack.includes(lower(w))) return { kind: 'custom', score: 70 + scoreMod, word: w };

    const path = url.split('?')[0].toLowerCase();
    if (path.endsWith('.pdf')) return { kind: 'pdf', score: 60 + scoreMod, word: '.pdf' };
    if (/[?&/](pdf|document|report|doc|view|download)[=/]/.test(url.toLowerCase())) {
      return { kind: 'pdf', score: 50 + scoreMod, word: 'Dokument' };
    }
    if (/pdf/i.test(haystack) || /bericht/i.test(haystack) || /spezifikation/i.test(haystack) || /protokoll/i.test(haystack)) {
      return { kind: 'condition', score: 50 + scoreMod, word: 'Bericht' };
    }
    return null;
  }

  function findDocuments() {
    const found = new Map();

    for (const el of candidateElements()) {
      const url = resolveUrl(el);
      if (!url) continue;
      const hit = classify(el, url);
      if (!hit) continue;
      const label = norm(el.innerText) || norm(el.getAttribute('aria-label')) || hit.word;
      const existing = found.get(url);
      if (!existing || existing.score < hit.score) {
        found.set(url, { url, label: label.slice(0, 60), kind: hit.kind, score: hit.score, el });
      }
    }
    const docs = [...found.values()]
      .filter((d) => !state.dismissed.has(d.url))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_DOCS);
    markLinks(docs);
    // Das DOM-Element bleibt lokal - es wird nicht an den Hintergrunddienst geschickt.
    return docs.map(({ el, ...rest }) => rest);
  }

  const DAMAGE_HEADINGS = [
    'schäden', 'schaden', 'schadensliste', 'schadenaufstellung', 'mängel', 'maengel',
    'beschädigungen', 'damages', 'damage', 'damage list', 'condition', 'zustand',
    'appraisal', 'befund', 'beanstandungen'
  ];

  const DAMAGE_NOISE =
    /^(mehr|weniger|alle|details|schlie|close|zeig|show|drucken|print|zurück|weiter|filter|sortier|cookie|anmeld|login|newsletter)/i;

  /**
   * Liest Schäden, die das Portal bereits auf der Seite anzeigt.
   * Damit steht der Schaden sofort im Panel - noch bevor das PDF ausgewertet ist.
   */
  function scrapeOnPageDamages() {
    const headings = [
      ...document.querySelectorAll('h1,h2,h3,h4,h5,h6,summary,legend,caption,th,[role="heading"]')
    ].slice(0, 600);
    const words = [...DAMAGE_HEADINGS, ...(state.portal?.damageHeadings || [])];
    const out = [];
    const seen = new Set();

    const add = (text) => {
      const clean = norm(text);
      if (clean.length < 4 || clean.length > 180) return;
      if (DAMAGE_NOISE.test(clean)) return;
      const key = lower(clean);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(clean);
    };

    for (const h of headings) {
      const label = lower(h.innerText || h.textContent).slice(0, 60);
      if (!label || !words.some((w) => label.includes(w))) continue;

      // Tabellenkopf -> zugehörige Spalte, sonst der folgende Block
      const table = h.closest('table');
      if (h.tagName === 'TH' && table) {
        const index = [...h.parentElement.children].indexOf(h);
        for (const row of [...table.querySelectorAll('tbody tr')].slice(0, 40)) {
          const cells = [...row.children];
          const value = cells[index]?.innerText;
          if (!value) continue;
          const first = cells[0] === cells[index] ? '' : norm(cells[0]?.innerText || '');
          add(first && first !== norm(value) ? `${first}: ${norm(value)}` : value);
        }
        continue;
      }

      const container =
        h.closest('details') ||
        h.nextElementSibling ||
        h.parentElement?.querySelector('table, ul, ol, dl') ||
        h.parentElement;
      if (!container) continue;

      const rows = container.querySelectorAll?.('tbody tr, li, dd, .row, [class*="damage" i], [class*="schaden" i]');
      if (rows?.length) {
        for (const row of [...rows].slice(0, 40)) add(rowText(row));
      } else if (container !== h) {
        norm(container.innerText || '')
          .split(/\s{2,}|\n/)
          .slice(0, 25)
          .forEach(add);
      }
      if (out.length >= 40) break;
    }
    return out.slice(0, 25);
  }

  /** Tabellenzeile lesbar zusammensetzen: "Bauteil: Beschreibung". */
  function rowText(row) {
    const cells = [...(row.children || [])]
      .map((c) => norm(c.innerText))
      .filter((t) => t && t.length < 120);
    if (cells.length >= 2) return `${cells[0]}: ${cells.slice(1).join(' · ')}`;
    return row.innerText;
  }

  const MARK_ATTR = 'data-autosmaya';
  let markStyleAdded = false;

  /**
   * Markiert die erkannten Dokument-Links auf der Seite, damit sichtbar ist,
   * was Autosmaya gelesen hat. Layout-neutral über outline, kein Reflow.
   */
  function markLinks(found) {
    if (!state.settings?.markLinks) return;
    if (!markStyleAdded) {
      const style = document.createElement('style');
      style.id = 'autosmaya-marks';
      style.textContent = [
        `[${MARK_ATTR}] {`,
        '  outline: 2px solid rgba(37, 99, 235, .55) !important;',
        '  outline-offset: 2px !important;',
        '  border-radius: 3px;',
        '}',
        `[${MARK_ATTR}="condition"] { outline-color: rgba(220, 38, 38, .6) !important; }`
      ].join('\n');
      (document.head || document.documentElement).appendChild(style);
      markStyleAdded = true;
    }
    document.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => el.removeAttribute(MARK_ATTR));
    for (const { el, kind, label } of found) {
      if (!el?.setAttribute) continue;
      el.setAttribute(MARK_ATTR, kind);
      if (!el.title) el.title = `Autosmaya liest dieses Dokument aus (${label})`;
    }
  }

  /** Liest Label/Wert-Paare (Tabellen, Definitionslisten, Grid-Layouts) aus. */
  function scrapeContext() {
    const wanted = {
      vin: ['fahrgestellnummer', 'fin', 'vin', 'chassis'],
      erstzulassung: ['erstzulassung', 'first registration', 'ez'],
      kilometer: ['km-stand', 'kilometerstand', 'laufleistung', 'mileage', 'km'],
      inventarnummer: ['inventarnummer', 'inventory', 'lagernummer'],
      kraftstoff: ['kraftstoff', 'fuel'],
      getriebe: ['getriebe', 'transmission'],
      preis: ['preis', 'kaufpreis', 'verkaufspreis', 'startpreis', 'sofortkauf', 'price', 'buy now'],
      leistung: ['leistung', 'ps', 'kw', 'power']
    };
    const ctx = {};

    const pairs = [];
    document.querySelectorAll('tr').forEach((tr) => {
      const cells = tr.querySelectorAll('th,td');
      if (cells.length >= 2) pairs.push([norm(cells[0].innerText), norm(cells[1].innerText)]);
    });
    document.querySelectorAll('dl').forEach((dl) => {
      const dts = [...dl.querySelectorAll('dt')];
      const dds = [...dl.querySelectorAll('dd')];
      dts.forEach((dt, i) => dds[i] && pairs.push([norm(dt.innerText), norm(dds[i].innerText)]));
    });

    for (const [rawKey, rawVal] of pairs) {
      const key = lower(rawKey).replace(/[:()]/g, '').trim();
      if (!rawVal || rawVal.length > 80) continue;
      for (const [field, aliases] of Object.entries(wanted)) {
        if (ctx[field]) continue;
        if (aliases.some((a) => key === a || key.startsWith(a))) ctx[field] = rawVal;
      }
    }

    const h1 = document.querySelector('h1, [class*="title" i] h2, h2');
    if (h1) ctx.titel = norm(h1.innerText).slice(0, 120);

    if (!ctx.vin) {
      const bodyText = norm(document.body?.innerText || '').slice(0, 20000);
      const labelled = bodyText.match(
        /(?:Fahrgestellnummer|FIN|VIN|Chassis)[^A-Z0-9]{0,10}([A-Z0-9]{17})/i
      );
      if (labelled) ctx.vin = labelled[1];
      else {
        const loose = bodyText.match(VIN_RE);
        if (loose && /\d/.test(loose[0]) && /[A-Z]/.test(loose[0])) ctx.vin = loose[0];
      }
    }
    if (!ctx.kilometer) {
      const km = norm(document.body?.innerText || '').match(/([\d][\d.\s']{2,9})\s?km\b/i);
      if (km) ctx.kilometer = km[1].trim() + ' km';
    }
    if (!ctx.preis) {
      // Preis nur uebernehmen, wenn er als solcher ausgezeichnet ist - sonst lieber keiner.
      const text = norm(document.body?.innerText || '').slice(0, 20000);
      const m = text.match(
        /(?:Preis|Kaufpreis|Sofortkauf|Startpreis|Price)[^0-9]{0,15}((?:\d{1,3}[.\s])?\d{1,3}(?:[.,]\d{2})?)\s*(?:€|EUR)/i
      ) || text.match(/(?:€|EUR)\s?((?:\d{1,3}[.\s])?\d{3}(?:[.,]\d{2})?)\b/);
      if (m) ctx.preis = `${m[1].trim()} EUR`;
    }
    return ctx;
  }

  function isVehiclePage(docs, ctx) {
    if (!docs.length) return false;
    if (state.portal) return true; // bekanntes Auktionsportal
    if (docs.some((d) => d.kind === 'condition')) return true;
    const signals = [ctx.vin, ctx.erstzulassung, ctx.kilometer, ctx.inventarnummer].filter(Boolean);
    return signals.length >= 2 || (Boolean(ctx.vin) && docs.length > 0);
  }

  /* ------------------------------------------------------------- Download */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const WAITING_RE = /in Vorbereitung|Bitte warten|wird vorbereitet|wird generiert|being prepared|please wait|is generating/i;

  /**
   * Ziel eines echten <meta http-equiv="refresh">. Bewusst NUR das Meta-Tag:
   * ein freies "url=" irgendwo im HTML ist meist ein Query-Parameter in einem
   * Skript und hat den Poll früher auf eine falsche Adresse geschickt.
   */
  function extractRefreshUrl(html, baseUrl) {
    if (!html) return null;
    const rawMatch = html.match(
      /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"'>]+)["']/i
    ) || html.match(/<meta[^>]+content=["'][^"']*?url=([^"'>]+)["'][^>]*http-equiv=["']?refresh["']?/i);
    if (rawMatch && rawMatch[1]) {
      let u = rawMatch[1].trim().replace(/^['"]|['"]$/g, '');
      u = u.replaceAll('&amp;', '&').replaceAll('&#38;', '&');
      try {
        return new URL(u, baseUrl).href;
      } catch { /* ignore */ }
    }
    return null;
  }

  const MAX_WAIT_ROUNDS = 20;
  const WAIT_INTERVAL_MS = 3000;

  /**
   * Download im Seitenkontext. Nur sinnvoll, solange das Dokument auf demselben
   * Origin liegt wie die Fahrzeugseite: ein fetch() aus dem Content-Script ist
   * CORS-pflichtig und bekommt fremde Origins weder mit Cookies noch überhaupt
   * beantwortet. Für alles andere übernimmt der Hintergrunddienst, der als
   * First-Party-Anfrage läuft und die Session-Cookies mitschickt.
   */
  function sameOriginAsPage(urlStr) {
    try {
      return new URL(urlStr, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  const HTML_ENTITIES = { '&amp;': '&', '&#38;': '&', '&quot;': '"', '&#34;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  const unescapeHtml = (s) => String(s).replace(/&(?:amp|#38|quot|#34|#39|apos|lt|gt);/g, (e) => HTML_ENTITIES[e] ?? e);

  /**
   * Die Warteseite von BCA ("Ihre PDF ist in Vorbereitung. Bitte warten …")
   * besteht nur aus einem Skript und einem leeren
   * <form method="post" action="./ViewPDF.aspx?VehId=…">, das die Seite nach
   * kurzer Zeit selbst abschickt. Erst dieser POST liefert das PDF - ein
   * erneutes GET bringt endlos wieder dieselbe Warteseite. Hier wird das
   * Formular so nachgebaut, wie es der Browser abschicken würde.
   */
  function findFormPost(html, baseUrl) {
    if (!html) return null;
    for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
      const attrs = m[1] || '';
      if (!/method\s*=\s*["']?post/i.test(attrs)) continue;

      const action = unescapeHtml((attrs.match(/action\s*=\s*["']([^"']*)["']/i)?.[1] || '').trim());
      let resolved;
      try {
        resolved = new URL(action || baseUrl, baseUrl).href;
      } catch {
        continue;
      }
      if (!isProbablePdfUrl(resolved)) continue;

      // ASP.NET schickt __VIEWSTATE & Co. mit - ohne die weist der Server ab.
      const body = new URLSearchParams();
      for (const inp of (m[2] || '').matchAll(/<input\b([^>]*)>/gi)) {
        const a = inp[1] || '';
        const name = a.match(/name\s*=\s*["']([^"']*)["']/i)?.[1];
        if (!name) continue;
        const kind = (a.match(/type\s*=\s*["']([^"']*)["']/i)?.[1] || 'text').toLowerCase();
        if ((kind === 'checkbox' || kind === 'radio') && !/\bchecked\b/i.test(a)) continue;
        body.append(name, unescapeHtml(a.match(/value\s*=\s*["']([^"']*)["']/i)?.[1] || ''));
      }
      return { action: resolved, body: body.toString() };
    }
    return null;
  }

  async function fetchPdfInPage(url, opts = {}) {
    const { depth = 0, waitCount = 0, postBody = null } = opts;
    if (depth > 4 || waitCount > MAX_WAIT_ROUNDS) return null;

    // Bereinige eventuelle Thumbnail-Parameter wie width=96
    const cleanUrl = url.replace(/([?&])(?:width|height)=\d+&?/gi, '$1').replace(/[?&]$/, '');
    if (!sameOriginAsPage(cleanUrl)) {
      logDebug('SKIP_TAB', `${cleanUrl.split('?')[0]} liegt auf einem anderen Origin – direkt an den Hintergrunddienst.`);
      return null;
    }

    try {
      const res = await fetch(cleanUrl, {
        method: postBody === null ? 'GET' : 'POST',
        body: postBody,
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
        // Bewusst nur "Accept" und der Formular-Content-Type: Cache-Control und
        // Pragma sind keine CORS-sicheren Header und würden jede Anfrage
        // präflight-pflichtig machen.
        headers: {
          'Accept': 'application/pdf, application/octet-stream, text/html, */*',
          ...(postBody === null ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' })
        }
      });
      if (!res.ok) return null;

      const type = (res.headers.get('content-type') || '').toLowerCase();
      const buf = await res.arrayBuffer();
      const head = String.fromCharCode.apply(null, new Uint8Array(buf.slice(0, 512)));

      if (head.includes('%PDF-')) return { base64: toBase64(buf), bytes: buf.byteLength };

      if (type.includes('html') || type.includes('text') || buf.byteLength < 800000) {
        const html = new TextDecoder().decode(buf);
        const snippet = html.replace(/\s+/g, ' ').slice(0, 300);

        // Warteseite mit eigenem Formular: so weitermachen, wie es die Seite
        // selbst tut - das Formular abschicken. Das ist der einzige Weg, der
        // bei BCA zum PDF führt.
        const form = findFormPost(html, res.url || cleanUrl);
        if (form && waitCount < MAX_WAIT_ROUNDS) {
          logDebug('FORM_POST', `Warteseite: Formular abschicken (${waitCount + 1}/${MAX_WAIT_ROUNDS}) -> ${form.action.split('?')[0]}`);
          await sleep(WAIT_INTERVAL_MS);
          return fetchPdfInPage(form.action, { depth, waitCount: waitCount + 1, postBody: form.body });
        }

        // Ohne Formular: dieselbe Adresse erneut abfragen. Verschieben darf das
        // Ziel nur ein echtes Meta-Refresh - ein beliebiger Link aus der
        // Warteseite führt sonst ins Leere.
        if (WAITING_RE.test(html) && waitCount < MAX_WAIT_ROUNDS) {
          const nextUrl = extractRefreshUrl(html, cleanUrl) || cleanUrl;
          logDebug('WAIT', `PDF wird noch erzeugt (${waitCount + 1}/${MAX_WAIT_ROUNDS}). Warte 3s...`);
          await sleep(WAIT_INTERVAL_MS);
          return fetchPdfInPage(nextUrl, { depth, waitCount: waitCount + 1 });
        }

        const nested = findPdfInHtml(html, res.url || cleanUrl);
        if (nested && nested !== cleanUrl && nested !== url && nested !== res.url) {
          logDebug('NESTED', `Gefundener PDF-Viewer-Link im HTML: ${nested}`);
          return fetchPdfInPage(nested, { depth: depth + 1, waitCount });
        }

        logDebug('HTML_PEEK', `HTML von ${cleanUrl.split('?')[0]} (${buf.byteLength} B): ${snippet}`);
      }
      return null;
    } catch (err) {
      logDebug('DOWNLOAD_ERR', `Fehler beim Tab-Download: ${err?.message || err}`);
      return null; // z.B. CORS -> Hintergrund versucht es erneut
    }
  }

  const NON_PDF_EXT = /\.(?:js|css|ico|svg|png|jpg|jpeg|gif|webp|woff|woff2|ttf|eot)(?:\?|$)/i;
  const NON_PDF_PATH = /(?:javascript|functions\.js|jquery|analytics|google|doubleclick|\/css\/|\/fonts\/|\/images\/)/i;

  function isProbablePdfUrl(urlStr) {
    if (!urlStr) return false;
    if (NON_PDF_EXT.test(urlStr) || NON_PDF_PATH.test(urlStr)) return false;
    return (
      /\.pdf(?:\?|$)/i.test(urlStr) ||
      /(?:ShowPDF|GetPDF|ViewPDF|GetDoc|ShowDoc|PDFHandler|PdfViewer|DocumentViewer|FileDownload|download)/i.test(urlStr) ||
      /(?:VehId|LotId|DocId|DocType)=/i.test(urlStr)
    );
  }

  function findPdfInHtml(html, baseUrl) {
    if (!html) return null;

    // 1. Suche nach iframe, embed, object oder frame
    const frameMatches = [
      ...html.matchAll(/<embed[^>]+src=["']([^"']+)["']/gi),
      ...html.matchAll(/<object[^>]+data=["']([^"']+)["']/gi),
      ...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi),
      ...html.matchAll(/<frame[^>]+src=["']([^"']+)["']/gi)
    ];
    // Nur Rahmen übernehmen, die wirklich nach einem Dokument aussehen. Früher
    // wurde hier jeder beliebige Rahmen akzeptiert - auf Viewer-Seiten landete
    // der Download damit im Cookie-Banner statt im PDF.
    for (const m of frameMatches) {
      let src = m[1]?.trim();
      if (!src || src.startsWith('javascript:') || src.startsWith('about:') || NON_PDF_EXT.test(src) || NON_PDF_PATH.test(src)) continue;
      src = src.replaceAll('&amp;', '&').replaceAll('&#38;', '&');
      try {
        const resolved = new URL(src, baseUrl).href;
        if (resolved !== baseUrl && isProbablePdfUrl(resolved)) return resolved;
      } catch { /* ignore */ }
    }

    // 2. Suche nach Links zu Dokumenten, PDFs oder Download-Endpoints
    const linkMatches = [
      ...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi),
      ...html.matchAll(/["'](https?:\/\/[^"'\s<>]+?(?:\.pdf|GetDoc|GetPDF|ShowPDF|ViewPDF|Download|VehId=)[^"'\s<>]*)["']/gi),
      ...html.matchAll(/["'](\/[^"'\s<>]+?(?:\.pdf|GetDoc|GetPDF|ShowPDF|ViewPDF|VehId=)[^"'\s<>]*)["']/gi)
    ];
    for (const m of linkMatches) {
      let target = m[1]?.trim();
      if (!target || NON_PDF_EXT.test(target) || NON_PDF_PATH.test(target)) continue;
      target = target.replaceAll('&amp;', '&').replaceAll('&#38;', '&');
      if (isProbablePdfUrl(target)) {
        try {
          const resolved = new URL(target, baseUrl).href;
          if (resolved !== baseUrl) return resolved;
        } catch { /* ignore */ }
      }
    }

    // 3. Meta Refresh
    const metaRef = extractRefreshUrl(html, baseUrl);
    if (metaRef && metaRef !== baseUrl) return metaRef;

    // 4. JavaScript Weiterleitungen / Variablen
    const jsMatches = [
      ...html.matchAll(/(?:window\.location(?:\.href)?|location\.replace|location\.href)\s*=\s*["']([^"']+)["']/gi),
      ...html.matchAll(/(?:pdfUrl|documentUrl|fileUrl|docUrl|reportUrl)\s*[:=]\s*["']([^"']+)["']/gi),
      ...html.matchAll(/window\.open\s*\(\s*["']([^"']+)["']/gi)
    ];
    for (const m of jsMatches) {
      let target = m[1]?.trim();
      if (!target || target.startsWith('javascript:') || NON_PDF_EXT.test(target) || NON_PDF_PATH.test(target)) continue;
      target = target.replaceAll('&amp;', '&').replaceAll('&#38;', '&');
      if (isProbablePdfUrl(target)) {
        try {
          const resolved = new URL(target, baseUrl).href;
          if (resolved !== baseUrl) return resolved;
        } catch { /* ignore */ }
      }
    }

    return null;
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /* --------------------------------------------------------------- Ablauf */

  async function runAnalysis({ force = false } = {}) {
    if (state.status === 'busy') return;

    // Port mit aktivem Heartbeat hält den Service Worker zuverlässig am Leben (auch bei 2+ Min KI-Anfragen)
    let keepAlivePort = null;
    let keepAlivePing = null;
    try {
      keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });
      keepAlivePing = setInterval(() => {
        try { keepAlivePort?.postMessage({ ping: Date.now() }); } catch { /* ignore */ }
      }, 10000);
    } catch { /* ignore */ }

    state.status = 'busy';
    state.error = null;
    state.result = null;
    state.progressPct = null;
    state.openDefects.clear();
    state.steps = [
      {
        key: 'scan',
        label: state.docs.length === 1 ? '1 Dokument gefunden' : `${state.docs.length} Dokumente gefunden`,
        done: true
      }
    ];
    logDebug('ANALYZE', `Starte Analyse (${state.docs.length} Dokumente, Force=${force})`);
    render();

    try {
      const payloadDocs = [];
      for (const doc of state.docs) {
        pushStep('download', `Lade ${doc.label}`);
        logDebug('DOWNLOAD', `Versuche Download im Tab: ${doc.url}`);
        const fetched = await fetchPdfInPage(doc.url);
        if (fetched) {
          logDebug('DOWNLOAD', `Erfolgreich im Tab geladen (${Math.round(fetched.bytes / 1024)} KB)`);
        } else {
          logDebug('DOWNLOAD', `Tab-Download fehlgeschlagen (CORS/Redirect o.ä.) – Übergabe an Hintergrunddienst.`);
        }
        payloadDocs.push({ ...doc, base64: fetched?.base64 || null, bytes: fetched?.bytes || 0 });
        completeStep('download', fetched ? `${doc.label} geladen` : `${doc.label} (Download über Hintergrund)`);
      }

      pushStep('ai', 'KI analysiert Dokumente');
      logDebug('AI', `Sende ANALYZE an Service Worker...`);
      const res = await send({
        type: 'ANALYZE',
        payload: { pageContext: state.context, docs: payloadDocs, force }
      });

      if (res.ok) {
        logDebug('SUCCESS', `Analyse erfolgreich abgeschlossen (${res.result?.defects?.length || 0} Mängel)`);
        state.result = res.result;
        state.status = 'done';
        state.progressPct = 100;
        state.tab = 'maengel';
        completeStep('synthesis', 'Bewertung fertig');
        completeStep('ai', 'Analyse fertig');
      } else {
        logDebug('ERROR', `Analyse fehlgeschlagen: ${res.error}`, { code: res.code });
        state.error = { message: res.error, code: res.code };
        state.status = 'error';
      }
    } catch (err) {
      logDebug('ERROR', `Unerwarteter Fehler: ${err?.message || err}`);
      state.error = { message: String(err?.message || err), code: 'GENERIC' };
      state.status = 'error';
    } finally {
      if (keepAlivePing) clearInterval(keepAlivePing);
      try { keepAlivePort?.disconnect(); } catch { /* ignore */ }
    }
    render();
  }

  function pushStep(key, label) {
    state.steps = state.steps.filter((s) => s.key !== key);
    state.steps.push({ key, label, done: false });
    render();
  }

  function completeStep(key, label) {
    const step = state.steps.find((s) => s.key === key && !s.done);
    if (step) {
      step.done = true;
      if (label) step.label = label;
    }
    render();
  }

  const MODE_LABEL = {
    text: 'Text',
    hybrid: 'Text + Bildseiten',
    vision: 'Scan / Bilderkennung',
    chunked: 'in Teilen'
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'PROGRESS') return;
    const d = msg.detail || {};

    if (msg.step === 'parse') {
      if (d.cached) completeStep('parse', `Text aus Cache${d.pages ? ` (${d.pages} Seiten)` : ''}`);
      else pushStep('parse', `Lese PDF${d.label ? `: ${d.label}` : ''}`);
    }
    if (msg.step === 'parse-progress') {
      const step = state.steps.find((x) => x.key === 'parse');
      if (step) {
        if (d.total && d.done) {
          step.hint = `Seite ${d.done}/${d.total}`;
          state.progressPct = Math.round((d.done / d.total) * 45);
        } else if (d.rendered) {
          step.hint = `Bildseite ${d.rendered}/${d.total}`;
        }
        render();
      }
    }
    if (msg.step === 'ai') {
      completeStep('parse');
      state.progressPct = 55;
      pushStep(
        'ai',
        d.chunks > 1
          ? `KI wertet ${d.chunks} Teile aus`
          : `KI analysiert (${MODE_LABEL[d.mode] || 'Text'})`
      );
    }
    if (msg.step === 'chunk') {
      const step = state.steps.find((x) => x.key === 'ai');
      if (step) {
        step.hint = `Teil ${d.done}/${d.total}`;
        state.progressPct = 55 + Math.round((d.done / d.total) * 35);
        render();
      }
    }
    if (msg.step === 'synthesis') {
      completeStep('ai', 'Alle Teile ausgewertet');
      state.progressPct = 92;
      pushStep('synthesis', 'Gesamtbewertung wird erstellt');
    }
    if (msg.step === 'cached') {
      completeStep('ai', 'Ergebnis aus Cache (keine Kosten)');
    }
  });

  /* ------------------------------------------------------------------- UI */

  async function buildUi() {
    if (ui) {
      ui.root.className = 'vms-root';
      return ui;
    }
    const host = document.createElement('div');
    host.id = 'vms-host';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    try {
      style.textContent = await (await fetch(chrome.runtime.getURL('src/content/panel.css'))).text();
    } catch {
      style.textContent = '';
    }
    const root = document.createElement('div');
    root.className = 'vms-root';
    shadow.append(style, root);
    (document.body || document.documentElement).appendChild(host);

    ui = { host, shadow, root };
    applyStoredPosition();
    root.addEventListener('click', onClick);
    root.addEventListener('change', (e) => {
      const sel = e.target.closest('[data-act="sort"]');
      if (!sel) return;
      state.sort = sel.value;
      render();
    });
    return ui;
  }

  function applyStoredPosition() {
    const pos = state.settings?.panelPosition;
    if (pos && typeof pos.top === 'number') {
      ui.root.style.top = `${Math.max(8, pos.top)}px`;
      ui.root.style.right = 'auto';
      ui.root.style.left = `${Math.max(8, pos.left)}px`;
    }
  }

  function onClick(event) {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'collapse') {
      state.collapsed = !state.collapsed;
      chrome.storage.local.set({ panelCollapsed: state.collapsed });
      render();
    } else if (act === 'close') {
      state.closed = true;
      showPill();
    } else if (act === 'run') {
      runAnalysis();
    } else if (act === 'rerun') {
      runAnalysis({ force: true });
    } else if (act === 'options') {
      send({ type: 'OPEN_OPTIONS' });
    } else if (act === 'copy') {
      copyResult(btn);
    } else if (act === 'filter') {
      state.filter = btn.dataset.value;
      render();
    } else if (act === 'toggle-defect') {
      const card = btn.closest('.vms-defect');
      const open = !card.classList.contains('open');
      card.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
      if (open) state.openDefects.add(card.dataset.id);
      else state.openDefects.delete(card.dataset.id);
    } else if (act === 'tab') {
      switchTab(btn.dataset.value);
    } else if (act === 'more-onpage') {
      state.showAllPageDamages = true;
      render();
    } else if (act === 'theme') {
      state.theme = THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length];
      chrome.storage.local.set({ panelTheme: state.theme });
      render();
    } else if (act === 'scroll-top') {
      ui.root.querySelector('.vms-body')?.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (act === 'page') {
      const url = primaryDocUrl();
      if (url) window.open(`${url}#page=${btn.dataset.page}`, '_blank', 'noopener');
    } else if (act === 'restore') {
      state.closed = false;
      state.collapsed = false;
      buildUi().then(render);
    } else if (act === 'expand-all') {
      state.expandAll = !state.expandAll;
      if (!state.expandAll) state.openDefects.clear();
      render();
    } else if (act === 'open-doc') {
      window.open(btn.dataset.url, '_blank', 'noopener');
    } else if (act === 'open-debug') {
      state.view = 'debug';
      render();
    } else if (act === 'close-debug') {
      state.view = 'main';
      render();
    } else if (act === 'test-api') {
      state.isDiagnosingApi = true;
      render();
      send({ type: 'DIAGNOSE_API' }).then((res) => {
        state.isDiagnosingApi = false;
        state.apiDiagnosis = res;
        logDebug('TEST_API', res.ok ? `API erreichbar (${res.durationMs}ms, ${res.model})` : `API Fehler: ${res.error}`);
        render();
      });
    } else if (act === 'test-pdf') {
      const url = state.docs[0]?.url;
      if (!url) {
        state.pdfDiagnosis = { ok: false, error: 'Keine PDF-URL auf dieser Seite gefunden.' };
        render();
        return;
      }
      state.isDiagnosingPdf = true;
      render();
      send({ type: 'DIAGNOSE_PDF', payload: { url } }).then((res) => {
        state.isDiagnosingPdf = false;
        state.pdfDiagnosis = res;
        logDebug('TEST_PDF', res.ok ? `PDF Download OK: HTTP ${res.status}, isPdf=${res.isPdf}` : `PDF Fehler: ${res.error}`);
        render();
      });
    } else if (act === 'copy-debug') {
      copyDebugReport(btn);
    }
  }

  function copyDebugReport(btn) {
    const lines = [
      '### Autosmaya Debug-Report',
      `- Zeit: ${new Date().toISOString()}`,
      `- Seite: ${location.href}`,
      `- Portal: ${state.portal?.id || 'nicht erkannt'}`,
      `- FIN: ${state.context?.vin || 'nicht gefunden'}`,
      `- Gefundene Dokumente (${state.docs.length}):`,
      ...state.docs.map((d) => `  * [${d.kind}] ${d.label} -> ${d.url}`),
      `- Status: ${state.status}, Tab: ${state.tab}, View: ${state.view}`,
      `- Letzter Fehler: ${state.error ? JSON.stringify(state.error) : 'keiner'}`,
      `- Konfiguration: Modell=${state.settings?.model}, Vision=${state.settings?.visionFallback}, Cache=${state.settings?.cacheEnabled}, ApiKeyVorhanden=${Boolean(state.settings?.apiKey)}`,
      '',
      '#### Letzte Protokoll-Einträge:',
      ...state.debugLogs.map((l) => `[${l.time}] [${l.tag}] ${l.message}`),
      ''
    ];
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      const old = btn.textContent;
      btn.textContent = 'Kopiert!';
      setTimeout(() => { if (btn) btn.textContent = old; }, 1600);
    });
  }

  /** Kleine Pille, mit der sich das geschlossene Panel zurückholen lässt. */
  function showPill() {
    if (!ui) return;
    const r = state.result;
    const crit = r?.counts?.kritisch || 0;
    const tone = !r ? 'muted' : crit ? 'bad' : r.defects.length ? 'warn' : 'good';
    ui.root.className = 'vms-pill';
    ui.root.removeAttribute('style');
    ui.root.innerHTML = `
      <button class="vms-pill-btn ${tone}" data-act="restore" title="Autosmaya wieder öffnen">
        ${carIcon()}
        <span>${r ? `${r.defects.length} Mängel` : 'Autosmaya'}</span>
        ${crit ? `<span class="vms-pill-count">${crit}</span>` : ''}
      </button>`;
  }

  function copyResult(btn) {
    const r = state.result;
    if (!r) return;
    const v = r.verdict || {};
    const meta = VERDICT_META[v.recommendation];
    const c = r.meta?.coverage;

    const lines = [
      r.vehicle?.title || state.context.titel || 'Fahrzeug',
      state.context.vin ? `FIN: ${state.context.vin}` : '',
      state.context.kilometer ? `Laufleistung: ${state.context.kilometer}` : '',
      '',
      `EMPFEHLUNG: ${meta ? meta.label.toUpperCase() : 'UNKLAR'}${typeof v.score === 'number' ? ` (Zustands-Score ${v.score}/100)` : ''}`,
      v.headline || '',
      ...(v.reasons || []).map((x) => `  - ${x}`),
      v.deal_breakers?.length ? `\nAUSSCHLUSSKRITERIEN:\n${v.deal_breakers.map((x) => `  - ${x}`).join('\n')}` : '',
      v.before_first_drive?.length ? `\nVOR DER ERSTEN FAHRT:\n${v.before_first_drive.map((x) => `  - ${x}`).join('\n')}` : '',
      v.negotiation_points?.length
        ? `\nVERHANDLUNGSHEBEL:\n${v.negotiation_points.map((p) => `  - ${p.point}${p.amount_eur ? ` (${fmtCost(p.amount_eur)})` : ''}`).join('\n')}`
        : '',
      `\nZUSTAND: ${r.overall_condition}`,
      r.summary,
      '',
      `MÄNGEL (${r.defects.length}):`,
      ...r.defects.map(
        (d, i) =>
          `${i + 1}. [${d.severity.toUpperCase()}] ${d.title}${d.area ? ` (${d.area})` : ''}` +
          `${d.estimated_cost_eur ? ` - ${fmtCost(d.estimated_cost_eur)}` : ''}` +
          `${d.affects_roadworthiness ? ' [TÜV]' : ''}\n   ${d.description}` +
          `${d.quote ? `\n   Beleg: "${d.quote}"${d.source_page ? ` (Seite ${d.source_page})` : ''}` : ''}`
      ),
      r.tires?.length
        ? `\nREIFEN:\n${r.tires.map((t) => `  ${t.position}: ${t.dimension || '?'}, ${t.tread_mm ?? '?'} mm${t.note ? ` - ${t.note}` : ''}`).join('\n')}`
        : '',
      c ? `\nGrundlage: ${c.pagesRead} von ${c.pages} Seiten aus ${c.documents.length} Dokument(en).` : '',
      'Einschätzung allein auf Basis der verlinkten Dokumente - ersetzt keine Besichtigung.'
    ].filter((x) => x !== '' && x !== undefined && x !== null);

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      btn.textContent = 'Kopiert';
      setTimeout(() => (btn.textContent = 'Kopieren'), 1600);
    });
  }

  /* --------------------------------------------------------------- Render */

  const SEV_LABEL = { kritisch: 'Kritisch', mittel: 'Mittel', gering: 'Gering', hinweis: 'Hinweis' };
  const THEME_LABEL = { auto: 'automatisch', light: 'hell', dark: 'dunkel' };
  const THEME_ORDER = ['auto', 'light', 'dark'];

  const VERDICT_META = {
    kaufen: { label: 'Kaufen', short: 'Kaufen', tone: 'good', icon: 'thumb' },
    kaufen_mit_vorbehalt: { label: 'Kaufen mit Vorbehalt', short: 'Vorbehalt', tone: 'ok', icon: 'thumb' },
    nachverhandeln: { label: 'Nachverhandeln', short: 'Verhandeln', tone: 'warn', icon: 'tag' },
    finger_weg: { label: 'Finger weg', short: 'Finger weg', tone: 'bad', icon: 'alert' },
    unklar: { label: 'Unklar', short: 'Unklar', tone: 'muted', icon: 'question' }
  };

  const CATEGORY_LABEL = {
    karosserie: 'Karosserie', lack: 'Lack', glas: 'Glas', reifen: 'Reifen', raeder: 'Räder',
    innenraum: 'Innenraum', technik: 'Technik', motor: 'Motor', getriebe: 'Getriebe',
    fahrwerk: 'Fahrwerk', bremsen: 'Bremsen', elektrik: 'Elektrik',
    ausstattung: 'Ausstattung', dokumente: 'Dokumente', sonstiges: 'Sonstiges'
  };

  const TABS = [
    { id: 'maengel', label: 'Mängel' },
    { id: 'berechnet', label: 'Berechnet' },
    { id: 'meinung', label: 'Meinung' }
  ];

  const SORTERS = {
    schwere: (a, b) =>
      ({ kritisch: 0, mittel: 1, gering: 2, hinweis: 3 })[a.severity] -
      ({ kritisch: 0, mittel: 1, gering: 2, hinweis: 3 })[b.severity],
    kosten: (a, b) => (b.estimated_cost_eur || 0) - (a.estimated_cost_eur || 0),
    seite: (a, b) => (a.source_page || 999) - (b.source_page || 999)
  };

  const searchText = (d) =>
    `${d.title} ${d.description} ${d.area} ${CATEGORY_LABEL[d.category] || d.category} ${d.quote || ''}`
      .toLowerCase();

  const defectId = (d) => `${d.title}|${d.area}`.toLowerCase().replace(/\s+/g, '-').slice(0, 80);

  function primaryDocUrl() {
    const docs = state.result?.meta?.coverage?.documents || [];
    return docs[0]?.url || state.docs[0]?.url || null;
  }

  function condClass(c) {
    return ({ 'sehr gut': 'good', gut: 'good', befriedigend: 'mid', mangelhaft: 'bad' })[c] || 'unknown';
  }

  /* ------------------------------------------------------------ Grundgerüst */

  function render() {
    if (!ui) return;
    const { root } = ui;
    root.dataset.status = state.status;
    root.dataset.tab = state.tab;
    if (state.theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = state.theme;
    root.classList.toggle('collapsed', Boolean(state.collapsed));

    root.innerHTML =
      header() +
      (state.collapsed
        ? ''
        : tabBar() +
          `<div class="vms-body" data-tab="${state.tab}">${tabContent()}</div>` +
          footer() +
          '<div class="vms-resize" title="Größe ändern" aria-hidden="true"></div>');

    attachDrag();
    attachResize();
    attachSearch();
    positionBlob(false);
    animateScore();
    applySize();
  }

  /** Wechselt den Tab und morpht dabei Höhe und Inhalt ineinander. */
  function switchTab(id) {
    if (id === state.tab || !ui) return;
    const body = ui.root.querySelector('.vms-body');
    if (!body) {
      state.tab = id;
      render();
      return;
    }

    const from = body.getBoundingClientRect().height;
    state.tab = id;
    ui.root.dataset.tab = id;

    body.classList.add('morphing');
    body.innerHTML = tabContent();
    body.dataset.tab = id;
    body.style.height = 'auto';
    const target = Math.min(maxBodyHeight(), body.scrollHeight);
    body.style.height = `${from}px`;
    void body.offsetHeight; // Reflow, damit der Übergang startet

    requestAnimationFrame(() => {
      body.style.height = `${target}px`;
    });
    body.addEventListener(
      'transitionend',
      (e) => {
        if (e.propertyName !== 'height') return;
        body.style.height = '';
        body.classList.remove('morphing');
      },
      { once: true }
    );

    ui.root.querySelectorAll('.vms-tab').forEach((t) => {
      const on = t.dataset.value === id;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
    });
    positionBlob(true);
    attachSearch();
    animateScore();
  }

  function maxBodyHeight() {
    const total = state.size?.height || Math.min(window.innerHeight * 0.78, 760);
    return Math.max(160, total - 132);
  }

  /** Der Tab-Indikator gleitet als weicher Blob mit kurzem Nachfedern. */
  function positionBlob(animate) {
    const bar = ui.root.querySelector('.vms-tabs');
    const blob = ui.root.querySelector('.vms-tab-blob');
    const active = ui.root.querySelector('.vms-tab.on');
    if (!bar || !blob || !active) return;
    const b = bar.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    blob.style.transition = animate ? '' : 'none';
    blob.style.width = `${a.width}px`;
    blob.style.transform = `translateX(${a.left - b.left}px)`;
    if (animate) {
      blob.classList.remove('squash');
      void blob.offsetWidth;
      blob.classList.add('squash');
    } else {
      requestAnimationFrame(() => (blob.style.transition = ''));
    }
  }

  function animateScore() {
    const ring = ui?.root.querySelector('.vms-ring-value');
    if (!ring) return;
    const target = Number(ring.dataset.offset);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        ring.style.strokeDashoffset = String(target);
      })
    );
  }

  /* ----------------------------------------------------------------- Kopf */

  function header() {
    const r = state.result;
    let badge = '';
    if (state.status === 'done') {
      const crit = r?.counts?.kritisch || 0;
      const total = r?.defects?.length || 0;
      // Sachlich: nur die Zahl. Die Bewertung steht im Tab "Meinung".
      badge = total
        ? `<span class="vms-badge ${crit ? 'bad' : 'warn'}"
             title="${total} Mängel${crit ? `, davon ${crit} kritisch` : ''}">${total} Mängel</span>`
        : '<span class="vms-badge good">Ohne Befund</span>';
    } else if (state.status === 'busy') {
      badge = '<span class="vms-badge busy">Prüft…</span>';
    } else if (state.status === 'error') {
      badge = '<span class="vms-badge bad">Fehler</span>';
    }

    const title = esc(state.context.titel || state.result?.vehicle?.title || 'Fahrzeug-Check');
    const sub = [state.context.vin, state.context.kilometer].filter(Boolean).map(esc).join(' · ');

    return `
      <header class="vms-head" data-drag>
        <div class="vms-blobs" aria-hidden="true"><i></i><i></i></div>
        <div class="vms-logo">${carIcon()}</div>
        <div class="vms-titles">
          <div class="vms-title" title="${title}">${title}</div>
          ${sub ? `<div class="vms-sub" title="${sub}">${sub}</div>` : ''}
        </div>
        ${badge}
        <div class="vms-actions">
          <button class="vms-icon" data-act="collapse" aria-label="Ein-/Ausklappen" title="Ein-/Ausklappen (Esc)">${state.collapsed ? chevronDown() : chevronUp()}</button>
          <button class="vms-icon" data-act="close" aria-label="Schließen" title="Schließen">${xIcon()}</button>
        </div>
      </header>`;
  }

  function tabBar() {
    if (state.status !== 'done') return '';
    const r = state.result;
    const count = { maengel: r.defects.length, berechnet: 0, meinung: 0 };
    return `
      <nav class="vms-tabs" role="tablist">
        <span class="vms-tab-blob" aria-hidden="true"></span>
        ${TABS.map(
          (t) => `<button class="vms-tab ${t.id === state.tab ? 'on' : ''}" role="tab"
                    aria-selected="${t.id === state.tab}" data-act="tab" data-value="${t.id}">
                    ${esc(t.label)}${count[t.id] ? `<span class="vms-tab-count">${count[t.id]}</span>` : ''}
                  </button>`
        ).join('')}
      </nav>`;
  }

  /* -------------------------------------------------------------- Inhalte */

  function tabContent() {
    if (state.view === 'debug') return debugBody();
    if (state.status === 'busy') return busyBody();
    if (state.status === 'error') return errorBody();
    if (state.status !== 'done') return idleBody();
    if (state.tab === 'berechnet') return calcTab();
    if (state.tab === 'meinung') return opinionTab();
    return defectTab();
  }

  function debugBody() {
    const doc = state.docs[0];
    const docUrl = doc?.url || 'Kein Dokument erkannt';
    const lastErr = state.error?.message || 'Kein Fehler protokolliert';
    const apiDiag = state.apiDiagnosis;
    const pdfDiag = state.pdfDiagnosis;

    return `
      <div class="vms-debug-view">
        <div class="vms-debug-head">
          <div class="vms-debug-title">
            <span class="vms-debug-icon">${debugIcon()}</span>
            <strong>Diagnose & Systemstatus</strong>
          </div>
          <button class="vms-ghost sm" data-act="close-debug">← Zurück</button>
        </div>

        <div class="vms-debug-card">
          <div class="vms-debug-row">
            <span class="vms-debug-label">Aktuelle Seite:</span>
            <span class="vms-debug-val" title="${esc(location.href)}">${esc(location.pathname + location.search)}</span>
          </div>
          <div class="vms-debug-row">
            <span class="vms-debug-label">Fahrzeug FIN:</span>
            <span class="vms-debug-val">${esc(state.context?.vin || 'Nicht im DOM gefunden')}</span>
          </div>
          <div class="vms-debug-row">
            <span class="vms-debug-label">PDF-Link:</span>
            <span class="vms-debug-val mono" title="${esc(docUrl)}">${esc(docUrl)}</span>
          </div>
          <div class="vms-debug-row">
            <span class="vms-debug-label">Letzter Fehler:</span>
            <span class="vms-debug-val ${state.error ? 'err' : ''}">${esc(lastErr)}</span>
          </div>
        </div>

        <div class="vms-debug-actions">
          <button class="vms-ghost sm" data-act="test-api">
            ${state.isDiagnosingApi ? '<span class="vms-spin"></span>' : '⚡'} API testen
          </button>
          <button class="vms-ghost sm" data-act="test-pdf">
            ${state.isDiagnosingPdf ? '<span class="vms-spin"></span>' : '📥'} PDF-Download testen
          </button>
          <button class="vms-ghost sm" data-act="copy-debug">📋 Report kopieren</button>
        </div>

        ${apiDiag ? `
          <div class="vms-diag-box ${apiDiag.ok ? 'ok' : 'bad'}">
            <strong>API-Verbindungstest (${apiDiag.durationMs}ms):</strong>
            ${apiDiag.ok
              ? `<div>Erfolgreich! Modell <code>${esc(apiDiag.model)}</code> antwortet ordnungsgemäß.</div>`
              : `<div>Fehler: ${esc(apiDiag.error)}</div>`}
          </div>` : ''}

        ${pdfDiag ? `
          <div class="vms-diag-box ${pdfDiag.ok && pdfDiag.isPdf ? 'ok' : 'bad'}">
            <strong>PDF-Download-Test (${pdfDiag.durationMs}ms):</strong>
            ${pdfDiag.ok
              ? `<div>Status: HTTP ${pdfDiag.status} | Content-Type: ${esc(pdfDiag.contentType || 'keiner')}</div>
                 <div>Ergebnis: ${pdfDiag.isPdf ? ' Gültiges PDF (%PDF- Signatur vorhanden)' : '⚠️ Antwort ist kein PDF!'} (${Math.round((pdfDiag.bytesReceived || 0)/1024)} KB)</div>
                 ${pdfDiag.nestedPdfUrl ? `<div>Gefundener Link im HTML: <code>${esc(pdfDiag.nestedPdfUrl)}</code></div>` : ''}
                 ${pdfDiag.preview ? `<pre class="vms-debug-pre">${esc(pdfDiag.preview)}</pre>` : ''}`
              : `<div>Fehler: ${esc(pdfDiag.error)}</div>`}
          </div>` : ''}

        <div class="vms-debug-log-head">
          <span>Ereignis-Protokoll (${state.debugLogs.length})</span>
        </div>
        <div class="vms-debug-log">
          ${state.debugLogs.length === 0
            ? '<div class="vms-debug-empty">Noch keine Log-Ereignisse aufgezeichnet.</div>'
            : state.debugLogs
                .slice()
                .reverse()
                .map(
                  (l) => `<div class="vms-debug-entry">
                     <span class="vms-debug-time">${esc(l.time)}</span>
                     <span class="vms-debug-tag ${esc((l.tag || '').toLowerCase())}">[${esc(l.tag)}]</span>
                     <span class="vms-debug-msg">${esc(l.message)}</span>
                   </div>`
                )
                .join('')}
        </div>
      </div>`;
  }

  function idleBody() {
    return `
      ${pageDamageBlock()}
      <div class="vms-docs">
        ${state.docs
          .map(
            (d, i) => `<div class="vms-doc" style="--i:${i}"><span class="vms-dot ${d.kind}"></span>
              <span class="vms-doc-label">${esc(d.label)}</span>
              <button class="vms-link" data-act="open-doc" data-url="${esc(d.url)}">öffnen</button></div>`
          )
          .join('')}
      </div>
      <button class="vms-primary" data-act="run">${searchIcon()}<span>Mängel prüfen</span></button>`;
  }

  function busyBody() {
    const steps = state.steps
      .map(
        (s, i) => `<li class="${s.done ? 'done' : 'active'}" style="--i:${i}">
             <span class="vms-step-icon">${s.done ? checkIcon() : '<span class="vms-spin"></span>'}</span>
             <span class="vms-step-label">${esc(s.label)}</span>
             ${s.hint ? `<span class="vms-step-hint">${esc(s.hint)}</span>` : ''}
           </li>`
      )
      .join('');
    const pct = state.progressPct;
    return `
      ${pageDamageBlock()}
      <div class="vms-progress">
        <div class="vms-progress-bar ${pct === null ? 'indeterminate' : ''}" ${pct !== null ? `style="width:${pct}%"` : ''}></div>
      </div>
      <ul class="vms-steps">${steps}</ul>`;
  }

  function errorBody() {
    const noKey = state.error?.code === 'NO_API_KEY';
    return `
      ${pageDamageBlock()}
      <div class="vms-error">${alertIcon()}<span>${esc(state.error?.message || 'Unbekannter Fehler')}</span></div>
      <div class="vms-row">
        ${noKey
          ? '<button class="vms-primary" data-act="options"><span>API-Key eintragen</span></button>'
          : '<button class="vms-primary" data-act="rerun"><span>Erneut versuchen</span></button>'}
        <button class="vms-ghost" data-act="open-debug"><span>🔍 Debug / Diagnose</span></button>
        ${noKey ? '' : '<button class="vms-ghost" data-act="options">Einstellungen</button>'}
      </div>`;
  }

  /** Schäden, die das Portal selbst anzeigt - sofort sichtbar, ohne Analyse. */
  function pageDamageBlock() {
    if (!state.pageDamages.length) return '';
    const shown = state.pageDamages.slice(0, state.showAllPageDamages ? 25 : 5);
    return `
      <section class="vms-onpage">
        <div class="vms-onpage-head">${eyeIcon()}<strong>Direkt von der Seite</strong>
          <span class="vms-onpage-count">${state.pageDamages.length}</span></div>
        <ul>${shown.map((t, i) => `<li style="--i:${i}">${esc(t)}</li>`).join('')}</ul>
        ${state.pageDamages.length > shown.length
          ? `<button class="vms-link" data-act="more-onpage">alle ${state.pageDamages.length} anzeigen</button>`
          : ''}
      </section>`;
  }

  /* ------------------------------------------------------------ Tab Mängel */

  function defectTab() {
    const r = state.result;
    if (!r.defects.length) {
      return `
        ${pageDamageBlock()}
        <div class="vms-empty">${checkBig()}<div><strong>Keine Mängel dokumentiert</strong>
          <p>${esc(r.report_found ? 'Im Dokument sind keine Schäden vermerkt.' : 'Das Dokument enthält keine Zustandsangaben.')}</p></div></div>
        ${coverageBlock()}`;
    }

    const counts = r.counts || {};
    const chips = ['alle', 'kritisch', 'mittel', 'gering', 'hinweis']
      .filter((k) => k === 'alle' || counts[k])
      .map(
        (k) =>
          `<button class="vms-chip ${k} ${state.filter === k ? 'on' : ''}" data-act="filter" data-value="${k}">
             ${k === 'alle' ? `Alle ${r.defects.length}` : `${SEV_LABEL[k]} ${counts[k]}`}
           </button>`
      )
      .join('');

    const visible = r.defects
      .filter((d) => state.filter === 'alle' || d.severity === state.filter)
      .slice()
      .sort(SORTERS[state.sort] || SORTERS.schwere);

    const showSearch = r.defects.length >= 5;

    return `
      ${pageDamageBlock()}
      <div class="vms-toolbar">
        <div class="vms-chips">${chips}</div>
        <button class="vms-ghost sm" data-act="expand-all">${state.expandAll ? 'Zuklappen' : 'Alle Details'}</button>
      </div>
      ${showSearch
        ? `<div class="vms-searchbar">
             <span class="vms-search-icon">${searchIcon()}</span>
             <input class="vms-search" type="search" placeholder="Mängel durchsuchen…"
               value="${esc(state.search)}" aria-label="Mängel durchsuchen" />
             <select class="vms-sort" aria-label="Sortierung" data-act="sort">
               <option value="schwere"${state.sort === 'schwere' ? ' selected' : ''}>Schwere</option>
               <option value="kosten"${state.sort === 'kosten' ? ' selected' : ''}>Kosten</option>
               <option value="seite"${state.sort === 'seite' ? ' selected' : ''}>Seite</option>
             </select>
           </div>
           <div class="vms-hits" hidden></div>`
        : ''}
      <div class="vms-list">${visible.map((d, i) => defectCard(d, i)).join('')}</div>
      <div class="vms-nohits" hidden>Kein Mangel passt zu dieser Suche.</div>
      ${tiresBlock(r)}
      ${r.missing_info?.length ? `<div class="vms-missing"><strong>Nicht im Dokument:</strong> ${esc(r.missing_info.join(', '))}</div>` : ''}
      ${coverageBlock()}`;
  }

  function defectCard(d, index) {
    const cost = fmtCost(d.estimated_cost_eur);
    const open = state.expandAll || state.openDefects.has(defectId(d));
    return `
      <article class="vms-defect ${d.severity} ${open ? 'open' : ''}" style="--i:${index}"
        data-id="${esc(defectId(d))}" data-search="${esc(searchText(d))}">
        <button class="vms-defect-head" data-act="toggle-defect" aria-expanded="${open}">
          <span class="vms-sev" title="${SEV_LABEL[d.severity]}"></span>
          <span class="vms-defect-title">${esc(d.title)}</span>
          ${d.affects_roadworthiness ? '<span class="vms-tag tuv" title="HU/TÜV-relevant">TÜV</span>' : ''}
          ${cost ? `<span class="vms-tag cost">${esc(cost)}</span>` : ''}
          <span class="vms-caret">${chevronDown()}</span>
        </button>
        <div class="vms-defect-body"><div class="vms-defect-inner"><div class="vms-defect-pad">
          <p>${esc(d.description)}</p>
          <div class="vms-meta">
            ${d.area ? `<span>${esc(d.area)}</span>` : ''}
            <span class="vms-cat">${esc(CATEGORY_LABEL[d.category] || d.category)}</span>
            ${d.source_page
              ? primaryDocUrl()
                ? `<button class="vms-page" data-act="page" data-page="${d.source_page}"
                     title="PDF auf Seite ${d.source_page} öffnen">Seite ${d.source_page}${externalIcon()}</button>`
                : `<span>Seite ${d.source_page}</span>`
              : ''}
          </div>
          ${d.quote ? `<blockquote>${esc(d.quote)}</blockquote>` : ''}
        </div></div></div>
      </article>`;
  }

  function tiresBlock(r) {
    if (!r.tires?.length) return '';
    const rows = r.tires
      .map(
        (t) =>
          `<tr><td>${esc(t.position || '')}</td><td>${esc(t.dimension || '-')}</td>
           <td class="${typeof t.tread_mm === 'number' && t.tread_mm < 3 ? 'low' : ''}">${t.tread_mm != null ? `${t.tread_mm} mm` : '-'}</td>
           <td>${esc(t.note || '')}</td></tr>`
      )
      .join('');
    return `<details class="vms-fold" ${state.expandAll ? 'open' : ''}>
      <summary>${tireIcon()}<span>Reifen (${r.tires.length})</span></summary>
      <table class="vms-tires"><thead><tr><th>Pos.</th><th>Größe</th><th>Profil</th><th>Notiz</th></tr></thead>
      <tbody>${rows}</tbody></table></details>`;
  }

  function coverageBlock() {
    const c = state.result?.meta?.coverage;
    if (!c) return '';
    const docs = c.documents || [];
    const scanned = docs.filter((d) => d.scanned).length;
    const imagePages = docs.reduce((a, d) => a + (d.imagePages?.length || 0), 0);
    const bits = [`${c.pagesRead} von ${c.pages} Seiten gelesen`];
    if (docs.length > 1) bits.push(`${docs.length} Dokumente`);
    if (scanned) bits.push(`${scanned} Scan${scanned > 1 ? 's' : ''} per Bilderkennung`);
    else if (imagePages) bits.push(`${imagePages} Bildseite${imagePages > 1 ? 'n' : ''} zusätzlich erkannt`);
    if (state.result?.meta?.chunks > 1) bits.push(`in ${state.result.meta.chunks} Teilen ausgewertet`);

    return `<div class="vms-coverage ${c.complete ? 'ok' : 'partial'}">
      ${c.complete ? checkIcon() : alertIcon()}<span>${esc(bits.join(' · '))}</span></div>`;
  }

  /* --------------------------------------------------------- Tab Berechnet */

  function calcTab() {
    const r = state.result;
    const n = computeNumbers(r, state.context);

    const row = (label, value, hint, cls = '') =>
      `<div class="vms-calc-row ${cls}">
         <span class="vms-calc-label">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>
         <span class="vms-calc-value">${value}</span>
       </div>`;

    const repairRows = [];
    if (n.documented !== null) {
      repairRows.push(
        row('Reparatur belegt', esc(fmtCost(n.documented)), `${n.documentedCount} von ${n.totalCount} Positionen beziffert`)
      );
    }
    if (n.reportTotal !== null && n.reportTotal !== n.documented) {
      repairRows.push(row('Summe laut Dokument', esc(fmtCost(n.reportTotal))));
    }
    if (n.urgent !== null) {
      repairRows.push(
        row('davon sicherheitsrelevant', esc(fmtCost(n.urgent)),
          n.urgentOpen ? `+ ${n.urgentOpen} Position(en) ohne Betrag` : '', 'urgent')
      );
    }
    if (n.withoutAmount) {
      repairRows.push(row('Ohne Betrag im Dokument', `${n.withoutAmount} Position${n.withoutAmount > 1 ? 'en' : ''}`, '', 'open'));
    }

    const priceRows = [];
    if (n.price !== null) {
      priceRows.push(row('Angebotspreis', esc(fmtCost(n.price))));
      if (n.effective !== null) {
        priceRows.push(row('Effektivpreis', esc(fmtCost(n.effective)), 'Preis + belegte Reparatur', 'strong'));
      }
      if (n.target !== null) {
        priceRows.push(row('Verhandlungsziel', esc(fmtCost(n.target)), 'Preis − Verhandlungshebel', 'target'));
      }
    } else if (n.negotiation !== null) {
      priceRows.push(row('Verhandlungshebel gesamt', esc(fmtCost(n.negotiation)), '', 'target'));
    }

    if (!repairRows.length && !priceRows.length) {
      return `<div class="vms-empty muted">${calcIcon()}<div><strong>Nichts zu rechnen</strong>
        <p>Im Dokument stehen keine Beträge, und auf der Seite wurde kein Preis gefunden.</p></div></div>`;
    }

    const byCategory = {};
    for (const d of r.defects) {
      if (typeof d.estimated_cost_eur !== 'number') continue;
      const key = CATEGORY_LABEL[d.category] || d.category;
      byCategory[key] = (byCategory[key] || 0) + d.estimated_cost_eur;
    }
    const cats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    const max = cats.length ? cats[0][1] : 0;

    return `
      <section class="vms-calc">
        <div class="vms-calc-head">${calcIcon()}<strong>Kosten</strong>
          <span class="vms-calc-note">nur belegte Beträge</span></div>
        ${repairRows.join('')}
        ${repairRows.length && priceRows.length ? '<div class="vms-calc-sep"></div>' : ''}
        ${priceRows.join('')}
      </section>
      ${cats.length
        ? `<section class="vms-bars">
             <div class="vms-bars-head">Nach Bereich</div>
             ${cats
               .map(
                 ([name, sum], i) => `<div class="vms-bar" style="--i:${i}">
                     <span class="vms-bar-label">${esc(name)}</span>
                     <span class="vms-bar-track"><i style="--w:${Math.round((sum / max) * 100)}%"></i></span>
                     <span class="vms-bar-value">${esc(fmtCost(sum))}</span>
                   </div>`
               )
               .join('')}
           </section>`
        : ''}
      ${negotiationBlock(r.verdict || {})}`;
  }

  function negotiationBlock(v) {
    if (!v.negotiation_points?.length) return '';
    const sum = v.negotiation_points.reduce((a, p) => a + (p.amount_eur || 0), 0);
    return `
      <details class="vms-fold" ${state.expandAll ? 'open' : ''}>
        <summary>${tagIcon()}<span>Verhandlungshebel (${v.negotiation_points.length})</span>
          ${sum ? `<span class="vms-fold-sum">${esc(fmtCost(sum))}</span>` : ''}</summary>
        <ul class="vms-negotiation">
          ${v.negotiation_points
            .map((p) => `<li><span>${esc(p.point)}</span>${p.amount_eur ? `<b>${esc(fmtCost(p.amount_eur))}</b>` : ''}</li>`)
            .join('')}
        </ul>
      </details>`;
  }

  /* ----------------------------------------------------------- Tab Meinung */

  function opinionTab() {
    const r = state.result;
    const v = r.verdict || {};
    const meta = VERDICT_META[v.recommendation] || VERDICT_META.unklar;

    return `
      <section class="vms-verdict ${meta.tone}">
        <div class="vms-verdict-glow" aria-hidden="true"></div>
        <div class="vms-verdict-head">
          ${scoreRing(v.score, meta.tone)}
          <div class="vms-verdict-main">
            <div class="vms-verdict-label">${verdictIcon(meta.icon)}<span>${meta.label}</span></div>
            ${v.headline ? `<p class="vms-verdict-line">${esc(v.headline)}</p>` : ''}
          </div>
        </div>
        ${v.reasons?.length
          ? `<ul class="vms-reasons">${v.reasons.map((x, i) => `<li style="--i:${i}">${esc(x)}</li>`).join('')}</ul>`
          : ''}
        ${v.price_assessment ? `<p class="vms-price">${tagIcon()}<span>${esc(v.price_assessment)}</span></p>` : ''}
        <div class="vms-verdict-foot">
          ${r.overall_condition && r.overall_condition !== 'unbekannt'
            ? `<span class="vms-cond ${condClass(r.overall_condition)}">${esc(r.overall_condition)}</span>`
            : ''}
          ${r.confidence !== null ? `<span class="vms-conf">Sicherheit ${Math.round((r.confidence || 0) * 100)} %</span>` : ''}
        </div>
      </section>
      ${listBlock(v.deal_breakers, 'bad', alertIcon(), 'Ausschlusskriterien')}
      ${listBlock(v.before_first_drive, 'warn', wrenchIcon(), 'Vor der ersten Fahrt')}
      ${r.summary ? `<p class="vms-lead">${esc(r.summary)}</p>` : ''}
      <p class="vms-disclaimer">Einschätzung allein aus den verlinkten Dokumenten – ersetzt keine
        Besichtigung und keine Probefahrt.</p>`;
  }

  function scoreRing(score, tone) {
    if (typeof score !== 'number') {
      return `<div class="vms-ring empty ${tone}">${questionIcon()}</div>`;
    }
    const R = 22;
    const circumference = 2 * Math.PI * R;
    const offset = circumference * (1 - Math.min(100, Math.max(0, score)) / 100);
    return `
      <div class="vms-ring ${tone}">
        <svg viewBox="0 0 52 52" width="52" height="52" aria-hidden="true">
          <circle class="vms-ring-track" cx="26" cy="26" r="${R}" />
          <circle class="vms-ring-value" cx="26" cy="26" r="${R}"
            style="stroke-dasharray:${circumference.toFixed(1)};stroke-dashoffset:${circumference.toFixed(1)}"
            data-offset="${offset.toFixed(1)}" />
        </svg>
        <span class="vms-ring-num">${score}</span>
      </div>`;
  }

  function listBlock(items, tone, icon, title) {
    if (!items?.length) return '';
    return `
      <section class="vms-callout ${tone}">
        <div class="vms-callout-head">${icon}<strong>${title}</strong></div>
        <ul>${items.map((x, i) => `<li style="--i:${i}">${esc(x)}</li>`).join('')}</ul>
      </section>`;
  }

  /* ---------------------------------------------------------------- Fuß */

  function footer() {
    const meta = state.result?.meta;
    const bits = [];
    if (meta) {
      bits.push(esc((meta.model || '').split('/').pop()));
      if (meta.fromCache) bits.push('Cache');
      else {
        if (typeof meta.usage?.cost === 'number') bits.push(`$${meta.usage.cost.toFixed(4)}`);
        if (meta.durationMs) bits.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
        if (meta.calls > 1) bits.push(`${meta.calls} Aufrufe`);
      }
      if (meta.mode === 'vision') bits.push('Scan-Modus');
      if (meta.mode === 'hybrid') bits.push('Text + Bild');
    }
    return `
      <footer class="vms-foot">
        <span class="vms-meta-line" title="${bits.join(' · ')}">${bits.join(' · ')}</span>
        <span class="vms-foot-actions">
          <button class="vms-icon sm" data-act="theme" aria-label="Darstellung wechseln"
            title="Darstellung: ${THEME_LABEL[state.theme]}">${themeIcon(state.theme)}</button>
          <button class="vms-icon sm" data-act="open-debug" aria-label="Diagnose & Debug"
            title="Diagnose & Systemstatus anzeigen">${debugIcon()}</button>
          ${state.status === 'done' ? '<button class="vms-ghost sm" data-act="copy">Kopieren</button>' : ''}
          ${state.status === 'done' ? '<button class="vms-ghost sm" data-act="rerun" title="Cache umgehen und neu auswerten">Neu</button>' : ''}
          <button class="vms-ghost sm" data-act="options">Einstellungen</button>
        </span>
      </footer>`;
  }

  /* ------------------------------------------------------- Interaktionen */

  /** Sucht direkt im DOM, damit der Cursor im Suchfeld nicht verloren geht. */
  function attachSearch() {
    const input = ui.root.querySelector('.vms-search');
    if (!input) return;
    input.addEventListener('input', () => {
      state.search = input.value;
      applySearch();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        input.value = '';
        state.search = '';
        applySearch();
      }
    });
    if (state.search) {
      applySearch();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function applySearch() {
    const q = state.search.trim().toLowerCase();
    const cards = [...ui.root.querySelectorAll('.vms-defect')];
    let hits = 0;
    for (const card of cards) {
      const match = !q || (card.dataset.search || '').includes(q);
      card.hidden = !match;
      if (match) hits++;
    }
    const hitBox = ui.root.querySelector('.vms-hits');
    if (hitBox) {
      hitBox.hidden = !q;
      hitBox.textContent = `${hits} von ${cards.length} Mängeln`;
    }
    const empty = ui.root.querySelector('.vms-nohits');
    if (empty) empty.hidden = !(q && hits === 0);
  }

  /** Panel in Breite und Höhe anpassbar; die Größe bleibt gespeichert. */
  function attachResize() {
    const grip = ui.root.querySelector('.vms-resize');
    if (!grip) return;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = ui.root.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      grip.setPointerCapture(e.pointerId);
      ui.root.classList.add('resizing');

      const move = (ev) => {
        const width = Math.min(720, Math.max(320, rect.width - (ev.clientX - startX)));
        const height = Math.min(window.innerHeight - 40, Math.max(240, rect.height + (ev.clientY - startY)));
        state.size = { width, height };
        applySize();
      };
      const up = (ev) => {
        grip.releasePointerCapture(ev.pointerId);
        ui.root.classList.remove('resizing');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        chrome.storage.local.set({ panelSize: state.size });
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }

  function applySize() {
    if (!state.size || !ui) return;
    ui.root.style.width = `${state.size.width}px`;
    if (!state.collapsed) ui.root.style.maxHeight = `${state.size.height}px`;
    else ui.root.style.maxHeight = '';
  }

  /* ------------------------------------------------------------- Dragging */

  function attachDrag() {
    const handle = ui.root.querySelector('[data-drag]');
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = ui.root.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      ui.root.classList.add('dragging');

      const move = (ev) => {
        const left = Math.min(Math.max(8, ev.clientX - offsetX), window.innerWidth - rect.width - 8);
        const top = Math.min(Math.max(8, ev.clientY - offsetY), window.innerHeight - 60);
        ui.root.style.left = `${left}px`;
        ui.root.style.top = `${top}px`;
        ui.root.style.right = 'auto';
      };
      const up = (ev) => {
        handle.releasePointerCapture(ev.pointerId);
        ui.root.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        const rect2 = ui.root.getBoundingClientRect();
        chrome.storage.local.set({ panelPosition: { top: rect2.top, left: rect2.left } });
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  /* ---------------------------------------------------------------- Icons */

  const carIcon = () =>
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13"/><path d="M3 13h18v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><circle cx="7.5" cy="15.5" r=".8" fill="currentColor"/><circle cx="16.5" cy="15.5" r=".8" fill="currentColor"/></svg>';
  const chevronDown = () =>
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const chevronUp = () =>
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';
  const xIcon = () =>
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const checkIcon = () =>
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const searchIcon = () =>
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  const alertIcon = () =>
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4"/><circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none"/></svg>';
  const wrenchIcon = () =>
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3.5a5 5 0 0 0-6.3 6.3L3.6 15.4a2 2 0 1 0 2.8 2.8l5.6-5.6a5 5 0 0 0 6.3-6.3l-2.9 2.9-2.1-2.1z"/></svg>';
  const tagIcon = () =>
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/></svg>';
  const externalIcon = () =>
    '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5h5v5"/><path d="M19 5l-7.5 7.5"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>';
  const themeIcon = (mode) =>
    ({
      auto: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="7.5"/><path d="M12 4.5v15" stroke-linecap="round"/><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none"/></svg>',
      light: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/></svg>',
      dark: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>'
    })[mode] || '';
  const eyeIcon = () =>
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
  const calcIcon = () =>
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7.5h7"/><path d="M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01"/></svg>';
  const tireIcon = () =>
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/></svg>';
  const questionIcon = () =>
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 9.2a2.9 2.9 0 1 1 3.9 2.7c-.8.3-1.1 1-1.1 1.8v.4"/><circle cx="12" cy="17.6" r="1" fill="currentColor" stroke="none"/></svg>';
  const thumbIcon = () =>
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v10H4V10zM7 10l4-7a2 2 0 0 1 3 1.8V9h4.5a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17.2 19H7z"/></svg>';
  const verdictIcon = (name) =>
    ({ thumb: thumbIcon, tag: tagIcon, alert: alertIcon, question: questionIcon }[name] || questionIcon)();
  const checkBig = () =>
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>';
  const debugIcon = () =>
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>';

  /* ----------------------------------------------------------------- Boot */

  async function scan({ auto = true } = {}) {
    const res = await send({ type: 'GET_SETTINGS' });
    if (!res.ok) return;
    state.settings = res.settings;
    state.portal = portalFor(location.hostname);
    state.collapsed = state.settings.panelCollapsed;
    state.theme = state.settings.panelTheme || 'auto';
    state.size = state.settings.panelSize || null;

    // Erst prüfen, dann lesen: ohne Freigabe wird die Seite nicht angefasst.
    if (!urlAllowed(state.settings, location.href)) {
      removeUi();
      return;
    }

    const docs = findDocuments();
    if (!docs.length) return;
    const ctx = scrapeContext();
    state.pageDamages = scrapeOnPageDamages();
    if (!isVehiclePage(docs, ctx)) return;

    const key = `${location.href}|${docs.map((d) => d.url).join(',')}`;
    if (key === state.pageKey && ui) return;
    state.pageKey = key;
    state.docs = docs;
    state.context = ctx;
    state.result = null;
    state.error = null;
    state.status = 'idle';
    state.tab = 'maengel';
    state.showAllPageDamages = false;
    logDebug('SCAN', `Erkannt: ${docs.length} Dokument(e), FIN=${ctx.vin || 'keine'} auf ${location.pathname}`);

    await buildUi();
    render();

    if (auto && state.settings.autoRun && state.settings.apiKey) {
      runAnalysis();
    } else if (auto && state.settings.autoRun && !state.settings.apiKey) {
      state.status = 'error';
      state.error = { message: 'Kein OpenRouter API-Key hinterlegt.', code: 'NO_API_KEY' };
      render();
    }
  }

  /**
   * Autosmaya arbeitet nur auf den freigegebenen Adressen. Der Host ist zusätzlich
   * im Manifest festgeschrieben; diese Prüfung schränkt auf die Fahrzeugseiten ein.
   * Spiegelt urlAllowed() aus lib/config.js - Content-Scripts können nicht importieren.
   */
  function urlAllowed(settings, href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return false;
    }

    // Für BCA-Portale: Erlaube Lot- und Fahrzeug-Seiten direkt
    if (/(?:bca-europe\.com|bca\.com|bca\.de|bca\.co\.uk)/i.test(url.hostname)) {
      if (url.pathname.includes('/lot') || url.pathname.includes('/vehicle') || url.searchParams.has('id') || url.searchParams.has('VehId')) {
        return true;
      }
    }

    const prefixes = settings?.urlPrefixes?.length
      ? settings.urlPrefixes
      : ['https://de.bca-europe.com/lot?id'];

    for (const raw of prefixes) {
      const prefix = String(raw).trim();
      if (!prefix) continue;
      if (href.startsWith(prefix)) return true;

      let ref;
      try {
        ref = new URL(prefix);
      } catch {
        continue;
      }
      if (url.origin !== ref.origin) continue;
      if (url.pathname.replace(/\/+$/, '') !== ref.pathname.replace(/\/+$/, '')) continue;
      const param = prefix.match(/[?&]([A-Za-z0-9_-]+)$/)?.[1];
      if (!param) return true;
      if (url.searchParams.has(param)) return true;
    }
    return false;
  }

  let lastScanAt = 0;
  const SCAN_COOLDOWN_MS = 2500;

  function removeUi() {
    if (!ui) return;
    ui.host.remove();
    ui = null;
    state.status = 'idle';
    state.result = null;
    state.pageKey = '';
    send({ type: 'CLEAR_BADGE' });
  }

  function scheduleScan(auto = true, { immediate = false } = {}) {
    if (state.status === 'busy') return;
    const wait = immediate ? 150 : Math.max(600, SCAN_COOLDOWN_MS - (Date.now() - lastScanAt));
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      lastScanAt = Date.now();
      scan({ auto });
    }, wait);
  }

  // SPA-Navigation erkennen
  let lastHref = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      state.pageKey = '';
      state.dismissed.clear();
      scheduleScan(true, { immediate: true });
    } else if (!ui) {
      scheduleScan();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', () => scheduleScan());

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !ui || state.closed || state.collapsed) return;
      if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      state.collapsed = true;
      chrome.storage.local.set({ panelCollapsed: true });
      render();
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg?.type === 'GET_STATE') {
      const r = state.result;
      respond({
        ok: true,
        status: state.status,
        verdict: r?.verdict || null,
        defects: r?.defects?.length || 0,
        counts: r?.counts || null,
        pages: r?.meta?.coverage?.pagesRead || 0
      });
      return false;
    }
    if (msg?.type === 'TOGGLE_PANEL') {
      if (!ui) {
        state.pageKey = '';
        scan({ auto: false }).then(() => respond({ ok: Boolean(ui) }));
        return true;
      }
      if (state.closed) {
        state.closed = false;
        state.collapsed = false;
        buildUi().then(render);
      } else {
        state.collapsed = !state.collapsed;
        chrome.storage.local.set({ panelCollapsed: state.collapsed });
        render();
      }
      respond({ ok: true });
      return false;
    }
    if (msg?.type === 'TRIGGER_SCAN') {
      state.pageKey = '';
      state.dismissed.clear();
      scan({ auto: false }).then(() => {
        if (!ui) respond({ ok: false, error: 'Auf dieser Seite wurde kein Fahrzeug-PDF gefunden.' });
        else {
          runAnalysis({ force: Boolean(msg.force) });
          respond({ ok: true });
        }
      });
      return true;
    }
    return false;
  });

  scheduleScan();
})();
