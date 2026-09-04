/* eslint-env browser */
const $ = (id) => document.getElementById(id);

const VERDICT = {
  kaufen: { label: 'Kaufen', tone: 'good' },
  kaufen_mit_vorbehalt: { label: 'Kaufen mit Vorbehalt', tone: 'ok' },
  nachverhandeln: { label: 'Nachverhandeln', tone: 'warn' },
  finger_weg: { label: 'Finger weg', tone: 'bad' },
  unklar: { label: 'Unklar', tone: 'muted' }
};

/** Zeigt das Urteil des aktiven Tabs, ohne dass das Panel offen sein muss. */
async function showTabState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
  } catch {
    return;
  }
  if (!res?.ok || res.status !== 'done' || !res.verdict) return;

  const meta = VERDICT[res.verdict.recommendation] || VERDICT.unklar;
  $('vDot').className = `vdot ${meta.tone}`;
  $('vLabel').className = `vlabel ${meta.tone}`;
  $('vLabel').textContent = meta.label;
  $('vScore').textContent = typeof res.verdict.score === 'number' ? `${res.verdict.score}/100` : '';
  $('vScore').hidden = typeof res.verdict.score !== 'number';
  const parts = [`${res.defects} Mängel`];
  if (res.counts?.kritisch) parts.push(`${res.counts.kritisch} kritisch`);
  if (res.pages) parts.push(`${res.pages} Seiten gelesen`);
  $('vCounts').textContent = parts.join(' · ');
  $('result').hidden = false;
  $('run').textContent = 'Neu prüfen';

  $('show').addEventListener('click', async () => {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
    window.close();
  });
}

async function init() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const s = res?.settings || {};

  $('keyPill').textContent = s.apiKey ? 'hinterlegt' : 'fehlt';
  $('keyPill').className = `pill ${s.apiKey ? 'ok' : 'err'}`;
  $('modelName').textContent = (s.model || '').split('/').pop() || '-';
  $('autoPill').textContent = s.autoRun ? 'an' : 'aus';
  $('autoPill').className = `pill ${s.autoRun ? 'ok' : ''}`;
  $('run').disabled = !s.apiKey;
  if (!s.apiKey) $('msg').textContent = 'Bitte zuerst den OpenRouter-Key eintragen.';
  showTabState();
}

$('run').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  $('msg').textContent = 'Starte Analyse…';
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_SCAN', force: false });
    if (res?.ok) window.close();
    else $('msg').textContent = res?.error || 'Kein Fahrzeug-PDF auf dieser Seite gefunden.';
  } catch {
    $('msg').textContent = 'Seite neu laden und erneut versuchen.';
  }
});

$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

init();
