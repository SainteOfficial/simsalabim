import { DEFAULTS, MODELS, getSettings, setSettings, priceFor } from '../lib/config.js';

const $ = (id) => document.getElementById(id);

const FIELDS = {
  apiKey: 'value',
  apiBase: 'value',
  model: 'value',
  visionModel: 'value',
  autoRun: 'checked',
  visionFallback: 'checked',
  markLinks: 'checked',
  cacheEnabled: 'checked',
  visionMaxPages: 'number',
  maxChars: 'number',
  outputLanguage: 'value',
  urlPrefixes: 'lines',
  keywords: 'lines'
};

function fillModels() {
  $('modelList').innerHTML = MODELS.map(
    (m) => `<option value="${m.id}">${m.label}</option>`
  ).join('');
}

function showPrice() {
  const id = $('model').value.trim();
  const p = priceFor(id);
  const known = MODELS.find((m) => m.id === id);
  if (p) {
    $('modelPrice').textContent =
      `ca. $${p.in.toFixed(2)} pro 1 Mio. Eingabe-Tokens · $${p.out.toFixed(2)} pro 1 Mio. ` +
      'Ausgabe-Tokens – ein Zustandsbericht kostet damit meist unter 1 Cent.';
  } else if (known) {
    $('modelPrice').textContent =
      'Preis wird von OpenRouter je Aufruf gemeldet und unten im Panel angezeigt.';
  } else {
    $('modelPrice').textContent =
      'Freies Modell – die Modell-ID muss genau der Schreibweise auf openrouter.ai/models entsprechen. ' +
      'Mit „Testen" prüfen.';
  }
}

async function load() {
  fillModels();
  const s = await getSettings();
  for (const [key, kind] of Object.entries(FIELDS)) {
    const el = $(key);
    if (!el) continue;
    if (kind === 'checked') el.checked = Boolean(s[key]);
    else if (kind === 'lines') el.value = (s[key] || []).join('\n');
    else el.value = s[key] ?? '';
  }
  showPrice();
  refreshCache();
}

async function save() {
  const patch = {};
  for (const [key, kind] of Object.entries(FIELDS)) {
    const el = $(key);
    if (!el) continue;
    if (kind === 'checked') patch[key] = el.checked;
    else if (kind === 'lines')
      patch[key] = el.value
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    else if (kind === 'number') patch[key] = Number(el.value) || DEFAULTS[key];
    else patch[key] = el.value.trim();
  }
  await setSettings(patch);
  const status = $('saveStatus');
  status.textContent = 'Gespeichert';
  setTimeout(() => (status.textContent = ''), 1800);
}

async function refreshCache() {
  const res = await chrome.runtime.sendMessage({ type: 'CACHE_STATS' });
  if (res?.ok) {
    const kb = Math.round(res.stats.bytes / 1024);
    $('cacheStats').textContent =
      `${res.stats.results} gespeicherte Analysen, ${res.stats.texts} PDF-Texte (${kb} KB).`;
  }
}

$('save').addEventListener('click', save);
$('model').addEventListener('input', showPrice);

$('toggleKey').addEventListener('click', () => {
  const input = $('apiKey');
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  $('toggleKey').textContent = hidden ? 'Verbergen' : 'Zeigen';
});

$('testKey').addEventListener('click', async () => {
  const box = $('keyStatus');
  box.hidden = false;
  box.className = 'status';
  box.textContent = 'Teste Verbindung…';
  const res = await chrome.runtime.sendMessage({
    type: 'TEST_KEY',
    payload: {
      apiKey: $('apiKey').value.trim(),
      model: $('model').value,
      apiBase: $('apiBase').value.trim() || undefined
    }
  });
  if (res?.ok) {
    box.className = 'status ok';
    box.textContent = `Verbindung ok – Antwort von ${res.model}.`;
  } else {
    box.className = 'status err';
    box.textContent = res?.error || 'Test fehlgeschlagen.';
  }
});

$('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CACHE_CLEAR' });
  refreshCache();
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

load();
