/**
 * Service Worker: Orchestriert PDF-Download, Text-Extraktion (Offscreen) und KI-Analyse.
 *
 * Vollständigkeit hat Vorrang: Es werden alle Seiten gelesen, und passt ein
 * Dokument nicht in einen Aufruf, wird es in Teilen ausgewertet und danach
 * zusammengeführt - statt Text wegzuwerfen.
 */

import { getSettings, setSettings, DEFAULTS } from './lib/config.js';
import {
  DEFECT_SCHEMA,
  CHUNK_SCHEMA,
  SYNTHESIS_SCHEMA,
  PROMPT_VERSION,
  systemPrompt,
  userPrompt,
  chunkPrompt,
  synthesisPrompt,
  visionUserPrompt,
  splitIntoChunks
} from './lib/prompt.js';
import { chat, parseJsonLoose, testKey, OpenRouterError } from './lib/openrouter.js';
import * as cache from './lib/cache.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const CHUNK_CONCURRENCY = 3;

let offscreenReady = null;
const running = new Map(); // tabId -> AbortController
const parseWatchers = new Map(); // requestId -> callback
let keepAliveTimer = null;

/* ---------------------------------------------------------------- Offscreen */

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length) return true;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WORKERS', 'DOM_PARSER'],
        justification: 'PDF-Dokumente mit pdf.js auslesen und Seiten rendern.'
      });
    } catch (err) {
      if (!/single offscreen|already exists/i.test(String(err))) throw err;
    }
    return true;
  })();
  try {
    return await offscreenReady;
  } catch (err) {
    offscreenReady = null;
    throw err;
  }
}

async function parseInOffscreen(payload, onProgress) {
  await ensureOffscreen();
  const requestId = crypto.randomUUID();
  if (onProgress) parseWatchers.set(requestId, onProgress);
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'PARSE_PDF',
      payload: { ...payload, requestId }
    });
    if (!res) throw new Error('Offscreen-Dokument antwortet nicht.');
    if (!res.ok) throw new Error(res.error || 'PDF konnte nicht gelesen werden.');
    return res.data;
  } finally {
    parseWatchers.delete(requestId);
  }
}

