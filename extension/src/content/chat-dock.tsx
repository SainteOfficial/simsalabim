import { FileText as FileTextIcon } from '@phosphor-icons/react/dist/icons/FileText';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { AgentDock } from '@/components/ui/agent-dock';
import { CHAT_HISTORY_TURNS } from '@/lib/chat-limits';
import type { PanelState } from '@/content/bridge';
import { onPanelState, sendMessage } from '@/content/bridge';

type Turn = { role: 'user' | 'assistant'; content: string; failed?: boolean };

/**
 * Chat zum gelesenen Dokument. Mitgeschickt werden der PDF-Text und die letzten
 * CHAT_HISTORY_TURNS Runden - mehr Verlauf kostet nur Token, ohne die Antwort
 * besser zu machen.
 */
export function ChatDock() {
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => onPanelState(setPanel), []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  const documents = panel?.result?.meta?.coverage?.documents ?? [];
  const ready = panel?.status === 'done' && documents.some((d) => d.hash);

  async function ask(question: string) {
    setError(null);
    const history = turns.filter((t) => !t.failed).slice(-CHAT_HISTORY_TURNS * 2);
    setTurns((prev) => [...prev, { role: 'user', content: question }]);

    const res = await sendMessage({
      type: 'CHAT',
      payload: {
        question,
        history,
        documents: documents.map((d) => ({ label: d.label, hash: d.hash })),
        pageContext: panel?.context ?? {}
      }
    });

    if (res.ok) {
      setTurns((prev) => [...prev, { role: 'assistant', content: res.answer ?? '' }]);
      return;
    }
    setError(res.error ?? 'Die Anfrage ist fehlgeschlagen.');
    setTurns((prev) => [...prev, { role: 'assistant', content: res.error ?? '', failed: true }]);
  }

  if (!panel || panel.status !== 'done') return null;

  return (
    <div className="vms-app px-3 pb-3 pt-1">
      {turns.length > 0 && (
        <div
          className="mb-2 max-h-56 space-y-2 overflow-y-auto pr-1"
          ref={scrollRef}
        >
          <AnimatePresence initial={false}>
            {turns.map((turn, i) => (
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                initial={{ opacity: 0, y: 6 }}
                key={`${i}-${turn.role}`}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <p
                  className={
                    turn.role === 'user'
                      ? 'ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-panel-accent/15 px-3 py-2 text-[12.5px] leading-relaxed'
                      : turn.failed
                        ? 'w-fit max-w-[92%] rounded-2xl rounded-bl-sm bg-panel-crit/10 px-3 py-2 text-[12.5px] leading-relaxed text-panel-crit'
                        : 'w-fit max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-panel-text/[0.06] px-3 py-2 text-[12.5px] leading-relaxed'
                  }
                >
                  {turn.content}
                </p>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <AgentDock
        agentName="Zum Dokument fragen"
        avatar={<FileTextIcon size={18} weight="bold" />}
        disabled={!ready}
        idleStatus={ready ? 'Antwortet nur aus dem Dokument' : 'Kein gelesenes Dokument'}
        onMessageSubmit={ask}
        workingStatus="Sucht im Dokument …"
      />

      {error && <p className="mt-2 px-1 text-[11px] text-panel-crit">{error}</p>}
    </div>
  );
}

export default ChatDock;
