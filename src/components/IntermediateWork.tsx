import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  FilePenLine,
  FileSearch,
  Globe,
  Loader2,
  Search,
  Terminal,
  Timer,
  Trash2,
  Wrench,
} from "lucide-react";
import type { IntermediateBlock, Turn } from "../types";
import { useAppStore } from "../store";
import { formatToolInput, formatToolPayload } from "../contentFormat";

function ToolIcon({ kind }: { kind?: string | null }) {
  const props = { size: 12, strokeWidth: 1.75 as const };
  switch (kind) {
    case "read":
      return <FileSearch {...props} />;
    case "edit":
      return <FilePenLine {...props} />;
    case "delete":
      return <Trash2 {...props} />;
    case "search":
      return <Search {...props} />;
    case "execute":
      return <Terminal {...props} />;
    case "think":
      return <Brain {...props} />;
    case "fetch":
      return <Globe {...props} />;
    default:
      return <Wrench {...props} />;
  }
}

function statusClass(status: string) {
  if (status === "completed" || status === "complete") return "st-done";
  if (status === "failed" || status === "error") return "st-fail";
  if (
    status === "in_progress" ||
    status === "running" ||
    status === "pending"
  )
    return "st-run";
  if (status === "cancelled") return "st-cancel";
  return "st-pending";
}

function isRunningStatus(status: string) {
  return (
    status === "in_progress" ||
    status === "running" ||
    status === "pending"
  );
}

function PayloadView({ value, label }: { value: unknown; label: string }) {
  if (value == null) return null;
  const formatted = formatToolPayload(value);
  if (!formatted.text.trim()) return null;
  return (
    <details>
      <summary>{label}</summary>
      <pre className="code">{formatted.text}</pre>
    </details>
  );
}

