import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type { ChatDocument, IntermediateBlock } from "../types";

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
          {block.output ? (
            <div className="markdown subagent-card-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {block.output}
              </ReactMarkdown>
            </div>
          ) : (
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

export function SubagentPanel({ chat, focusTurnId }: Props) {
  const items = useMemo(() => collectSubagents(chat), [chat]);
  const anyRunning = items.some((i) => isRunning(i.block.status));
  // Open aggressively whenever there is anything to show (not only while running).
  const [open, setOpen] = useState(items.length > 0);
  const [userClosed, setUserClosed] = useState(false);

  useEffect(() => {
    if (items.length === 0) {
      setOpen(false);
      setUserClosed(false);
      return;
    }
    // Auto-open on first subagent or when a child starts running, unless the
    // user explicitly collapsed the rail this turn.
    if (!userClosed) {
      setOpen(true);
    } else if (anyRunning) {
      // Running always wins — show the rail.
      setOpen(true);
      setUserClosed(false);
    }
  }, [items.length, anyRunning, userClosed]);

  if (items.length === 0) return null;

  const ordered = [...items].sort((a, b) => {
    if (focusTurnId) {
      if (a.turnId === focusTurnId && b.turnId !== focusTurnId) return -1;
      if (b.turnId === focusTurnId && a.turnId !== focusTurnId) return 1;
    }
    const ar = isRunning(a.block.status) ? 0 : 1;
    const br = isRunning(b.block.status) ? 0 : 1;
    if (ar !== br) return ar - br;
    // Prefer cards with output next.
    const ao = a.block.output ? 0 : 1;
    const bo = b.block.output ? 0 : 1;
    return ao - bo;
  });

  return (
    <aside
      className={`subagent-panel ${open ? "is-open" : "is-closed"}${
        anyRunning ? " has-running" : ""
      }`}
      aria-label="Subagents"
    >
      <div className="subagent-panel-bar">
        <button
          type="button"
          className="subagent-panel-toggle"
          onClick={() => {
            setOpen((o) => {
              const next = !o;
              setUserClosed(!next);
              return next;
            });
          }}
          title={open ? "Hide subagents" : "Show subagents"}
        >
          {open ? (
            <PanelRightClose size={15} strokeWidth={1.75} />
          ) : (
            <PanelRightOpen size={15} strokeWidth={1.75} />
          )}
          <span className="subagent-panel-toggle-label">
            Subagents
            <span className="subagent-panel-count">{items.length}</span>
            {anyRunning && <Loader2 size={11} className="spin" />}
          </span>
        </button>
      </div>
      {open && (
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
      )}
    </aside>
  );
}
