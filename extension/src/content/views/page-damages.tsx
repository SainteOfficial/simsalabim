import type { CSSProperties } from 'react';

import { EyeIcon } from '@/content/tabs/icons';

/**
 * Schäden, die das Portal schon auf der Seite listet. Sie stehen im Panel,
 * bevor das PDF ausgewertet ist - deshalb erscheinen sie in jeder Ansicht vor
 * dem Ergebnis und danach im Mängel-Tab.
 */
export function PageDamages({ damages, showAll }: { damages: string[]; showAll: boolean }) {
  if (!damages.length) return null;
  const shown = damages.slice(0, showAll ? 25 : 5);
  return (
    <section className="vms-onpage">
      <div className="vms-onpage-head">
        <EyeIcon />
        <strong>Direkt von der Seite</strong>
        <span className="vms-onpage-count">{damages.length}</span>
      </div>
      <ul>
        {shown.map((t, i) => (
          <li key={i} style={{ '--i': i } as CSSProperties}>
            {t}
          </li>
        ))}
      </ul>
      {damages.length > shown.length ? (
        <button className="vms-link" data-act="more-onpage" type="button">
          alle {damages.length} anzeigen
        </button>
      ) : null}
    </section>
  );
}
