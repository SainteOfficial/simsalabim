/**
 * Brücke zwischen dem bestehenden Panel (content/panel.js, reines DOM) und der
 * React-Insel. Das Panel meldet seinen Zustand über ein CustomEvent am
 * Shadow-Root; React hört zu, statt den Zustand ein zweites Mal zu halten.
 */

import type { AnalysisResult } from '@/lib/result';

export type PanelDocument = {
  label?: string;
  url?: string;
  hash?: string;
  pages?: number;
};

export type PanelState = {
  status: 'idle' | 'busy' | 'done' | 'error';
  view: 'main' | 'debug';
  tab: 'maengel' | 'berechnet' | 'meinung';
  context: Record<string, string>;
  pageDamages: string[];
  showAllPageDamages: boolean;
  docs: { url?: string; label?: string }[];
  result: AnalysisResult | null;
};

export const PANEL_EVENT = 'vms:state';
export const READY_EVENT = 'vms:ready';

type Bridge = {
  shadow: ShadowRoot;
  slot: HTMLElement;
  body: HTMLElement;
  state: PanelState;
  /** HTML der noch nicht portierten Ansichten (Diagnose, Laden, Fehler). */
  legacyBody: () => string;
  /** Höhe von .vms-body im Moment des Tabwechsels, für den Übergang. */
  morphFrom: number;
};

function bridge(): Bridge | null {
  return (globalThis as unknown as { __vmsBridge?: Bridge }).__vmsBridge ?? null;
}

/** Meldet den aktuellen Zustand und jede spätere Änderung. */
export function onPanelState(listener: (state: PanelState) => void): () => void {
  const current = bridge();
  if (current) listener(current.state);
  const handler = (event: Event) => listener((event as CustomEvent<PanelState>).detail);
  document.addEventListener(PANEL_EVENT, handler);
  return () => document.removeEventListener(PANEL_EVENT, handler);
}

export function panelShadow(): ShadowRoot | null {
  return bridge()?.shadow ?? null;
}

export function panelSlot(): HTMLElement | null {
  return bridge()?.slot ?? null;
}

export function panelBody(): HTMLElement | null {
  return bridge()?.body ?? null;
}

export function legacyBody(): string {
  try {
    return bridge()?.legacyBody() ?? '';
  } catch {
    return '';
  }
}

export function morphFrom(): number {
  return bridge()?.morphFrom ?? 0;
}

type Response = { ok: boolean; error?: string; answer?: string; code?: string };

export function sendMessage(message: unknown): Promise<Response> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (res: Response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res ?? { ok: false, error: 'Keine Antwort vom Hintergrunddienst.' });
      });
    } catch (err) {
      resolve({ ok: false, error: String((err as Error)?.message || err) });
    }
  });
}
