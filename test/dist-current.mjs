/**
 * Wacht darüber, dass extension/dist/ zum Quellcode passt.
 *
 *   node test/dist-current.mjs
 *
 * dist/ ist eingecheckt, damit ein ZIP-Download direkt als entpackte
 * Erweiterung ladbar ist - ohne Node und ohne Build-Schritt. Das handelt sich
 * eine Gefahr ein: wer Quellcode ändert und nicht neu baut, lädt still den
 * alten Stand. Deshalb wird hier neu gebaut und geprüft, ob dabei etwas anderes
 * herauskommt als das, was im Verzeichnis liegt.
 */
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'extension', 'dist');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Inhalt aller Dateien in dist/, nach Namen sortiert. */
function fingerprint() {
  if (!fs.existsSync(DIST)) return {};
  return Object.fromEntries(
    fs
      .readdirSync(DIST)
      .sort()
      .map((name) => [
        name,
        createHash('sha256').update(fs.readFileSync(path.join(DIST, name))).digest('hex')
      ])
  );
}

const before = fingerprint();
if (!Object.keys(before).length) {
  console.log('FAIL  extension/dist ist leer – `npm run build` ausführen und einchecken.');
  process.exit(1);
}

execFileSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
const after = fingerprint();

const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
const stale = names.filter((n) => before[n] !== after[n]);

if (stale.length) {
  console.log('FAIL  extension/dist ist nicht auf dem Stand des Quellcodes:');
  for (const n of stale) {
    const was = before[n] ? before[n].slice(0, 12) : 'fehlte';
    const now = after[n] ? after[n].slice(0, 12) : 'entfällt';
    console.log(`        ${n}: ${was} -> ${now}`);
  }
  console.log('\n      Der Neubau wurde bereits geschrieben – bitte mit einchecken.');
  console.log('      Sonst lädt ein ZIP-Download still den alten Stand.');
  process.exit(1);
}

console.log(`PASS  extension/dist passt zum Quellcode (${names.length} Dateien)`);
console.log('\n1 bestanden, 0 fehlgeschlagen');
