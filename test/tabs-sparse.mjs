/**
 * Test für "Berechnet" und "Meinung", wenn die Datenlage dünn ist.
 *
 *   node test/tabs-sparse.mjs
 *
 * Der Regelfall bei einem Zustandsbericht: Schäden ja, Euro-Beträge nein.
 * Vorher blieb "Berechnet" dann bei zwei Zeilen stehen und "Meinung" zeigte
 * bei einem Urteil "unklar" nur einen Score-Ring mit 0 – was sich wie
 * Totalschaden liest, obwohl gerade die Angaben fehlen.
 *
 * Drei Datenlagen:
 *   A) voll     – Beträge, Preis, Urteil (wie test/e2e.mjs)
 *   B) dünn     – Befunde ohne einen einzigen Betrag
 *   C) unklar   – Modell kann kein Urteil bilden
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
const PROFILE = path.join(HERE, '.profile-sparse');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SITE_PORT = 8851;
const API_PORT = 8852;
const HOST = 'de.bca-europe.com';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      erwartet: ${JSON.stringify(expected)}\n      erhalten: ${JSON.stringify(actual)}`}`);
  ok ? passed++ : failed++;
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

/* ------------------------------------------------------------ Datenlagen */

const FULL = JSON.parse(
  JSON.parse(fs.readFileSync(path.join(FIXTURES, 'mock-response.json'), 'utf8'))
    .choices[0].message.content
);

/** Befunde wie gehabt, aber das Dokument nennt keinen einzigen Betrag. */
function sparse() {
  const c = structuredClone(FULL);
  c.total_estimated_repair_cost_eur = null;
  c.defects.forEach((d) => (d.estimated_cost_eur = null));
  c.verdict.repair_budget_min_eur = null;
  c.verdict.repair_budget_max_eur = null;
  c.verdict.negotiation_points.forEach((p) => (p.amount_eur = null));
  return c;
}

/** Datenlage reicht nicht für ein Urteil. */
function unclear() {
  const c = sparse();
  c.overall_condition = 'unbekannt';
  c.summary = '';
  c.confidence = 0.31;
  c.verdict = {
    recommendation: 'unklar',
    score: 0, // genau der Fall: das Modell liefert 0 statt null
    headline: '',
    reasons: [],
    deal_breakers: [],
    negotiation_points: [],
    before_first_drive: [],
    repair_budget_min_eur: null,
    repair_budget_max_eur: null,
    price_assessment: null
  };
  return c;
}

const PDF = fs.readFileSync(path.join(FIXTURES, 'zustandsbericht.pdf'));

