/**
 * Service Worker: Orchestriert PDF-Download, Text-Extraktion (Offscreen) und KI-Analyse.
 */

import { getSettings, setSettings, DEFAULTS } from './lib/config.js';
import {
  DEFECT_SCHEMA,
  PROMPT_VERSION,
  systemPrompt,
  userPrompt,
  visionUserPrompt,
  condenseText
} from './lib/prompt.js';
import { chat, parseJsonLoose, testKey, OpenRouterError } from './lib/openrouter.js';
import * as cache from './lib/cache.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const MAX_PDF_BYTES = 25 * 1024 * 1024;

let offscreenReady = null;
const running = new Map(); // tabId -> AbortController
let keepAliveTimer = null;

/* ---------------------------------------------------------------- Offscreen */

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
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

async function parseInOffscreen(payload) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PARSE_PDF', payload });
  if (!res) throw new Error('Offscreen-Dokument antwortet nicht.');
  if (!res.ok) throw new Error(res.error || 'PDF konnte nicht gelesen werden.');
  return res.data;
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
  const str = String.fromCharCode.apply(null, head);
  return str.includes('%PDF-');
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

/* ------------------------------------------------------------- KI-Analyse */

function normalizeAnalysis(raw) {
  const order = { kritisch: 0, mittel: 1, gering: 2, hinweis: 3 };
  const defects = Array.isArray(raw?.defects) ? raw.defects : [];
  const clean = defects
    .filter((d) => d && (d.title || d.description))
    .map((d) => ({
      title: String(d.title || d.description).slice(0, 120),
      description: String(d.description || '').slice(0, 600),
      area: d.area ? String(d.area).slice(0, 120) : '',
      category: d.category || 'sonstiges',
      severity: order[d.severity] !== undefined ? d.severity : 'hinweis',
      estimated_cost_eur: typeof d.estimated_cost_eur === 'number' ? d.estimated_cost_eur : null,
      affects_roadworthiness: Boolean(d.affects_roadworthiness),
      source_page: Number.isInteger(d.source_page) ? d.source_page : null,
      quote: d.quote ? String(d.quote).slice(0, 200) : null
    }))
    .sort((a, b) => order[a.severity] - order[b.severity]);

  const counts = { kritisch: 0, mittel: 0, gering: 0, hinweis: 0 };
  let costSum = 0;
  let hasCost = false;
  for (const d of clean) {
    counts[d.severity]++;
    if (typeof d.estimated_cost_eur === 'number') {
      costSum += d.estimated_cost_eur;
      hasCost = true;
    }
  }

  return {
    vehicle: raw?.vehicle || {},
    report_found: raw?.report_found !== false,
    overall_condition: raw?.overall_condition || 'unbekannt',
    summary: String(raw?.summary || '').slice(0, 800),
    total_estimated_repair_cost_eur:
      typeof raw?.total_estimated_repair_cost_eur === 'number'
        ? raw.total_estimated_repair_cost_eur
        : hasCost
          ? Math.round(costSum)
          : null,
    defects: clean,
    tires: Array.isArray(raw?.tires) ? raw.tires.slice(0, 8) : [],
    missing_info: Array.isArray(raw?.missing_info) ? raw.missing_info.slice(0, 8) : [],
    confidence: typeof raw?.confidence === 'number' ? raw.confidence : null,
    counts
  };
}

function progress(tabId, step, detail) {
  if (tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, { type: 'PROGRESS', step, detail }).catch(() => {});
}

async function analyze({ tabId, pageContext, docs, force }) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    const err = new Error('Kein OpenRouter API-Key hinterlegt.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const controller = new AbortController();
  running.get(tabId)?.abort();
  running.set(tabId, controller);
  startKeepAlive();

  try {
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
        progress(tabId, 'parse', { label: doc.label, cached: true });
      } else {
        progress(tabId, 'parse', { label: doc.label, sizeKb: Math.round(bytes / 1024) });
        extracted = await parseInOffscreen({
          base64,
          wantImages: settings.visionFallback,
          maxPages: settings.visionMaxPages
        });
        if (settings.cacheEnabled) {
          // Bilder nicht cachen (zu groß)
          await cache.putText(hash, { ...extracted, images: [] });
        }
      }

      parsed.push({
        ...doc,
        hash,
        text: extracted.text || '',
        charCount: extracted.charCount || 0,
        pageCount: extracted.pageCount || 0,
        looksScanned: Boolean(extracted.looksScanned),
        images: extracted.images || []
      });
    }

    if (!parsed.length) throw new Error('Keine lesbaren PDFs gefunden.');

    const usableText = parsed.filter((d) => d.charCount > 150);
    const mode = usableText.length ? 'text' : settings.visionFallback ? 'vision' : 'text';

    if (mode === 'vision' && !parsed.some((d) => d.images.length)) {
      throw new Error(
        'PDF enthält keinen auslesbaren Text (Scan) und die Bild-Auswertung ist deaktiviert.'
      );
    }

    const docHash = await cache.sha256(parsed.map((d) => d.hash).join('|'));
    const model = mode === 'vision' ? settings.visionModel : settings.model;
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

    progress(tabId, 'ai', { model, mode, pages: parsed.reduce((a, d) => a + d.pageCount, 0) });

    const perDocBudget = Math.floor(settings.maxChars / Math.max(1, usableText.length || 1));
    const documents = usableText.map((d) => {
      const c = condenseText(d.text, perDocBudget);
      return { label: d.label, pages: d.pageCount, text: c.text, truncated: c.truncated };
    });

    let messages;
    if (mode === 'vision') {
      const images = parsed.flatMap((d) => d.images).slice(0, settings.visionMaxPages);
      messages = [
        { role: 'system', content: systemPrompt(settings.outputLanguage) },
        {
          role: 'user',
          content: [
            { type: 'text', text: visionUserPrompt(pageContext) },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
          ]
        }
      ];
    } else {
      messages = [
        { role: 'system', content: systemPrompt(settings.outputLanguage) },
        { role: 'user', content: userPrompt({ pageContext, documents }) }
      ];
    }

    const res = await chat({
      apiKey: settings.apiKey,
      apiBase: settings.apiBase,
      model,
      messages,
      schema: DEFECT_SCHEMA,
      signal: controller.signal,
      maxTokens: 6000
    });

    const analysis = normalizeAnalysis(parseJsonLoose(res.content));
    const meta = {
      model: res.model,
      mode,
      usage: res.usage,
      durationMs: res.durationMs,
      documents: parsed.map((d) => ({
        label: d.label,
        url: d.url,
        pages: d.pageCount,
        chars: d.charCount,
        scanned: d.looksScanned
      })),
      truncated: documents.some((d) => d.truncated),
      fromCache: false,
      ts: Date.now()
    };

    if (settings.cacheEnabled) {
      await cache.putResult(key, { result: { ...analysis }, meta });
      cache.trim(settings.cacheMaxEntries).catch(() => {});
    }

    return { ...analysis, meta };
  } finally {
    running.delete(tabId);
    stopKeepAlive();
  }
}

/* ---------------------------------------------------------------- Messaging */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;

  const tabId = sender.tab?.id ?? msg?.tabId;

  switch (msg?.type) {
    case 'ANALYZE':
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
