/**
 * Regressionstest fuer den BCA-Dokumentenabruf.
 *
 *   node test/bca-viewpdf.mjs
 *
 * Bildet die echte BCA-Topologie nach: die Fahrzeugseite liegt auf
 * de.bca-europe.com, das Dokument auf einem anderen Origin
 * (classic.bca-europe.com) und ist nur mit Session-Cookie abrufbar.
 *
 * Zwei Fälle:
 *   A) Der Endpunkt liefert das PDF direkt - sobald die Session mitkommt.
 *   B) Der Endpunkt liefert erst eine Warteseite; das Dokument entsteht
 *      überhaupt nur, wenn das JavaScript der Seite läuft. Genau das
 *      passiert beim Anklicken von Hand – und genau daran ist die Extension
 *      vorher gescheitert.
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
const PROFILE = path.join(HERE, '.profile-bca');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SITE_PORT = 8871;
const DOC_PORT = 8872;
const API_PORT = 8873;
const SITE_HOST = 'de.bca-europe.com';
const DOC_HOST = 'classic.bca-europe.com';
const SESSION = 'ASP.NET_SessionId=abc123sessionvalue';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      erwartet: ${JSON.stringify(expected)}\n      erhalten: ${JSON.stringify(actual)}`}`);
  ok ? passed++ : failed++;
}

const PDF = fs.readFileSync(path.join(FIXTURES, 'zustandsbericht.pdf'));

/** Selbstsigniertes Wegwerf-Zertifikat je Testhost, nicht eingecheckt. */
function certificate(cn) {
  const dir = path.join(FIXTURES, 'cert-' + cn);
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '3650',
      '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`
    ], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/* --------------------------------------------------------------- Server */

// Fahrzeugseite: setzt die Session wie ASP.NET (ohne SameSite -> Chrome: Lax)
// und verlinkt das Dokument auf dem zweiten Origin.
const siteServer = https.createServer(certificate(SITE_HOST), (req, res) => {
  const u = new URL(req.url, `https://${SITE_HOST}`);
  if (u.pathname !== '/lot') {
    res.writeHead(404).end('not found');
    return;
  }
  const id = u.searchParams.get('id') || '';
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Set-Cookie': `${SESSION}; Path=/; Domain=.bca-europe.com; Secure`
  });
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Volkswagen Touran 2.0 TDI</title></head>
<body><h1>Volkswagen Touran 2.0 TDI</h1>
<p><a href="https://${DOC_HOST}/Classic/Pages/ViewPDF.aspx?VehId=${id}&Index=5&SubIndex=6">Fahrzeug PDF</a></p>
<table>
<tr><td>Fahrgestellnummer</td><td>WVGZZZ1T4PW004548</td></tr>
<tr><td>Erstzulassung</td><td>16/11/2022</td></tr>
<tr><td>Kilometerstand</td><td>207121 km</td></tr>
</table></body></html>`);
});

const docRequests = [];
const generatedFor = new Set();

// Dokument-Endpunkt. "direkt" liefert das PDF sofort, "warte" erst nachdem das
// Skript der Seite die Erzeugung angestoßen hat. X-Frame-Options wie üblich:
// ein verstecktes iFrame kann das Skript deshalb nicht ausführen.
const docServer = https.createServer(certificate(DOC_HOST), (req, res) => {
  const u = new URL(req.url, `https://${DOC_HOST}`);
  const veh = u.searchParams.get('VehId') || '';
  const hasSession = (req.headers.cookie || '').includes(SESSION);
  docRequests.push({
    path: u.pathname,
    veh,
    hasSession,
    origin: req.headers.origin || null,
    dest: req.headers['sec-fetch-dest'] || null,
    // 'none' = Anfrage des Hintergrunddienstes, 'same-origin' = die Seite selbst
    site: req.headers['sec-fetch-site'] || null
  });

  if (u.pathname.endsWith('GeneratePDF.aspx')) {
    generatedFor.add(veh);
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (!u.pathname.endsWith('ViewPDF.aspx')) {
    res.writeHead(404).end('not found');
    return;
  }
  if (!hasSession) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><h1>Bitte melden Sie sich an</h1></body></html>');
    return;
  }
  if (veh.startsWith('warte') && !generatedFor.has(veh)) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'SAMEORIGIN'
    });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Dokument</title></head>
