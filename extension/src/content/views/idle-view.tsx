import { FileTextIcon } from '@/content/views/shared';
import { SearchIcon } from '@/content/tabs/icons';
import { PageDamages } from '@/content/views/page-damages';
import type { PanelState } from '@/content/bridge';

const KIND_LABEL: Record<string, string> = {
  condition: 'Zustandsbericht',
  datasheet: 'Datenblatt',
  pdf: 'PDF',
  custom: 'Dokument'
};

/**
 * Startbildschirm: was gefunden wurde und der eine Knopf, der zählt.
 * Die Dokumente stehen als Liste mit Art und Ziel - vorher war nur der
 * Dateiname zu sehen, ohne Hinweis darauf, was die Extension gleich liest.
 */
export function IdleView({ panel }: { panel: PanelState }) {
  return (
    <div className="vms-app flex flex-col gap-3 px-3 pb-3 pt-2">
      <PageDamages damages={panel.pageDamages || []} showAll={Boolean(panel.showAllPageDamages)} />
      <ul className="flex flex-col gap-1.5">
        {panel.docs.map((d, i) => (
          <li
            className="flex items-center gap-2.5 rounded-xl border border-panel-line bg-panel-soft px-2.5 py-2"
            key={`${d.url}-${i}`}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-panel-accent/12 text-panel-accent">
              <FileTextIcon size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium">{d.label}</span>
              <span className="block text-[10.5px] uppercase tracking-wide text-panel-dim">
                {KIND_LABEL[d.kind || ''] || 'Dokument'}
              </span>
            </span>
            <button
              className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-panel-dim hover:bg-panel-text/[0.07] hover:text-panel-text"
              data-act="open-doc"
              data-url={d.url}
              type="button"
            >
              öffnen
            </button>
          </li>
        ))}
      </ul>

      <button
        className="vms-primary flex w-full items-center justify-center gap-2 rounded-xl bg-panel-accent px-3 py-2.5 text-[13px] font-semibold text-panel-on-accent transition hover:brightness-110 active:scale-[0.99]"
        data-act="run"
        type="button"
      >
        <SearchIcon />
        <span>Mängel prüfen</span>
      </button>
    </div>
  );
}
