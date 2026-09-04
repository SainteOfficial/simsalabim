/* eslint-env browser */
const $ = (id) => document.getElementById(id);

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
