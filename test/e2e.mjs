/**
 * End-to-End-Test der Extension mit echtem Chromium.
 *
 *   npm i -D playwright   (oder: npx playwright@1.49.1 ...)
 *   node test/e2e.mjs
 *
 * Startet einen lokalen Fixture-Server und einen Mock von OpenRouter,
 * laedt die Extension ungepackt und prueft den kompletten Ablauf:
 * Erkennung -> PDF-Download -> pdf.js -> Prompt -> Panel -> Cache.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extension');
const FIXTURES = path.join(HERE, 'fixtures');
const PROFILE = path.join(HERE, '.profile');
const CHROME =
  process.env.CHROME_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SITE_PORT = 8899;
const API_PORT = 8898;

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      erwartet: ${JSON.stringify(expected)}\n      erhalten: ${JSON.stringify(actual)}`}`);
  ok ? passed++ : failed++;
}

/* ------------------------------------------------------------- Server */

const TYPES = { '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf' };
const siteServer = http.createServer((req, res) => {
  const name = path.basename(decodeURIComponent(req.url.split('?')[0])) || 'vehicle.html';
  const file = path.join(FIXTURES, name);
  if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const MOCK = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'mock-response.json'), 'utf8'));
let apiCalls = 0;
let lastRequest = null;
const apiServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    apiCalls++;
    try {
      lastRequest = JSON.parse(body || '{}');
    } catch {
      lastRequest = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(MOCK));
  });
});

await new Promise((r) => siteServer.listen(SITE_PORT, '127.0.0.1', r));
await new Promise((r) => apiServer.listen(API_PORT, '127.0.0.1', r));
const site = (f) => `http://127.0.0.1:${SITE_PORT}/${f}`;

/* ------------------------------------------------------------ Browser */

fs.rmSync(PROFILE, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 1180, height: 900 },
  colorScheme: 'light'
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;
const swErrors = [];
sw.on('console', (m) => m.type() === 'error' && swErrors.push(m.text()));

const ROOT = `document.getElementById('vms-host')?.shadowRoot?.querySelector('.vms-root')`;
const waitDone = (page, ms = 45000) =>
  page.waitForFunction(`${ROOT}?.dataset.status === 'done' || ${ROOT}?.querySelector('.vms-error')`, null, { timeout: ms });
const evalRoot = (page, expr) => page.evaluate(`(() => { const r = ${ROOT}; return ${expr}; })()`);

/* 1 – ohne API-Key fuehrt die Extension zur Einrichtung */
let page = await ctx.newPage();
await page.goto(site('vehicle.html'));
await page.waitForFunction(ROOT, null, { timeout: 20000 });
await waitDone(page).catch(() => {});
check('Ohne API-Key: Hinweis + Button', await evalRoot(page, `r.querySelector('.vms-primary')?.textContent.trim()`), 'API-Key eintragen');
await page.close();

const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/src/options/options.html`);
await opt.evaluate((base) => chrome.storage.local.set({ apiKey: 'sk-or-test', apiBase: base, autoRun: true, cacheEnabled: true }),
  `http://127.0.0.1:${API_PORT}/v1`);
await opt.close();

/* 2 – keine Fehlalarme auf Seiten ohne Fahrzeugbezug */
for (const [file, expected] of [['blog.html', false], ['pricelist.html', false]]) {
  const p = await ctx.newPage();
  await p.goto(site(file));
  await p.waitForTimeout(3500);
  check(`Kein Panel auf ${file}`, await p.evaluate(`Boolean(${ROOT})`), expected);
  await p.close();
}

/* 3 – Fahrzeugseite: kompletter Durchlauf */
const callsBefore = apiCalls;
page = await ctx.newPage();
await page.goto(site('vehicle.html'));
await waitDone(page);

check('Status nach Analyse', await evalRoot(page, `r.dataset.status`), 'done');
check('Fahrzeugdaten von der Seite gelesen', await evalRoot(page, `r.querySelector('.vms-sub').textContent.trim()`), 'WVGZZZ1T4PW004548 · 207121 km');
check('Anzahl Mängelkarten', await evalRoot(page, `r.querySelectorAll('.vms-defect').length`), 6);
check('Zählung nach Schwere', await evalRoot(page, `[...r.querySelectorAll('.vms-chip')].map(c => c.textContent.trim())`), ['Alle 6', 'Kritisch 3', 'Mittel 1', 'Gering 2']);
check('Genau ein API-Aufruf', apiCalls - callsBefore, 1);
check('PDF-Text steckt im Prompt', String(lastRequest?.messages?.[1]?.content).includes('Belaege verschlissen, HU-relevant'), true);
check('Tabellenspalten bleiben erhalten', /Bremsen hinten {2,}Belaege/.test(String(lastRequest?.messages?.[1]?.content)), true);
check('Structured Output angefordert', lastRequest?.response_format?.type, 'json_schema');
check('Temperatur 0', lastRequest?.temperature, 0);

await page.evaluate(`${ROOT}.querySelector('.vms-defect-head').click()`);
await page.waitForTimeout(250);
check('Mangel aufklappbar mit Beleg-Zitat', await evalRoot(page, `Boolean(r.querySelector('.vms-defect.open blockquote'))`), true);

await page.evaluate(`${ROOT}.querySelector('.vms-chip.kritisch').click()`);
await page.waitForTimeout(200);
check('Filter zeigt nur kritische Mängel', await evalRoot(page, `[...r.querySelectorAll('.vms-defect')].every(d => d.classList.contains('kritisch'))`), true);

await page.evaluate(`${ROOT}.querySelector('[data-act="collapse"]').click()`);
await page.waitForTimeout(250);
check('Einklappen blendet den Inhalt aus', await evalRoot(page, `Boolean(r.querySelector('.vms-body'))`), false);
await page.close();

/* 4 – Cache: gleiches PDF kostet kein zweites Mal */
const beforeCache = apiCalls;
page = await ctx.newPage();
await page.goto(site('vehicle.html'));
await waitDone(page);
check('Zweiter Aufruf ohne API-Kosten', apiCalls - beforeCache, 0);
// Das Panel merkt sich den eingeklappten Zustand aus Schritt 3 - hier wieder aufklappen.
check('Eingeklappter Zustand bleibt seitenübergreifend', await evalRoot(page, `r.classList.contains('collapsed')`), true);
check('Badge auch eingeklappt sichtbar', await evalRoot(page, `r.querySelector('.vms-badge')?.textContent.trim()`), '6 Mängel');
await page.evaluate(`${ROOT}.querySelector('[data-act="collapse"]').click()`);
await page.waitForTimeout(250);
check('Footer weist Cache aus', await evalRoot(page, `r.querySelector('.vms-meta-line').textContent.includes('Cache')`), true);
await page.close();

/* 5 – gescanntes PDF ohne Textlayer -> Bilderkennung */
const beforeScan = apiCalls;
page = await ctx.newPage();
await page.goto(site('scanned.html'));
await waitDone(page, 60000).catch(() => {});
check('Scan-PDF wird analysiert', await evalRoot(page, `r.dataset.status`), 'done');
check('Bilder statt Text im Request', (lastRequest?.messages?.[1]?.content || []).filter?.((p) => p.type === 'image_url').length, 1);
check('Ein API-Aufruf für den Scan', apiCalls - beforeScan, 1);
await page.close();

check('Keine Fehler im Service Worker', swErrors, []);

await ctx.close();
siteServer.close();
apiServer.close();
fs.rmSync(PROFILE, { recursive: true, force: true });

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
