import {
  useState,
  useRef,
  useEffect,
  KeyboardEvent,
  ClipboardEvent,
  DragEvent,
  ChangeEvent,
} from "react";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import {
  ClipboardPaste,
  FileText,
  Folder,
  Paperclip,
  Plus,
  SendHorizontal,
  Square,
  X,
} from "lucide-react";
import { healStuckBusy, useAppStore } from "../store";
import {
  FILE_ACCEPT,
  MAX_ATTACHMENTS,
  PendingAttachment,
  fileToPending,
  formatSize,
  uid,
} from "../attachments";
import { chipLabel } from "../contextChips";
import { agentBackendLabel, normalizeAgentBackend } from "../types";

type Props = {
  onSend?: () => void;
};

export function Composer({ onSend }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const {
    sendMessage,
    resubmitFromTurn,
    cancelPrompt,
    busy,
    activeChat,
    activeChatId,
    activeBackend,
    agent,
    messageQueue,
    removeQueuedMessage,
    clearMessageQueue,
    contextChips,
    removeContextChip,
    updateContextChipNote,
    clearContextChips,
    composerEdit,
    clearComposerEdit,
  } = useAppStore();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Prevent double Enter while send_message invoke is in flight. */
  const sendingRef = useRef(false);
  // Only a live streaming turn keeps Stop visible — cancelled/cancelling must not.
  const streaming = activeChat?.turns.some((t) => t.status === "streaming");
  const chatQueue = messageQueue.filter((m) => m.chatId === activeChatId);
  const editing =
    composerEdit?.chatId === activeChatId ? composerEdit : null;
  const backendLabel = agentBackendLabel(
    normalizeAgentBackend(activeChat?.backend ?? activeBackend),
  );

  useEffect(() => {
    taRef.current?.focus();
  }, [activeChat?.id]);

  // Seed the bottom textarea when the user picks Edit on a prior message.
  useEffect(() => {
    if (!composerEdit || composerEdit.chatId !== activeChatId) return;
    setText(composerEdit.text);
    setAttachments([]);
    setMenuOpen(false);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
  }, [composerEdit?.seed, composerEdit?.chatId, activeChatId]);

  // Keep the textarea height in lockstep with content so + / text / send
  // share one row when empty, and grow together when multi-line.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "34px";
    const next = Math.min(Math.max(el.scrollHeight, 34), 160);
    el.style.height = `${next}px`;
  }, [text]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function flash(msg: string) {
    setHint(msg);
    window.setTimeout(() => setHint(null), 3500);
  }

  function addAttachments(next: PendingAttachment[]) {
    if (!next.length) return;
    setAttachments((prev) => {
      const room = MAX_ATTACHMENTS - prev.length;
      if (room <= 0) {
        flash(`Max ${MAX_ATTACHMENTS} attachments per message`);
        return prev;
      }
      if (next.length > room) {
        flash(`Only added ${room} (max ${MAX_ATTACHMENTS})`);
      }
      return [...prev, ...next.slice(0, room)];
    });
  }

  async function ingestFiles(files: File[]) {
    const ok: PendingAttachment[] = [];
    const errors: string[] = [];
    for (const f of files) {
      const res = await fileToPending(f);
      if (res.ok) ok.push(res.attachment);
      else errors.push(res.reason);
    }
    if (errors.length) flash(errors[0]);
    addAttachments(ok);
  }

  async function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) files.push(blob);
      }
    }
    if (files.length) {
      e.preventDefault();
      await ingestFiles(files);
    }
  }

  async function pasteImageFromClipboard() {
    setMenuOpen(false);
    try {
      if (navigator.clipboard && "read" in navigator.clipboard) {
        const items = await navigator.clipboard.read();
        const files: File[] = [];
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (!type) continue;
          const blob = await item.getType(type);
          files.push(
            new File([blob], `clipboard.${type.split("/")[1] || "png"}`, {
              type,
            }),
          );
        }
        if (files.length) {
          await ingestFiles(files);
          return;
        }
      }
    } catch {
      // native fallback
    }

    try {
      const img = await readImage();
      const rgba = await img.rgba();
      const size = await img.size();
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(rgba), size.width, size.height),
        0,
        0,
      );
      const dataUrl = canvas.toDataURL("image/png");
      const data = dataUrl.split(",")[1] || "";
      if (!data) throw new Error("empty clipboard image");
      addAttachments([
        {
          id: uid(),
          kind: "image",
          name: "clipboard.png",
          mimeType: "image/png",
          data,
          dataUrl,
          size: Math.floor((data.length * 3) / 4),
        },
      ]);
    } catch {
      flash("No image on the clipboard");
    }
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    await ingestFiles(Array.from(e.dataTransfer?.files || []));
  }

  async function onFilePick(e: ChangeEvent<HTMLInputElement>) {
    await ingestFiles(Array.from(e.target.files || []));
    e.target.value = "";
    setMenuOpen(false);
  }

  async function submit() {
    const value = text.trim();
    const editingNow =
      composerEdit?.chatId === activeChatId ? composerEdit : null;
    if (
      !value &&
      attachments.length === 0 &&
      contextChips.length === 0 &&
      !editingNow?.hasAttachments
    ) {
      return;
    }
    if (sendingRef.current) return;

    // Lost prompt-finished leaves busy=true with no stream → Send was a no-op.
    // Force-heal here: sendingRef already blocks true double-dispatch.
    healStuckBusy(useAppStore.setState, useAppStore.getState, { force: true });
    const state = useAppStore.getState();
    const nowStreaming = !!state.activeChat?.turns.some(
      (t) => t.status === "streaming",
    );
    const nowBusy = state.busy;

    if (editingNow) {
      if (editingNow.laterCount > 0) {
        const n = editingNow.laterCount;
        const ok = window.confirm(
          n === 1
            ? "Resending will remove this reply. Continue?"
            : `Resending will remove this reply and ${n} later messages. Continue?`,
        );
        if (!ok) return;
      } else if (nowStreaming) {
        const ok = window.confirm(
          "This will stop the current response and resend your message. Continue?",
        );
        if (!ok) return;
      }
    }

    const prevAttachments = attachments;
    const toSend = attachments.map((a) => ({
      kind: a.kind,
      data: a.data,
      mimeType: a.mimeType,
      name: a.name,
      dataUrl: a.dataUrl,
    }));
    const chipsSnapshot = contextChips;
    const editSnapshot = editingNow;
    setText("");
    setAttachments([]);
    onSend?.();
    if (!editSnapshot && (nowStreaming || nowBusy)) {
      flash(
        chatQueue.length === 0
          ? "Queued — will send when this turn finishes (Stop to interrupt)"
          : `Queued (${chatQueue.length + 1})`,
      );
    }
    sendingRef.current = true;
    try {
      if (editSnapshot) {
        await resubmitFromTurn(editSnapshot.turnId, value, {
          keepOriginalAttachments: editSnapshot.hasAttachments,
          extraAttachments: toSend,
        });
      } else {
        await sendMessage(value, toSend);
      }
    } catch (e) {
      // Restore draft so a failed send is not silent data-loss.
      setText(value);
      setAttachments(prevAttachments);
      flash(String(e));
      if (
        chipsSnapshot.length &&
        useAppStore.getState().contextChips.length === 0
      ) {
        for (const c of chipsSnapshot) {
          useAppStore.getState().addContextChip(c);
        }
      }
    } finally {
      sendingRef.current = false;
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && editing) {
      e.preventDefault();
      clearComposerEdit();
      setText("");
      setAttachments([]);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  // Grace period: real sends set busy before streaming starts. Only treat
  // busy&&!streaming as stuck after a few seconds (missed prompt-finished).
  useEffect(() => {
    if (!busy || streaming) return;
    const t = window.setTimeout(() => {
      healStuckBusy(useAppStore.setState, useAppStore.getState, {
        force: true,
      });
    }, 5000);
    return () => window.clearTimeout(t);
  }, [busy, streaming]);

  const hasContent =
    !!text.trim() ||
    attachments.length > 0 ||
    contextChips.length > 0 ||
    !!editing?.hasAttachments;
  // Enable whenever there is content. submit() heals a stuck busy lock, queues
  // while streaming, and sendingRef blocks a true double-dispatch.
  const canSend = hasContent;
  const canAttach = true;

  return (
    <div
      className={`composer ${dragOver ? "drag-over" : ""} ${editing ? "is-editing" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void onDrop(e)}
    >
      {editing && (
        <div className="edit-banner">
          <div className="edit-banner-text">
            <span className="edit-banner-label">Editing message</span>
            <span className="edit-banner-detail">
              {editing.laterCount > 0
                ? `Send will replace it and remove ${editing.laterCount} later message${editing.laterCount === 1 ? "" : "s"}.`
                : "Send will replace this message and its reply."}
              {editing.hasAttachments
                ? " Original attachments are kept."
                : ""}{" "}
              Esc to cancel.
            </span>
          </div>
          <button
            type="button"
            className="edit-banner-cancel"
            title="Cancel edit"
            onClick={() => {
              clearComposerEdit();
              setText("");
              setAttachments([]);
              taRef.current?.focus();
            }}
          >
            <X size={13} strokeWidth={2} />
            Cancel
          </button>
        </div>
      )}

      {chatQueue.length > 0 && (
        <div className="queue-row">
          <div className="queue-label">
            Queued ({chatQueue.length})
            <button
              type="button"
              className="queue-clear"
              onClick={() => clearMessageQueue(activeChatId ?? undefined)}
            >
              Clear
            </button>
          </div>
          {chatQueue.map((m) => (
            <div key={m.id} className="queue-chip" title={m.text}>
              <span className="queue-chip-text">
                {m.text.trim()
                  ? m.text.trim().slice(0, 80)
                  : m.attachments.length
                    ? `${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}`
                    : "(empty)"}
              </span>
              <button
                type="button"
                className="queue-remove"
                title="Remove from queue"
                onClick={() => removeQueuedMessage(m.id)}
              >
                <X size={11} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}

      {contextChips.length > 0 && (
        <div className="context-row">
          <div className="context-row-label">
            Context
            <button
              type="button"
              className="queue-clear"
              onClick={() => clearContextChips()}
            >
              Clear
            </button>
          </div>
          {contextChips.map((c) => (
            <div
              key={c.id}
              className={`context-chip kind-${c.kind}`}
              title={c.path}
            >
              <span className="context-chip-icon">
                {c.kind === "dir" ? (
                  <Folder size={13} strokeWidth={1.75} />
                ) : (
                  <FileText size={13} strokeWidth={1.75} />
                )}
              </span>
              <div className="context-chip-body">
                <div className="context-chip-name mono">{chipLabel(c)}</div>
                <input
                  className="context-chip-note"
                  placeholder="Optional note…"
                  value={c.note ?? ""}
                  onChange={(e) => updateContextChipNote(c.id, e.target.value)}
                />
              </div>
              <button
                type="button"
                className="attach-remove"
                title="Remove"
                onClick={() => removeContextChip(c.id)}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((a) => (
            <div
              key={a.id}
              className={`attach-chip ${a.kind === "image" ? "is-image" : "is-file"}`}
            >
              {a.kind === "image" && a.dataUrl ? (
                <img src={a.dataUrl} alt={a.name} className="attach-chip-img" />
              ) : (
                <span className="attach-chip-icon">
                  <FileText size={16} strokeWidth={1.75} />
                </span>
              )}
              <div className="attach-chip-meta">
                <div className="attach-chip-name" title={a.name}>
                  {a.name}
                </div>
                <div className="attach-chip-sub">
                  {a.kind} · {formatSize(a.size)}
                </div>
              </div>
              <button
                type="button"
                className="attach-remove"
                title="Remove"
                onClick={() =>
                  setAttachments((prev) => prev.filter((p) => p.id !== a.id))
                }
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}

      {hint && <div className="composer-hint">{hint}</div>}

      <div className={`composer-shell ${menuOpen ? "menu-open" : ""}`}>
        <div className="attach-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="composer-icon-btn"
            title="Attach"
            disabled={!canAttach}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Plus size={18} strokeWidth={1.75} />
          </button>
          {menuOpen && (
            <div className="attach-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="attach-menu-item"
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip size={15} strokeWidth={1.75} />
                <span>
                  <span className="attach-menu-title">Attach files…</span>
                  <span className="attach-menu-desc">
                    Images, text, and source code
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="attach-menu-item"
                onClick={() => void pasteImageFromClipboard()}
              >
                <ClipboardPaste size={15} strokeWidth={1.75} />
                <span>
                  <span className="attach-menu-title">Paste image</span>
                  <span className="attach-menu-desc">From system clipboard</span>
                </span>
              </button>
              <div className="attach-menu-note">
                Not supported: PDF, Office, zip, video, audio. Put those in the
                project folder instead.
              </div>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={FILE_ACCEPT}
            multiple
            hidden
            onChange={(e) => void onFilePick(e)}
          />
        </div>

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => void onPaste(e)}
          placeholder={
            editing
              ? "Edit your message and press Enter to resend…"
              : !agent.connected
                ? "Connect to agent, then type a message…"
                : streaming || busy
                  ? "Queue a follow-up… (Stop to interrupt the current turn)"
                  : `Message ${backendLabel}…`
          }
          rows={1}
        />

        <div className="composer-actions">
          {streaming && (
            <button
              type="button"
              className="composer-icon-btn stop"
              title={
                editing
                  ? "Stop current turn (keeps your edit draft)"
                  : "Stop"
              }
              onClick={() => void cancelPrompt()}
            >
              <Square size={14} strokeWidth={2} fill="currentColor" />
            </button>
          )}
          <button
            type="button"
            className="composer-send"
            title={
              editing
                ? "Save & resend"
                : streaming
                  ? "Queue follow-up"
                  : "Send"
            }
            onClick={() => void submit()}
            disabled={!canSend}
          >
            <SendHorizontal size={16} strokeWidth={1.85} />
          </button>
        </div>
      </div>
    </div>
  );
}
