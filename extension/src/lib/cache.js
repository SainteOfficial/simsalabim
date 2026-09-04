/**
 * Zwei Caches in chrome.storage.local:
 *  - text:<pdfHash>          extrahierter PDF-Text (teuer zu erzeugen)
 *  - result:<key>            fertige KI-Analyse (kostet Geld)
 * Damit wird dieselbe PDF nie zweimal bezahlt.
 */

const TEXT_PREFIX = 'cache:text:';
const RESULT_PREFIX = 'cache:result:';

export async function sha256(input) {
  const data =
    input instanceof ArrayBuffer || ArrayBuffer.isView(input)
      ? input
      : new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getText(hash) {
  const key = TEXT_PREFIX + hash;
  const store = await chrome.storage.local.get(key);
  return store[key] || null;
}

export async function putText(hash, value) {
  await chrome.storage.local.set({ [TEXT_PREFIX + hash]: { ...value, ts: Date.now() } });
}

export function resultKey({ docHash, model, promptVersion, lang, mode }) {
  return `${RESULT_PREFIX}${docHash}:${model}:${promptVersion}:${lang}:${mode}`;
}

export async function getResult(key) {
  const store = await chrome.storage.local.get(key);
  const hit = store[key];
  if (hit) {
    // Zugriffszeit aktualisieren (LRU)
    chrome.storage.local.set({ [key]: { ...hit, lastUsed: Date.now() } });
  }
  return hit || null;
}

export async function putResult(key, value) {
  await chrome.storage.local.set({ [key]: { ...value, ts: Date.now(), lastUsed: Date.now() } });
}

/** Hält den Cache klein: älteste Einträge fliegen raus. */
export async function trim(maxEntries = 60) {
  const all = await chrome.storage.local.get(null);
  for (const prefix of [TEXT_PREFIX, RESULT_PREFIX]) {
    const entries = Object.entries(all)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({ k, ts: v?.lastUsed || v?.ts || 0 }))
      .sort((a, b) => b.ts - a.ts);
    const doomed = entries.slice(maxEntries).map((e) => e.k);
    if (doomed.length) await chrome.storage.local.remove(doomed);
  }
}

export async function stats() {
  const all = await chrome.storage.local.get(null);
  let texts = 0;
  let results = 0;
  let bytes = 0;
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(TEXT_PREFIX)) texts++;
    else if (k.startsWith(RESULT_PREFIX)) results++;
    else continue;
    bytes += k.length + JSON.stringify(v).length;
  }
  return { texts, results, bytes };
}

export async function clearAll() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(
    (k) => k.startsWith(TEXT_PREFIX) || k.startsWith(RESULT_PREFIX)
  );
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}