const siteServer = https.createServer(certificate(HOST), (req, res) => {
  const u = new URL(req.url, `https://${HOST}`);
  if (u.pathname === '/zustandsbericht.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(PDF);
    return;
  }
  if (u.pathname !== '/lot') {
    res.writeHead(404).end('not found');
    return;
  }
  // "mit-preis" nennt den Preis in einer Tabellenzeile, "text:<...>" als
  // Fliesstext - damit laesst sich die Erkennung einzeln pruefen.
  const id = u.searchParams.get('id') || '';
  const withPrice = id === 'mit-preis';
  const freeText = id.startsWith('text:') ? decodeURIComponent(id.slice(5)) : '';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Volkswagen Touran</title></head>
<body><h1>Volkswagen Touran 2.0 TDI</h1>
<p><a href="/zustandsbericht.pdf">Fahrzeug PDF</a></p>
${freeText ? `<p>${freeText}</p>` : ''}
<table>
<tr><td>Fahrgestellnummer</td><td>WVGZZZ1T4PW004548</td></tr>
<tr><td>Kilometerstand</td><td>207121 km</td></tr>
${withPrice ? '<tr><td>Sofortkauf</td><td>18.900 EUR</td></tr>' : ''}
</table></body></html>`);
});

let payload = FULL;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const apiServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
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
  viewport: { width: 1180, height: 900 }
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

/** Öffnet die Fahrzeugseite mit der gewünschten Datenlage und liest beide Tabs. */
async function open(data, id) {
  payload = data;
  const page = await ctx.newPage();
  await page.goto(`https://${HOST}/lot?id=${id}`);
  await page
    .waitForFunction(`['done', 'error'].includes(${ROOT}?.dataset.status)`, null, { timeout: 60000 })
    .catch(() => {});
  const at = async (tab) => {
    await page.evaluate(`${ROOT}.querySelector('[data-act="tab"][data-value="${tab}"]').click()`);
    await page.waitForTimeout(450);
  };
  const q = (expr) => page.evaluate(`(() => { const r = ${ROOT}; return ${expr}; })()`);
  return { page, at, q, status: await page.evaluate(`${ROOT}?.dataset.status`) };
}

const labels = `[...r.querySelectorAll('.vms-calc-row')].map(x => x.querySelector('.vms-calc-label').firstChild.textContent.trim())`;
const valueOf = (label) =>
  `[...r.querySelectorAll('.vms-calc-row')].find(x => x.querySelector('.vms-calc-label').firstChild.textContent.trim() === ${JSON.stringify(label)})?.querySelector('.vms-calc-value').textContent.replace(/\\s/g, ' ').trim()`;

/* 1 - volle Datenlage: die Kostenrechnung bleibt wie sie war */
{
  const { page, at, q } = await open(FULL, 'mit-preis');
  await at('berechnet');
  check('Voll: belegte Reparatursumme', await q(valueOf('Reparatur belegt')), '1.830 €');
  check('Voll: Effektivpreis', await q(valueOf('Effektivpreis')), '20.730 €');
  check('Voll: Balken zeigen Beträge', await q(`r.querySelector('.vms-bar-value')?.textContent.includes('€')`), true);
  check('Voll: kein Hinweis auf fehlende Beträge', await q(`Boolean(r.querySelector('.vms-calc-hint'))`), false);
  await at('meinung');
  check('Voll: Score-Ring mit Zahl', await q(`r.querySelector('.vms-ring-num')?.textContent.trim()`), '58');
  await page.close();
}

/* 2 - dünne Datenlage: keine Beträge im Dokument */
{
  const { page, at, q } = await open(sparse(), 'ohne-preis');
  await at('berechnet');
  // Das ist der Kern: der Tab bleibt nutzbar, obwohl nichts beziffert ist.
  check('Dünn: Hinweis, dass das Dokument nichts beziffert', await q(`Boolean(r.querySelector('.vms-calc-hint'))`), true);
  check('Dünn: gezählte Mängel', await q(valueOf('Mängel gesamt')), '6');
  check('Dünn: kritische Befunde gezählt', await q(valueOf('davon kritisch')), '3');
  check('Dünn: HU-Relevanz gezählt', await q(valueOf('HU-/TÜV-relevant')), '3 von 6');
  check('Dünn: Reifen unter 3 mm gezählt', await q(valueOf('Reifen unter 3 mm')), '2 von 4');
  check('Dünn: dünnstes Profil ausgewiesen',
    await q(`[...r.querySelectorAll('.vms-calc-label small')].some(x => x.textContent.includes('1,4 mm'))`), true);
  check('Dünn: Balken zählen statt zu summieren',
    await q(`r.querySelector('.vms-bar-value')?.textContent.trim()`), '1 Befund');
  check('Dünn: Balken sind trotzdem da', await q(`r.querySelectorAll('.vms-bar').length > 0`), true);
  check('Dünn: Verhandlungshebel stehen offen', await q(`Boolean(r.querySelector('.vms-fold[open]'))`), true);
  check('Dünn: keine erfundene Reparatursumme', await q(labels + `.includes('Reparatur belegt')`), false);
  await page.close();
}

/* 3 - kein Urteil möglich */
{
  const { page, at, q } = await open(unclear(), 'ohne-preis');
  await at('meinung');
  // Eine 0 im Ring liest sich wie Totalschaden - bei "unklar" darf da nichts stehen.
  check('Unklar: kein irreführender Score', await q(`r.querySelector('.vms-ring-num')?.textContent.trim() ?? null`), null);
  check('Unklar: leerer Ring statt Zahl', await q(`Boolean(r.querySelector('.vms-ring.empty'))`), true);
  check('Unklar: Empfehlung benannt', await q(`r.querySelector('.vms-verdict-label span')?.textContent.trim()`), 'Unklar');
  check('Unklar: Ersatz-Überschrift statt leerer Zeile',
    await q(`r.querySelector('.vms-verdict-line')?.textContent.trim()`),
    'Für ein Urteil reichen die Angaben im Dokument nicht aus.');
  check('Unklar: "Warum unklar" erklärt die Lücke',
    await q(`r.querySelector('.vms-callout.muted .vms-callout-head strong')?.textContent.trim()`), 'Warum unklar');
  check('Unklar: die fehlende Angabe steht da',
    await q(`r.querySelector('.vms-callout.muted li')?.textContent.trim()`), 'kein Fehlerspeicher-Auslesen dokumentiert');
  await page.close();
}

/* 4 - Preiserkennung. Ein falscher Preis verfaelscht die ganze Kostenrechnung,
      deshalb im Zweifel lieber keiner. */
{
  const cases = [
    ['Kaufpreis 18900 EUR', '18.900 €', 'ohne Tausenderpunkt'],
    ['Preis 1.118.900 EUR', '1.118.900 €', 'zwei Tausendergruppen'],
    ['Preis: EUR 18.900', '18.900 €', 'Waehrung vor dem Betrag'],
    ['Versandkosten 49 EUR und Sofortkauf 18.900 EUR', '18.900 €', 'Gebuehr davor wird uebergangen'],
    ['Nur ein Betrag auf der Seite: 18.900 EUR', '18.900 €', 'unbeschriftet, aber eindeutig'],
    ['Transportpauschale 750 EUR, Zulassung 890 EUR', undefined, 'mehrdeutig -> gar kein Preis'],
    ['Auktion endet 2024', undefined, 'keine Waehrung -> kein Preis']
  ];
  for (const [text, want, why] of cases) {
    const { page, at, q } = await open(FULL, `text:${encodeURIComponent(text)}`);
    await at('berechnet');
    check(`Preis (${why})`, await q(valueOf('Angebotspreis')), want);
    await page.close();
  }
}

check('Keine Fehler im Service Worker', swErrors, []);

await ctx.close();
siteServer.close();
apiServer.close();
console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
