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
    dismissed: new Set()
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
        found.set(url, { url, label: label.slice(0, 60), kind: hit.kind, score: hit.score });
      }
    }
    return [...found.values()]
      .filter((d) => !state.dismissed.has(d.url))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_DOCS);
  }

  /** Liest Label/Wert-Paare (Tabellen, Definitionslisten, Grid-Layouts) aus. */
  function scrapeContext() {
    const wanted = {
      vin: ['fahrgestellnummer', 'fin', 'vin', 'chassis'],
      erstzulassung: ['erstzulassung', 'first registration', 'ez'],
      kilometer: ['km-stand', 'kilometerstand', 'laufleistung', 'mileage', 'km'],
      inventarnummer: ['inventarnummer', 'inventory', 'lagernummer'],
      kraftstoff: ['kraftstoff', 'fuel'],
      getriebe: ['getriebe', 'transmission']
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
    state.steps = [{ key: 'scan', label: `${state.docs.length} Dokument(e) gefunden`, done: true }];
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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'PROGRESS') return;
    if (msg.step === 'parse') {
      pushStep('parse', msg.detail?.cached ? 'Text aus Cache' : `Lese PDF-Text (${msg.detail?.label || ''})`);
      completeStep('parse');
    }
    if (msg.step === 'ai') {
      pushStep('ai', `KI analysiert (${msg.detail?.mode === 'vision' ? 'Scan/Bilderkennung' : 'Text'})`);
    }
    if (msg.step === 'cached') {
      completeStep('ai', 'Ergebnis aus Cache (0 Kosten)');
    }
  });

  /* ------------------------------------------------------------------- UI */

  async function buildUi() {
    if (ui) return ui;
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
      state.docs.forEach((d) => state.dismissed.add(d.url));
      ui.host.remove();
      ui = null;
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
      card.classList.toggle('open');
    } else if (act === 'open-doc') {
      window.open(btn.dataset.url, '_blank', 'noopener');
    }
  }

  function copyResult(btn) {
    const r = state.result;
    if (!r) return;
    const lines = [
      r.vehicle?.title || state.context.titel || 'Fahrzeug',
      state.context.vin ? `FIN: ${state.context.vin}` : '',
      `Zustand: ${r.overall_condition}`,
      r.summary,
      '',
      ...r.defects.map(
        (d, i) =>
          `${i + 1}. [${d.severity.toUpperCase()}] ${d.title}${d.area ? ` (${d.area})` : ''}` +
          `${d.estimated_cost_eur ? ` - ${fmtCost(d.estimated_cost_eur)}` : ''}\n   ${d.description}`
      )
    ].filter(Boolean);
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      btn.textContent = 'Kopiert';
      setTimeout(() => (btn.textContent = 'Kopieren'), 1500);
    });
  }

  /* --------------------------------------------------------------- Render */

  const SEV_LABEL = { kritisch: 'Kritisch', mittel: 'Mittel', gering: 'Gering', hinweis: 'Hinweis' };

  function render() {
    if (!ui) return;
    const { root } = ui;
    root.dataset.status = state.status;
    root.classList.toggle('collapsed', Boolean(state.collapsed));
    root.innerHTML = header() + (state.collapsed ? '' : body() + footer());
    attachDrag();
  }

  function header() {
    const r = state.result;
    const crit = r?.counts?.kritisch || 0;
    const total = r?.defects?.length || 0;
    let badge = '';
    if (state.status === 'done') {
      badge = total
        ? `<span class="vms-badge ${crit ? 'crit' : 'warn'}">${total} Mängel</span>`
        : '<span class="vms-badge ok">Keine Mängel</span>';
    } else if (state.status === 'busy') {
      badge = '<span class="vms-badge busy">Prüft…</span>';
    } else if (state.status === 'error') {
      badge = '<span class="vms-badge crit">Fehler</span>';
    }

    const title = esc(state.result?.vehicle?.title || state.context.titel || 'Fahrzeug-Check');
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
          <button class="vms-icon" data-act="collapse" aria-label="Ein-/Ausklappen" title="Ein-/Ausklappen">${state.collapsed ? chevronDown() : chevronUp()}</button>
          <button class="vms-icon" data-act="close" aria-label="Schließen" title="Schließen">${xIcon()}</button>
        </div>
      </header>`;
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
              (d) => `<div class="vms-doc"><span class="vms-dot ${d.kind}"></span>
                <span class="vms-doc-label">${esc(d.label)}</span>
                <button class="vms-link" data-act="open-doc" data-url="${esc(d.url)}">öffnen</button></div>`
            )
            .join('')}
        </div>
        <button class="vms-primary" data-act="run">Mängel prüfen</button>
      </div>`;
  }

  function busyBody() {
    const steps = state.steps
      .map(
        (s) =>
          `<li class="${s.done ? 'done' : 'active'}"><span class="vms-step-icon">${s.done ? checkIcon() : '<span class="vms-spin"></span>'}</span>${esc(s.label)}</li>`
      )
      .join('');
    return `<div class="vms-body"><div class="vms-progress"><div class="vms-progress-bar"></div></div><ul class="vms-steps">${steps}</ul></div>`;
  }

  function errorBody() {
    const noKey = state.error?.code === 'NO_API_KEY';
    return `
      <div class="vms-body">
        <div class="vms-error">${esc(state.error?.message || 'Unbekannter Fehler')}</div>
        <div class="vms-row">
          ${noKey ? '<button class="vms-primary" data-act="options">API-Key eintragen</button>' : '<button class="vms-primary" data-act="rerun">Erneut versuchen</button>'}
          ${noKey ? '' : '<button class="vms-ghost" data-act="options">Einstellungen</button>'}
        </div>
      </div>`;
  }

  function resultBody() {
    const r = state.result;
    if (!r.report_found && !r.defects.length) {
      return `<div class="vms-body">
        <div class="vms-empty">${checkBig()}<div><strong>Keine Mängel dokumentiert</strong>
        <p>${esc(r.summary || 'Im PDF stehen keine Zustands- oder Mängelangaben.')}</p></div></div>
        <div class="vms-row"><button class="vms-ghost" data-act="rerun">Neu analysieren</button></div>
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

    const visible = r.defects.filter((d) => state.filter === 'alle' || d.severity === state.filter);
    const cost = fmtCost(r.total_estimated_repair_cost_eur);

    return `
      <div class="vms-body">
        <div class="vms-summary">
          <span class="vms-cond ${condClass(r.overall_condition)}">${esc(r.overall_condition)}</span>
          ${cost ? `<span class="vms-cost">Reparatur lt. Dokument: <b>${esc(cost)}</b></span>` : ''}
          ${r.confidence !== null ? `<span class="vms-conf" title="Sicherheit der Auswertung">${Math.round((r.confidence || 0) * 100)}%</span>` : ''}
        </div>
        ${r.summary ? `<p class="vms-lead">${esc(r.summary)}</p>` : ''}
        <div class="vms-chips">${chips}</div>
        <div class="vms-list">${visible.map(defectCard).join('')}</div>
        ${tiresBlock(r)}
        ${r.missing_info?.length ? `<div class="vms-missing"><strong>Nicht im Dokument:</strong> ${esc(r.missing_info.join(', '))}</div>` : ''}
      </div>`;
  }

  function defectCard(d) {
    const cost = fmtCost(d.estimated_cost_eur);
    return `
      <article class="vms-defect ${d.severity}">
        <button class="vms-defect-head" data-act="toggle-defect">
          <span class="vms-sev" title="${SEV_LABEL[d.severity]}"></span>
          <span class="vms-defect-title">${esc(d.title)}</span>
          ${d.affects_roadworthiness ? '<span class="vms-tag tuv" title="HU/TÜV-relevant">TÜV</span>' : ''}
          ${cost ? `<span class="vms-tag cost">${esc(cost)}</span>` : ''}
          <span class="vms-caret">${chevronDown()}</span>
        </button>
        <div class="vms-defect-body">
          <p>${esc(d.description)}</p>
          <div class="vms-meta">
            ${d.area ? `<span>${esc(d.area)}</span>` : ''}
            <span class="vms-cat">${esc(d.category)}</span>
            ${d.source_page ? `<span>Seite ${d.source_page}</span>` : ''}
          </div>
          ${d.quote ? `<blockquote>„${esc(d.quote)}“</blockquote>` : ''}
        </div>
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
    return `<details class="vms-tires"><summary>Reifen (${r.tires.length})</summary>
      <table><thead><tr><th>Pos.</th><th>Größe</th><th>Profil</th><th>Notiz</th></tr></thead><tbody>${rows}</tbody></table></details>`;
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
      }
      if (meta.mode === 'vision') bits.push('Scan-Modus');
    }
    return `
      <footer class="vms-foot">
        <span class="vms-meta-line">${bits.join(' · ')}</span>
        <span class="vms-foot-actions">
          ${state.status === 'done' ? '<button class="vms-ghost sm" data-act="copy">Kopieren</button>' : ''}
          ${state.status === 'done' ? '<button class="vms-ghost sm" data-act="rerun" title="Cache umgehen">Neu</button>' : ''}
          <button class="vms-ghost sm" data-act="options">Einstellungen</button>
        </span>
      </footer>`;
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
  const checkBig = () =>
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>';

  /* ----------------------------------------------------------------- Boot */

  async function scan({ auto = true } = {}) {
    const res = await send({ type: 'GET_SETTINGS' });
    if (!res.ok) return;
    state.settings = res.settings;
    state.collapsed = state.settings.panelCollapsed;

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

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
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
