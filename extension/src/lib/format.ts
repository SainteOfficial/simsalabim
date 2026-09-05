import type { AnalysisResult } from '@/lib/result';

export const fmtNumber = (n: unknown) =>
  typeof n === 'number' ? n.toLocaleString('de-DE') : '';

export function fmtCost(n: unknown): string | null {
  if (typeof n !== 'number') return null;
  return n.toLocaleString('de-DE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0
  });
}

/** "18.900 EUR" / "1.830,50 €" -> 18900 / 1830.5 */
export function parseEuro(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (!value) return null;
  const m = String(value).match(/(\d[\d.,\s']*)/);
  if (!m) return null;
  let raw = m[1].replace(/[\s']/g, '');
  if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}(\D|$)/.test(raw + ' ')) raw = raw.replace(/\./g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export type Numbers = ReturnType<typeof computeNumbers>;

/**
 * Rechnet aus den belegten Angaben - ohne Schätzungen der KI.
 * Alles hier ist nachvollziehbar aus dem Dokument bzw. der Seite abgeleitet.
 */
export function computeNumbers(r: AnalysisResult, ctx: Record<string, string>) {
  const defects = r.defects || [];
  const withAmount = defects.filter((d) => typeof d.estimated_cost_eur === 'number');
  const documented = withAmount.reduce((a, d) => a + (d.estimated_cost_eur as number), 0);
  const urgent = defects
    .filter((d) => d.affects_roadworthiness && typeof d.estimated_cost_eur === 'number')
    .reduce((a, d) => a + (d.estimated_cost_eur as number), 0);
  const urgentOpen = defects.filter(
    (d) => d.affects_roadworthiness && typeof d.estimated_cost_eur !== 'number'
  ).length;

  const v = r.verdict || ({} as AnalysisResult['verdict']);
  const negotiation = (v.negotiation_points || []).reduce((a, p) => a + (p.amount_eur || 0), 0);
  const price = parseEuro(ctx.preis);
  const reportTotal =
    typeof r.total_estimated_repair_cost_eur === 'number' ? r.total_estimated_repair_cost_eur : null;
  const repair = documented || reportTotal || 0;

  // Zählbares aus dem Dokument. Das steht auch dann zur Verfügung, wenn kein
  // einziger Betrag genannt ist - und genau das ist bei Zustandsberichten der
  // Normalfall. Ohne diesen Teil bliebe der Tab dort leer.
  const counts = r.counts || ({} as AnalysisResult['counts']);
  const roadworthy = defects.filter((d) => d.affects_roadworthiness).length;
  const treads = (r.tires || [])
    .map((t) => t.tread_mm)
    .filter((mm): mm is number => typeof mm === 'number');

  return {
    documented: withAmount.length ? documented : null,
    documentedCount: withAmount.length,
    totalCount: defects.length,
    withoutAmount: defects.length - withAmount.length,
    urgent: urgent || null,
    urgentOpen,
    reportTotal,
    budgetMax: typeof v.repair_budget_max_eur === 'number' ? v.repair_budget_max_eur : null,
    negotiation: negotiation || null,
    price,
    effective: price !== null && repair ? price + repair : null,
    target: price !== null && negotiation ? price - negotiation : null,
    critical: counts.kritisch || 0,
    medium: counts.mittel || 0,
    roadworthy,
    tireCount: treads.length,
    tiresLow: treads.filter((mm) => mm < 3).length,
    tiresIllegal: treads.filter((mm) => mm < 1.6).length,
    minTread: treads.length ? Math.min(...treads) : null
  };
}
