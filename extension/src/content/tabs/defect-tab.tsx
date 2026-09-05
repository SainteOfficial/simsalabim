import { useMemo, useState, type CSSProperties } from 'react';

import {
  AlertIcon,
  CheckBig,
  CheckIcon,
  ChevronDown,
  ExternalIcon,
  SearchIcon,
  TireIcon
} from '@/content/tabs/icons';
import { PageDamages } from '@/content/views/page-damages';
import { fmtCost } from '@/lib/format';
import {
  CATEGORY_LABEL,
  SEV_LABEL,
  SORTERS,
  defectId,
  searchText,
  type AnalysisResult,
  type Defect,
  type Severity
} from '@/lib/result';

type Props = {
  result: AnalysisResult;
  pageDamages: string[];
  showAllPageDamages: boolean;
  primaryDocUrl: string | null;
  expandAll: boolean;
  onToggleExpandAll: () => void;
};

const CHIP_KEYS: (Severity | 'alle')[] = ['alle', 'kritisch', 'mittel', 'gering', 'hinweis'];

export function DefectTab({
  result,
  pageDamages,
  showAllPageDamages,
  primaryDocUrl,
  expandAll,
  onToggleExpandAll
}: Props) {
  const r = result;
  const [filter, setFilter] = useState<Severity | 'alle'>('alle');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'schwere' | 'kosten' | 'seite'>('schwere');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const visible = useMemo(
    () =>
      r.defects
        .filter((d) => filter === 'alle' || d.severity === filter)
        .slice()
        .sort(SORTERS[sort] || SORTERS.schwere),
    [r.defects, filter, sort]
  );

  const query = search.trim().toLowerCase();
  // Die Suche blendet Karten aus, statt die Liste neu zu bauen: so bleibt die
  // Aufklapp-Animation ruhig und der Cursor im Suchfeld stehen.
  const matches = useMemo(
    () => visible.map((d) => !query || searchText(d).includes(query)),
    [visible, query]
  );
  const hits = matches.filter(Boolean).length;

  if (!r.defects.length) {
    return (
      <>
        <PageDamages damages={pageDamages} showAll={showAllPageDamages} />
        {r.suspect_empty ? <EmptyButSuspect hints={r.damage_hints || 0} /> : (
          <div className="vms-empty">
            <CheckBig />
            <div>
              <strong>Keine Mängel dokumentiert</strong>
              <p>
                {r.report_found
                  ? 'Im Dokument sind keine Schäden vermerkt.'
                  : 'Das Dokument enthält keine Zustandsangaben.'}
              </p>
            </div>
          </div>
        )}
        <Coverage result={r} />
      </>
    );
  }

  const counts = r.counts || ({} as AnalysisResult['counts']);
  const chips = CHIP_KEYS.filter((k) => k === 'alle' || counts[k as Severity]);
  const showSearch = r.defects.length >= 5;

  return (
    <>
      <PageDamages damages={pageDamages} showAll={showAllPageDamages} />

      <div className="vms-toolbar">
        <div className="vms-chips">
          {chips.map((k) => (
            <button
              className={`vms-chip ${k} ${filter === k ? 'on' : ''}`}
              data-act="filter"
              data-value={k}
              key={k}
              onClick={() => setFilter(k)}
              type="button"
            >
              {k === 'alle' ? `Alle ${r.defects.length}` : `${SEV_LABEL[k as Severity]} ${counts[k as Severity]}`}
            </button>
          ))}
        </div>
        <button className="vms-ghost sm" data-act="expand-all" onClick={onToggleExpandAll} type="button">
          {expandAll ? 'Zuklappen' : 'Alle Details'}
        </button>
      </div>

      {showSearch ? (
        <>
          <div className="vms-searchbar">
            <span className="vms-search-icon">
              <SearchIcon />
            </span>
            <input
              aria-label="Mängel durchsuchen"
              className="vms-search"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape' && search) {
                  e.preventDefault();
                  setSearch('');
                }
              }}
              placeholder="Mängel durchsuchen…"
              type="search"
              value={search}
            />
            <select
              aria-label="Sortierung"
              className="vms-sort"
              onChange={(e) => setSort(e.target.value as typeof sort)}
              value={sort}
            >
              <option value="schwere">Schwere</option>
              <option value="kosten">Kosten</option>
              <option value="seite">Seite</option>
            </select>
          </div>
          <div className="vms-hits" hidden={!query}>
            {hits} von {visible.length} Mängeln
          </div>
        </>
      ) : null}

      <div className="vms-list">
        {visible.map((d, i) => {
          const id = defectId(d);
          return (
            <DefectCard
              defect={d}
              hidden={!matches[i]}
              index={i}
              key={id}
              open={expandAll || open.has(id)}
              primaryDocUrl={primaryDocUrl}
              onToggle={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  next.has(id) ? next.delete(id) : next.add(id);
                  return next;
                })
              }
            />
          );
        })}
      </div>

      <div className="vms-nohits" hidden={!(query && hits === 0)}>
        Kein Mangel passt zu dieser Suche.
      </div>

      <Tires result={r} expandAll={expandAll} />
      {r.missing_info?.length ? (
        <div className="vms-missing">
          <strong>Nicht im Dokument:</strong> {r.missing_info.join(', ')}
        </div>
      ) : null}
      <Coverage result={r} />
    </>
  );
}

