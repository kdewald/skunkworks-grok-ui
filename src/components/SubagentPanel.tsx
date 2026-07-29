import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bot, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { ChatDocument, IntermediateBlock } from "../types";
import { useAppStore } from "../store";
import { Markdown } from "../Markdown";

type SubagentBlock = Extract<IntermediateBlock, { type: "subagent" }>;

function isRunning(status: string) {
  return (
    status === "running" ||
    status === "in_progress" ||
    status === "pending"
  );
}

function collectSubagents(chat: ChatDocument | null): Array<{
  turnId: string;
  turnLabel: string;
  block: SubagentBlock;
}> {
  if (!chat) return [];
  const out: Array<{
    turnId: string;
    turnLabel: string;
    block: SubagentBlock;
  }> = [];
  chat.turns.forEach((turn, i) => {
    const label =
      turn.userMessage.trim().slice(0, 40) ||
      (turn.status === "streaming" ? "Current turn" : `Turn ${i + 1}`);
    for (const b of turn.intermediate) {
      if (b.type === "subagent") {
        out.push({ turnId: turn.id, turnLabel: label, block: b });
      }
    }
  });
  return out;
}

function statusClass(status: string) {
  if (status === "completed" || status === "complete") return "st-done";
  if (status === "failed" || status === "error") return "st-fail";
  if (isRunning(status)) return "st-run";
  if (status === "cancelled") return "st-cancel";
  return "st-pending";
}

function SubagentCard({
  block,
  turnLabel,
  defaultOpen,
}: {
  block: SubagentBlock;
  turnLabel: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const running = isRunning(block.status);

  // Stay open while running; re-open when fresh output lands.
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  useEffect(() => {
    if (block.output) setOpen(true);
  }, [block.output]);
  useEffect(() => {
    if (block.progress) setOpen(true);
  }, [block.progress]);

  return (
    <div className={`subagent-card ${statusClass(block.status)}`}>
      <button
        type="button"
        className="subagent-card-header"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown size={12} className="chev-icon" />
        ) : (
          <ChevronRight size={12} className="chev-icon" />
        )}
        <Bot size={13} strokeWidth={1.75} className="subagent-card-icon" />
        <div className="subagent-card-titles">
          <div className="subagent-card-title">
            {block.description || "Subagent"}
          </div>
          <div className="subagent-card-sub">
            {[block.subagentType, block.model, turnLabel]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <span className={`status-chip ${statusClass(block.status)}`}>
          {running && <Loader2 size={10} className="spin" />}
          {block.status}
        </span>
      </button>
      {open && (
        <div className="subagent-card-body">
          {block.progress && (
            <>
              <div className="subagent-card-section-label">Progress</div>
              <Markdown className="markdown subagent-card-md subagent-card-progress">
                {block.progress}
              </Markdown>
            </>
          )}
          {block.output && (
            <>
              <div className="subagent-card-section-label">Result</div>
              <Markdown className="markdown subagent-card-md">
                {block.output}
              </Markdown>
            </>
          )}
          {!block.progress && !block.output && (
            <div className="subagent-card-empty">
              {running
                ? "Running in the background… results appear here when done."
                : "No output captured."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Props = {
  chat: ChatDocument | null;
  focusTurnId?: string | null;
};

/**
 * Right-hand subagent rail. Visibility is controlled by the header toggle
 * (`subagentsOpen`) — same pattern as the terminal dock.
 */
export function SubagentPanel({ chat, focusTurnId }: Props) {
  const subagentsOpen = useAppStore((s) => s.subagentsOpen);
  const items = useMemo(() => collectSubagents(chat), [chat]);
  const anyRunning = items.some((i) => isRunning(i.block.status));
  const subagentSessionIds = items
    .map(({ block }) => block.subagentId)
    .sort()
    .join("\n");

  // Codex child agents are separate ACP sessions. Loading them replays existing
  // history and subscribes to live progress; polling also recovers after an
  // adapter restart without creating duplicate subscriptions.
  useEffect(() => {
    if (!chat || chat.backend !== "codex" || !subagentSessionIds) return;
    const sessionIds = subagentSessionIds.split("\n");
    let watchRunning = false;
    const watch = async () => {
      if (watchRunning) return;
      watchRunning = true;
      for (const subagentId of sessionIds) {
        try {
          await invoke("watch_subagent_session", {
            chatId: chat.id,
            subagentId,
          });
        } catch {
          // The agent may still be reconnecting. The interval retries.
        }
      }
      watchRunning = false;
    };
    void watch();
    const timer = window.setInterval(() => void watch(), 5_000);
    return () => window.clearInterval(timer);
  }, [chat?.backend, chat?.id, subagentSessionIds]);

  // Nothing to show — header button is also hidden.
  if (items.length === 0 || !subagentsOpen) return null;

  const ordered = [...items].sort((a, b) => {
    if (focusTurnId) {
      if (a.turnId === focusTurnId && b.turnId !== focusTurnId) return -1;
      if (b.turnId === focusTurnId && a.turnId !== focusTurnId) return 1;
    }
    const ar = isRunning(a.block.status) ? 0 : 1;
    const br = isRunning(b.block.status) ? 0 : 1;
    if (ar !== br) return ar - br;
    const ao = a.block.output ? 0 : 1;
    const bo = b.block.output ? 0 : 1;
    return ao - bo;
  });

  return (
    <aside
      className={`subagent-panel is-open${anyRunning ? " has-running" : ""}`}
      aria-label="Subagents"
    >
      <div className="subagent-panel-bar">
        <div className="subagent-panel-title-row">
          <Bot size={14} strokeWidth={1.75} />
          <span className="subagent-panel-title">Subagents</span>
          <span className="subagent-panel-count">{items.length}</span>
          {anyRunning && <Loader2 size={12} className="spin" />}
        </div>
      </div>
      <div className="subagent-panel-list">
        <p className="subagent-panel-hint">
          Parallel workers — reports land here, not in the main transcript.
        </p>
        {ordered.map(({ block, turnLabel, turnId }) => (
          <SubagentCard
            key={block.id}
            block={block}
            turnLabel={turnLabel}
            defaultOpen={
              turnId === focusTurnId ||
              isRunning(block.status) ||
              !!block.output
            }
          />
        ))}
      </div>
    </aside>
  );
}
