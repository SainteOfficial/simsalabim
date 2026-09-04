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
  keepAliveTimer = setInterval(() => chrome.storage.local.get('keepalive'), 10000);
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

/** Findet PDF-URLs in einer HTML-Antwort (Viewer-Seite, Redirect o.Ä.). */
function findPdfInHtml(html, baseUrl) {
  if (!html) return null;

  // 1. Suche nach iframe, embed, object oder frame
  const frameMatches = [
    ...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi),
    ...html.matchAll(/<embed[^>]+src=["']([^"']+)["']/gi),
    ...html.matchAll(/<object[^>]+data=["']([^"']+)["']/gi),
    ...html.matchAll(/<frame[^>]+src=["']([^"']+)["']/gi)
  ];
  for (const m of frameMatches) {
    const src = m[1]?.trim();
    if (!src || src.startsWith('javascript:') || src.startsWith('about:') || NON_PDF_EXT.test(src) || NON_PDF_PATH.test(src)) continue;
    try {
      const resolved = new URL(src, baseUrl).href;
      if (resolved !== baseUrl && isProbablePdfUrl(resolved)) return resolved;
      if (resolved !== baseUrl && !NON_PDF_EXT.test(resolved) && !NON_PDF_PATH.test(resolved)) return resolved;
    } catch { /* ignore */ }
  }

  // 2. Suche nach Links zu Dokumenten, PDFs oder Download-Endpoints
  const linkMatches = [
    ...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi),
    ...html.matchAll(/["'](https?:\/\/[^"'\s<>]+?(?:\.pdf|GetDoc|GetPDF|ShowPDF|ViewPDF|Download|VehId=)[^"'\s<>]*)["']/gi),
    ...html.matchAll(/["'](\/[^"'\s<>]+?(?:\.pdf|GetDoc|GetPDF|ShowPDF|ViewPDF|VehId=)[^"'\s<>]*)["']/gi),
    ...html.matchAll(/<meta[^>]+content=["'][^"']*?url=([^"'\s;]+)["']/gi)
  ];
  for (const m of linkMatches) {
    const target = m[1]?.trim();
    if (!target || NON_PDF_EXT.test(target) || NON_PDF_PATH.test(target)) continue;
    if (isProbablePdfUrl(target)) {
      try {
        const resolved = new URL(target, baseUrl).href;
        if (resolved !== baseUrl) return resolved;
      } catch { /* ignore */ }
    }
  }

  // 3. JavaScript Weiterleitungen / Variablen
  const jsMatches = [
    ...html.matchAll(/(?:window\.location(?:\.href)?|location\.replace|location\.href)\s*=\s*["']([^"']+)["']/gi),
    ...html.matchAll(/(?:pdfUrl|documentUrl|fileUrl|docUrl|reportUrl)\s*[:=]\s*["']([^"']+)["']/gi),
    ...html.matchAll(/window\.open\s*\(\s*["']([^"']+)["']/gi)
  ];
  for (const m of jsMatches) {
    const target = m[1]?.trim();
    if (!target || target.startsWith('javascript:') || NON_PDF_EXT.test(target) || NON_PDF_PATH.test(target)) continue;
    if (isProbablePdfUrl(target)) {
      try {
        const resolved = new URL(target, baseUrl).href;
        if (resolved !== baseUrl) return resolved;
      } catch { /* ignore */ }
    }
  }

  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WAITING_RE = /in Vorbereitung|Bitte warten|wird vorbereitet|wird generiert|being prepared|please wait|is generating/i;

/** Fallback-Download im Hintergrund (kein CORS, dafür evtl. ohne Session-Cookies). */
async function fetchPdfInBackground(url, signal, _depth = 0, _waitCount = 0) {
  if (_depth > 4) throw new Error('Zu viele Weiterleitungen beim PDF-Download.');
  if (_waitCount > 25) throw new Error('Das PDF wird von BCA noch vorbereitet. Bitte versuche es in wenigen Sekunden erneut.');

  let res;
  // Entferne eventuelle Thumbnail-Parameter wie width=96
  const cleanUrl = url.replace(/([?&])(?:width|height)=\d+&?/gi, '$1').replace(/[?&]$/, '');
  try {
    res = await fetch(cleanUrl, {
      credentials: 'include',
      signal,
      redirect: 'follow',
      headers: { 'Accept': 'application/pdf, application/octet-stream, */*' }
    });
  } catch (err) {
    if (signal?.aborted) throw new Error('PDF-Download wurde abgebrochen.');
    throw new Error(`PDF-Download im Hintergrund nicht möglich (${err.message}). URL: ${cleanUrl}`);
  }
  if (!res.ok) throw new Error(`PDF-Download fehlgeschlagen (HTTP ${res.status} ${res.statusText}). URL: ${cleanUrl}`);
  let buf;
  try {
    buf = await res.arrayBuffer();
  } catch (err) {
    throw new Error(`PDF-Daten konnten nicht gelesen werden (${err.message}).`);
  }
  if (buf.byteLength > MAX_PDF_BYTES) throw new Error('PDF ist zu groß (> 25 MB).');
  if (looksLikePdf(buf)) {
    return { base64: bytesToBase64(buf), bytes: buf.byteLength, finalUrl: res.url };
  }
  // Kein PDF? Prüfe ob die Antwort HTML ist und ein eingebettetes PDF enthält oder noch generiert wird
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.includes('html') || type.includes('text') || buf.byteLength < 800000) {
    try {
      const html = new TextDecoder().decode(buf);

      // Falls BCA das PDF noch generiert ("in Vorbereitung / Bitte warten"):
      if (WAITING_RE.test(html) && _waitCount < 25) {
        const refreshMatch = html.match(/<meta[^>]+content=["'][^"']*?url=([^"'\s;]+)["']/i);
        const nextUrl = refreshMatch?.[1] ? new URL(refreshMatch[1], cleanUrl).href : cleanUrl;
        await sleep(3000);
        return fetchPdfInBackground(nextUrl, signal, _depth, _waitCount + 1);
      }

      const nested = findPdfInHtml(html, res.url || cleanUrl);
      if (nested && nested !== url && nested !== res.url && nested !== cleanUrl) {
        return fetchPdfInBackground(nested, signal, _depth + 1, _waitCount);
      }
    } catch { /* decode-Fehler ignorieren */ }
  }
  throw new Error(
    `Antwort ist kein PDF (Content-Type: ${res.headers.get('content-type') || 'unbekannt'}). ` +
    'Möglicherweise erfordert der Download eine aktive Sitzung auf der Auktionsseite – ' +
    'bitte stelle sicher, dass du auf BCA eingeloggt bist und versuche es erneut.'
  );
}

/** Führt eine detaillierte Diagnose eines PDF-Downloads durch. */
async function diagnosePdf(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      headers: { 'Accept': 'application/pdf, application/octet-stream, */*' }
    });
    const contentType = res.headers.get('content-type') || '';
    const contentLength = res.headers.get('content-length') || '';
    const buf = await res.arrayBuffer();
    const isPdf = looksLikePdf(buf);
    let preview = '';
    let nested = null;
    if (!isPdf) {
      try {
        const text = new TextDecoder().decode(buf.slice(0, 4000));
        preview = text.slice(0, 300).replace(/\s+/g, ' ').trim();
        nested = findPdfInHtml(text, res.url);
      } catch { /* ignore */ }
    }
    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      contentType,
      contentLength,
      bytesReceived: buf.byteLength,
      isPdf,
      finalUrl: res.url,
      nestedPdfUrl: nested,
      preview: isPdf ? `%PDF Header erkannt (${Math.round(buf.byteLength / 1024)} KB)` : preview,
      durationMs: Date.now() - started
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      url,
      durationMs: Date.now() - started
    };
  }
}

