import { computeNumbers } from '@/lib/format';
import { fmtCost } from '@/lib/format';
import { CATEGORY_LABEL, SEV_LABEL, VERDICT_META, type AnalysisResult } from '@/lib/result';

/**
 * Ein Blatt zum Mitnehmen. Alles, was für ein Gebot zählt, auf einer Seite:
 * Fahrzeug, Preisrechnung, Mängel mit Kosten, Reifen, Ausstattung, Urteil.
 *
 * Bewusst ein eigenständiges Dokument ohne Skripte und ohne externe Dateien -
 * es soll sich drucken und als PDF ablegen lassen, auch offline.
 */

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );

const STYLE = `
  @page { size: A4; margin: 14mm 13mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #14161a; background: #fff;
    font: 11pt/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  h1 { font-size: 17pt; margin: 0 0 2px; }
  h2 {
    font-size: 10pt; text-transform: uppercase; letter-spacing: .06em;
    color: #6b7280; margin: 16px 0 5px; padding-bottom: 3px; border-bottom: 1px solid #e4e6ea;
  }
  .sub { color: #6b7280; font-size: 10pt; margin-bottom: 2px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px 18px; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
  .row b { font-variant-numeric: tabular-nums; }
  .strong { border-top: 1px solid #e4e6ea; margin-top: 3px; padding-top: 4px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th {
    text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .05em;
    color: #6b7280; border-bottom: 1px solid #e4e6ea; padding: 0 6px 3px 0; font-weight: 600;
  }
  td { padding: 3px 6px 3px 0; border-bottom: 1px solid #f0f1f3; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sev { font-weight: 700; white-space: nowrap; }
  .sev.kritisch { color: #dc2626; }
  .sev.mittel { color: #d97706; }
  .quote { color: #6b7280; font-size: 9pt; font-style: italic; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { border: 1px solid #d7dae0; border-radius: 999px; padding: 1px 8px; font-size: 9.5pt; }
  .chip.value { border-color: #16a34a; color: #15803d; font-weight: 600; }
  .cols { columns: 3; column-gap: 16px; font-size: 9.5pt; color: #4b5563; }
  .cols div { break-inside: avoid; padding: 1px 0; }
  .verdict { border: 1.5px solid #14161a; border-radius: 8px; padding: 8px 10px; margin-top: 4px; }
  .verdict .label { font-size: 13pt; font-weight: 700; }
  ul { margin: 4px 0 0; padding-left: 16px; }
  li { padding: 1px 0; }
  footer { margin-top: 18px; color: #9ca3af; font-size: 8.5pt; border-top: 1px solid #e4e6ea; padding-top: 5px; }
  .note { color: #6b7280; font-size: 9.5pt; }
  @media print { .noprint { display: none; } }
  .noprint {
    position: fixed; top: 10px; right: 10px; padding: 8px 14px; border: 0; border-radius: 8px;
    background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
  }
`;

