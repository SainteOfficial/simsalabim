/**
 * Übergabe großer PDFs und paralleles Laden.
 *
 *   npm run build && node test/handoff.mjs
 *
 * Zwei Punkte aus einem echten Lauf bei BCA:
 *
 *  - Ein Fahrzeug-PDF, das serverseitig erst erzeugt werden muss, brauchte
 *    knapp eine Minute. Danach war es zu groß für chrome.runtime.sendMessage,
 *    wurde verworfen und vom Hintergrunddienst ein zweites Mal angefordert -
 *    dieselbe Minute noch einmal. Jetzt gehen die Bytes über den Speicher; das
 *    Portal wird genau einmal gefragt.
 *  - Drei Dokumente wurden nacheinander geladen, jedes wartete auf das vorige.
 *    Jetzt laufen sie gleichzeitig.
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
const PROFILE = path.join(HERE, '.profile-handoff');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SITE_PORT = 8781;
const API_PORT = 8782;
const HOST = 'de.bca-europe.com';
const SLOW_MS = 1500;

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

const pdfHits = [];
const siteServer = https.createServer(certificate(HOST), (req, res) => {
  const u = new URL(req.url, `https://${HOST}`);

  if (u.pathname.endsWith('.pdf')) {
    pdfHits.push({ path: u.pathname, at: Date.now() });
    // Bewusst langsam: nur so lässt sich zeigen, dass gleichzeitig geladen
    // wird und dass eine zweite Anfrage echte Zeit kosten würde.
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(PDF);
    }, SLOW_MS);
    return;
  }

  const two = u.searchParams.get('id') === 'zwei';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Volkswagen Touran</title></head>
<body><h1>Volkswagen Touran 2.0 TDI</h1>
<p><a href="/zustandsbericht.pdf">Fahrzeug PDF</a>
${two ? '<a href="/appraisal.pdf">Appraisal</a>' : ''}</p>
<table><tr><td>Fahrgestellnummer</td><td>WVGZZZ1T4PW004548</td></tr></table></body></html>`);
});

const MOCK = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'mock-response.json'), 'utf8'));
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
let apiCalls = 0;
const apiServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    apiCalls++;
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
  ignoreHTTPSErrors: true
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;
const swErrors = [];
sw.on('console', (m) => m.type() === 'error' && swErrors.push(m.text()));

async function settings(patch) {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/src/options/options.html`);
  await p.evaluate((v) => chrome.storage.local.set(v), patch);
  await p.close();
}

const ROOT = `document.getElementById('vms-host')?.shadowRoot?.querySelector('.vms-root')`;

async function run(id) {
  pdfHits.length = 0;
  const page = await ctx.newPage();
  await page.goto(`https://${HOST}/lot?id=${id}`);
  await page
    .waitForFunction(`['done', 'error'].includes(${ROOT}?.dataset.status)`, null, { timeout: 90000 })
    .catch(() => {});
  const status = await page.evaluate(`${ROOT}?.dataset.status`);
  await page.close();
  return status;
}

/* 1 - zu groß für eine Nachricht: über den Speicher, nicht per zweitem Download */
{
  // Die Grenze künstlich auf 1 kB: damit gilt schon das Test-PDF als zu groß.
  await settings({
    apiKey: 'sk-or-test',
    apiBase: `http://127.0.0.1:${API_PORT}/v1`,
    autoRun: true,
    cacheEnabled: false,
    panelCollapsed: false,
    maxInlineBase64: 1000
  });
  const before = apiCalls;
  const status = await run('eins');
  check('Analyse läuft trotz Übergabe über den Speicher durch', status, 'done');
  check('Das Portal wurde genau einmal gefragt', pdfHits.length, 1);
  check('Ein API-Aufruf', apiCalls - before, 1);

  const leftovers = await (async () => {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/src/options/options.html`);
    const keys = await p.evaluate(async () =>
      Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('handoff:'))
    );
    await p.close();
    return keys;
  })();
  check('Keine Übergabe-Reste im Speicher', leftovers, []);
}

/* 2 - zwei Dokumente werden gleichzeitig geladen, nicht nacheinander */
{
  await settings({ maxInlineBase64: 24 * 1024 * 1024 });
  const started = Date.now();
  const status = await run('zwei');
  const elapsed = Date.now() - started;

  check('Analyse mit zwei Dokumenten läuft durch', status, 'done');
  check('Beide Dokumente wurden geladen', pdfHits.length, 2);
  // Nacheinander waeren es mindestens 2 x SLOW_MS gewesen.
  check('Die Anfragen überlappen sich',
    pdfHits.length === 2 && Math.abs(pdfHits[1].at - pdfHits[0].at) < SLOW_MS, true);
  check('Insgesamt schneller als zweimal die Wartezeit', elapsed < SLOW_MS * 2 + 8000, true);
}

check('Keine Fehler im Service Worker', swErrors, []);

await ctx.close();
siteServer.close();
apiServer.close();
console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
