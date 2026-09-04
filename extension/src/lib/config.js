/**
 * Zentrale Defaults + Storage-Helfer.
 * Wird vom Service Worker, den Optionen und dem Popup als ES-Modul genutzt.
 */

export const DEFAULTS = {
  apiKey: '',
  apiBase: 'https://openrouter.ai/api/v1',
  model: 'amazon/nova-2-lite-v1',
  visionModel: 'amazon/nova-2-lite-v1',
  autoRun: true,
  visionFallback: true,
  visionMaxPages: 6,
  maxChars: 120000, // pro KI-Aufruf; laengere Dokumente werden in Teilen ausgewertet
  outputLanguage: 'de',
  panelPosition: null,
  panelCollapsed: false,
  panelTheme: 'auto',
  panelSize: null,
  markLinks: true,
  /**
   * Autosmaya wird nur auf diesen Adressen aktiv. Der Host selbst ist zusätzlich im
   * Manifest festgeschrieben - hier lässt sich nur weiter einschränken, nicht ausweiten.
   */
  urlPrefixes: ['https://de.bca-europe.com/lot?id'],
  /** Nur ZUSAETZLICHE Stichwoerter des Nutzers - die gaengigen sind im Content-Script eingebaut. */
  keywords: [],
  cacheEnabled: true,
  cacheMaxEntries: 60,
  debug: false
};

/**
 * Vorschläge für die Modellwahl. Die Felder in/out sind USD pro 1 Mio. Tokens und dienen
 * nur der Vorschau - abgerechnet wird, was OpenRouter je Aufruf zurückmeldet.
 * Das Modellfeld ist frei beschreibbar, hier stehen nur die Vorschläge.
 */
export const MODELS = [
  {
    id: 'amazon/nova-2-lite-v1',
    label: 'Amazon Nova 2 Lite (Standard)',
    in: null,
    out: null,
    vision: true
  },
  {
    id: 'openai/gpt-4o-mini',
    label: 'GPT-4o mini (bewährt, günstig)',
    in: 0.15,
    out: 0.6,
    vision: true
  },
  {
    id: 'google/gemini-2.0-flash-001',
    label: 'Gemini 2.0 Flash (starkes OCR für Scans)',
    in: 0.1,
    out: 0.4,
    vision: true
  },
  {
    id: 'openai/gpt-4.1-mini',
    label: 'GPT-4.1 mini (genauer, etwas teurer)',
    in: 0.4,
    out: 1.6,
    vision: true
  },
  {
    id: 'anthropic/claude-3.5-haiku',
    label: 'Claude 3.5 Haiku (sorgfältig bei Tabellen)',
    in: 0.8,
    out: 4.0,
    vision: true
  }
];

export function priceFor(modelId) {
  const m = MODELS.find((x) => x.id === modelId);
  return m && typeof m.in === 'number' && typeof m.out === 'number' ? m : null;
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (stored[key] !== undefined && stored[key] !== null) out[key] = stored[key];
  }
  return out;
}

export async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

/**
 * Prüft, ob Autosmaya auf dieser Adresse arbeiten darf.
 * Erlaubt ist ein konfigurierter Präfix - oder, auf demselben Host und Pfad,
 * dieselbe Seite mit anders sortierten Parametern (…/lot?foo=1&id=2).
 */
export function urlAllowed(settings, href) {
  const url = safeUrl(href);
  if (!url) return false;

  // Für BCA-Portale: Erlaube Lot- und Fahrzeug-Seiten direkt
  if (/(?:bca-europe\.com|bca\.com|bca\.de|bca\.co\.uk)/i.test(url.hostname)) {
    if (url.pathname.includes('/lot') || url.pathname.includes('/vehicle') || url.searchParams.has('id') || url.searchParams.has('VehId')) {
      return true;
    }
  }

  const prefixes = settings?.urlPrefixes?.length ? settings.urlPrefixes : DEFAULTS.urlPrefixes;

  for (const raw of prefixes) {
    const prefix = String(raw).trim();
    if (!prefix) continue;
    if (href.startsWith(prefix)) return true;

    const ref = safeUrl(prefix);
    if (!ref) continue;
    if (url.origin !== ref.origin) continue;
    if (url.pathname.replace(/\/+$/, '') !== ref.pathname.replace(/\/+$/, '')) continue;
    // Der Präfix endet auf "?name" bzw. "&name": dieser Parameter muss vorhanden sein.
    const param = prefix.match(/[?&]([A-Za-z0-9_-]+)$/)?.[1];
    if (!param) return true;
    if (url.searchParams.has(param)) return true;
  }
  return false;
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