/** Testet die OpenRouter-API-Verbindung und gibt genaue Metriken zurück. */
async function diagnoseApi() {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, error: 'Kein OpenRouter API-Key hinterlegt.' };
  }
  const started = Date.now();
  try {
    const res = await testKey(settings.apiKey, settings.model, settings.apiBase);
    return {
      ok: true,
      model: res.model,
      durationMs: Date.now() - started,
      usage: res.usage
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      model: settings.model,
      durationMs: Date.now() - started
    };
  }
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
    let lastDocError = null;
    for (const doc of docs) {
      if (controller.signal.aborted) throw new Error('Abgebrochen.');
      progress(tabId, 'download', { label: doc.label });

      let base64 = doc.base64 || null;
      let bytes = doc.bytes || 0;
      if (!base64) {
        try {
          const dl = await fetchPdfInBackground(doc.url, controller.signal);
          base64 = dl.base64;
          bytes = dl.bytes;
        } catch (dlErr) {
          lastDocError = dlErr;
          continue; // Wenn dieses Dokument nicht lesbar ist (z.B. ein Vorschaubild), versuche das nächste Dokument
        }
      }

      const hash = await cache.sha256(base64);
      let extracted = settings.cacheEnabled && !force ? await cache.getText(hash) : null;

      if (extracted) {
        progress(tabId, 'parse', { label: doc.label, cached: true, pages: extracted.pageCount });
      } else {
        progress(tabId, 'parse', { label: doc.label, sizeKb: Math.round(bytes / 1024) });
        try {
          extracted = await parseInOffscreen(
            { base64, wantImages: settings.visionFallback, maxPages: settings.visionMaxPages },
            (detail) => progress(tabId, 'parse-progress', { label: doc.label, ...detail })
          );
        } catch (parseErr) {
          lastDocError = parseErr;
          continue;
        }
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

    if (!parsed.length) {
      throw lastDocError || new Error('Keine lesbaren PDFs gefunden.');
    }

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

/* ------------------------------------------------------------ Toolbar-Badge */

async function setBadge(tabId, state, result) {
  if (tabId === undefined) return;
  try {
    if (state === 'busy') {
      await chrome.action.setBadgeText({ tabId, text: '...' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
      await chrome.action.setTitle({ tabId, title: 'Autosmaya prüft dieses Fahrzeug…' });
      return;
    }
    if (state === 'error') {
      await chrome.action.setBadgeText({ tabId, text: '!' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
      await chrome.action.setTitle({ tabId, title: 'Autosmaya: Analyse fehlgeschlagen' });
      return;
    }
    if (state === 'done' && result) {
      // Sachlich nach Schwere, nicht nach Bewertung: die Zahl ist ein Befund.
      const counts = result.counts || {};
      const total = result.defects?.length || 0;
      const color = counts.kritisch ? '#dc2626' : counts.mittel ? '#d97706' : total ? '#0891b2' : '#16a34a';
      await chrome.action.setBadgeText({ tabId, text: total ? String(Math.min(99, total)) : '0' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color });
      const parts = [`${total} Mängel`];
      if (counts.kritisch) parts.push(`${counts.kritisch} kritisch`);
      await chrome.action.setTitle({ tabId, title: `Autosmaya: ${parts.join(', ')}` });
      return;
    }
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'Autosmaya – Fahrzeug prüfen' });
  } catch {
    /* Tab kann bereits geschlossen sein */
  }
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') setBadge(tabId, 'idle');
});

/* -------------------------------------------------------------- Tastatur */

chrome.commands?.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const type = command === 'analyze-page' ? 'TRIGGER_SCAN' : 'TOGGLE_PANEL';
  chrome.tabs.sendMessage(tab.id, { type, force: false }).catch(() => {});
});

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
      setBadge(tabId, 'busy');
      analyze({ tabId, ...msg.payload })
        .then((result) => {
          setBadge(tabId, 'done', result);
          sendResponse({ ok: true, result });
        })
        .catch((err) => {
          setBadge(tabId, 'error');
          sendResponse({
            ok: false,
            error: String(err?.message || err),
            code: err?.code || (err instanceof OpenRouterError ? 'API' : 'GENERIC')
          });
        });
      return true;
    }

    case 'CLEAR_BADGE':
      setBadge(tabId, 'idle');
      sendResponse({ ok: true });
      return false;

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

    case 'DIAGNOSE_PDF':
      diagnosePdf(msg.payload.url).then((r) => sendResponse(r));
      return true;

    case 'DIAGNOSE_API':
      diagnoseApi().then((r) => sendResponse(r));
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

/* -------------------------------------------------- Port-basiertes Keep-Alive */
// Content-Scripts öffnen während der Analyse einen Port, der den Service Worker
// zuverlässig am Leben hält – auch bei langen KI-Anfragen.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onMessage.addListener(() => {
      // Eingehende Heartbeat-Nachrichten vom Tab setzen den MV3-Inaktivitätstimer zurück
    });
  }
});
