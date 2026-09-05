import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import { AlertIcon, QuestionIcon, TagIcon, VerdictIcon, WrenchIcon } from '@/content/tabs/icons';
import { VERDICT_META, condClass, type AnalysisResult, type Verdict } from '@/lib/result';

export function OpinionTab({ result }: { result: AnalysisResult }) {
  const r = result;
  const v = r.verdict || ({} as Verdict);
  const meta = VERDICT_META[v.recommendation] || VERDICT_META.unklar;

  return (
    <>
      <section className={`vms-verdict ${meta.tone}`}>
        <div className="vms-verdict-glow" aria-hidden="true" />
        <div className="vms-verdict-head">
          <ScoreRing score={v.score} tone={meta.tone} />
          <div className="vms-verdict-main">
            <div className="vms-verdict-label">
              <VerdictIcon name={meta.icon} />
              <span>{meta.label}</span>
            </div>
            {v.headline ? <p className="vms-verdict-line">{v.headline}</p> : null}
          </div>
        </div>
        {v.reasons?.length ? (
          <ul className="vms-reasons">
            {v.reasons.map((x, i) => (
              <li key={i} style={{ '--i': i } as CSSProperties}>
                {x}
              </li>
            ))}
          </ul>
        ) : null}
        {v.price_assessment ? (
          <p className="vms-price">
            <TagIcon />
            <span>{v.price_assessment}</span>
          </p>
        ) : null}
        <div className="vms-verdict-foot">
          {r.overall_condition && r.overall_condition !== 'unbekannt' ? (
            <span className={`vms-cond ${condClass(r.overall_condition)}`}>{r.overall_condition}</span>
          ) : null}
          {r.confidence !== null ? (
            <span className="vms-conf">Sicherheit {Math.round((r.confidence || 0) * 100)} %</span>
          ) : null}
        </div>
      </section>

      <ListBlock items={v.deal_breakers} tone="bad" icon={<AlertIcon />} title="Ausschlusskriterien" />
      <ListBlock items={v.before_first_drive} tone="warn" icon={<WrenchIcon />} title="Vor der ersten Fahrt" />
      <DataBasis result={r} verdict={v} />
      {r.summary ? <p className="vms-lead">{r.summary}</p> : null}
      <p className="vms-disclaimer">
        Einschätzung allein aus den verlinkten Dokumenten – ersetzt keine Besichtigung und keine
        Probefahrt.
      </p>
    </>
  );
}

/**
 * Was das Dokument NICHT hergibt. Bei "unklar" ist das die eigentliche
 * Antwort - sonst stünde dort nur die Vokabel ohne jede Begründung.
 */
function DataBasis({ result, verdict }: { result: AnalysisResult; verdict: Verdict }) {
  // Außerhalb von "unklar" steht die Liste schon im Mängel-Tab - im engen
  // Panel wäre eine zweite Kopie nur Rauschen.
  if (verdict.recommendation !== 'unklar') return null;
  const missing = result.missing_info || [];

  return (
    <section className="vms-callout muted">
      <div className="vms-callout-head">
        <QuestionIcon />
        <strong>Warum unklar</strong>
      </div>
      <ul>
        {missing.length ? (
          missing.map((x, i) => (
            <li key={i} style={{ '--i': i } as CSSProperties}>
              {x}
            </li>
          ))
        ) : (
          <li>
            Das Dokument enthält keine belastbaren Zustandsangaben, aus denen sich ein Urteil
            ableiten ließe.
          </li>
        )}
      </ul>
    </section>
  );
}

export function ScoreRing({ score, tone }: { score: number | null; tone: string }) {
  const ring = useRef<SVGCircleElement>(null);
  const R = 22;
  const circumference = 2 * Math.PI * R;
  const offset =
    typeof score === 'number' ? circumference * (1 - Math.min(100, Math.max(0, score)) / 100) : 0;

  // Der Ring startet leer und läuft auf den Wert zu. Zwei Frames Abstand,
  // damit der Browser den Startwert übernimmt, bevor der Übergang beginnt -
  // sonst springt der Ring ohne Animation auf den Endwert.
  useEffect(() => {
    const el = ring.current;
    if (!el) return;
    let frame = 0;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        el.style.strokeDashoffset = String(offset.toFixed(1));
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [offset]);

  if (typeof score !== 'number') {
    return (
      <div className={`vms-ring empty ${tone}`}>
        <QuestionIcon />
      </div>
    );
  }

  return (
    <div className={`vms-ring ${tone}`}>
      <svg viewBox="0 0 52 52" width="52" height="52" aria-hidden="true">
        <circle className="vms-ring-track" cx="26" cy="26" r={R} />
        <circle
          className="vms-ring-value"
          cx="26"
          cy="26"
          r={R}
          data-offset={offset.toFixed(1)}
          ref={ring}
          style={{
            strokeDasharray: circumference.toFixed(1),
            strokeDashoffset: circumference.toFixed(1)
          }}
        />
      </svg>
      <span className="vms-ring-num">{score}</span>
    </div>
  );
}

function ListBlock({
  items,
  tone,
  icon,
  title
}: {
  items?: string[];
  tone: string;
  icon: ReactNode;
  title: string;
}) {
  if (!items?.length) return null;
  return (
    <section className={`vms-callout ${tone}`}>
      <div className="vms-callout-head">
        {icon}
        <strong>{title}</strong>
      </div>
      <ul>
        {items.map((x, i) => (
          <li key={i} style={{ '--i': i } as CSSProperties}>
            {x}
          </li>
        ))}
      </ul>
    </section>
  );
}
