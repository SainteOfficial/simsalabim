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
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
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
// Die Extension läuft laut Manifest nur auf https://de.bca-europe.com - der Test
// leitet diesen Host im Testbrowser auf den lokalen Fixture-Server um.
const HOST = 'de.bca-europe.com';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      erwartet: ${JSON.stringify(expected)}\n      erhalten: ${JSON.stringify(actual)}`}`);
  ok ? passed++ : failed++;
}

/* ------------------------------------------------------------- Server */

const TYPES = { '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf' };

/**
 * Bildet die BCA-Adressform nach: /lot?id=<fixture> liefert die Fahrzeugseite,
 * alle anderen Pfade die Datei mit diesem Namen (PDFs, Negativfälle).
 */
function serveFixture(req, res) {
  const url = new URL(req.url, `https://${HOST}`);
  const name =
    url.pathname === '/lot'
      ? url.searchParams.get('id') || 'index.html'
      : path.basename(decodeURIComponent(url.pathname)) || 'index.html';
  const file = path.join(FIXTURES, name);
  if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

/**
 * Selbstsigniertes Wegwerf-Zertifikat für den Testhost. Wird beim ersten Lauf
 * erzeugt und ist absichtlich nicht eingecheckt.
 */
function testCertificate() {
  const dir = path.join(FIXTURES, 'cert');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '3650',
      '-subj', `/CN=${HOST}`,
      '-addext', `subjectAltName=DNS:${HOST},DNS:localhost,IP:127.0.0.1`
    ], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const siteServer = https.createServer(testCertificate(), serveFixture);

const MOCK = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'mock-response.json'), 'utf8'));
const MOCK_DELAY_MS = Number(process.env.MOCK_DELAY_MS || 0);
let apiCalls = 0;
let lastRequest = null;
let requests = [];
// Die Extension hat nur noch für openrouter.ai eine Host-Berechtigung; der Mock
// liegt auf einem anderen Ursprung und muss deshalb CORS beantworten.
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
    apiCalls++;
    try {
      lastRequest = JSON.parse(body || '{}');
      requests.push(lastRequest);
    } catch {
      lastRequest = null;
    }
    const reply = () => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(MOCK));
    };
    MOCK_DELAY_MS ? setTimeout(reply, MOCK_DELAY_MS) : reply();
  });
});

await new Promise((r) => siteServer.listen(SITE_PORT, '127.0.0.1', r));
await new Promise((r) => apiServer.listen(API_PORT, '127.0.0.1', r));
const site = (f) => `https://${HOST}/lot?id=${f}`;
const raw = (p) => `https://${HOST}/${p}`;

/* ------------------------------------------------------------ Browser */

fs.rmSync(PROFILE, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-sandbox',
    '--ignore-certificate-errors',
    // Der Testbrowser darf nicht über einen Umgebungs-Proxy gehen, sonst greifen
    // die Host-Umleitungen auf den lokalen Fixture-Server nicht.
    '--no-proxy-server',
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${SITE_PORT}, MAP www.example.com 127.0.0.1:${SITE_PORT}`
  ],
  ignoreHTTPSErrors: true,
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
const openTab = async (page, id) => {
  await page.evaluate(`${ROOT}.querySelector('[data-act="tab"][data-value="${id}"]').click()`);
  await page.waitForTimeout(650);
};

/* 1 – ohne API-Key fuehrt die Extension zur Einrichtung */
let page = await ctx.newPage();
await page.goto(site('vehicle.html'));
await page.waitForFunction(ROOT, null, { timeout: 20000 });
await waitDone(page).catch(() => {});
check('Ohne API-Key: Hinweis + Button', await evalRoot(page, `r.querySelector('.vms-primary')?.textContent.trim()`), 'API-Key eintragen');
await page.close();

async function settings(patch) {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/src/options/options.html`);
  await p.evaluate((v) => chrome.storage.local.set(v), patch);
  await p.close();
}
await settings({
  apiKey: 'sk-or-test',
  apiBase: `http://127.0.0.1:${API_PORT}/v1`,
  autoRun: true,
  cacheEnabled: true,
  maxChars: 120000,
  panelCollapsed: false
});