/** Visible thinking stream — distinct from assistant replies, content always readable. */
function ThoughtStream({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  if (!text.trim()) return null;
  return (
    <div className={`thought-stream ${open ? "is-open" : "is-closed"}`}>
      <button
        type="button"
        className="thought-stream-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <Brain size={12} strokeWidth={1.75} className="thought-stream-icon" />
        <span className="thought-stream-label">Thinking</span>
        <span className="thought-stream-meta">
          {text.length.toLocaleString()} chars
        </span>
        {open ? (
          <ChevronDown size={12} className="chev-icon" />
        ) : (
          <ChevronRight size={12} className="chev-icon" />
        )}
      </button>
      {open && (
        <div className="thought-stream-body">
          <p className="thought-stream-text">{text}</p>
        </div>
      )}
    </div>
  );
}

function BlockView({
  turnId,
  block,
}: {
  turnId: string;
  block: IntermediateBlock;
}) {
  const setBlockCollapsed = useAppStore((s) => s.setBlockCollapsed);

  if (block.type === "message" || block.type === "thought") {
    // Messages + thoughts are rendered by the timeline, not as work rows.
    return null;
  }

  // Subagents render in SubagentPanel (side rail), not the main transcript.
  if (block.type === "subagent") {
    return null;
  }

  if (block.type === "task") {
    const running = isRunningStatus(block.status);
    return (
      <div className={`block compact task ${statusClass(block.status)}`}>
        <button
          className="block-header compact"
          onClick={() => setBlockCollapsed(turnId, block.id, !block.collapsed)}
        >
          {block.collapsed ? (
            <ChevronRight size={11} className="chev-icon" />
          ) : (
            <ChevronDown size={11} className="chev-icon" />
          )}
          <span className="block-type-icon">
            <Timer size={12} strokeWidth={1.75} />
          </span>
          <span className="block-label" title={block.command || block.description}>
            {block.description || "Background task"}
          </span>
          <span className={`status-dot ${statusClass(block.status)}`} title={block.status}>
            {running && <Loader2 size={10} className="spin" />}
          </span>
        </button>
        {!block.collapsed && (
          <div className="block-body compact">
            {block.command && (
              <details>
                <summary>Command</summary>
                <pre className="code">{block.command}</pre>
              </details>
            )}
            {block.output && (
              <details>
                <summary>Output</summary>
                <pre className="code">{block.output}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    );
  }

  if (block.type === "plan") {
    return (
      <div className="block compact plan">
        <button
          className="block-header compact"
          onClick={() => setBlockCollapsed(turnId, block.id, !block.collapsed)}
        >
          {block.collapsed ? (
            <ChevronRight size={11} className="chev-icon" />
          ) : (
            <ChevronDown size={11} className="chev-icon" />
          )}
          <span className="block-label">Plan</span>
          <span className="block-meta">{block.entries.length} steps</span>
        </button>
        {!block.collapsed && (
          <ol className="plan-list compact">
            {block.entries.map((e, i) => (
              <li key={i} className={`plan-item ${e.status ?? ""}`}>
                <span className="plan-status">{e.status ?? "pending"}</span>
                <span>{e.content}</span>
                {e.priority && <span className="plan-pri">{e.priority}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  // Tool — dense single line; expand for I/O
  const running = isRunningStatus(block.status);
  const inputText =
    block.rawInput != null ? formatToolInput(block.rawInput) : "";
  const content = block.content != null ? formatToolPayload(block.content) : null;
  const output =
    block.rawOutput != null ? formatToolPayload(block.rawOutput) : null;
  const primary =
    content && content.text.trim()
      ? content
      : output && output.text.trim()
        ? output
        : null;
  const showRawOut =
    output &&
    primary &&
    content &&
    content.text.trim() &&
    output.text.trim() &&
    output.text !== content.text;
  const hasDetail = !!(inputText || primary || showRawOut);

  return (
    <div className={`block compact tool ${statusClass(block.status)}`}>
      <button
        className="block-header compact tool-row"
        onClick={() =>
          hasDetail && setBlockCollapsed(turnId, block.id, !block.collapsed)
        }
        disabled={!hasDetail}
        title={block.title}
      >
        <span className="block-type-icon">
          <ToolIcon kind={block.kind} />
        </span>
        <span className="block-label">{block.title}</span>
        <span
          className={`status-dot ${statusClass(block.status)}`}
          title={block.status}
        >
          {running ? (
            <Loader2 size={10} className="spin" />
          ) : (
            <span className="status-dot-core" />
          )}
        </span>
        {hasDetail &&
          (block.collapsed ? (
            <ChevronRight size={11} className="chev-icon tool-chev" />
          ) : (
            <ChevronDown size={11} className="chev-icon tool-chev" />
          ))}
      </button>
      {!block.collapsed && hasDetail && (
        <div className="block-body compact">
          {inputText && (
            <details>
              <summary>Input</summary>
              <pre className="code">{inputText}</pre>
            </details>
          )}
          {primary && (
            <details>
              <summary>Result</summary>
              <pre className="code">{primary.text}</pre>
            </details>
          )}
          {showRawOut && (
            <PayloadView value={block.rawOutput} label="Raw output" />
          )}
        </div>
      )}
    </div>
  );
}

type TimelineRun =
  | { kind: "work"; key: string; blocks: IntermediateBlock[] }
  | { kind: "thought"; key: string; text: string }
  | { kind: "message"; key: string; text: string };

/** Tool shapes that belong in SubagentPanel, not the main work strip. */
function isSubagentRailTool(b: IntermediateBlock): boolean {
  if (b.type !== "tool") return false;
  const ri = (b.rawInput ?? null) as Record<string, unknown> | null;
  const variant = String(ri?.variant ?? "").toLowerCase();
  const title = (b.title ?? "").toLowerCase();
  if (variant === "task") {
    return !!(
      ri?.prompt ||
      ri?.subagent_type ||
      ri?.subagentType ||
      ri?.description
    );
  }
  if (
    variant === "taskoutput" ||
    variant === "task_output" ||
    title.includes("get_command_or_subagent_output") ||
    title.includes("wait_commands_or_subagents")
  ) {
    return true;
  }
  if (ri && typeof ri === "object") {
    if (
      (ri.prompt || ri.description) &&
      (ri.subagent_type || ri.subagentType || ri.capability_mode || ri.capabilityMode)
    ) {
      return true;
    }
    if (ri.task_ids || ri.taskIds) return true;
  }
  return false;
}

/**
 * Group intermediate into: thought streams (visible), work (tools/etc), messages.
 * Consecutive thoughts are merged so thinking reads as one stream.
 */
function buildTimeline(blocks: IntermediateBlock[]): TimelineRun[] {
  const runs: TimelineRun[] = [];
  for (const b of blocks) {
    // Subagent reports live only in the right-hand SubagentPanel.
    if (b.type === "subagent") continue;
    if (isSubagentRailTool(b)) continue;

    if (b.type === "message") {
      if (!b.text.trim()) continue;
      const last = runs[runs.length - 1];
      if (last?.kind === "message") {
        last.text += b.text;
        continue;
      }
      runs.push({ kind: "message", key: b.id, text: b.text });
      continue;
    }
    if (b.type === "thought") {
      if (!b.text.trim()) continue;
      const last = runs[runs.length - 1];
      if (last?.kind === "thought") {
        last.text += b.text;
        continue;
      }
      runs.push({ kind: "thought", key: b.id, text: b.text });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last?.kind === "work") {
      last.blocks.push(b);
    } else {
      runs.push({ kind: "work", key: b.id, blocks: [b] });
    }
  }

  // message → thought → message  ⇒  thought, then one merged message
  const coalesced: TimelineRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const cur = runs[i];
    const prev = coalesced[coalesced.length - 1];
    const next = runs[i + 1];
    if (
      cur.kind === "thought" &&
      prev?.kind === "message" &&
      next?.kind === "message"
    ) {
      const msg = coalesced.pop();
      if (msg?.kind === "message") {
        coalesced.push(cur);
        coalesced.push({
          kind: "message",
          key: msg.key,
          text: msg.text + next.text,
        });
        i += 1;
        continue;
      }
    }
    coalesced.push(cur);
  }
  return coalesced;
}

function WorkGroup({
  turnId,
  blocks,
  streaming,
  forceCollapsed,
}: {
  turnId: string;
  blocks: IntermediateBlock[];
  streaming: boolean;
  forceCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useStateAwareCollapse(
    forceCollapsed ?? !streaming,
  );

  // Tools-only groups auto-expand while streaming so rows are visible; stay compact.
  // Filter out subagents / Task spawns (side panel only) and empty leftovers.
  const visible = blocks.filter(
    (b) => b.type !== "subagent" && !isSubagentRailTool(b),
  );
  if (visible.length === 0) return null;

  const toolCount = visible.filter((b) => b.type === "tool").length;
  const taskCount = visible.filter((b) => b.type === "task").length;
  const summary = [
    toolCount ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : null,
    taskCount ? `${taskCount} task${taskCount === 1 ? "" : "s"}` : null,
    visible.some((b) => b.type === "plan") ? "plan" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // When only a few tools, skip the outer shell and show compact rows directly.
  const bare =
    visible.length <= 6 && !visible.some((b) => b.type === "plan");

  if (bare && !forceCollapsed) {
    return (
      <div className={`work-strip ${streaming ? "is-streaming" : ""}`}>
        <div className="work-strip-rows">
          {visible.map((b) => (
            <BlockView key={b.id} turnId={turnId} block={b} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`intermediate compact ${collapsed ? "is-collapsed" : "is-expanded"} ${streaming ? "is-streaming" : ""}`}
    >
      <button
        className="intermediate-toggle"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? (
          <ChevronRight size={12} className="chev-icon" />
        ) : (
          <ChevronDown size={12} className="chev-icon" />
        )}
        <span className="intermediate-title">
          {streaming ? "Working" : "Work"}
        </span>
        <span className="intermediate-summary">
          {summary || `${visible.length} steps`}
        </span>
        {streaming && <Loader2 size={11} className="spin work-spinner" />}
      </button>
      {!collapsed && (
        <div className="intermediate-body compact">
          {visible.map((b) => (
            <BlockView key={b.id} turnId={turnId} block={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function useStateAwareCollapse(preferred: boolean) {
  const [collapsed, setCollapsed] = useState(preferred);
  const prev = useRef(preferred);
  useEffect(() => {
    if (prev.current !== preferred) {
      setCollapsed(preferred);
      prev.current = preferred;
    }
  }, [preferred]);
  return [collapsed, setCollapsed] as const;
}

export function IntermediateWork({ turn }: { turn: Turn }) {
  const streaming = turn.status === "streaming";
  const timeline = buildTimeline(turn.intermediate);
  const hasMessageBlocks = timeline.some((r) => r.kind === "message");
  const legacyText =
    !hasMessageBlocks && turn.assistantMessage.trim()
      ? turn.assistantMessage
      : null;

  if (timeline.length === 0 && !legacyText) return null;

  return (
    <div className="turn-timeline">
      {timeline.map((run, idx) => {
        if (run.kind === "message") {
          return <AssistantMessage key={run.key} text={run.text} />;
        }
        if (run.kind === "thought") {
          return <ThoughtStream key={run.key} text={run.text} />;
        }
        const laterHasMessage = timeline
          .slice(idx + 1)
          .some((r) => r.kind === "message");
        const groupStreaming = streaming && !laterHasMessage;
        return (
          <WorkGroup
            key={run.key}
            turnId={turn.id}
            blocks={run.blocks}
            streaming={groupStreaming}
            forceCollapsed={turn.intermediateCollapsed && !streaming}
          />
        );
      })}
      {legacyText && <AssistantMessage text={legacyText} />}
    </div>
  );
}

export const AssistantMessage = React.memo(function AssistantMessage({
  text,
}: {
  text: string;
}) {
  if (!text) return null;
  return (
    <div className="assistant-msg markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});
