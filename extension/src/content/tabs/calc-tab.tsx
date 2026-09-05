import type { CSSProperties, ReactNode } from 'react';

import { CalcIcon, EyeIcon, TagIcon } from '@/content/tabs/icons';
import { computeNumbers, fmtCost, type Numbers } from '@/lib/format';
import { CATEGORY_LABEL, type AnalysisResult, type Verdict } from '@/lib/result';

export function CalcTab({
  result,
  context,
  expandAll
}: {
  result: AnalysisResult;
  context: Record<string, string>;
  expandAll: boolean;
}) {
  const r = result;
  const n = computeNumbers(r, context);

  const repairRows: ReactNode[] = [];
  if (n.documented !== null) {
    repairRows.push(
      <Row
        key="documented"
        label="Reparatur belegt"
        hint={`${n.documentedCount} von ${n.totalCount} Positionen beziffert`}
        value={fmtCost(n.documented)}
      />
    );
  }
  if (n.reportTotal !== null && n.reportTotal !== n.documented) {
    repairRows.push(<Row key="reportTotal" label="Summe laut Dokument" value={fmtCost(n.reportTotal)} />);
  }
  if (n.urgent !== null) {
    repairRows.push(
      <Row
        key="urgent"
        cls="urgent"
        label="davon sicherheitsrelevant"
        hint={n.urgentOpen ? `+ ${n.urgentOpen} Position(en) ohne Betrag` : ''}
        value={fmtCost(n.urgent)}
      />
    );
  }
  if (n.withoutAmount) {
    repairRows.push(
      <Row
        key="withoutAmount"
        cls="open"
        label="Ohne Betrag im Dokument"
        value={`${n.withoutAmount} Position${n.withoutAmount > 1 ? 'en' : ''}`}
      />
    );
  }

  // Gezählter Befund. Immer verfügbar, auch wenn das Dokument keinen einzigen
  // Betrag nennt - beim Zustandsbericht ist das der Regelfall.
  const factRows: ReactNode[] = [];
  if (n.totalCount) {
    factRows.push(<Row key="total" label="Mängel gesamt" value={String(n.totalCount)} />);
    if (n.critical) factRows.push(<Row key="crit" cls="urgent" label="davon kritisch" value={String(n.critical)} />);
    if (n.medium) factRows.push(<Row key="med" label="davon mittel" value={String(n.medium)} />);
  }
  if (n.roadworthy) {
    factRows.push(
      <Row key="tuv" cls="urgent" label="HU-/TÜV-relevant" value={`${n.roadworthy} von ${n.totalCount}`} />
    );
  }
  if (n.tiresLow) {
    factRows.push(
      <Row
        key="tires"
        cls={n.tiresIllegal ? 'urgent' : ''}
        label="Reifen unter 3 mm"
        hint={n.minTread !== null ? `dünnstes Profil ${String(n.minTread).replace('.', ',')} mm` : ''}
        value={`${n.tiresLow} von ${n.tireCount}`}
      />
    );
  }

  const priceRows: ReactNode[] = [];
  if (n.price !== null) {
    priceRows.push(<Row key="price" label="Angebotspreis" value={fmtCost(n.price)} />);
    if (n.effective !== null) {
      priceRows.push(
        <Row key="eff" cls="strong" label="Effektivpreis" hint="Preis + belegte Reparatur" value={fmtCost(n.effective)} />
      );
    }
    if (n.target !== null) {
      priceRows.push(
        <Row key="target" cls="target" label="Verhandlungsziel" hint="Preis − Verhandlungshebel" value={fmtCost(n.target)} />
      );
    }
  } else if (n.negotiation !== null) {
    priceRows.push(<Row key="neg" cls="target" label="Verhandlungshebel gesamt" value={fmtCost(n.negotiation)} />);
  }

  if (!repairRows.length && !priceRows.length && !factRows.length) {
    return (
      <div className="vms-empty muted">
        <CalcIcon />
        <div>
          <strong>Nichts zu rechnen</strong>
          <p>Im Dokument stehen keine Beträge, und auf der Seite wurde kein Preis gefunden.</p>
        </div>
      </div>
    );
  }

  // Nach Bereich: mit Beträgen wird die Summe gezeigt, sonst die Anzahl der
  // Befunde. So bleibt sichtbar, wo das Fahrzeug schwerpunktmäßig klemmt.
  const hasAmounts = n.documented !== null;
  const byCategory: Record<string, number> = {};
  for (const d of r.defects) {
    if (hasAmounts && typeof d.estimated_cost_eur !== 'number') continue;
    const key = CATEGORY_LABEL[d.category] || d.category;
    byCategory[key] = (byCategory[key] || 0) + (hasAmounts ? (d.estimated_cost_eur as number) : 1);
  }
  const cats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const max = cats.length ? cats[0][1] : 0;
  const barValue = (sum: number) => (hasAmounts ? fmtCost(sum) : `${sum} Befund${sum > 1 ? 'e' : ''}`);

  return (
    <>
      {repairRows.length || priceRows.length ? (
        <section className="vms-calc">
          <div className="vms-calc-head">
            <CalcIcon />
            <strong>Kosten</strong>
            <span className="vms-calc-note">nur belegte Beträge</span>
          </div>
          {repairRows}
          {repairRows.length && priceRows.length ? <div className="vms-calc-sep" /> : null}
          {priceRows}
        </section>
      ) : null}

      {/* Nennt das Dokument keine Beträge, sagt das Panel das offen, statt eine
          leere Kostenrechnung stehen zu lassen. */}
      {!hasAmounts && n.reportTotal === null && n.totalCount ? (
        <p className="vms-calc-hint">
          Das Dokument beziffert keine Reparaturkosten. Gerechnet wird deshalb nur mit dem, was
          belegt ist – gezählte Befunde statt geschätzter Summen.
        </p>
      ) : null}

      {factRows.length ? (
        <section className="vms-calc">
          <div className="vms-calc-head">
            <EyeIcon />
            <strong>Befund</strong>
            <span className="vms-calc-note">aus dem Dokument gezählt</span>
          </div>
          {factRows}
        </section>
      ) : null}

      {cats.length ? (
        <section className="vms-bars">
          <div className="vms-bars-head">Nach Bereich{hasAmounts ? '' : ' (Anzahl)'}</div>
          {cats.map(([name, sum], i) => (
            <div className="vms-bar" key={name} style={{ '--i': i } as CSSProperties}>
              <span className="vms-bar-label">{name}</span>
              <span className="vms-bar-track">
                <i style={{ '--w': `${Math.round((sum / max) * 100)}%` } as CSSProperties} />
              </span>
              <span className="vms-bar-value">{barValue(sum)}</span>
            </div>
          ))}
        </section>
      ) : null}

      <NegotiationBlock verdict={r.verdict} open={expandAll || !hasAmounts} />
    </>
  );
}

function Row({
  label,
  value,
  hint,
  cls = ''
}: {
  label: string;
  value: string | null;
  hint?: string;
  cls?: string;
}) {
  return (
    <div className={`vms-calc-row ${cls}`}>
      <span className="vms-calc-label">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      <span className="vms-calc-value">{value}</span>
    </div>
  );
}

function NegotiationBlock({ verdict, open }: { verdict?: Verdict; open: boolean }) {
  const points = verdict?.negotiation_points;
  if (!points?.length) return null;
  const sum = points.reduce((a, p) => a + (p.amount_eur || 0), 0);
  return (
    <details className="vms-fold" open={open}>
      <summary>
        <TagIcon />
        <span>Verhandlungshebel ({points.length})</span>
        {sum ? <span className="vms-fold-sum">{fmtCost(sum)}</span> : null}
      </summary>
      <ul className="vms-negotiation">
        {points.map((p, i) => (
          <li key={i}>
            <span>{p.point}</span>
            {p.amount_eur ? <b>{fmtCost(p.amount_eur)}</b> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export type { Numbers };
