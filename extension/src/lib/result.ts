/** Das Analyseergebnis, so wie das Panel es sieht. */

export type Severity = 'kritisch' | 'mittel' | 'gering' | 'hinweis';

export type Defect = {
  title: string;
  description: string;
  area: string;
  category: string;
  severity: Severity;
  estimated_cost_eur: number | null;
  affects_roadworthiness: boolean;
  source_page: number | null;
  quote: string | null;
};

export type Tire = {
  position: string;
  dimension: string | null;
  tread_mm: number | null;
  note: string | null;
};

export type Equipment = { name: string; value_relevant: boolean };

export type NegotiationPoint = { point: string; amount_eur: number | null };

export type Verdict = {
  recommendation: 'kaufen' | 'kaufen_mit_vorbehalt' | 'nachverhandeln' | 'finger_weg' | 'unklar';
  score: number | null;
  headline: string;
  reasons: string[];
  deal_breakers: string[];
  negotiation_points: NegotiationPoint[];
  before_first_drive: string[];
  repair_budget_min_eur: number | null;
  repair_budget_max_eur: number | null;
  price_assessment: string | null;
};

export type CoverageDocument = {
  label?: string;
  url?: string;
  hash?: string;
  pages?: number;
  pagesRead?: number;
  chars?: number;
  complete?: boolean;
  scanned?: boolean;
  imagePages?: number[];
};

export type Meta = {
  model?: string;
  mode?: string;
  chunks?: number;
  usage?: { promptTokens?: number; completionTokens?: number; cost?: number } | null;
  calls?: number;
  durationMs?: number;
  fromCache?: boolean;
  ts?: number;
  coverage?: {
    documents?: CoverageDocument[];
    pages?: number;
    pagesRead?: number;
    chars?: number;
    complete?: boolean;
  };
};

export type AnalysisResult = {
  vehicle: Record<string, unknown>;
  report_found: boolean;
  overall_condition: string;
  summary: string;
  total_estimated_repair_cost_eur: number | null;
  defects: Defect[];
  tires: Tire[];
  equipment: Equipment[];
  missing_info: string[];
  confidence: number | null;
  verdict: Verdict;
  counts: Record<Severity, number>;
  meta?: Meta;
  /** Leere Mängelliste, obwohl der Text voller Befundwörter steht. */
  suspect_empty?: boolean;
  /** Wie viele verschiedene Befundwörter im Dokument vorkommen. */
  damage_hints?: number;
};

export const SEVERITY_ORDER: Record<Severity, number> = {
  kritisch: 0,
  mittel: 1,
  gering: 2,
  hinweis: 3
};

export const SEV_LABEL: Record<Severity, string> = {
  kritisch: 'Kritisch',
  mittel: 'Mittel',
  gering: 'Gering',
  hinweis: 'Hinweis'
};

export const CATEGORY_LABEL: Record<string, string> = {
  karosserie: 'Karosserie',
  lack: 'Lack',
  glas: 'Glas',
  reifen: 'Reifen',
  raeder: 'Räder',
  innenraum: 'Innenraum',
  technik: 'Technik',
  motor: 'Motor',
  getriebe: 'Getriebe',
  fahrwerk: 'Fahrwerk',
  bremsen: 'Bremsen',
  elektrik: 'Elektrik',
  ausstattung: 'Ausstattung',
  dokumente: 'Dokumente',
  sonstiges: 'Sonstiges'
};

export const VERDICT_META: Record<
  Verdict['recommendation'],
  { label: string; short: string; tone: string; icon: string }
> = {
  kaufen: { label: 'Kaufen', short: 'Kaufen', tone: 'good', icon: 'thumb' },
  kaufen_mit_vorbehalt: { label: 'Kaufen mit Vorbehalt', short: 'Vorbehalt', tone: 'ok', icon: 'thumb' },
  nachverhandeln: { label: 'Nachverhandeln', short: 'Verhandeln', tone: 'warn', icon: 'tag' },
  finger_weg: { label: 'Finger weg', short: 'Finger weg', tone: 'bad', icon: 'alert' },
  unklar: { label: 'Unklar', short: 'Unklar', tone: 'muted', icon: 'question' }
};

export function condClass(c: string): string {
  return (
    ({ 'sehr gut': 'good', gut: 'good', befriedigend: 'mid', mangelhaft: 'bad' } as Record<string, string>)[c] ||
    'unknown'
  );
}

export const defectId = (d: Defect) =>
  `${d.title}|${d.area}`.toLowerCase().replace(/\s+/g, '-').slice(0, 80);

export const searchText = (d: Defect) =>
  `${d.title} ${d.description} ${d.area} ${CATEGORY_LABEL[d.category] || d.category} ${d.quote || ''}`.toLowerCase();

export const SORTERS: Record<string, (a: Defect, b: Defect) => number> = {
  schwere: (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  kosten: (a, b) => (b.estimated_cost_eur || 0) - (a.estimated_cost_eur || 0),
  seite: (a, b) => (a.source_page || 999) - (b.source_page || 999)
};
