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
  chatHidden: boolean;
  docs: { url?: string; label?: string; kind?: string }[];
  result: AnalysisResult | null;
  steps: Step[];
  progressPct: number | null;
  error: { message: string; code?: string } | null;
  debugLogs: LogEntry[];
  apiDiagnosis: ApiDiagnosis | null;
  pdfDiagnosis: PdfDiagnosis | null;
  isDiagnosingApi: boolean;
  isDiagnosingPdf: boolean;
  href: string;
  path: string;
};

export type Step = { key: string; label: string; done: boolean; hint?: string };
export type LogEntry = { time: string; tag: string; message: string };

export type ApiDiagnosis = {
  ok: boolean;
  model?: string;
  error?: string;
  durationMs?: number;
};

export type PdfDiagnosis = {
  ok: boolean;
  error?: string;
  status?: number;
  contentType?: string;
  bytesReceived?: number;
  isPdf?: boolean;
  nestedPdfUrl?: string | null;
  preview?: string;
  durationMs?: number;
};

export const PANEL_EVENT = 'vms:state';
export const READY_EVENT = 'vms:ready';

type Bridge = {
  shadow: ShadowRoot;
  slot: HTMLElement;
  body: HTMLElement;
  state: PanelState;
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
