/**
 * Gegenprobe für eine leere Mängelliste.
 *
 *   npm run build && node test/empty-recheck.mjs
 *
 * Beobachtet an einem echten BCA-Zustandsbericht: die Analyse meldete "Keine
 * Mängel dokumentiert", während dieselbe Datei im Chat mehrere Vorschäden und
 * wertmindernde Faktoren hergab. Der eine große Aufruf mit vollem Schema ist
 * für ein kleines Modell die schwerere Aufgabe als die freie Frage.
 *
 * Zwei Fälle:
 *   A) Der zweite Anlauf in kleineren Teilen findet die Mängel doch.
 *   B) Auch der zweite Anlauf bleibt leer - dann darf das Panel kein
 *      beruhigendes "keine Mängel" zeigen, sondern muss den Widerspruch
 *      benennen. Ein falsches Entwarnen ist beim Auktionskauf der teuerste
 *      Fehler.
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
const PROFILE = path.join(HERE, '.profile-recheck');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SITE_PORT = 8791;
const API_PORT = 8792;
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
  if (u.pathname === '/zustandsbericht.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(PDF);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Volkswagen Touran</title></head>
<body><h1>Volkswagen Touran 2.0 TDI</h1>
<p><a href="/zustandsbericht.pdf">Fahrzeug PDF</a></p>
<table><tr><td>Fahrgestellnummer</td><td>WVGZZZ1T4PW004548</td></tr></table></body></html>`);
});

/* -------------------------------------------------------- Antwortformen */

const VEHICLE = {
  title: 'Volkswagen Touran',
  vin: 'WVGZZZ1T4PW004548',
  mileage_km: 207121,
  first_registration: null,
  report_date: null
};

const VERDICT = {
  recommendation: 'nachverhandeln',
  score: 60,
  headline: 'Mehrere dokumentierte Befunde.',
  reasons: ['Vorschaden dokumentiert.'],
  deal_breakers: [],
  negotiation_points: [],
  before_first_drive: [],
  repair_budget_min_eur: null,
  repair_budget_max_eur: null,
  price_assessment: null
};

const defect = (title) => ({
  title,
  description: `${title} laut Zustandsbericht.`,
  area: 'Seitenwand links',
  category: 'karosserie',
  severity: 'mittel',
  estimated_cost_eur: null,
  affects_roadworthiness: false,
  source_page: 1,
  quote: title
});

/** Vollständige Analyse, wahlweise mit oder ohne Mängel. */
const single = (defects) => ({
  vehicle: VEHICLE,
  report_found: true,
  overall_condition: 'befriedigend',
  summary: 'Zustandsbericht ausgewertet.',
  total_estimated_repair_cost_eur: null,
  defects,
  tires: [],
  missing_info: [],
  confidence: 0.7,
  verdict: VERDICT
});

const chunk = (defects) => ({
  vehicle: VEHICLE,
  report_found: true,
  defects,
  tires: [],
  missing_info: [],
  confidence: 0.7
});

const synthesis = () => ({
  overall_condition: 'befriedigend',
  summary: 'Zusammengeführt.',
  total_estimated_repair_cost_eur: null,
  duplicate_indices: [],
  verdict: VERDICT
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// 'recover' = zweiter Anlauf findet Mängel, 'never' = bleibt überall leer
let scenario = 'recover';
const calls = [];

const apiServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const text = String(parsed.messages?.[1]?.content ?? '');
    const kind = text.includes('### Gefundene Mängel')
      ? 'synthesis'
      : / - Teil \d+ von /.test(text)
        ? 'chunk'
        : 'single';
    calls.push(kind);

    let payload;
    if (kind === 'synthesis') payload = synthesis();
    else if (kind === 'chunk') payload = chunk(scenario === 'recover' ? [defect('Delle Seitenwand links')] : []);
    else payload = single([]);

    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  });
});

await new Promise((r) => siteServer.listen(SITE_PORT, '127.0.0.1', r));
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

async function run(id) {
  calls.length = 0;
  const page = await ctx.newPage();
  await page.goto(`https://${HOST}/lot?id=${id}`);
  await page
    .waitForFunction(`['done', 'error'].includes(${ROOT}?.dataset.status)`, null, { timeout: 90000 })
    .catch(() => {});
  const q = (expr) => page.evaluate(`(() => { const r = ${ROOT}; return ${expr}; })()`);
  return { page, q };
}

/* 1 - der zweite Anlauf findet die Mängel doch */
{
  scenario = 'recover';
  const { page, q } = await run('recover');
  check('Erster Aufruf blieb leer, danach wurde in Teilen geprüft',
    calls.filter((c) => c === 'single').length >= 1 && calls.includes('chunk'), true);
  check('Zweiter Anlauf liefert Mängel', await q(`r.querySelectorAll('.vms-defect').length > 0`), true);
  check('Kein Warnhinweis, wenn es geklappt hat',
    await q(`Boolean(r.querySelector('[data-act="rerun"].bg-panel-accent'))`), false);
  check('Der Modus im Fuß nennt die Teilauswertung',
    await q(`r.querySelector('.vms-meta-line')?.textContent.includes('Aufrufe')`), true);
  await page.close();
}

/* 2 - auch der zweite Anlauf bleibt leer */
{
  scenario = 'never';
  const { page, q } = await run('never');
  // Das ist der Kern: nicht beruhigen, sondern den Widerspruch benennen.
  check('Kein beruhigendes "Keine Mängel dokumentiert"',
    await q(`r.textContent.includes('Keine Mängel dokumentiert')`), false);
  check('Der Widerspruch wird benannt',
    await q(`r.textContent.includes('Auswertung passt nicht zum Dokument')`), true);
  check('Warnung nennt die Zahl der Befundwörter',
    await q(`/\\d+ verschiedene\\s+Begriffe/.test(r.textContent.replace(/\\s+/g, ' '))`), true);
  check('Neu auswerten wird angeboten',
    await q(`Boolean(r.querySelector('[data-act="rerun"]'))`), true);
  check('Auch hier wurde ein zweiter Anlauf versucht', calls.includes('chunk'), true);
  await page.close();
}

check('Keine Fehler im Service Worker', swErrors, []);

await ctx.close();
siteServer.close();
apiServer.close();
console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