/* ------------------------------------------------------------- Keep-Alive */

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => chrome.storage.local.get('keepalive'), 20000);
}
function stopKeepAlive() {
  if (running.size) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/* ----------------------------------------------------------------- Fetching */

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function looksLikePdf(buffer) {
  const head = new Uint8Array(buffer.slice(0, 1024));
  return String.fromCharCode.apply(null, head).includes('%PDF-');
}

/** Fallback-Download im Hintergrund (kein CORS, dafür evtl. ohne Session-Cookies). */
async function fetchPdfInBackground(url, signal) {
  const res = await fetch(url, { credentials: 'include', signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}).`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_PDF_BYTES) throw new Error('PDF ist zu groß (> 25 MB).');
  if (!looksLikePdf(buf)) {
    const type = res.headers.get('content-type') || 'unbekannt';
    throw new Error(`Antwort ist kein PDF (Content-Type: ${type}).`);
  }
  return { base64: bytesToBase64(buf), bytes: buf.byteLength, finalUrl: res.url };
}

/* ---------------------------------------------------------- Normalisierung */

const SEVERITY_ORDER = { kritisch: 0, mittel: 1, gering: 2, hinweis: 3 };

function normalizeDefect(d) {
  return {
    title: String(d.title || d.description).slice(0, 120),
    description: String(d.description || '').slice(0, 600),
    area: d.area ? String(d.area).slice(0, 120) : '',
    category: d.category || 'sonstiges',
    severity: SEVERITY_ORDER[d.severity] !== undefined ? d.severity : 'hinweis',
    estimated_cost_eur: typeof d.estimated_cost_eur === 'number' ? d.estimated_cost_eur : null,
    affects_roadworthiness: Boolean(d.affects_roadworthiness),
    source_page: Number.isInteger(d.source_page) ? d.source_page : null,
    quote: d.quote ? String(d.quote).slice(0, 200) : null
  };
}

const dedupeKey = (d) =>
  `${d.title} ${d.area}`
    .toLowerCase()
    .replace(/[^a-z0-9äöüß ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function mergeDefects(lists) {
  const seen = new Map();
  for (const d of lists.flat()) {
    if (!d || (!d.title && !d.description)) continue;
    const clean = normalizeDefect(d);
    const key = dedupeKey(clean);
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, clean);
      continue;
    }
    // Bei Dubletten den informativeren Eintrag behalten
    const better =
      SEVERITY_ORDER[clean.severity] < SEVERITY_ORDER[prev.severity] ||
      (clean.description.length > prev.description.length && clean.severity === prev.severity)
        ? clean
        : prev;
    better.estimated_cost_eur = better.estimated_cost_eur ?? prev.estimated_cost_eur ?? clean.estimated_cost_eur;
    better.quote = better.quote || prev.quote || clean.quote;
    better.source_page = better.source_page ?? prev.source_page ?? clean.source_page;
    seen.set(key, better);
  }
  return [...seen.values()].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );
}

const RECOMMENDATIONS = ['kaufen', 'kaufen_mit_vorbehalt', 'nachverhandeln', 'finger_weg', 'unklar'];

function normalizeVerdict(v) {
  if (!v || !RECOMMENDATIONS.includes(v.recommendation)) {
    return {
      recommendation: 'unklar',
      score: null,
      headline: 'Für eine Empfehlung reichen die Angaben im Dokument nicht aus.',
      reasons: [],
      deal_breakers: [],
      negotiation_points: [],
      before_first_drive: [],
      repair_budget_min_eur: null,
      repair_budget_max_eur: null,
      price_assessment: null
    };
  }

  let score = Number.isFinite(v.score) ? Math.round(v.score) : null;
  if (score !== null) score = Math.min(100, Math.max(0, score));

  return {
    recommendation: v.recommendation,
    score,
    headline: String(v.headline || '').slice(0, 240),
    reasons: (Array.isArray(v.reasons) ? v.reasons : []).slice(0, 5).map((r) => String(r).slice(0, 220)),
    deal_breakers: (Array.isArray(v.deal_breakers) ? v.deal_breakers : [])
      .slice(0, 5)
      .map((r) => String(r).slice(0, 220)),
    negotiation_points: (Array.isArray(v.negotiation_points) ? v.negotiation_points : [])
      .slice(0, 6)
      .filter((p) => p && p.point)
      .map((p) => ({
        point: String(p.point).slice(0, 200),
        amount_eur: typeof p.amount_eur === 'number' ? p.amount_eur : null
      }))
      .sort((a, b) => (b.amount_eur || 0) - (a.amount_eur || 0)),
    before_first_drive: (Array.isArray(v.before_first_drive) ? v.before_first_drive : [])
      .slice(0, 5)
      .map((r) => String(r).slice(0, 200)),
    repair_budget_min_eur: typeof v.repair_budget_min_eur === 'number' ? v.repair_budget_min_eur : null,
    repair_budget_max_eur: typeof v.repair_budget_max_eur === 'number' ? v.repair_budget_max_eur : null,
    price_assessment: v.price_assessment ? String(v.price_assessment).slice(0, 300) : null
  };
}

function buildResult({ raw, defects, tires, missingInfo, vehicle, confidence }) {
  const counts = { kritisch: 0, mittel: 0, gering: 0, hinweis: 0 };
  let costSum = 0;
  let hasCost = false;
  for (const d of defects) {
    counts[d.severity]++;
    if (typeof d.estimated_cost_eur === 'number') {
      costSum += d.estimated_cost_eur;
      hasCost = true;
    }
  }

  return {
    vehicle: vehicle || {},
    report_found: raw?.report_found !== false,
    overall_condition: raw?.overall_condition || 'unbekannt',
    summary: String(raw?.summary || '').slice(0, 800),
    total_estimated_repair_cost_eur:
      typeof raw?.total_estimated_repair_cost_eur === 'number'
        ? raw.total_estimated_repair_cost_eur
        : hasCost
          ? Math.round(costSum)
          : null,
    defects,
    tires: (tires || []).slice(0, 10),
    missing_info: (missingInfo || []).slice(0, 8),
    confidence: typeof confidence === 'number' ? confidence : null,
    verdict: normalizeVerdict(raw?.verdict),
    counts
  };
}

function mergeUsage(list) {
  const usable = list.filter(Boolean);
  if (!usable.length) return null;
  return {
    promptTokens: usable.reduce((a, u) => a + (u.promptTokens || 0), 0),
    completionTokens: usable.reduce((a, u) => a + (u.completionTokens || 0), 0),
    cost: usable.reduce((a, u) => a + (u.cost || 0), 0)
  };
}

/* ------------------------------------------------------------------ Ablauf */

function progress(tabId, step, detail) {
  if (tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, { type: 'PROGRESS', step, detail }).catch(() => {});
}

/** Führt Aufgaben mit begrenzter Parallelität aus, Reihenfolge bleibt erhalten. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function analyze({ tabId, pageContext, docs, force }) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    const err = new Error('Kein OpenRouter API-Key hinterlegt.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  running.get(tabId)?.abort();
  running.set(tabId, controller);
  startKeepAlive();

  try {
    /* ---- 1. PDFs holen und vollständig auslesen ---- */
    const parsed = [];
    for (const doc of docs) {
      if (controller.signal.aborted) throw new Error('Abgebrochen.');
      progress(tabId, 'download', { label: doc.label });

      let base64 = doc.base64 || null;
      let bytes = doc.bytes || 0;
      if (!base64) {
        const dl = await fetchPdfInBackground(doc.url, controller.signal);
        base64 = dl.base64;
        bytes = dl.bytes;
      }

      const hash = await cache.sha256(base64);
      let extracted = settings.cacheEnabled && !force ? await cache.getText(hash) : null;

      if (extracted) {
        progress(tabId, 'parse', { label: doc.label, cached: true, pages: extracted.pageCount });
      } else {
        progress(tabId, 'parse', { label: doc.label, sizeKb: Math.round(bytes / 1024) });
        extracted = await parseInOffscreen(
          { base64, wantImages: settings.visionFallback, maxPages: settings.visionMaxPages },
          (detail) => progress(tabId, 'parse-progress', { label: doc.label, ...detail })
        );
        // Bilder sind zu groß für den Cache. Dokumente, die Bildseiten brauchen,
        // werden deshalb gar nicht zwischengespeichert - sonst käme der zweite Lauf
        // ohne Bilder in einem anderen Modus heraus und würde erneut Geld kosten.
        const needsImages = extracted.looksScanned || extracted.hasSparsePages;
        if (settings.cacheEnabled && !needsImages) await cache.putText(hash, extracted);
      }

      parsed.push({
        ...doc,
        hash,
        text: extracted.text || '',
        charCount: extracted.charCount || 0,
        pageCount: extracted.pageCount || 0,
        parsedPages: extracted.parsedPages || extracted.pageCount || 0,
        complete: extracted.complete !== false,
        sparsePages: extracted.sparsePages || [],
        looksScanned: Boolean(extracted.looksScanned),
        hasSparsePages: Boolean(extracted.hasSparsePages),
        images: extracted.images || [],
        imagePages: extracted.imagePages || []
      });
    }

    if (!parsed.length) throw new Error('Keine lesbaren PDFs gefunden.');

    /* ---- 2. Modus bestimmen ---- */
    const withText = parsed.filter((d) => d.charCount > 150);
    const totalChars = withText.reduce((a, d) => a + d.text.length, 0);
    // Deckel gilt über alle Dokumente zusammen, damit die Bildkosten planbar bleiben.
    const images = parsed.flatMap((d) => d.images).slice(0, settings.visionMaxPages);
    const imagePages = parsed.flatMap((d) => d.imagePages).slice(0, settings.visionMaxPages);

    let mode;
    if (!withText.length) {
      if (!images.length) {
        throw new Error(
          'PDF enthält keinen auslesbaren Text (Scan) und die Bild-Auswertung ist deaktiviert.'
        );
      }
      mode = 'vision';
    } else if (totalChars > settings.maxChars) {
      mode = 'chunked';
    } else if (images.length) {
      mode = 'hybrid';
    } else {
      mode = 'text';
    }

    const model = mode === 'vision' ? settings.visionModel : settings.model;
    const docHash = await cache.sha256(parsed.map((d) => d.hash).join('|'));
    const key = cache.resultKey({
      docHash,
      model,
      promptVersion: PROMPT_VERSION,
      lang: settings.outputLanguage,
      mode
    });

    if (settings.cacheEnabled && !force) {
      const hit = await cache.getResult(key);
      if (hit) {
        progress(tabId, 'cached', {});
        return { ...hit.result, meta: { ...hit.meta, fromCache: true } };
      }
    }

    const coverage = {
      documents: parsed.map((d) => ({
        label: d.label,
        url: d.url,
        pages: d.pageCount,
        pagesRead: d.parsedPages,
        chars: d.charCount,
        complete: d.complete,
        scanned: d.looksScanned,
        imagePages: d.imagePages
      })),
      pages: parsed.reduce((a, d) => a + d.pageCount, 0),
      pagesRead: parsed.reduce((a, d) => a + d.parsedPages, 0),
      chars: totalChars,
      complete: parsed.every((d) => d.complete)
    };

    /* ---- 3. Analyse ---- */
    const common = {
      apiKey: settings.apiKey,
      apiBase: settings.apiBase,
      model,
      signal: controller.signal
    };
    const usages = [];
    let result;
    let chunkCount = 1;

    if (mode === 'chunked') {
      const units = [];
      for (const doc of withText) {
        splitIntoChunks(doc.text, settings.maxChars).forEach((c) =>
          units.push({ label: doc.label, ...c })
        );
      }
      chunkCount = units.length;
      progress(tabId, 'ai', { model, mode, chunks: chunkCount, pages: coverage.pages });

      let finished = 0;
      const partials = await pool(units, CHUNK_CONCURRENCY, async (unit, i) => {
        const res = await chat({
          ...common,
          messages: [
            { role: 'system', content: systemPrompt(settings.outputLanguage, { withVerdict: false }) },
            {
              role: 'user',
              content: chunkPrompt({
                pageContext,
                label: unit.label,
                text: unit.text,
                index: i,
                total: units.length,
                pageRange: unit.pages
              })
            }
          ],
          schema: CHUNK_SCHEMA,
          maxTokens: 6000
        });
        usages.push(res.usage);
        progress(tabId, 'chunk', { done: ++finished, total: units.length });
        return parseJsonLoose(res.content);
      });

      const defects = mergeDefects(partials.map((p) => p?.defects || []));
      const tires = dedupeTires(partials.flatMap((p) => p?.tires || []));
      const missingInfo = [...new Set(partials.flatMap((p) => p?.missing_info || []))];
      const vehicle = {};
      for (const p of partials) {
        for (const [k, v] of Object.entries(p?.vehicle || {})) {
          if (vehicle[k] == null && v != null) vehicle[k] = v;
        }
      }
      const confidences = partials.map((p) => p?.confidence).filter((c) => typeof c === 'number');
      const confidence = confidences.length ? Math.min(...confidences) : null;

      progress(tabId, 'synthesis', { defects: defects.length });
      const syn = await chat({
        ...common,
        messages: [
          { role: 'system', content: systemPrompt(settings.outputLanguage) },
          {
            role: 'user',
            content: synthesisPrompt({
              pageContext,
              defects,
              tires,
              missingInfo,
              documents: coverage.documents
            })
          }
        ],
        schema: SYNTHESIS_SCHEMA,
        maxTokens: 3000
      });
      usages.push(syn.usage);
      const synthesis = parseJsonLoose(syn.content);

      const drop = new Set((synthesis.duplicate_indices || []).filter(Number.isInteger));
      const finalDefects = defects.filter((_, i) => !drop.has(i));

      result = buildResult({
        raw: {
          report_found: partials.some((p) => p?.report_found),
          overall_condition: synthesis.overall_condition,
          summary: synthesis.summary,
          total_estimated_repair_cost_eur: synthesis.total_estimated_repair_cost_eur,
          verdict: synthesis.verdict
        },
        defects: finalDefects,
        tires,
        missingInfo,
        vehicle,
        confidence
      });
    } else {
      progress(tabId, 'ai', { model, mode, pages: coverage.pages, images: images.length });

      const documents = withText.map((d) => ({
        label: d.label,
        pages: d.pageCount,
        text: d.text
      }));

      let userContent;
      if (mode === 'vision') {
        userContent = [
          { type: 'text', text: visionUserPrompt(pageContext) },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
        ];
      } else if (mode === 'hybrid') {
        userContent = [
          { type: 'text', text: userPrompt({ pageContext, documents }) },
          { type: 'text', text: visionUserPrompt(null, { partial: true, pages: imagePages }) },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
        ];
      } else {
        userContent = userPrompt({ pageContext, documents });
      }

      const res = await chat({
        ...common,
        messages: [
          { role: 'system', content: systemPrompt(settings.outputLanguage) },
          { role: 'user', content: userContent }
        ],
        schema: DEFECT_SCHEMA,
        maxTokens: 8000
      });
      usages.push(res.usage);

      const raw = parseJsonLoose(res.content);
      result = buildResult({
        raw,
        defects: mergeDefects([raw?.defects || []]),
        tires: dedupeTires(raw?.tires || []),
        missingInfo: raw?.missing_info || [],
        vehicle: raw?.vehicle,
        confidence: raw?.confidence
      });
    }

    const meta = {
      model,
      mode,
      chunks: chunkCount,
      usage: mergeUsage(usages),
      calls: usages.length,
      durationMs: Date.now() - startedAt,
      coverage,
      fromCache: false,
      ts: Date.now()
    };

    if (settings.cacheEnabled) {
      await cache.putResult(key, { result, meta });
      cache.trim(settings.cacheMaxEntries).catch(() => {});
    }

    return { ...result, meta };
  } finally {
    running.delete(tabId);
    stopKeepAlive();
  }
}

function dedupeTires(tires) {
  const byPos = new Map();
  for (const t of tires || []) {
    if (!t?.position) continue;
    const key = String(t.position).toUpperCase().trim();
    const prev = byPos.get(key);
    if (!prev || (prev.tread_mm == null && t.tread_mm != null)) byPos.set(key, t);
  }
  return [...byPos.values()];
}

/* ---------------------------------------------------------------- Messaging */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;

  if (msg?.type === 'OFFSCREEN_PROGRESS') {
    parseWatchers.get(msg.requestId)?.(msg.detail);
    return false;
  }

  const tabId = sender.tab?.id ?? msg?.tabId;

  switch (msg?.type) {
    case 'ANALYZE': {
      analyze({ tabId, ...msg.payload })
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: String(err?.message || err),
            code: err?.code || (err instanceof OpenRouterError ? 'API' : 'GENERIC')
          })
        );
      return true;
    }

    case 'ABORT':
      running.get(tabId)?.abort();
      running.delete(tabId);
      sendResponse({ ok: true });
      return false;

    case 'GET_SETTINGS':
      getSettings().then((s) => sendResponse({ ok: true, settings: s }));
      return true;

    case 'SET_SETTINGS':
      setSettings(msg.payload).then(() => sendResponse({ ok: true }));
      return true;

    case 'TEST_KEY':
      testKey(msg.payload.apiKey, msg.payload.model, msg.payload.apiBase)
        .then((r) => sendResponse({ ok: true, model: r.model, usage: r.usage }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;

    case 'CACHE_STATS':
      cache.stats().then((s) => sendResponse({ ok: true, stats: s }));
      return true;

    case 'CACHE_CLEAR':
      cache.clearAll().then((n) => sendResponse({ ok: true, removed: n }));
      return true;

    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (current[k] === undefined) patch[k] = v;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
