/* eslint-env browser */
/**
 * Offscreen-Dokument: liest PDFs mit pdf.js aus.
 * Der Service Worker hat kein DOM/Canvas - deshalb passiert das hier.
 */

const pdfjs = globalThis.pdfjsLib;
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.js');

const MAX_RENDER_DIMENSION = 1400;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'PARSE_PDF') {
    parsePdf(msg.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // async
  }
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function parsePdf({ base64, wantImages = false, maxPages = 6, maxTextPages = 40 }) {
  const bytes = base64ToBytes(base64);

  const doc = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false, // MV3-CSP: kein unsafe-eval
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: 0
  }).promise;

  const pageCount = doc.numPages;
  const limit = Math.min(pageCount, maxTextPages);
  const pageTexts = [];

  for (let p = 1; p <= limit; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pageTexts.push(layoutText(content.items));
    page.cleanup();
  }

  const text = pageTexts
    .map((t, i) => `--- Seite ${i + 1} ---\n${t}`)
    .join('\n\n')
    .trim();

  const charCount = text.replace(/--- Seite \d+ ---/g, '').replace(/\s/g, '').length;
  const avgPerPage = charCount / Math.max(1, limit);
  const looksScanned = charCount < 200 || avgPerPage < 80;

  const result = {
    text,
    charCount,
    pageCount,
    parsedPages: limit,
    looksScanned,
    images: []
  };

  if (wantImages && looksScanned) {
    result.images = await renderPages(doc, Math.min(pageCount, maxPages));
  }

  await doc.destroy();
  return result;
}

/**
 * Baut aus den pdf.js-Textfragmenten zeilen-/spaltenerhaltenden Text.
 * Wichtig, weil Zustandsberichte fast immer Tabellen sind.
 */
function layoutText(items) {
  const lines = [];
  const tolerance = 2.2;

  for (const item of items) {
    if (!item.str) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const height = Math.abs(item.transform[3]) || item.height || 10;
    let line = lines.find((l) => Math.abs(l.y - y) <= Math.max(tolerance, height * 0.35));
    if (!line) {
      line = { y, height, parts: [] };
      lines.push(line);
    }
    line.parts.push({ x, str: item.str, width: item.width || item.str.length * height * 0.5 });
  }

  lines.sort((a, b) => b.y - a.y);

  return lines
    .map((line) => {
      line.parts.sort((a, b) => a.x - b.x);
      const charWidth = Math.max(2, line.height * 0.45);
      let out = '';
      let prevEnd = null;

      for (const part of line.parts) {
        const isBlank = !part.str.trim();

        // Geometrische Luecke zwischen zwei Fragmenten (Spalten erhalten)
        if (prevEnd !== null && !isBlank) {
          const gap = part.x - prevEnd;
          if (gap > charWidth * 3) out += '   ';
          else if (gap > charWidth * 0.5 && !/\s$/.test(out)) out += ' ';
        }

        if (isBlank) {
          // pdf.js liefert Luecken oft selbst als Leerzeichen-Item mit grosser Breite
          if (out && !/ {3}$/.test(out)) out += part.width > charWidth * 3 ? '   ' : ' ';
        } else {
          out += part.str;
        }
        prevEnd = part.x + Math.max(part.width, 0);
      }
      return out.replace(/ {4,}/g, '   ').replace(/[ \t]+$/g, '');
    })
    .filter((l) => l.trim().length)
    .join('\n');
}

/** Rendert Seiten als JPEG-DataURLs für die Vision-Auswertung gescannter PDFs. */
async function renderPages(doc, count) {
  const images = [];
  for (let p = 1; p <= count; p++) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, MAX_RENDER_DIMENSION / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale: Math.max(1, scale) });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    images.push(canvas.toDataURL('image/jpeg', 0.72));

    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
  return images;
}
