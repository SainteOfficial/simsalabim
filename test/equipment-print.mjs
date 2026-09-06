/**
 * Ausstattung und das Blatt zum Ausdrucken.
 *
 *   npm run build && node test/equipment-print.mjs
 *
 * Ausstattung war bisher ausdrücklich ausgeschlossen ("Reine Ausstattungslisten
 * sind KEINE Mängel"). Beim Auktionskauf ist sie aber ein Preisfaktor: dieselbe
 * Baureihe mit Anhängerkupplung, Navi und Matrix-Licht ist deutlich mehr wert.
 * Das Blatt fasst alles auf einer Seite zusammen - zum Mitnehmen zur Auktion.
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extension');
const FIXTURES = path.join(HERE, 'fixtures');
const PROFILE = path.join(HERE, '.profile-equip');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SITE_PORT = 8771;
const API_PORT = 8772;
const HOST = 'de.bca-europe.com';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      erwartet: ${JSON.stringify(expected)}\n      erhalten: ${JSON.stringify(actual)}`}`);
  ok ? passed++ : failed++;
}

if (!fs.existsSync(path.join(EXT, 'dist', 'content.js'))) {
  console.error('extension/dist fehlt – bitte zuerst `npm run build` ausführen.');
  process.exit(1);
}

function certificate(cn) {
  const dir = path.join(FIXTURES, 'cert-' + cn);
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '3650', '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`
    ], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const PDF = fs.readFileSync(path.join(FIXTURES, 'zustandsbericht.pdf'));
const siteServer = https.createServer(certificate(HOST), (req, res) => {
  const u = new URL(req.url, `https://${HOST}`);
  if (u.pathname.endsWith('.pdf')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(PDF);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Volkswagen Touran 2.0 TDI</title></head>
<body><h1>Volkswagen Touran 2.0 TDI</h1>
<p><a href="/zustandsbericht.pdf">Fahrzeug PDF</a></p>
<table>
<tr><td>Fahrgestellnummer</td><td>WVGZZZ1T4PW004548</td></tr>
<tr><td>Kilometerstand</td><td>207121 km</td></tr>
<tr><td>Sofortkauf</td><td>18.900 EUR</td></tr>
</table></body></html>`);
});

const MOCK = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'mock-response.json'), 'utf8'));
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
let lastRequest = null;
const apiServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try { lastRequest = JSON.parse(body || '{}'); } catch { lastRequest = null; }
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(MOCK));
  });
});

await new Promise((r) => siteServer.listen(SITE_PORT, '127.0.0.1', r));
await new Promise((r) => apiServer.listen(API_PORT, '127.0.0.1', r));

fs.rmSync(PROFILE, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-sandbox',
    '--ignore-certificate-errors',
    '--no-proxy-server',
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${SITE_PORT}`
  ],
  ignoreHTTPSErrors: true,
  viewport: { width: 520, height: 900 }
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;
const swErrors = [];
sw.on('console', (m) => m.type() === 'error' && swErrors.push(m.text()));

const options = await ctx.newPage();
await options.goto(`chrome-extension://${extId}/src/options/options.html`);
await options.evaluate((v) => chrome.storage.local.set(v), {
  apiKey: 'sk-or-test',
  apiBase: `http://127.0.0.1:${API_PORT}/v1`,
  autoRun: true,
  cacheEnabled: false,
  panelCollapsed: false
});
await options.close();

const ROOT = `document.getElementById('vms-host')?.shadowRoot?.querySelector('.vms-root')`;
const page = await ctx.newPage();
await page.goto(`https://${HOST}/lot?id=x`);
await page.waitForFunction(`${ROOT}?.dataset.status === 'done'`, null, { timeout: 60000 });
const q = (expr) => page.evaluate(`(() => { const r = ${ROOT}; return ${expr}; })()`);

/* 1 - die Ausstattung wird überhaupt angefordert */
{
  const schema = JSON.stringify(lastRequest?.response_format?.json_schema ?? {});
  check('Das Schema fragt Ausstattung ab', schema.includes('"equipment"'), true);
  check('Und die Wertrelevanz dazu', schema.includes('value_relevant'), true);
  const system = String(lastRequest?.messages?.[0]?.content || '');
  check('Ausstattung zählt weiterhin nicht als Mangel', /Ausstattungslisten.*KEINE Mängel/s.test(system), true);
  check('Sie soll aber ins eigene Feld', /gehört aber vollständig nach "equipment"/.test(system), true);
}

/* 2 - im Panel: werthaltiges sichtbar, Rest aufklappbar */
{
  // Werthaltiges zuerst, innerhalb der Gruppe alphabetisch - so steht die
  // Reihenfolge fest, egal wie das Modell die Liste anordnet.
  check('Werthaltige Ausstattung steht als Chips da, alphabetisch',
    await q(`[...r.querySelectorAll('.vms-equip-chip')].map(c => c.textContent.trim())`),
    ['Anhaengerkupplung schwenkbar', 'LED-Matrix-Scheinwerfer', 'Navigationssystem Discover Pro', 'Sitzheizung vorn']);
  check('Die vollständige Liste hängt im Aufklapper',
    await q(`r.querySelectorAll('.vms-equip-list li').length`), 8);
  check('Werthaltiges ist auch dort markiert',
    await q(`r.querySelectorAll('.vms-equip-list li.value').length`), 4);
  check('Ausstattung landet nicht in der Mängelliste',
    await q(`[...r.querySelectorAll('.vms-defect-title')].some(t => /Sitzheizung|Navigations/.test(t.textContent))`), false);
}

/* 3 - das Blatt zum Ausdrucken */
{
  const [sheet] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 15000 }),
    page.evaluate(`${ROOT}.querySelector('[data-act="print"]').click()`)
  ]);
  await sheet.waitForLoadState('domcontentloaded');
  const text = await sheet.evaluate(() => document.body.innerText);

  check('Das Blatt trägt das Fahrzeug im Titel',
    (await sheet.title()).includes('Volkswagen Touran'), true);
  check('Fahrzeugdaten stehen drauf', text.includes('WVGZZZ1T4PW004548'), true);
  check('Die Rechnung steht drauf', /Effektivpreis/.test(text) && /20\.730/.test(text), true);
  check('Alle Mängel stehen drauf',
    await sheet.evaluate(() => document.querySelectorAll('table tbody tr').length >= 6), true);
  check('Mit Beleg-Zitat', await sheet.evaluate(() => Boolean(document.querySelector('.quote'))), true);
  check('Werthaltige Ausstattung hervorgehoben',
    await sheet.evaluate(() => document.querySelectorAll('.chip.value').length), 4);
  check('Übrige Ausstattung als Liste',
    await sheet.evaluate(() => document.querySelectorAll('.cols div').length), 4);
  check('Die Einschätzung steht drauf', /Nachverhandeln/.test(text), true);
  check('Quelle und Vorbehalt im Fuß',
    /Ersetzt keine Besichtigung/.test(text) && /de\.bca-europe\.com/.test(text), true);
  check('Es druckt sich ohne Skripte von aussen',
    await sheet.evaluate(() => document.querySelectorAll('script[src], link[rel=stylesheet]').length), 0);
  await sheet.close();
}

check('Keine Fehler im Service Worker', swErrors, []);

await ctx.close();
siteServer.close();
apiServer.close();
console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
