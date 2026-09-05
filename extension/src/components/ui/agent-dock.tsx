"use client";

// Einzeln importiert statt über den Sammel-Export: der zieht sonst alle
// paar tausend Icons ins Bundle.
import { Chat as ChatIcon } from "@phosphor-icons/react/dist/icons/Chat";
import { PaperPlaneTilt as PaperPlaneTiltIcon } from "@phosphor-icons/react/dist/icons/PaperPlaneTilt";
import { X as XIcon } from "@phosphor-icons/react/dist/icons/X";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

type AgentDockMode = "idle" | "composing" | "working";

type AgentDockProps = {
  agentName: string;
  avatar?: ReactNode;
  avatarSrc?: string;
  className?: string;
  disabled?: boolean;
  idleStatus?: string;
  placeholder?: string;
  workingStatus?: string;
  children?: ReactNode;
  onMessageSubmit?: (message: string) => void | Promise<void>;
};

const dockTransition = {
  duration: 0.3,
  ease: [0.22, 1, 0.36, 1],
} as const;

export function AgentDock({
  agentName,
  avatar,
  avatarSrc,
  className,
  disabled = false,
  idleStatus = "Bereit",
  placeholder = "Frag etwas zum Dokument …",
  workingStatus = "Liest nach …",
  children,
  onMessageSubmit,
}: AgentDockProps) {
  const [mode, setMode] = useState<AgentDockMode>("idle");
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shouldReduceMotion = useReducedMotion();

  function openComposer() {
    setMode("composing");
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function submitMessage() {
    const nextMessage = message.trim();
    if (!nextMessage) {
      openComposer();
      return;
    }
    setMessage("");
    setMode("working");
    try {
      await onMessageSubmit?.(nextMessage);
    } finally {
      // Nach der Antwort bleibt der Composer offen: die nächste Nachfrage ist
      // der Normalfall, nicht die Ausnahme.
      setMode("composing");
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "composing") {
      void submitMessage();
      return;
    }
    openComposer();
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Esc darf nicht bis zum Panel durchschlagen, das würde es einklappen.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      setMode("idle");
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void submitMessage();
  }

  return (
    <form className={cn("vms-app", className)} onSubmit={handleSubmit}>
      <div className="flex w-full flex-col-reverse overflow-hidden rounded-2xl border border-panel-line bg-panel-card p-2 shadow-lg">
        <div className="flex items-center gap-3">
          {avatarSrc ? (
            <img
              alt=""
              aria-hidden="true"
              className="size-9 shrink-0 rounded-xl"
              height={36}
              src={avatarSrc}
              width={36}
            />
          ) : (
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-xl bg-panel-accent/15 text-panel-accent"
            >
              {avatar}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium leading-none">{agentName}</p>
            <AnimatePresence initial={false} mode="popLayout">
              <motion.p
                animate={{ opacity: 1, y: 0 }}
                className="mt-1 truncate text-xs text-panel-dim"
                exit={{ opacity: 0, y: -6 }}
                initial={{ opacity: 0, y: 6 }}
                key={mode}
                transition={{ duration: 0.16, ease: "easeOut" }}
              >
                {mode === "working" ? workingStatus : idleStatus}
              </motion.p>
            </AnimatePresence>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <DockButton
              disabled={disabled || mode === "working"}
              icon={
                mode === "composing" ? (
                  <PaperPlaneTiltIcon weight="fill" />
                ) : (
                  <ChatIcon weight="bold" />
                )
              }
              label={mode === "composing" ? "Senden" : "Fragen"}
              type="submit"
            />
          </div>
        </div>
        <motion.div
          animate={{
            height: mode === "idle" ? 0 : 120,
            opacity: mode === "idle" ? 0 : 1,
          }}
          aria-hidden={mode === "idle"}
          className="overflow-hidden"
          initial={false}
          transition={shouldReduceMotion ? { duration: 0 } : dockTransition}
        >
          <div className="relative mb-2">
            <button
              aria-label="Eingabe schließen"
              className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md text-panel-dim hover:bg-panel-text/10"
              onClick={() => setMode("idle")}
              type="button"
            >
              <XIcon className="size-3.5" weight="bold" />
            </button>
            <textarea
              aria-label="Frage zum Dokument"
              className="vms-chat-input h-28 w-full resize-none bg-transparent px-2 py-2 pr-9 text-sm leading-6 outline-none placeholder:text-panel-dim"
              disabled={disabled}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              placeholder={placeholder}
              ref={textareaRef}
              value={message}
            />
          </div>
        </motion.div>
        {children}
      </div>
    </form>
  );
}

function DockButton({
  disabled = false,
  icon,
  label,
  type = "button",
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      className="flex h-9 items-center gap-1.5 rounded-lg px-1.5 text-sm font-medium hover:bg-panel-text/10 disabled:opacity-40 disabled:hover:bg-transparent"
      disabled={disabled}
      type={type}
    >
      <span className="size-4">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export default AgentDock;