<body><h1>Ihr Dokument wird vorbereitet</h1><p>Bitte warten...</p>
<script>fetch('/Classic/Pages/GeneratePDF.aspx?VehId=${veh}').then(() => setTimeout(() => location.reload(), 400));<\/script>
</body></html>`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'X-Frame-Options': 'SAMEORIGIN' });
  res.end(PDF);
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
await new Promise((r) => docServer.listen(DOC_PORT, '127.0.0.1', r));
await new Promise((r) => apiServer.listen(API_PORT, '127.0.0.1', r));

/* -------------------------------------------------------------- Browser */

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
    `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1:${SITE_PORT}, MAP ${DOC_HOST} 127.0.0.1:${DOC_PORT}`
  ],
  ignoreHTTPSErrors: true
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

async function run(id, timeout) {
  const page = await ctx.newPage();
  const corsErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /CORS/i.test(m.text())) corsErrors.push(m.text());
  });
  await page.goto(`https://${SITE_HOST}/lot?id=${id}`);
  await page.waitForFunction(ROOT, null, { timeout: 20000 });
  await page
    .waitForFunction(`['done', 'error'].includes(${ROOT}?.dataset.status)`, null, { timeout })
    .catch(() => {});
  const status = await page.evaluate(`${ROOT}?.dataset.status`);
  const error = await page.evaluate(`${ROOT}?.querySelector('.vms-error')?.textContent?.trim() || null`);
  await page.close();
  return { status, error, corsErrors };
}

/* 1 - Dokument auf fremdem Origin, nur mit Session abrufbar */
{
  const before = apiCalls;
  const r = await run('direkt0001', 60000);
  check('Fremder Origin: Analyse läuft durch', r.status, 'done');
  check('Fremder Origin: kein Fehler', r.error, null);
  check('Fremder Origin: ein API-Aufruf', apiCalls - before, 1);
  check('Fremder Origin: kein CORS-Fehler in der Seite', r.corsErrors.length, 0);
  const viewPdf = docRequests.filter((d) => d.path.endsWith('ViewPDF.aspx'));
  check('Fremder Origin: nur der Hintergrunddienst lädt (kein Origin-Header)', viewPdf.every((d) => d.origin === null), true);
  check('Fremder Origin: jede Anfrage trägt die Session', viewPdf.every((d) => d.hasSession), true);
}

/* 2 - Warteseite: das Dokument entsteht erst, wenn die Seite wirklich läuft */
{
  docRequests.length = 0;
  const before = apiCalls;
  const r = await run('warte0002', 120000);
  check('Warteseite: Analyse läuft durch', r.status, 'done');
  check('Warteseite: kein Fehler', r.error, null);
  check('Warteseite: ein API-Aufruf', apiCalls - before, 1);
  check('Warteseite: Erzeugung wurde angestoßen', generatedFor.has('warte0002'), true);
  check(
    'Warteseite: Seite wurde als echtes Dokument geöffnet, nicht als iFrame',
    docRequests.some((d) => d.dest === 'document'),
    true
  );
  // Der Erzeugungs-Endpunkt darf nur von der Seite selbst gerufen werden.
  // Früher ist der Poll auf diesen Link gesprungen und mit "Antwort ist kein
  // PDF (Content-Type: text/plain)" abgebrochen.
  check(
    'Warteseite: der Poll springt nicht auf den Erzeugungs-Endpunkt',
    docRequests.filter((d) => d.path.endsWith('GeneratePDF.aspx') && d.site === 'none').length,
    0
  );
  check(
    'Warteseite: die Seite selbst hat die Erzeugung gerufen',
    docRequests.some((d) => d.path.endsWith('GeneratePDF.aspx') && d.site === 'same-origin'),
    true
  );
}

check('Keine Fehler im Service Worker', swErrors, []);

await ctx.close();
siteServer.close();
docServer.close();
apiServer.close();

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
