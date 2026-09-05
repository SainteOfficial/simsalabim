import type { ReactNode } from 'react';

import { BoltIcon, CopyIcon, DownloadIcon, Spinner } from '@/content/views/shared';
import type { ApiDiagnosis, PanelState, PdfDiagnosis } from '@/content/bridge';

/**
 * Diagnose. Vorher eine Wand aus Zeilen - jetzt in Abschnitte geteilt, mit
 * den Werten rechtsbündig in Monospace, damit sich Adressen und Zeiten
 * überhaupt vergleichen lassen.
 */
export function DebugView({ panel }: { panel: PanelState }) {
  const doc = panel.docs[0];
  const docUrl = doc?.url || 'Kein Dokument erkannt';

  return (
    <div className="vms-app flex flex-col gap-3 px-3 pb-3 pt-2">
      <div className="flex items-center justify-between">
        <strong className="text-[12.5px]">Diagnose &amp; Systemstatus</strong>
        <button
          className="rounded-lg px-2 py-1 text-[11.5px] text-panel-dim hover:bg-panel-text/[0.07] hover:text-panel-text"
          data-act="close-debug"
          type="button"
        >
          ← Zurück
        </button>
      </div>

      <section className="overflow-hidden rounded-xl border border-panel-line">
        <Row label="Seite" value={panel.path} title={panel.href} mono />
        <Row label="FIN" value={panel.context?.vin || 'nicht im DOM gefunden'} mono />
        <Row label="Dokument" value={docUrl} title={docUrl} mono />
        <Row
          label="Letzter Fehler"
          value={panel.error?.message || 'keiner'}
          tone={panel.error ? 'bad' : undefined}
        />
      </section>

      <div className="flex flex-wrap gap-1.5">
        <DebugButton act="test-api" busy={panel.isDiagnosingApi} icon={<BoltIcon />}>
          API testen
        </DebugButton>
        <DebugButton act="test-pdf" busy={panel.isDiagnosingPdf} icon={<DownloadIcon />}>
          PDF-Download testen
        </DebugButton>
        <DebugButton act="copy-debug" icon={<CopyIcon />}>
          Report kopieren
        </DebugButton>
      </div>

      {panel.apiDiagnosis ? <ApiResult diag={panel.apiDiagnosis} /> : null}
      {panel.pdfDiagnosis ? <PdfResult diag={panel.pdfDiagnosis} /> : null}

      <section>
        <div className="mb-1 flex items-baseline justify-between px-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-panel-dim">
            Protokoll
          </span>
          <span className="text-[11px] text-panel-dim">{panel.debugLogs.length}</span>
        </div>
        <div className="max-h-52 overflow-y-auto rounded-xl border border-panel-line bg-panel-text/[0.03]">
          {panel.debugLogs.length === 0 ? (
            <p className="px-2.5 py-3 text-center text-[11.5px] text-panel-dim">
              Noch nichts aufgezeichnet.
            </p>
          ) : (
            panel.debugLogs
              .slice()
              .reverse()
              .map((l, i) => (
                <div
                  className="flex gap-2 border-b border-panel-line/60 px-2.5 py-1.5 text-[11px] last:border-0"
                  key={i}
                >
                  <span className="shrink-0 font-mono text-panel-dim">{l.time}</span>
                  <span className="shrink-0 font-mono font-semibold text-panel-accent">{l.tag}</span>
                  <span className="min-w-0 break-words">{l.message}</span>
                </div>
              ))
          )}
        </div>
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  title,
  mono = false,
  tone
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
  tone?: 'bad';
}) {
  return (
    <div className="flex items-baseline gap-3 border-b border-panel-line/60 px-2.5 py-1.5 last:border-0">
      <span className="shrink-0 text-[11.5px] text-panel-dim">{label}</span>
      <span
        className={`min-w-0 flex-1 truncate text-right text-[11.5px] ${mono ? 'font-mono' : ''} ${
          tone === 'bad' ? 'text-panel-crit' : ''
        }`}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

function DebugButton({
  act,
  busy = false,
  icon,
  children
}: {
  act: string;
  busy?: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      className="flex items-center gap-1.5 rounded-lg border border-panel-line px-2.5 py-1.5 text-[11.5px] text-panel-dim transition hover:bg-panel-text/[0.05] hover:text-panel-text"
      data-act={act}
      type="button"
    >
      {busy ? <Spinner size={12} /> : icon}
      {children}
    </button>
  );
}

function Box({ ok, title, children }: { ok: boolean; title: string; children: ReactNode }) {
  return (
    <section
      className={`rounded-xl border px-2.5 py-2 text-[11.5px] leading-relaxed ${
        ok
          ? 'border-panel-good/25 bg-panel-good/[0.07]'
          : 'border-panel-crit/25 bg-panel-crit/[0.07]'
      }`}
    >
      <strong className="mb-0.5 block">{title}</strong>
      {children}
    </section>
  );
}

function ApiResult({ diag }: { diag: ApiDiagnosis }) {
  return (
    <Box ok={diag.ok} title={`API-Verbindung (${diag.durationMs} ms)`}>
      {diag.ok ? (
        <div>
          Modell <code className="font-mono">{diag.model}</code> antwortet.
        </div>
      ) : (
        <div>{diag.error}</div>
      )}
    </Box>
  );
}

function PdfResult({ diag }: { diag: PdfDiagnosis }) {
  const good = Boolean(diag.ok && diag.isPdf);
  return (
    <Box ok={good} title={`PDF-Download (${diag.durationMs} ms)`}>
      {diag.ok ? (
        <>
          <div>
            HTTP {diag.status} · {diag.contentType || 'kein Content-Type'} ·{' '}
            {Math.round((diag.bytesReceived || 0) / 1024)} KB
          </div>
          <div className={good ? '' : 'text-panel-crit'}>
            {good ? 'Gültiges PDF (%PDF- erkannt)' : 'Die Antwort ist kein PDF'}
          </div>
          {diag.nestedPdfUrl ? (
            <div className="break-all">
              Link im HTML: <code className="font-mono">{diag.nestedPdfUrl}</code>
            </div>
          ) : null}
          {diag.preview ? (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-panel-text/[0.05] p-1.5 font-mono text-[10.5px]">
              {diag.preview}
            </pre>
          ) : null}
        </>
      ) : (
        <div>{diag.error}</div>
      )}
    </Box>
  );
}
