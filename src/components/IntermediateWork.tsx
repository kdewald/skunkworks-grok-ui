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
  Trash2,
  Wrench,
} from "lucide-react";
import type { IntermediateBlock, Turn } from "../types";
import { useAppStore } from "../store";
import { formatToolInput, formatToolPayload } from "../contentFormat";

function ToolIcon({ kind }: { kind?: string | null }) {
  const props = { size: 13, strokeWidth: 1.75 as const };
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
  if (status === "completed") return "st-done";
  if (status === "failed") return "st-fail";
  if (status === "in_progress") return "st-run";
  if (status === "cancelled") return "st-cancel";
  return "st-pending";
}

function PayloadView({ value, label }: { value: unknown; label: string }) {
  if (value == null) return null;
  const formatted = formatToolPayload(value);
  if (!formatted.text.trim()) return null;
  return (
    <details open={label !== "Raw"}>
      <summary>{label}</summary>
      <pre className="code">{formatted.text}</pre>
    </details>
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

  if (block.type === "thought") {
    return (
      <div className="block thought">
        <button
          className="block-header"
          onClick={() => setBlockCollapsed(turnId, block.id, !block.collapsed)}
        >
          {block.collapsed ? (
            <ChevronRight size={13} className="chev-icon" />
          ) : (
            <ChevronDown size={13} className="chev-icon" />
          )}
          <Brain size={13} strokeWidth={1.75} className="block-type-icon" />
          <span className="block-label">Thinking</span>
          <span className="block-meta">
            {block.text.length.toLocaleString()} chars
          </span>
        </button>
        {!block.collapsed && (
          <div className="block-body thought-body">
            <pre>{block.text}</pre>
          </div>
        )}
      </div>
    );
  }

  if (block.type === "plan") {
    return (
      <div className="block plan">
        <button
          className="block-header"
          onClick={() => setBlockCollapsed(turnId, block.id, !block.collapsed)}
        >
          {block.collapsed ? (
            <ChevronRight size={13} className="chev-icon" />
          ) : (
            <ChevronDown size={13} className="chev-icon" />
          )}
          <span className="block-label">Plan</span>
          <span className="block-meta">{block.entries.length} steps</span>
        </button>
        {!block.collapsed && (
          <ol className="plan-list">
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

  return (
    <div className={`block tool ${statusClass(block.status)}`}>
      <button
        className="block-header"
        onClick={() => setBlockCollapsed(turnId, block.id, !block.collapsed)}
      >
        {block.collapsed ? (
          <ChevronRight size={13} className="chev-icon" />
        ) : (
          <ChevronDown size={13} className="chev-icon" />
        )}
        <span className="block-type-icon">
          <ToolIcon kind={block.kind} />
        </span>
        <span className="block-label">{block.title}</span>
        <span className={`status-chip ${statusClass(block.status)}`}>
          {block.status === "in_progress" && (
            <Loader2 size={10} className="spin" />
          )}
          {block.status}
        </span>
      </button>
      {!block.collapsed && (
        <div className="block-body">
          {inputText && (
            <details>
              <summary>Input</summary>
              <pre className="code">{inputText}</pre>
            </details>
          )}
          {primary && (
            <details open>
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

export function IntermediateWork({ turn }: { turn: Turn }) {
  const setTurnCollapsed = useAppStore((s) => s.setTurnCollapsed);
  const count = turn.intermediate.length;
  if (count === 0) return null;

  const toolCount = turn.intermediate.filter((b) => b.type === "tool").length;
  const thoughtCount = turn.intermediate.filter(
    (b) => b.type === "thought",
  ).length;
  const summary = [
    thoughtCount ? `${thoughtCount} thought` : null,
    toolCount ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : null,
    turn.intermediate.some((b) => b.type === "plan") ? "plan" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const collapsed = turn.intermediateCollapsed;
  const streaming = turn.status === "streaming";

  return (
    <div
      className={`intermediate ${collapsed ? "is-collapsed" : "is-expanded"} ${streaming ? "is-streaming" : ""}`}
    >
      <button
        className="intermediate-toggle"
        onClick={() => setTurnCollapsed(turn.id, !collapsed)}
      >
        {collapsed ? (
          <ChevronRight size={13} className="chev-icon" />
        ) : (
          <ChevronDown size={13} className="chev-icon" />
        )}
        <span className="intermediate-title">
          {streaming ? "Working" : "Work"}
        </span>
        <span className="intermediate-summary">
          {summary || `${count} steps`}
        </span>
        {streaming && <Loader2 size={12} className="spin work-spinner" />}
      </button>
      {!collapsed && (
        <div className="intermediate-body">
          {turn.intermediate.map((b) => (
            <BlockView key={b.id} turnId={turn.id} block={b} />
          ))}
        </div>
      )}
    </div>
  );
}

export function AssistantMessage({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="assistant-msg markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