function row(label: string, value: string | null, cls = '') {
  if (!value) return '';
  return `<div class="row ${cls}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

export function buildPrintSheet(
  result: AnalysisResult,
  context: Record<string, string>,
  sourceUrl: string
): string {
  const n = computeNumbers(result, context);
  const v = result.verdict || null;
  const meta = v ? VERDICT_META[v.recommendation] : null;
  const equipment = result.equipment || [];
  const valuable = equipment.filter((e) => e.value_relevant);

  const title = context.titel || (result.vehicle?.title as string) || 'Fahrzeug';
  const facts = [
    row('FIN', context.vin || (result.vehicle?.vin as string) || null),
    row('Kilometerstand', context.kilometer || null),
    row('Erstzulassung', context.erstzulassung || null),
    row('Inventarnummer', context.inventarnummer || null),
    row('Kraftstoff', context.kraftstoff || null),
    row('Getriebe', context.getriebe || null)
  ].join('');

  const money = [
    row('Angebotspreis', n.price !== null ? fmtCost(n.price) : null),
    row('Reparatur belegt', n.documented !== null ? fmtCost(n.documented) : null),
    row('davon sicherheitsrelevant', n.urgent !== null ? fmtCost(n.urgent) : null),
    row('Effektivpreis', n.effective !== null ? fmtCost(n.effective) : null, 'strong'),
    row('Verhandlungsziel', n.target !== null ? fmtCost(n.target) : null)
  ].join('');

  const counts = [
    `${result.defects.length} Mängel`,
    n.critical ? `${n.critical} kritisch` : '',
    n.roadworthy ? `${n.roadworthy} HU-relevant` : '',
    n.withoutAmount ? `${n.withoutAmount} ohne Betrag` : ''
  ]
    .filter(Boolean)
    .join(' · ');

  const defectRows = result.defects
    .map(
      (d) => `<tr>
        <td class="sev ${esc(d.severity)}">${esc(SEV_LABEL[d.severity])}</td>
        <td>
          <b>${esc(d.title)}</b>${d.affects_roadworthiness ? ' · HU' : ''}<br>
          ${esc(d.description)}
          ${d.quote ? `<br><span class="quote">„${esc(d.quote)}“</span>` : ''}
        </td>
        <td>${esc(d.area || CATEGORY_LABEL[d.category] || '')}</td>
        <td class="num">${esc(fmtCost(d.estimated_cost_eur) || '–')}</td>
      </tr>`
    )
    .join('');

  const tireRows = (result.tires || [])
    .map(
      (t) =>
        `<tr><td>${esc(t.position)}</td><td>${esc(t.dimension || '–')}</td>
         <td class="num">${t.tread_mm != null ? `${esc(t.tread_mm)} mm` : '–'}</td>
         <td>${esc(t.note || '')}</td></tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<title>${esc(title)} – Prüfblatt</title>
<style>${STYLE}</style></head>
<body>
<button class="noprint" onclick="window.print()">Drucken</button>

<h1>${esc(title)}</h1>
<div class="sub">${esc(counts)}</div>

<h2>Fahrzeug</h2>
<div class="grid">${facts || '<div class="note">Keine Fahrzeugdaten auf der Seite gefunden.</div>'}</div>

${money ? `<h2>Rechnung</h2><div class="grid"><div>${money}</div><div></div></div>` : ''}

${
  result.defects.length
    ? `<h2>Mängel</h2>
<table><thead><tr><th>Schwere</th><th>Befund</th><th>Bereich</th><th class="num">Kosten</th></tr></thead>
<tbody>${defectRows}</tbody></table>`
    : `<h2>Mängel</h2><p class="note">${
        result.suspect_empty
          ? 'Die Auswertung hat keinen Mangel erfasst, obwohl das Dokument Befundwörter enthält – bitte im Dokument selbst nachsehen.'
          : 'Im Dokument sind keine Schäden vermerkt.'
      }</p>`
}

${
  tireRows
    ? `<h2>Reifen</h2><table><thead><tr><th>Pos.</th><th>Größe</th><th class="num">Profil</th><th>Notiz</th></tr></thead><tbody>${tireRows}</tbody></table>`
    : ''
}

${
  equipment.length
    ? `<h2>Ausstattung</h2>
${valuable.length ? `<div class="chips">${valuable.map((e) => `<span class="chip value">${esc(e.name)}</span>`).join('')}</div>` : ''}
<div class="cols" style="margin-top:6px">${equipment
        .filter((e) => !e.value_relevant)
        .map((e) => `<div>${esc(e.name)}</div>`)
        .join('')}</div>`
    : ''
}

${
  v && meta
    ? `<h2>Einschätzung</h2>
<div class="verdict">
  <div class="label">${esc(meta.label)}${typeof v.score === 'number' ? ` · Zustand ${v.score}/100` : ''}</div>
  ${v.headline ? `<div>${esc(v.headline)}</div>` : ''}
  ${v.deal_breakers?.length ? `<ul>${v.deal_breakers.map((x) => `<li><b>${esc(x)}</b></li>`).join('')}</ul>` : ''}
  ${v.before_first_drive?.length ? `<div style="margin-top:6px"><b>Vor der ersten Fahrt:</b><ul>${v.before_first_drive.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
</div>`
    : ''
}

<footer>
  Autosmaya · ${esc(new Date().toLocaleString('de-DE'))} · Quelle: ${esc(sourceUrl)}<br>
  Alle Angaben stammen aus den verlinkten Dokumenten. Ersetzt keine Besichtigung und keine Probefahrt.
</footer>
</body></html>`;
}

/** Öffnet das Blatt in einem neuen Tab. */
export function openPrintSheet(
  result: AnalysisResult,
  context: Record<string, string>,
  sourceUrl: string
) {
  const html = buildPrintSheet(result, context, sourceUrl);
  // Über eine Blob-URL statt document.write: die Seite bleibt eigenständig und
  // die Sicherheitsregeln der Portalseite gelten dort nicht mit.
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
