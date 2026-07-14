import { useAppStore } from "../store";

export function PermissionModal() {
  const permission = useAppStore((s) => s.permission);
  const respondPermission = useAppStore((s) => s.respondPermission);

  if (!permission) return null;

  const title =
    permission.toolCall?.title ||
    permission.toolCall?.toolCallId ||
    "Tool permission";

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Permission required</h2>
        <p className="modal-sub">Grok wants to run a tool:</p>
        <div className="modal-tool">
          <div className="modal-tool-title">{title}</div>
          {permission.toolCall?.kind && (
            <div className="muted">kind: {permission.toolCall.kind}</div>
          )}
          {permission.toolCall?.rawInput != null && (
            <pre className="code">
              {typeof permission.toolCall.rawInput === "string"
                ? permission.toolCall.rawInput
                : JSON.stringify(permission.toolCall.rawInput, null, 2)}
            </pre>
          )}
        </div>
        <div className="modal-actions">
          {(permission.options ?? []).map((opt) => (
            <button
              key={opt.optionId}
              className={
                opt.kind.startsWith("allow")
                  ? "primary-btn"
                  : opt.kind.startsWith("reject")
                    ? "danger-btn"
                    : "ghost-btn"
              }
              onClick={() => respondPermission(opt.optionId)}
            >
              {opt.name}
            </button>
          ))}
          <button className="ghost-btn" onClick={() => respondPermission(null, true)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
