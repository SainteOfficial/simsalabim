/**
 * Test der Chat-Funktion.
 *
 *   npm run build && node test/chat.mjs
 *
 * Der Chat beantwortet Fragen ausschließlich aus dem gelesenen Dokument.
 * Geprüft wird, was tatsächlich an die KI geht: der PDF-Text, die Regel
 * "nur aus dem Dokument" – und ein Verlauf, der bei drei Runden gedeckelt
 * bleibt, damit der Tokenverbrauch pro Frage vorhersehbar ist.
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
const PROFILE = path.join(HERE, '.profile-chat');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SITE_PORT = 8841;
const API_PORT = 8842;
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
  if (u.pathname !== '/lot') {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Volkswagen Touran</title></head>
<body><h1>Volkswagen Touran 2.0 TDI</h1>
<p><a href="/zustandsbericht.pdf">Fahrzeug PDF</a></p>
<table>
<tr><td>Fahrgestellnummer</td><td>WVGZZZ1T4PW004548</td></tr>
<tr><td>Kilometerstand</td><td>207121 km</td></tr>
</table></body></html>`);
});

const ANALYSIS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'mock-response.json'), 'utf8'));
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const chatRequests = [];
let answerNo = 0;
const apiServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    // Die Analyse fordert Structured Output an, der Chat nicht.
    if (parsed.response_format?.type === 'json_schema') {
      res.end(JSON.stringify(ANALYSIS));
      return;
    }
    chatRequests.push(parsed);
    answerNo++;
    res.end(JSON.stringify({
      choices: [{ message: { content: `Antwort ${answerNo} aus dem Dokument (Seite 1).` } }]
    }));
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
  viewport: { width: 1180, height: 950 }
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
  cacheEnabled: true,
  panelCollapsed: false
});
await options.close();

const ROOT = `document.getElementById('vms-host')?.shadowRoot?.querySelector('.vms-root')`;
const page = await ctx.newPage();
const pageErrors = [];
// Das Favicon liefert der Fixture-Server nicht - das ist kein Fehler der Extension.
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/favicon|404 \(Not Found\)/i.test(m.text())) return;
  pageErrors.push(m.text());
});
await page.goto(`https://${HOST}/lot?id=chat`);
await page.waitForFunction(`${ROOT}?.dataset.status === 'done'`, null, { timeout: 60000 });

const q = (expr) => page.evaluate(`(() => { const r = ${ROOT}; return ${expr}; })()`);

/* 1 - die React-Insel ist da und trägt keine Voice-Bedienung mehr */
await page.waitForFunction(`${ROOT}?.querySelector('#vms-react-root .vms-chat-input')`, null, { timeout: 15000 });
check('Chat-Insel ist gemountet', await q(`Boolean(r.querySelector('#vms-react-root'))`), true);
check('Kein Mikrofon-Knopf', await q(`[...r.querySelectorAll('#vms-react-root button')].some(b => /voice|mikro/i.test(b.textContent))`), false);
check('Status nennt die Regel',
  await q(`r.querySelector('#vms-react-root p.text-xs')?.textContent.trim()`),
  'Antwortet nur aus dem Dokument');
// Das Kürzel im Knopf war nur Dekoration - ohne Taste dahinter gehört es weg.
check('Kein vorgetäuschtes Tastenkürzel',
  await q(`Boolean(r.querySelector('#vms-react-root kbd'))`), false);

/** Öffnet den Composer, tippt die Frage und schickt sie mit Enter ab. */
async function ask(question) {
  const before = chatRequests.length;
  await page.evaluate(`${ROOT}.querySelector('#vms-react-root button[type="submit"]').click()`);
  await page.waitForTimeout(350);
  await page.evaluate(([sel, text]) => {
    const root = document.getElementById('vms-host').shadowRoot.querySelector('.vms-root');
    const el = root.querySelector(sel);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, ['.vms-chat-input', question]);
  await page.waitForTimeout(120);
  await page.evaluate(`(() => {
    const el = ${ROOT}.querySelector('.vms-chat-input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await page.waitForFunction(`(${chatRequests.length} , true)`, null, { timeout: 100 }).catch(() => {});
  for (let i = 0; i < 60 && chatRequests.length === before; i++) await page.waitForTimeout(200);
  await page.waitForTimeout(400);
}

/* 2 - erste Frage: was geht an die KI? */
await ask('Wie tief ist das Profil hinten rechts?');
check('Eine Chat-Anfrage ging raus', chatRequests.length, 1);

const first = chatRequests[0] || {};
const system = String(first.messages?.[0]?.content || '');
const docMsg = String(first.messages?.[1]?.content || '');
check('Regel "nur aus dem Dokument" im System-Prompt', /ausschließlich aus dem Dokumenttext/i.test(system), true);
check('Keine Kaufempfehlung im Chat', /Keine Kaufempfehlung/i.test(system), true);
check('Der PDF-Text geht mit', docMsg.includes('Belaege verschlissen, HU-relevant'), true);
check('Die Seitenangaben bleiben erhalten', /--- Seite 1 ---/.test(docMsg), true);
check('Fahrzeugdaten von der Seite gehen mit', /WVGZZZ1T4PW004548/.test(docMsg), true);
check('Kein Structured Output beim Chat', first.response_format?.type, undefined);
check('Die Frage steht am Ende', first.messages?.at(-1)?.content, 'Wie tief ist das Profil hinten rechts?');
check('Antwort steht im Verlauf',
  await q(`[...r.querySelectorAll('#vms-react-root p')].some(p => p.textContent.includes('Antwort 1 aus dem Dokument'))`), true);

/* 3 - der Verlauf wächst, bleibt aber gedeckelt */
await ask('Und was steht zu den Bremsen?');
await ask('Gibt es Rost?');
await ask('Steht etwas zum Unfallschaden?');
await ask('Und zur Scheibe?');

check('Fünf Chat-Anfragen insgesamt', chatRequests.length, 5);

/** Nachrichten zwischen Dokumentblock und aktueller Frage = mitgeschickter Verlauf. */
const historyOf = (req) => (req.messages || []).slice(3, -1);
check('Erste Frage ohne Verlauf', historyOf(chatRequests[0]).length, 0);
check('Zweite Frage mit einem Paar', historyOf(chatRequests[1]).length, 2);
check('Verlauf bei drei Paaren gedeckelt', historyOf(chatRequests[4]).length, 6);
check('Verlauf wechselt Frage/Antwort ab',
  historyOf(chatRequests[4]).map((m) => m.role),
  ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
check('Der Verlauf endet bei der vorletzten Frage',
  historyOf(chatRequests[4]).at(-2).content, 'Steht etwas zum Unfallschaden?');
check('Die älteste Frage ist rausgefallen',
  historyOf(chatRequests[4]).some((m) => m.content.includes('Profil hinten rechts')), false);

/* 4 - das Dokument geht genau einmal pro Anfrage mit, nicht je Runde */
check('Dokumenttext nur einmal pro Anfrage',
  (chatRequests[4].messages || []).filter((m) => String(m.content).includes('--- Seite 1 ---')).length, 1);

check('Keine Fehler im Service Worker', swErrors, []);
check('Keine Fehler in der Seite', pageErrors, []);

await ctx.close();
siteServer.close();
apiServer.close();
console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
