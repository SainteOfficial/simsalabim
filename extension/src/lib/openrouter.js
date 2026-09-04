/** Minimaler OpenRouter-Client: Structured Outputs, Retry, Kosten. */

import { priceFor } from './config.js';

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
const REFERER = 'https://github.com/SainteOfficial/simsalabim';
const TITLE = 'Autosmaya';

export class OpenRouterError extends Error {
  constructor(message, { status, retryable = false, body } = {}) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

function friendly(status, body) {
  const detail = body?.error?.message || body?.message || '';
  if (/not a valid model|no endpoints found|model not found|unknown model/i.test(detail)) {
    return `Modell nicht gefunden: ${detail} Bitte die Modell-ID in den Einstellungen prüfen (Schreibweise wie auf openrouter.ai/models).`;
  }
  switch (status) {
    case 401:
      return 'API-Key ungültig oder fehlt. Bitte in den Einstellungen prüfen.';
    case 402:
      return 'OpenRouter-Guthaben aufgebraucht (402). Bitte Credits aufladen.';
    case 403:
      return `Zugriff verweigert (403). ${detail}`;
    case 408:
      return 'Zeitüberschreitung bei OpenRouter.';
    case 429:
      return 'Rate-Limit erreicht (429). Kurz warten und erneut versuchen.';
    default:
      if (status >= 500) return `OpenRouter-Serverfehler (${status}).`;
      return detail || `OpenRouter-Fehler (${status}).`;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array} opts.messages
 * @param {object} [opts.schema]  JSON-Schema für Structured Output
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxRetries]
 * @param {string} [opts.apiBase]  abweichender Endpunkt (z.B. eigener Proxy)
 * @param {AbortSignal} [opts.signal]
 */
export async function chat({
  apiKey,
  apiBase = DEFAULT_BASE,
  model,
  messages,
  schema,
  timeoutMs = 240000,
  maxRetries = 2,
  maxTokens = 4000,
  signal
}) {
  if (!apiKey) throw new OpenRouterError('Kein OpenRouter API-Key hinterlegt.', { status: 401 });
  const endpoint = `${String(apiBase || DEFAULT_BASE).replace(/\/+$/, '')}/chat/completions`;

  let useSchema = Boolean(schema);
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const body = {
      model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      usage: { include: true }
    };
    if (useSchema) {
      body.response_format = { type: 'json_schema', json_schema: schema };
    } else {
      body.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': REFERER,
          'X-Title': TITLE
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const raw = await res.text();
      let json = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        /* nicht-JSON Antwort */
      }

      if (!res.ok) {
        const msg = friendly(res.status, json);
        // Manche Provider lehnen json_schema ab -> einmal ohne Schema versuchen.
        // Nicht jedes Modell beherrscht Structured Outputs - dann einmal ohne Schema.
        const schemaIssue =
          useSchema &&
          (res.status === 400 || res.status === 404 || res.status === 422) &&
          /schema|response_format|structured|json_schema|not support/i.test(raw || '');
        if (schemaIssue) {
          useSchema = false;
          continue;
        }
        const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
        lastError = new OpenRouterError(msg, { status: res.status, retryable, body: json });
        if (retryable && attempt < maxRetries) {
          await sleep(800 * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      if (json?.error) {
        throw new OpenRouterError(json.error.message || 'OpenRouter-Fehler', {
          status: json.error.code,
          body: json
        });
      }

      const choice = json?.choices?.[0];
      const content = choice?.message?.content;
      if (!content) {
        lastError = new OpenRouterError('Leere Antwort vom Modell.', { retryable: true });
        if (attempt < maxRetries) {
          await sleep(600);
          continue;
        }
        throw lastError;
      }

      return {
        content,
        finishReason: choice.finish_reason,
        model: json.model || model,
        usage: normalizeUsage(json.usage, json.model || model),
        durationMs: Date.now() - started
      };
    } catch (err) {
      if (err instanceof OpenRouterError) {
        if (!err.retryable || attempt >= maxRetries) throw err;
        lastError = err;
        await sleep(800 * Math.pow(2, attempt));
        continue;
      }
      if (err?.name === 'AbortError') {
        if (signal?.aborted) throw new OpenRouterError('Analyse abgebrochen.', { status: 0 });
        lastError = new OpenRouterError('Zeitüberschreitung bei der KI-Anfrage.', {
          status: 408,
          retryable: true
        });
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      lastError = new OpenRouterError(
        err.message === 'Failed to fetch'
          ? 'Verbindung zur KI unterbrochen (Service Worker wurde beendet). Bitte erneut versuchen.'
          : `Netzwerkfehler: ${err.message}`,
        { retryable: true }
      );
      if (attempt < maxRetries) {
        await sleep(800 * Math.pow(2, attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  throw lastError || new OpenRouterError('Unbekannter Fehler.');
}

function normalizeUsage(usage, modelId) {
  if (!usage) return null;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  let cost = typeof usage.cost === 'number' ? usage.cost : null;
  if (cost === null) {
    const p = priceFor(modelId);
    if (p) cost = (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out;
  }
  if (!Number.isFinite(cost)) cost = null;
  return { promptTokens, completionTokens, cost };
}

/** Extrahiert JSON auch aus Antworten mit Markdown-Fence oder Vor-/Nachtext. */
export function parseJsonLoose(content) {
  const text = String(content).trim();
  const direct = tryParse(text);
  if (direct) return direct;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed) return parsed;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(text.slice(start, end + 1));
    if (parsed) return parsed;
  }
  throw new Error('Antwort des Modells war kein gültiges JSON.');
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Testet den Key mit einer minimalen, praktisch kostenlosen Anfrage. */
export async function testKey(apiKey, model, apiBase) {
  const res = await chat({
    apiKey,
    apiBase,
    model,
    messages: [
      { role: 'system', content: 'Antworte mit JSON.' },
      { role: 'user', content: 'Antworte exakt mit {"ok":true}' }
    ],
    maxTokens: 20,
    maxRetries: 0,
    timeoutMs: 30000
  });
  return res;
}
