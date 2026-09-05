import { AlertIcon } from '@/content/tabs/icons';
import { PageDamages } from '@/content/views/page-damages';
import type { PanelState } from '@/content/bridge';

/**
 * Wenn es schiefging. Die Meldung steht vollständig da - abgeschnittene
 * Fehlertexte kosten beim Suchen mehr Zeit als sie an Platz sparen - und
 * daneben steht der eine Schritt, der jetzt weiterhilft.
 */
export function ErrorView({ panel }: { panel: PanelState }) {
  const noKey = panel.error?.code === 'NO_API_KEY';
  return (
    <div className="vms-app flex flex-col gap-3 px-3 pb-3 pt-2">
      <PageDamages damages={panel.pageDamages || []} showAll={Boolean(panel.showAllPageDamages)} />
      <div className="vms-error flex gap-2.5 rounded-xl border border-panel-crit/25 bg-panel-crit/[0.07] px-3 py-2.5">
        <span className="mt-0.5 shrink-0 text-panel-crit">
          <AlertIcon />
        </span>
        <span className="text-[12.5px] leading-relaxed">
          {panel.error?.message || 'Unbekannter Fehler'}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          className="vms-primary flex-1 rounded-xl bg-panel-accent px-3 py-2 text-[12.5px] font-semibold text-panel-on-accent transition hover:brightness-110 active:scale-[0.99]"
          data-act={noKey ? 'options' : 'rerun'}
          type="button"
        >
          {noKey ? 'API-Key eintragen' : 'Erneut versuchen'}
        </button>
        <button
          className="rounded-xl border border-panel-line px-3 py-2 text-[12.5px] text-panel-dim transition hover:bg-panel-text/[0.05] hover:text-panel-text"
          data-act="open-debug"
          type="button"
        >
          Diagnose
        </button>
        {noKey ? null : (
          <button
            className="rounded-xl border border-panel-line px-3 py-2 text-[12.5px] text-panel-dim transition hover:bg-panel-text/[0.05] hover:text-panel-text"
            data-act="options"
            type="button"
          >
            Einstellungen
          </button>
        )}
      </div>
    </div>
  );
}