/**
 * Leere Liste, aber der Dokumenttext ist voller Befundwörter. Ein beruhigendes
 * "keine Mängel" wäre hier die teuerste Art von Fehler - also sagt das Panel
 * offen, dass die Auswertung nicht zum Dokument passt.
 */
function EmptyButSuspect({ hints }: { hints: number }) {
  return (
    <div className="vms-app px-1 py-2">
      <div className="rounded-xl border border-panel-warn/30 bg-panel-warn/[0.08] px-3 py-3">
        <div className="mb-1 flex items-center gap-2 text-panel-warn">
          <AlertIcon />
          <strong className="text-[12.5px]">Auswertung passt nicht zum Dokument</strong>
        </div>
        <p className="text-[12px] leading-relaxed">
          Die Auswertung hat keinen Mangel erfasst, im Dokument stehen aber {hints} verschiedene
          Begriffe, die auf Befunde hindeuten – etwa Vorschäden, Dellen oder Kratzer.
          Verlass dich hier <strong>nicht</strong> auf „keine Mängel“.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button
            className="rounded-lg bg-panel-accent px-2.5 py-1.5 text-[12px] font-semibold text-panel-on-accent transition hover:brightness-110"
            data-act="rerun"
            type="button"
          >
            Neu auswerten
          </button>
          <span className="self-center text-[11.5px] text-panel-dim">
            oder unten im Chat gezielt nachfragen
          </span>
        </div>
      </div>
    </div>
  );
}

function DefectCard({
  defect: d,
  hidden,
  index,
  open,
  primaryDocUrl,
  onToggle
}: {
  defect: Defect;
  hidden: boolean;
  index: number;
  open: boolean;
  primaryDocUrl: string | null;
  onToggle: () => void;
}) {
  const cost = fmtCost(d.estimated_cost_eur);
  return (
    <article
      className={`vms-defect ${d.severity} ${open ? 'open' : ''}`}
      data-id={defectId(d)}
      data-search={searchText(d)}
      hidden={hidden}
      style={{ '--i': index } as CSSProperties}
    >
      <button aria-expanded={open} className="vms-defect-head" onClick={onToggle} type="button">
        <span className="vms-sev" title={SEV_LABEL[d.severity]} />
        <span className="vms-defect-title">{d.title}</span>
        {d.affects_roadworthiness ? (
          <span className="vms-tag tuv" title="HU/TÜV-relevant">
            TÜV
          </span>
        ) : null}
        {cost ? <span className="vms-tag cost">{cost}</span> : null}
        <span className="vms-caret">
          <ChevronDown />
        </span>
      </button>
      <div className="vms-defect-body">
        <div className="vms-defect-inner">
          <div className="vms-defect-pad">
            <p>{d.description}</p>
            <div className="vms-meta">
              {d.area ? <span>{d.area}</span> : null}
              <span className="vms-cat">{CATEGORY_LABEL[d.category] || d.category}</span>
              {d.source_page ? (
                primaryDocUrl ? (
                  <button
                    className="vms-page"
                    data-act="page"
                    data-page={d.source_page}
                    title={`PDF auf Seite ${d.source_page} öffnen`}
                    type="button"
                  >
                    Seite {d.source_page}
                    <ExternalIcon />
                  </button>
                ) : (
                  <span>Seite {d.source_page}</span>
                )
              ) : null}
            </div>
            {d.quote ? <blockquote>{d.quote}</blockquote> : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function Tires({ result, expandAll }: { result: AnalysisResult; expandAll: boolean }) {
  if (!result.tires?.length) return null;
  return (
    <details className="vms-fold" open={expandAll}>
      <summary>
        <TireIcon />
        <span>Reifen ({result.tires.length})</span>
      </summary>
      <table className="vms-tires">
        <thead>
          <tr>
            <th>Pos.</th>
            <th>Größe</th>
            <th>Profil</th>
            <th>Notiz</th>
          </tr>
        </thead>
        <tbody>
          {result.tires.map((t, i) => (
            <tr key={i}>
              <td>{t.position || ''}</td>
              <td>{t.dimension || '-'}</td>
              <td className={typeof t.tread_mm === 'number' && t.tread_mm < 3 ? 'low' : ''}>
                {t.tread_mm != null ? `${t.tread_mm} mm` : '-'}
              </td>
              <td>{t.note || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Coverage({ result }: { result: AnalysisResult }) {
  const c = result.meta?.coverage;
  if (!c) return null;
  const docs = c.documents || [];
  const scanned = docs.filter((d) => d.scanned).length;
  const imagePages = docs.reduce((a, d) => a + (d.imagePages?.length || 0), 0);
  const bits = [`${c.pagesRead} von ${c.pages} Seiten gelesen`];
  if (docs.length > 1) bits.push(`${docs.length} Dokumente`);
  if (scanned) bits.push(`${scanned} Scan${scanned > 1 ? 's' : ''} per Bilderkennung`);
  else if (imagePages) bits.push(`${imagePages} Bildseite${imagePages > 1 ? 'n' : ''} zusätzlich erkannt`);
  if ((result.meta?.chunks || 0) > 1) bits.push(`in ${result.meta?.chunks} Teilen ausgewertet`);

  return (
    <div className={`vms-coverage ${c.complete ? 'ok' : 'partial'}`}>
      {c.complete ? <CheckIcon /> : <AlertIcon />}
      <span>{bits.join(' · ')}</span>
    </div>
  );
}
