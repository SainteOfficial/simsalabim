import type { CSSProperties } from 'react';

import { CheckIcon } from '@/content/tabs/icons';
import { Spinner } from '@/content/views/shared';
import { PageDamages } from '@/content/views/page-damages';
import type { PanelState } from '@/content/bridge';

/**
 * Während gelesen und ausgewertet wird. Der laufende Schritt steht oben und
 * bleibt lesbar; erledigte Schritte treten zurück, statt gleich laut zu
 * bleiben - so sieht man auf einen Blick, wo es gerade steht.
 */
export function BusyView({ panel }: { panel: PanelState }) {
  const pct = panel.progressPct;
  return (
    <div className="vms-app flex flex-col gap-3 px-3 pb-3 pt-2">
      <PageDamages damages={panel.pageDamages || []} showAll={Boolean(panel.showAllPageDamages)} />
      <div className="h-1 overflow-hidden rounded-full bg-panel-text/[0.08]">
        <div
          className={
            pct === null
              ? 'vms-indeterminate h-full w-1/3 rounded-full bg-panel-accent'
              : 'h-full rounded-full bg-panel-accent transition-[width] duration-500 ease-out'
          }
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>

      <ul className="flex flex-col gap-0.5">
        {panel.steps.map((s, i) => (
          <li
            className={`flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-[12.5px] ${
              s.done ? 'text-panel-dim' : 'font-medium text-panel-text'
            }`}
            key={s.key + i}
            style={{ '--i': i } as CSSProperties}
          >
            <span
              className={`grid size-5 shrink-0 place-items-center rounded-full ${
                s.done ? 'bg-panel-good/15 text-panel-good' : 'text-panel-accent'
              }`}
            >
              {s.done ? <CheckIcon size={11} /> : <Spinner size={12} />}
            </span>
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            {s.hint ? (
              <span className="shrink-0 font-mono text-[10.5px] text-panel-dim">{s.hint}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
