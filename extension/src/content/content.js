/* eslint-env browser */
/**
 * Content-Script: erkennt Fahrzeugseiten + PDF-Links, lädt die PDFs mit der
 * Session der Seite herunter und zeigt das Ergebnis in einem Panel oben rechts.
 */
(() => {
  if (window.__vmsInjected) return;
  window.__vmsInjected = true;

  const MAX_DOCS = 3;
  const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;

  const CONDITION_WORDS = [
    'zustandsbericht', 'zustandsberichte', 'appraisal', 'gutachten', 'prüfbericht',
    'pruefbericht', 'schadenbericht', 'schadensbericht', 'condition report',
    'inspection report', 'damage report', 'schadensgutachten'
  ];
  const DATASHEET_WORDS = [
    'fahrzeug pdf', 'fahrzeugpdf', 'vehicle pdf', 'datenblatt', 'exposé', 'expose',
    'fahrzeugdaten', 'car pdf', 'fahrzeugschein'
  ];

  const state = {
    settings: null,
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
    scrolled: false,
    closed: false,
    theme: 'auto'
  };

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
    const raw =
      el.getAttribute('href') ||
      el.dataset?.href ||
      el.dataset?.url ||
      el.getAttribute('data-download-url') ||
      '';
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return null;
    try {
      const url = new URL(raw, location.href);
      if (!/^https?:$/.test(url.protocol)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function classify(el, url) {
    const haystack = lower(
      [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.className, url].join(' ')
    ).slice(0, 400);

    for (const w of CONDITION_WORDS) if (haystack.includes(w)) return { kind: 'condition', score: 100, word: w };
    for (const w of DATASHEET_WORDS) if (haystack.includes(w)) return { kind: 'datasheet', score: 70, word: w };

    const extra = (state.settings?.keywords || []).filter(
      (k) => k && ![...CONDITION_WORDS, ...DATASHEET_WORDS].includes(k)
    );
    for (const w of extra) if (w && haystack.includes(lower(w))) return { kind: 'custom', score: 60, word: w };

    const path = url.split('?')[0].toLowerCase();
    if (path.endsWith('.pdf')) return { kind: 'pdf', score: 40, word: '.pdf' };
    if (/[?&/](pdf|document|report)[=/]/.test(url.toLowerCase()) && /pdf/i.test(haystack)) {
      return { kind: 'pdf', score: 30, word: 'pdf' };
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
        /(?:Fahrgestellnummer|FIN|VIN|Chassis)[^A-HJ-NPR-Z0-9]{0,10}([A-HJ-NPR-Z0-9]{17})/i
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
    if (docs.some((d) => d.kind === 'condition')) return true;
    const signals = [ctx.vin, ctx.erstzulassung, ctx.kilometer, ctx.inventarnummer].filter(Boolean);
    return signals.length >= 2 || (Boolean(ctx.vin) && docs.length > 0);
  }

  /* ------------------------------------------------------------- Download */

  async function fetchPdfInPage(url) {
    try {
      const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
      if (!res.ok) return null;
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const buf = await res.arrayBuffer();
      const head = String.fromCharCode.apply(null, new Uint8Array(buf.slice(0, 512)));

      if (head.includes('%PDF-')) return { base64: toBase64(buf), bytes: buf.byteLength };

      if (type.includes('html')) {
        const nested = findPdfInHtml(new TextDecoder().decode(buf), url);
        if (nested && nested !== url) return fetchPdfInPage(nested);
      }
      return null;
    } catch {
      return null; // z.B. CORS -> Hintergrund versucht es erneut
    }
  }

  function findPdfInHtml(html, baseUrl) {
    const patterns = [
      /<iframe[^>]+src=["']([^"']+\.pdf[^"']*)["']/i,
      /<embed[^>]+src=["']([^"']+\.pdf[^"']*)["']/i,
      /<a[^>]+href=["']([^"']+\.pdf[^"']*)["']/i,
      /["'](https?:\/\/[^"']+\.pdf[^"']*)["']/i
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) {
        try {
          return new URL(m[1], baseUrl).href;
        } catch {
          /* ignore */
        }
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
    render();

    const payloadDocs = [];
    for (const doc of state.docs) {
      pushStep('download', `Lade ${doc.label}`);
      const fetched = await fetchPdfInPage(doc.url);
      payloadDocs.push({ ...doc, base64: fetched?.base64 || null, bytes: fetched?.bytes || 0 });
      completeStep('download', fetched ? `${doc.label} geladen` : `${doc.label} (Download über Hintergrund)`);
    }

    pushStep('ai', 'KI analysiert Dokumente');
    const res = await send({
      type: 'ANALYZE',
      payload: { pageContext: state.context, docs: payloadDocs, force }
    });

    if (res.ok) {
      state.result = res.result;
      state.status = 'done';
      state.progressPct = 100;
      completeStep('synthesis', 'Bewertung fertig');
      completeStep('ai', 'Analyse fertig');
    } else {
      state.error = { message: res.error, code: res.code };
      state.status = 'error';
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
    }
  }

  /** Kleine Pille, mit der sich das geschlossene Panel zurückholen lässt. */
  function showPill() {
    if (!ui) return;
    const r = state.result;
    const meta = r ? VERDICT_META[r.verdict?.recommendation] || VERDICT_META.unklar : null;
    ui.root.className = 'vms-pill';
    ui.root.removeAttribute('style');
    ui.root.innerHTML = `
      <button class="vms-pill-btn ${meta ? meta.tone : 'muted'}" data-act="restore"
        title="Autosmaya wieder öffnen">
        ${carIcon()}
        ${r ? `<span>${meta.label}</span>` : '<span>Autosmaya</span>'}
        ${r?.counts?.kritisch ? `<span class="vms-pill-count">${r.counts.kritisch}</span>` : ''}
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

  function render() {
    if (!ui) return;
    const { root } = ui;
    root.dataset.status = state.status;
    if (state.theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = state.theme;
    root.classList.toggle('scrolled', state.scrolled);
    root.classList.toggle('collapsed', Boolean(state.collapsed));
    root.innerHTML =
      header() +
      (state.collapsed ? '' : body() + footer()) +
      (state.collapsed ? '' : '<div class="vms-resize" title="Größe ändern" aria-hidden="true"></div>');
    attachDrag();
    attachResize();
    attachScroll();
    attachSearch();
    animateScore();
    applySize();
  }

  /** Score-Ring erst nach dem Einfügen animieren, damit der Übergang läuft. */
  function animateScore() {
    const ring = ui?.root.querySelector('.vms-ring-value');
    if (!ring) return;
    const target = Number(ring.dataset.offset);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ring.style.strokeDashoffset = String(target);
    }));
  }

  function header() {
    const r = state.result;
    const crit = r?.counts?.kritisch || 0;
    const total = r?.defects?.length || 0;
    let badge = '';
    if (state.status === 'done') {
      const v = r?.verdict?.recommendation;
      const meta = VERDICT_META[v];
      badge = meta
        ? `<span class="vms-badge ${meta.tone}" title="${meta.label}${
            typeof r.verdict?.score === 'number' ? ` (Zustands-Score ${r.verdict.score}/100)` : ''
          }">${
            state.collapsed
              ? `${meta.label}${typeof r.verdict?.score === 'number' ? ` · ${r.verdict.score}` : ''}`
              : meta.short
          }</span>`
        : total
          ? `<span class="vms-badge ${crit ? 'bad' : 'warn'}">${total} Mängel</span>`
          : '<span class="vms-badge good">Keine Mängel</span>';
    } else if (state.status === 'busy') {
      badge = '<span class="vms-badge busy">Prüft…</span>';
    } else if (state.status === 'error') {
      badge = '<span class="vms-badge bad">Fehler</span>';
    }

    // Der Seitentitel gehört zum Fahrzeug, das der Nutzer gerade ansieht - er hat Vorrang
    // vor dem Titel aus dem Dokument.
    const title = esc(state.context.titel || state.result?.vehicle?.title || 'Fahrzeug-Check');
    const sub = [state.context.vin, state.context.kilometer].filter(Boolean).map(esc).join(' · ');

    return `
      <header class="vms-head" data-drag>
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
      </header>
      ${state.status === 'done' ? stickyBar() : ''}`;
  }

  /** Kompakte Leiste, die beim Scrollen einblendet, damit das Urteil sichtbar bleibt. */
  function stickyBar() {
    const r = state.result;
    const v = r?.verdict || {};
    const meta = VERDICT_META[v.recommendation] || VERDICT_META.unklar;
    const crit = r?.counts?.kritisch || 0;
    return `
      <div class="vms-sticky ${meta.tone}">
        <span class="vms-sticky-dot"></span>
        <span class="vms-sticky-label">${meta.label}</span>
        ${typeof v.score === 'number' ? `<span class="vms-sticky-score">${v.score}</span>` : ''}
        <span class="vms-sticky-counts">${r.defects.length} Mängel${crit ? `, ${crit} kritisch` : ''}</span>
        <button class="vms-sticky-top" data-act="scroll-top" title="Nach oben">${chevronUp()}</button>
      </div>`;
  }

  function body() {
    if (state.status === 'busy') return busyBody();
    if (state.status === 'error') return errorBody();
    if (state.status === 'done') return resultBody();
    return idleBody();
  }

  function idleBody() {
    return `
      <div class="vms-body">
        <div class="vms-docs">
          ${state.docs
            .map(
              (d, i) => `<div class="vms-doc" style="--i:${i}"><span class="vms-dot ${d.kind}"></span>
                <span class="vms-doc-label">${esc(d.label)}</span>
                <button class="vms-link" data-act="open-doc" data-url="${esc(d.url)}">öffnen</button></div>`
            )
            .join('')}
        </div>
        <button class="vms-primary" data-act="run">${searchIcon()}<span>Mängel prüfen</span></button>
      </div>`;
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
    return `<div class="vms-body">
      <div class="vms-progress">
        <div class="vms-progress-bar ${pct === null ? 'indeterminate' : ''}" ${pct !== null ? `style="width:${pct}%"` : ''}></div>
      </div>
      <ul class="vms-steps">${steps}</ul>
    </div>`;
  }

  function errorBody() {
    const noKey = state.error?.code === 'NO_API_KEY';
    return `
      <div class="vms-body">
        <div class="vms-error">${alertIcon()}<span>${esc(state.error?.message || 'Unbekannter Fehler')}</span></div>
        <div class="vms-row">
          ${noKey
            ? '<button class="vms-primary" data-act="options"><span>API-Key eintragen</span></button>'
            : '<button class="vms-primary" data-act="rerun"><span>Erneut versuchen</span></button>'}
          ${noKey ? '' : '<button class="vms-ghost" data-act="options">Einstellungen</button>'}
        </div>
      </div>`;
  }

  function resultBody() {
    const r = state.result;
    const v = r.verdict || {};

    if (!r.report_found && !r.defects.length) {
      return `<div class="vms-body">
        ${verdictBlock(v, r)}
        <div class="vms-empty">${checkBig()}<div><strong>Keine Mängel dokumentiert</strong>
        <p>${esc(r.summary || 'Im PDF stehen keine Zustands- oder Mängelangaben.')}</p></div></div>
        ${coverageBlock()}
      </div>`;
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
      <div class="vms-body">
        ${verdictBlock(v, r)}
        ${calcBlock(r)}
        ${listBlock(v.deal_breakers, 'bad', alertIcon(), 'Ausschlusskriterien')}
        ${listBlock(v.before_first_drive, 'warn', wrenchIcon(), 'Vor der ersten Fahrt')}
        ${r.summary ? `<p class="vms-lead">${esc(r.summary)}</p>` : ''}
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
        ${negotiationBlock(v)}
        ${tiresBlock(r)}
        ${r.missing_info?.length ? `<div class="vms-missing"><strong>Nicht im Dokument:</strong> ${esc(r.missing_info.join(', '))}</div>` : ''}
        ${coverageBlock()}
      </div>`;
  }

  function verdictBlock(v, r) {
    const meta = VERDICT_META[v.recommendation] || VERDICT_META.unklar;
    const cond = r.overall_condition && r.overall_condition !== 'unbekannt'
      ? `<span class="vms-cond ${condClass(r.overall_condition)}">${esc(r.overall_condition)}</span>`
      : '';
    const budget = budgetText(v, r);

    return `
      <section class="vms-verdict ${meta.tone}">
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
          ${cond}
          ${budget ? `<span class="vms-budget">${budget}</span>` : ''}
          ${r.confidence !== null ? `<span class="vms-conf" title="Sicherheit der Auswertung">Sicherheit ${Math.round((r.confidence || 0) * 100)} %</span>` : ''}
        </div>
      </section>`;
  }

  function budgetText(v, r) {
    const min = v.repair_budget_min_eur ?? r.total_estimated_repair_cost_eur;
    const max = v.repair_budget_max_eur;
    if (typeof min !== 'number') return '';
    if (typeof max === 'number' && max > min) {
      return `Reparatur lt. Dokument <b>${esc(fmtCost(min))} – ${esc(fmtCost(max))}</b>`;
    }
    return `Reparatur lt. Dokument <b>${esc(fmtCost(min))}</b>`;
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

  function calcBlock(r) {
    const n = computeNumbers(r, state.context);
    if (n.documented === null && n.price === null && !n.reportTotal) return '';

    const row = (label, value, hint, cls = '') =>
      `<div class="vms-calc-row ${cls}">
         <span class="vms-calc-label">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>
         <span class="vms-calc-value">${value}</span>
       </div>`;

    const repairRows = [];
    if (n.documented !== null) {
      repairRows.push(
        row(
          'Reparatur belegt',
          esc(fmtCost(n.documented)),
          `${n.documentedCount} von ${n.totalCount} Positionen beziffert`
        )
      );
    }
    if (n.reportTotal !== null && n.reportTotal !== n.documented) {
      repairRows.push(row('Summe laut Dokument', esc(fmtCost(n.reportTotal))));
    }
    if (n.urgent !== null) {
      repairRows.push(
        row(
          'davon sicherheitsrelevant',
          esc(fmtCost(n.urgent)),
          n.urgentOpen ? `+ ${n.urgentOpen} Position(en) ohne Betrag` : '',
          'urgent'
        )
      );
    }
    if (n.withoutAmount) {
      repairRows.push(
        row('Ohne Betrag im Dokument', `${n.withoutAmount} Position${n.withoutAmount > 1 ? 'en' : ''}`, '', 'open')
      );
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

    return `
      <section class="vms-calc">
        <div class="vms-calc-head">${calcIcon()}<strong>Berechnet</strong>
          <span class="vms-calc-note">nur belegte Beträge</span></div>
        ${repairRows.join('')}
        ${repairRows.length && priceRows.length ? '<div class="vms-calc-sep"></div>' : ''}
        ${priceRows.join('')}
      </section>`;
  }

  function listBlock(items, tone, icon, title) {
    if (!items?.length) return '';
    return `
      <section class="vms-callout ${tone}">
        <div class="vms-callout-head">${icon}<strong>${title}</strong></div>
        <ul>${items.map((x, i) => `<li style="--i:${i}">${esc(x)}</li>`).join('')}</ul>
      </section>`;
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
            .map(
              (p) =>
                `<li><span>${esc(p.point)}</span>${p.amount_eur ? `<b>${esc(fmtCost(p.amount_eur))}</b>` : ''}</li>`
            )
            .join('')}
        </ul>
      </details>`;
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

  function condClass(c) {
    return ({ 'sehr gut': 'good', gut: 'good', befriedigend: 'mid', mangelhaft: 'bad' })[c] || 'unknown';
  }

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
          ${state.status === 'done' ? '<button class="vms-ghost sm" data-act="copy">Kopieren</button>' : ''}
          ${state.status === 'done' ? '<button class="vms-ghost sm" data-act="rerun" title="Cache umgehen und neu auswerten">Neu</button>' : ''}
          <button class="vms-ghost sm" data-act="options">Einstellungen</button>
        </span>
      </footer>`;
  }

  /* ------------------------------------------------------- Interaktionen */

  /** Blendet die Urteilsleiste ein, sobald der Empfehlungsblock weggescrollt ist. */
  function attachScroll() {
    const body = ui.root.querySelector('.vms-body');
    if (!body) return;
    body.scrollTop = state.scrollTop || 0;
    body.addEventListener('scroll', () => {
      state.scrollTop = body.scrollTop;
      const scrolled = body.scrollTop > 90;
      if (scrolled !== state.scrolled) {
        state.scrolled = scrolled;
        ui.root.classList.toggle('scrolled', scrolled);
      }
    });
  }

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

  /* ----------------------------------------------------------------- Boot */

  async function scan({ auto = true } = {}) {
    const res = await send({ type: 'GET_SETTINGS' });
    if (!res.ok) return;
    state.settings = res.settings;
    state.collapsed = state.settings.panelCollapsed;
    state.theme = state.settings.panelTheme || 'auto';
    state.size = state.settings.panelSize || null;

    if (!hostAllowed(state.settings, location.hostname)) return;

    const docs = findDocuments();
    if (!docs.length) return;
    const ctx = scrapeContext();
    if (!isVehiclePage(docs, ctx)) return;

    const key = `${location.href}|${docs.map((d) => d.url).join(',')}`;
    if (key === state.pageKey && ui) return;
    state.pageKey = key;
    state.docs = docs;
    state.context = ctx;
    state.result = null;
    state.error = null;
    state.status = 'idle';

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

  function hostAllowed(settings, hostname) {
    const host = (hostname || '').toLowerCase();
    const match = (list) =>
      (list || []).some((entry) => {
        const e = String(entry).trim().toLowerCase().replace(/^\*\./, '');
        return e && (host === e || host.endsWith('.' + e));
      });
    if (settings.domainMode === 'allowlist') return match(settings.allowlist);
    if (settings.domainMode === 'blocklist') return !match(settings.blocklist);
    return true;
  }

  let lastScanAt = 0;
  const SCAN_COOLDOWN_MS = 2500;

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
