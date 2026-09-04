/**
 * Zentrale Defaults + Storage-Helfer.
 * Wird vom Service Worker, den Optionen und dem Popup als ES-Modul genutzt.
 */

export const DEFAULTS = {
  apiKey: '',
  apiBase: 'https://openrouter.ai/api/v1',
  model: 'openai/gpt-4o-mini',
  visionModel: 'openai/gpt-4o-mini',
  autoRun: true,
  visionFallback: true,
  visionMaxPages: 6,
  maxChars: 120000,
  outputLanguage: 'de',
  panelPosition: null,
  panelCollapsed: false,
  domainMode: 'all', // 'all' | 'allowlist' | 'blocklist'
  allowlist: [],
  blocklist: [],
  /** Nur ZUSAETZLICHE Stichwoerter des Nutzers - die gaengigen sind im Content-Script eingebaut. */
  keywords: [],
  cacheEnabled: true,
  cacheMaxEntries: 60,
  debug: false
};

/** Modelle, die in den Optionen zur Auswahl stehen. Preise in USD pro 1 Mio Tokens. */
export const MODELS = [
  {
    id: 'openai/gpt-4o-mini',
    label: 'GPT-4o mini (Standard – günstig & schnell)',
    in: 0.15,
    out: 0.6,
    vision: true
  },
  {
    id: 'google/gemini-2.0-flash-001',
    label: 'Gemini 2.0 Flash (sehr günstig, starkes OCR)',
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
    label: 'Claude 3.5 Haiku (sehr sorgfältig bei Tabellen)',
    in: 0.8,
    out: 4.0,
    vision: true
  },
  {
    id: 'openai/gpt-4o',
    label: 'GPT-4o (teuer – nur für schwierige Scans)',
    in: 2.5,
    out: 10.0,
    vision: true
  }
];

export function priceFor(modelId) {
  return MODELS.find((m) => m.id === modelId) || null;
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

/** Prüft, ob die Extension auf diesem Host laufen darf. */
export function hostAllowed(settings, hostname) {
  const host = (hostname || '').toLowerCase();
  const match = (list) =>
    (list || []).some((entry) => {
      const e = String(entry).trim().toLowerCase().replace(/^\*\./, '');
      if (!e) return false;
      return host === e || host.endsWith('.' + e);
    });

  if (settings.domainMode === 'allowlist') return match(settings.allowlist);
  if (settings.domainMode === 'blocklist') return !match(settings.blocklist);
  return true;
}