/* 2 – ohne Dokument auf der Seite kein Panel */
{
  const p = await ctx.newPage();
  await p.goto(site('nodoc.html'));
  await p.waitForTimeout(3500);
  check('Kein Panel ohne Dokument-Link', await p.evaluate(`Boolean(${ROOT})`), false);
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

check('Details sind zugeklappt unsichtbar', await evalRoot(page, `r.querySelector('.vms-defect .vms-defect-inner').getBoundingClientRect().height`), 0);
await page.evaluate(`${ROOT}.querySelector('.vms-defect-head').click()`);
await page.waitForTimeout(450);
check('Mangel aufklappbar mit Beleg-Zitat', await evalRoot(page, `Boolean(r.querySelector('.vms-defect.open blockquote'))`), true);
check('Aufgeklappt hat der Inhalt Höhe', await evalRoot(page, `r.querySelector('.vms-defect.open .vms-defect-inner').getBoundingClientRect().height > 40`), true);
check('Kopfzeile bleibt sachlich (keine Meinung)', await evalRoot(page, `[r.querySelector('.vms-badge')?.textContent.trim(), r.querySelector('.vms-badge')?.title]`), ['6 Mängel', '6 Mängel, davon 3 kritisch']);
check('Start zeigt den Mängel-Tab', await evalRoot(page, `r.dataset.tab`), 'maengel');
check('Kein Urteil auf dem Mängel-Tab', await evalRoot(page, `Boolean(r.querySelector('.vms-verdict, .vms-ring, .vms-callout'))`), false);
check('Drei Tabs vorhanden', await evalRoot(page, `[...r.querySelectorAll('.vms-tab')].map(t => t.dataset.value)`), ['maengel', 'berechnet', 'meinung']);
check('Fahrzeugtitel kommt von der Seite', await evalRoot(page, `r.querySelector('.vms-title')?.title`), 'Volkswagen Touran 2.0 TDI SCR DSG Automatic Diesel');

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
check('Eingeklappt bleibt die Mängelzahl sichtbar', await evalRoot(page, `r.querySelector('.vms-badge')?.textContent.trim()`), '6 Mängel');
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

/* 6 - Kaufempfehlung */
const beforeVerdict = apiCalls;
page = await ctx.newPage();
await page.goto(site('vehicle.html'));
await waitDone(page);
await openTab(page, 'meinung');
check('Meinung liegt in einem eigenen Tab', await evalRoot(page, `r.dataset.tab`), 'meinung');
check('Empfehlungsblock vorhanden', await evalRoot(page, `Boolean(r.querySelector('.vms-verdict.warn'))`), true);
check('Zustands-Score angezeigt', await evalRoot(page, `r.querySelector('.vms-ring-num')?.textContent.trim()`), '58');
check('Score-Ring wird animiert', await evalRoot(page, `(() => { const c = r.querySelector('.vms-ring-value'); return Number(c.style.strokeDashoffset) > 0 && Number(c.style.strokeDashoffset) < Number(c.dataset.offset) * 3; })()`), true);
check('Begründungen gelistet', await evalRoot(page, `r.querySelectorAll('.vms-reasons li').length`), 3);
check('"Vor der ersten Fahrt" als Warnblock', await evalRoot(page, `r.querySelectorAll('.vms-callout.warn li').length`), 2);
check('Keine Ausschlusskriterien -> kein roter Block', await evalRoot(page, `Boolean(r.querySelector('.vms-callout.bad'))`), false);
check('Hinweis auf die Grenzen der Einschätzung', await evalRoot(page, `Boolean(r.querySelector('.vms-disclaimer'))`), true);
await openTab(page, 'berechnet');
check('Verhandlungshebel im Berechnet-Tab, nach Betrag sortiert', await evalRoot(page, `[...r.querySelectorAll('.vms-negotiation li b')].map(b => b.textContent.replace(/\\s/g, ' ').trim())`), ['690 €', '480 €', '310 €']);
check('Kostenbalken je Bereich', await evalRoot(page, `r.querySelectorAll('.vms-bar').length > 0`), true);
await openTab(page, 'maengel');
check('Leseabdeckung ausgewiesen', await evalRoot(page, `r.querySelector('.vms-coverage')?.textContent.trim()`), '1 von 1 Seiten gelesen');
check('Empfehlung kommt aus dem Cache, ohne neuen Aufruf', apiCalls - beforeVerdict, 0);

await page.evaluate(`${ROOT}.querySelector('[data-act="expand-all"]').click()`);
await page.waitForTimeout(300);
check('"Alle Details" klappt alles auf', await evalRoot(page, `[...r.querySelectorAll('.vms-defect')].every(d => d.classList.contains('open'))`), true);
await page.close();

/* 7 - langes Dokument wird vollständig in Teilen ausgewertet */
await settings({ maxChars: 20000 });
requests = [];
const beforeChunks = apiCalls;
page = await ctx.newPage();
await page.goto(site('long.html'));
await waitDone(page, 90000).catch(() => console.log('      (Timeout im Chunk-Lauf)'));

const chunkReqs = requests.filter((r) => String(r.messages?.[1]?.content).includes('Teil '));
const synthesis = requests.filter((r) => String(r.messages?.[1]?.content).includes('Gefundene Mängel'));
check('Dokument wurde in mehrere Teile zerlegt', chunkReqs.length > 1, true);
check('Abschließende Gesamtbewertung', synthesis.length, 1);
check('Aufrufe = Teile + Gesamtbewertung', apiCalls - beforeChunks, chunkReqs.length + 1);

const sentText = chunkReqs.map((r) => r.messages[1].content).join('\n');
const missingPages = Array.from({ length: 30 }, (_, i) => i + 1).filter(
  (n) => !sentText.includes(`MARKER-SEITE-${String(n).padStart(2, '0')}`)
);
check('Alle 30 Seiten an die KI geschickt', missingPages, []);
check('Befund auf Seite 17 enthalten', sentText.includes('Bremsscheiben stark eingelaufen'), true);
check('Befund auf Seite 29 enthalten', sentText.includes('Rost am Laengstraeger'), true);
check('Preis der Seite geht in den Prompt', /preis: 18\.900 EUR/i.test(sentText), true);
check('FIN der Seite geht in den Prompt', sentText.includes('WDB9066331S123456'), true);
check('Panel meldet vollständige Abdeckung', await evalRoot(page, `r.querySelector('.vms-coverage.ok')?.textContent.replace(/\\s+/g, ' ').trim()`), '30 von 30 Seiten gelesen · in 3 Teilen ausgewertet');
await page.close();
await settings({ maxChars: 120000 });

/* 8 - Hybrid: Textseiten + einzelne Bildseite */
requests = [];
const beforeHybrid = apiCalls;
page = await ctx.newPage();
await page.goto(site('hybrid.html'));
await waitDone(page, 60000).catch(() => {});
const hybridReq = requests.at(-1);
const parts = hybridReq?.messages?.[1]?.content;
check('Hybrid: Text UND Bild im selben Aufruf',
  Array.isArray(parts) && parts.some((p) => p.type === 'text' && p.text.includes('Position 1.0')) && parts.some((p) => p.type === 'image_url'), true);
check('Hybrid: nur die textlose Seite als Bild', Array.isArray(parts) ? parts.filter((p) => p.type === 'image_url').length : 0, 1);
check('Hybrid: ein Aufruf', apiCalls - beforeHybrid, 1);
check('Hybrid im Footer ausgewiesen', await evalRoot(page, `r.querySelector('.vms-meta-line')?.textContent.includes('Text + Bild')`), true);
await page.close();

// Zweiter Besuch derselben Hybrid-Seite darf nichts kosten und muss im selben Modus bleiben
const beforeHybrid2 = apiCalls;
page = await ctx.newPage();
await page.goto(site('hybrid.html'));
await waitDone(page, 60000).catch(() => {});
check('Hybrid: zweiter Besuch ohne neuen Aufruf', apiCalls - beforeHybrid2, 0);
check('Hybrid: Modus bleibt stabil', await evalRoot(page, `r.querySelector('.vms-meta-line')?.textContent.includes('Text + Bild')`), true);
await page.close();

// Dasselbe für den reinen Scan
const beforeScan2 = apiCalls;
page = await ctx.newPage();
await page.goto(site('scanned.html'));
await waitDone(page, 60000).catch(() => {});
check('Scan: zweiter Besuch ohne neuen Aufruf', apiCalls - beforeScan2, 0);
await page.close();

/* 9 - Berechnet-Block, Sichtbarkeit und Bedienkomfort */
await settings({ cacheEnabled: false });
page = await ctx.newPage();
await page.goto(site('long.html'));       // Seite mit Preis 18.900 EUR
await waitDone(page, 60000);
await page.waitForTimeout(400);
await openTab(page, 'berechnet');

const calc = await evalRoot(page, `[...r.querySelectorAll('.vms-calc-row')].map(x => [
  x.querySelector('.vms-calc-label').firstChild.textContent.trim(),
  x.querySelector('.vms-calc-value').textContent.replace(/\\s/g, ' ').trim()
])`);
check('Berechnet: belegte Reparatursumme', calc.find((r) => r[0] === 'Reparatur belegt')?.[1], '1.830 €');
check('Berechnet: sicherheitsrelevanter Anteil', calc.find((r) => r[0] === 'davon sicherheitsrelevant')?.[1], '1.000 €');
check('Berechnet: Positionen ohne Betrag', calc.find((r) => r[0] === 'Ohne Betrag im Dokument')?.[1], '2 Positionen');
check('Berechnet: Angebotspreis von der Seite', calc.find((r) => r[0] === 'Angebotspreis')?.[1], '18.900 €');
check('Berechnet: Effektivpreis = Preis + Reparatur', calc.find((r) => r[0] === 'Effektivpreis')?.[1], '20.730 €');
check('Berechnet: Verhandlungsziel = Preis − Hebel', calc.find((r) => r[0] === 'Verhandlungsziel')?.[1], '17.420 €');

// Morph: Höhe wird animiert und der Blob wandert unter den aktiven Tab
const blobBefore = await evalRoot(page, `r.querySelector('.vms-tab-blob').getBoundingClientRect().left`);
await openTab(page, 'meinung');
const blobAfter = await evalRoot(page, `r.querySelector('.vms-tab-blob').getBoundingClientRect().left`);
check('Tab-Blob wandert mit', blobAfter > blobBefore, true);
check('Höhe wird weich gemorpht', await evalRoot(page, `getComputedStyle(r.querySelector('.vms-body')).transitionDuration`), '0.42s');
await openTab(page, 'maengel');

await page.evaluate(`(() => { const i = ${ROOT}.querySelector('.vms-search'); i.value = 'reifen'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await page.waitForTimeout(300);
check('Suche filtert die Liste', await evalRoot(page, `[...r.querySelectorAll('.vms-defect')].filter(d => !d.hidden).length`), 1);
check('Trefferzahl wird angezeigt', await evalRoot(page, `r.querySelector('.vms-hits').textContent.trim()`), '1 von 6 Mängeln');
await page.evaluate(`(() => { const i = ${ROOT}.querySelector('.vms-search'); i.value = 'zzz'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await page.waitForTimeout(250);
check('Leere Suche zeigt Hinweis', await evalRoot(page, `!r.querySelector('.vms-nohits').hidden`), true);
await page.evaluate(`(() => { const i = ${ROOT}.querySelector('.vms-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await page.waitForTimeout(250);

await page.selectOption('#vms-host >> internal:control=enter-frame >> .vms-sort', 'kosten').catch(async () => {
  await page.evaluate(`(() => { const s = ${ROOT}.querySelector('.vms-sort'); s.value = 'kosten'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
});
await page.waitForTimeout(400);
check('Sortierung nach Kosten', await evalRoot(page, `[...r.querySelectorAll('.vms-defect .vms-tag.cost')].map(t => t.textContent.replace(/\\s/g, ' ').trim())`), ['690 €', '480 €', '350 €', '310 €']);

check('Seitensprung verlinkt das PDF', await evalRoot(page, `r.querySelector('.vms-page')?.dataset.page`), '1');

await page.evaluate(`${ROOT}.querySelector('[data-act="theme"]').click()`);
await page.waitForTimeout(250);
check('Theme-Schalter: hell erzwungen', await evalRoot(page, `r.dataset.theme`), 'light');
await page.evaluate(`${ROOT}.querySelector('[data-act="theme"]').click()`);
await page.waitForTimeout(250);
check('Theme-Schalter: dunkel erzwungen', await evalRoot(page, `[r.dataset.theme, getComputedStyle(r).backgroundColor]`), ['dark', 'rgb(22, 24, 29)']);
await page.evaluate(`${ROOT}.querySelector('[data-act="theme"]').click()`);

check('Erkannte Links sind auf der Seite markiert',
  await page.evaluate(`(() => { const a = document.querySelector('[data-autosmaya]'); return [a?.textContent.trim(), a?.getAttribute('data-autosmaya')]; })()`),
  ['Zustandsbericht', 'condition']);

// Toolbar-Symbol trägt das Urteil
const probe = await ctx.newPage();
await probe.goto(`chrome-extension://${extId}/src/options/options.html`);
const badge = await probe.evaluate(async (target) => {
  const tabs = await chrome.tabs.query({ url: target });
  const id = tabs[0]?.id;
  return { text: await chrome.action.getBadgeText({ tabId: id }), title: await chrome.action.getTitle({ tabId: id }) };
}, `https://${HOST}/lot?id=long.html`);
check('Toolbar-Symbol zeigt die Mängelzahl', badge.text, '6');
check('Toolbar-Titel bleibt sachlich', badge.title, 'Autosmaya: 6 Mängel, 3 kritisch');
const probe0 = probe;

// Zustand für das Popup
const popupState = await probe0.evaluate(async (target) => {
  const tabs = await chrome.tabs.query({ url: target });
  return chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATE' });
}, `https://${HOST}/lot?id=long.html`);
check('Popup bekommt Urteil und Leseabdeckung',
  [popupState.status, popupState.verdict.recommendation, popupState.defects, popupState.pages],
  ['done', 'nachverhandeln', 6, 30]);

check('Panel schließt zur Rückhol-Pille', await (async () => {
  await page.evaluate(`${ROOT}.querySelector('[data-act="close"]').click()`);
  await page.waitForTimeout(300);
  return page.evaluate(`(() => {
    const host = document.getElementById('vms-host').shadowRoot;
    return [host.querySelector('.vms-pill-btn span')?.textContent, host.querySelector('.vms-pill-count')?.textContent];
  })()`);
})(), ['6 Mängel', '3']);
await page.evaluate(`document.getElementById('vms-host').shadowRoot.querySelector('[data-act="restore"]').click()`);
await page.waitForTimeout(400);
check('Rückhol-Pille öffnet das Panel wieder', await evalRoot(page, `[Boolean(r.querySelector('.vms-list')), r.dataset.tab]`), [true, 'maengel']);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Esc klappt das Panel ein', await evalRoot(page, `r.classList.contains('collapsed')`), true);
await probe0.close();
await page.close();
await settings({ cacheEnabled: true, panelCollapsed: false, panelTheme: 'auto' });

/* 10 - Adressschranke: nur /lot?id auf de.bca-europe.com */
for (const [name, url] of [
  ['Startseite', raw('')],
  ['Los ohne id', raw('lot')],
  ['anderer Pfad mit id', raw('suche?id=1')],
  ['fremde Domain', 'https://www.example.com/lot?id=bca.html']
]) {
  const p = await ctx.newPage();
  await p.goto(url).catch(() => {});
  await p.waitForTimeout(2500);
  check(`Kein Zugriff: ${name}`, await p.evaluate(`Boolean(${ROOT})`), false);
  await p.close();
}
check('Parameterreihenfolge egal', await (async () => {
  const p = await ctx.newPage();
  await p.goto(`https://${HOST}/lot?ref=abc&id=bca.html`);
  await p.waitForTimeout(3000);
  const has = await p.evaluate(`Boolean(${ROOT})`);
  await p.close();
  return has;
})(), true);

/* 11 - BCA: Portal-Erkennung und Schäden direkt von der Seite */
await settings({ cacheEnabled: true });
page = await ctx.newPage();
await page.goto(site('bca.html'));
await page.waitForFunction(ROOT, null, { timeout: 20000 });

check('Schäden von der Seite sofort sichtbar (vor der KI)',
  await evalRoot(page, `[...r.querySelectorAll('.vms-onpage li')].map(l => l.textContent.trim())`),
  ['Stoßfänger vorne: Kratzer, 20 cm', 'Tür hinten links: Delle, handtellergroß',
   'Windschutzscheibe: Steinschlag im Sichtfeld', 'Felge vorne rechts: Bordsteinschaden']);

await waitDone(page, 60000);
check('BCA: "Appraisal" wird als Zustandsbericht erkannt',
  String(requests.at(-1)?.messages?.[1]?.content || '').includes('Belaege verschlissen') ||
    (await evalRoot(page, `r.dataset.status`)) === 'done', true);
check('BCA: Seiten-Schäden bleiben neben dem Ergebnis stehen',
  await evalRoot(page, `r.querySelectorAll('.vms-onpage li').length`), 4);
check('BCA: Mängel-Tab ist der Startpunkt', await evalRoot(page, `r.dataset.tab`), 'maengel');
await page.close();

/* 12 - Optionsseite und Barrierefreiheit */
const opts = await ctx.newPage();
await opts.goto(`chrome-extension://${extId}/src/options/options.html`);
await opts.waitForTimeout(400);
check('Erlaubte Adresse steht in den Optionen',
  await opts.evaluate(() => document.getElementById('urlPrefixes').value.trim()),
  'https://de.bca-europe.com/lot?id');
check('Modellfeld ist frei beschreibbar mit Vorschlägen',
  await opts.evaluate(() => [
    document.getElementById('model').tagName,
    document.getElementById('model').getAttribute('list'),
    document.querySelectorAll('#modelList option').length > 0
  ]), ['INPUT', 'modelList', true]);
check('Standardmodell ist Nova 2 Lite',
  await opts.evaluate(() => document.getElementById('model').value), 'amazon/nova-2-lite-v1');
await opts.close();

const rm = await ctx.newPage();
await rm.emulateMedia({ reducedMotion: 'reduce' });
await rm.goto(site('vehicle.html'));
await rm.waitForFunction(`${ROOT}?.dataset.status === 'done'`, null, { timeout: 40000 });
await rm.waitForTimeout(300);
check('Reduzierte Bewegung: keine Karten-Animation',
  await evalRoot(rm, `getComputedStyle(r.querySelector('.vms-defect')).animationName`), 'none');
check('Reduzierte Bewegung: kein Höhen-Morph',
  await evalRoot(rm, `getComputedStyle(r.querySelector('.vms-body')).transitionDuration`), '0s');
await openTab(rm, 'meinung');
check('Reduzierte Bewegung: Score-Ring ohne Übergang',
  await evalRoot(rm, `getComputedStyle(r.querySelector('.vms-ring-value')).transitionDuration`), '0s');
await rm.close();

check('Keine Fehler im Service Worker', swErrors, []);

await ctx.close();
siteServer.close();
apiServer.close();
fs.rmSync(PROFILE, { recursive: true, force: true });

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
