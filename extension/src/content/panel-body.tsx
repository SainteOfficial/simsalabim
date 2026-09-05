import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { CalcTab } from '@/content/tabs/calc-tab';
import { DefectTab } from '@/content/tabs/defect-tab';
import { OpinionTab } from '@/content/tabs/opinion-tab';
import { onPanelState, legacyBody, morphFrom, type PanelState } from '@/content/bridge';

/**
 * Der Inhalt von .vms-body. Das Panel drumherum (Kopf, Tab-Leiste, Fuß) liegt
 * weiterhin in content/panel.js - dort hängen Ziehen, Größe und die Tab-Leiste.
 *
 * Zustand teilt sich auf: alles, was das Panel als Ganzes betrifft (Status,
 * aktiver Tab, Ergebnis), kommt über die Brücke; was nur die Tabs angeht
 * (Filter, Suche, Sortierung, aufgeklappte Karten), gehört React.
 */
export function PanelBody({ bodyEl }: { bodyEl: HTMLElement }) {
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [expandAll, setExpandAll] = useState(false);

  useEffect(() => onPanelState(setPanel), []);

  useTabMorph(bodyEl, panel?.tab);

  if (!panel) return null;

  // Noch nicht portiert: Diagnose-Ansicht sowie die Zustände vor dem Ergebnis.
  // Sie kommen weiter als HTML aus panel.js; die Klickziele darin bedient
  // dessen Delegat unverändert.
  if (panel.view === 'debug' || panel.status !== 'done' || !panel.result) {
    return <div dangerouslySetInnerHTML={{ __html: legacyBody() }} />;
  }

  const r = panel.result;
  const docs = r.meta?.coverage?.documents || [];
  const primaryDocUrl = docs[0]?.url || panel.docs?.[0]?.url || null;

  if (panel.tab === 'berechnet') {
    return <CalcTab context={panel.context} expandAll={expandAll} result={r} />;
  }
  if (panel.tab === 'meinung') {
    return <OpinionTab result={r} />;
  }
  return (
    <DefectTab
      expandAll={expandAll}
      onToggleExpandAll={() => setExpandAll((v) => !v)}
      pageDamages={panel.pageDamages || []}
      primaryDocUrl={primaryDocUrl}
      result={r}
      showAllPageDamages={Boolean(panel.showAllPageDamages)}
    />
  );
}

/**
 * Der weiche Höhenwechsel beim Tabwechsel. Die Ausgangshöhe misst panel.js im
 * Moment des Klicks - nach dem Rendern ist sie nicht mehr zu haben.
 */
function useTabMorph(bodyEl: HTMLElement, tab?: string) {
  const previous = useRef(tab);

  useLayoutEffect(() => {
    if (previous.current === tab) return;
    previous.current = tab;

    const from = morphFrom();
    if (!from) return;

    bodyEl.classList.add('morphing');
    bodyEl.style.height = 'auto';
    const target = Math.min(window.innerHeight * 0.72, bodyEl.scrollHeight);
    bodyEl.style.height = `${from}px`;
    void bodyEl.offsetHeight; // Reflow, damit der Übergang startet

    requestAnimationFrame(() => {
      bodyEl.style.height = `${target}px`;
    });
    const done = (e: TransitionEvent) => {
      if (e.propertyName !== 'height') return;
      bodyEl.style.height = '';
      bodyEl.classList.remove('morphing');
    };
    bodyEl.addEventListener('transitionend', done, { once: true });
    return () => bodyEl.removeEventListener('transitionend', done);
  }, [bodyEl, tab]);
}
