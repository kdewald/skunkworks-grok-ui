//! Pure ACP session-update → chat transcript reducer.
//!
//! No Tauri, no AppState, no disk, no process I/O. `commands` owns locking,
//! session validation, and persistence; this module only mutates `ChatDocument`.

use serde_json::{json, Value};

use crate::store::{new_id, ChatDocument, IntermediateBlock, PlanEntry, Turn};


/// Older transcripts stored spawn_subagent as plain Tool blocks. Lift them into
/// Subagent cards so the side rail populates for historical chats too.
pub(crate) fn promote_subagent_tools_in_doc(doc: &mut ChatDocument) {
    for turn in &mut doc.turns {
        // Snapshot tool indices first — we may remove some.
        let tools: Vec<(usize, IntermediateBlock)> = turn
            .intermediate
            .iter()
            .enumerate()
            .filter_map(|(i, b)| match b {
                IntermediateBlock::Tool { .. } => Some((i, b.clone())),
                _ => None,
            })
            .collect();

        let mut remove_idxs: Vec<usize> = Vec::new();
        for (idx, block) in tools {
            let IntermediateBlock::Tool {
                tool_call_id,
                title,
                status,
                raw_input,
                content,
                raw_output,
                ..
            } = block
            else {
                continue;
            };
            if looks_like_subagent_spawn(raw_input.as_ref(), &title) {
                upsert_subagent_from_spawn_tool(
                    turn,
                    &tool_call_id,
                    &title,
                    &status,
                    raw_input.as_ref(),
                    content.as_ref(),
                    raw_output.as_ref(),
                );
                remove_idxs.push(idx);
            } else if looks_like_subagent_wait(raw_input.as_ref(), &title) {
                apply_subagent_wait_output(turn, content.as_ref(), raw_output.as_ref());
                remove_idxs.push(idx);
            }
        }
        // Remove promoted tools from the main work list (highest index first).
        remove_idxs.sort_unstable();
        remove_idxs.dedup();
        for idx in remove_idxs.into_iter().rev() {
            if idx < turn.intermediate.len() {
                if matches!(turn.intermediate[idx], IntermediateBlock::Tool { .. }) {
                    turn.intermediate.remove(idx);
                }
            }
        }
    }
}

pub(crate) fn json_str<'a>(update: &'a Value, camel: &str, snake: &str) -> Option<&'a str> {
    update
        .get(camel)
        .or_else(|| update.get(snake))
        .and_then(|v| v.as_str())
}

pub(crate) fn json_val<'a>(update: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    update.get(camel).or_else(|| update.get(snake))
}

/// High-churn stream kinds that can debounce disk writes.
pub(crate) fn is_stream_chunk_kind(kind: &str) -> bool {
    matches!(
        kind,
        "agent_message_chunk" | "agent_thought_chunk" | "tool_call_update"
    )
}

/// Kinds that may still apply after the parent turn is marked complete
/// (late stream chunks and background child results).
pub(crate) fn is_late_allowed_kind(kind: &str) -> bool {
    matches!(
        kind,
        "agent_message_chunk"
            | "agent_thought_chunk"
            | "subagent_finished"
            | "task_completed"
            | "tool_call_update"
            | "subagent_spawned"
    )
}

/// Find a turn that owns a subagent/task id (for late child updates after parent complete).
fn find_turn_for_child_id(doc: &ChatDocument, child_id: &str) -> Option<usize> {
    if child_id.is_empty() {
        return None;
    }
    doc.turns.iter().rposition(|t| {
        t.intermediate.iter().any(|b| match b {
            IntermediateBlock::Subagent { subagent_id, .. } => subagent_id == child_id,
            IntermediateBlock::Task { task_id, .. } => task_id == child_id,
            IntermediateBlock::Tool { tool_call_id, .. } => tool_call_id == child_id,
            _ => false,
        })
    })
}

/// Apply a single session/update into the chat's last turn.
/// Returns the update kind when the event was considered (for flush decisions).
pub(crate) fn apply_one_update(doc: &mut ChatDocument, update: &Value) -> Option<String> {
    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    // Prefer the latest streaming turn so a completed previous turn never
    // swallows the new user message's stream.
    let mut turn_idx = doc
        .turns
        .iter()
        .rposition(|t| t.status == "streaming" || t.status == "cancelling")
        .or_else(|| doc.turns.len().checked_sub(1))?;

    // Route late child/tool results to the turn that owns that id.
    if matches!(
        kind.as_str(),
        "subagent_finished" | "task_completed" | "subagent_spawned" | "tool_call_update"
    ) {
        let child_id = update
            .get("subagent_id")
            .or_else(|| update.get("subagentId"))
            .or_else(|| update.get("task_id"))
            .or_else(|| update.get("taskId"))
            .or_else(|| update.get("toolCallId"))
            .or_else(|| update.get("tool_call_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let child_from_snap = update
            .get("task_snapshot")
            .and_then(|s| {
                s.get("task_id")
                    .or_else(|| s.get("taskId"))
                    .and_then(|v| v.as_str())
            })
            .unwrap_or("");
        let id = if !child_id.is_empty() {
            child_id
        } else {
            child_from_snap
        };
        if let Some(idx) = find_turn_for_child_id(doc, id) {
            turn_idx = idx;
        }
    }

    let turn = doc.turns.get_mut(turn_idx)?;
    // Already stopped by user — don't append more content to a dead turn.
    if turn.status == "cancelled" || turn.status == "cancelling" {
        return None;
    }

    // Late chunks after parent complete: accept message tails + child results.
    if turn.status != "streaming" && !is_late_allowed_kind(&kind) {
        return None;
    }
    if turn.status == "complete" && !is_late_allowed_kind(&kind) {
        return None;
    }
    // error status: only allow late child terminal updates, not new parent text.
    if turn.status == "error" && !matches!(kind.as_str(), "subagent_finished" | "task_completed" | "tool_call_update") {
        return None;
    }

    match kind.as_str() {
        "agent_message_chunk" => {
            if turn.status != "streaming" && turn.status != "complete" {
                return None;
            }
            let text = extract_chunk_text(update);
            if !text.is_empty() {
                let message_id = update
                    .get("messageId")
                    .or_else(|| update.get("message_id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                append_agent_message(turn, message_id, &text);
            }
        }
        "agent_thought_chunk" => {
            // Match Grok TUI: reasoning channel → thought buffer only.
            // Pure concat of content.text (no space glue, no kind re-routing).
            if turn.status != "streaming" && turn.status != "complete" {
                return None;
            }
            let text = extract_chunk_text(update);
            if !text.is_empty() {
                append_agent_thought(turn, &text);
            }
        }
        "tool_call" => {
            let tool_call_id = json_str(&update, "toolCallId", "tool_call_id")
                .unwrap_or("")
                .to_string();
            let title = update
                .get("title")
                .and_then(|s| s.as_str())
                .unwrap_or("Tool")
                .to_string();
            let tool_kind = update
                .get("kind")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let status = update
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("pending")
                .to_string();
            let raw_input = json_val(&update, "rawInput", "raw_input").cloned();
            let content = update.get("content").cloned();
            let raw_output = json_val(&update, "rawOutput", "raw_output").cloned();

            // Grok emits spawn_subagent as a normal tool_call with variant "Task"
            // (not a dedicated sessionUpdate). Park it on the Subagent rail.
            if looks_like_subagent_spawn(raw_input.as_ref(), &title) {
                upsert_subagent_from_spawn_tool(
                    turn,
                    &tool_call_id,
                    &title,
                    &status,
                    raw_input.as_ref(),
                    content.as_ref(),
                    raw_output.as_ref(),
                );
            } else if looks_like_subagent_wait(raw_input.as_ref(), &title)
                && apply_subagent_wait_output(turn, content.as_ref(), raw_output.as_ref())
            {
                // Wait tool folded into subagent cards — skip main work list.
            } else if !tool_call_id.is_empty() {
                // Accept parent tools even while subagents run. Child text fan-in is
                // filtered on message/thought chunks; tool rows may include some child
                // noise, but dropping *all* tools hid legitimate parent work.
                if let Some(IntermediateBlock::Tool {
                    title: existing_title,
                    kind: existing_kind,
                    status: existing_status,
                    raw_input: existing_input,
                    content: existing_content,
                    raw_output: existing_output,
                    ..
                }) = turn.intermediate.iter_mut().find(|b| match b {
                    IntermediateBlock::Tool { tool_call_id: id, .. } => id == &tool_call_id,
                    _ => false,
                }) {
                    if title.len() > existing_title.len() || existing_title == "Tool" {
                        *existing_title = title;
                    }
                    if tool_kind.is_some() {
                        *existing_kind = tool_kind;
                    }
                    *existing_status = status;
                    if raw_input.is_some() {
                        *existing_input = raw_input;
                    }
                    if content.is_some() {
                        *existing_content = content;
                    }
                    if raw_output.is_some() {
                        *existing_output = raw_output;
                    }
                } else {
                    turn.intermediate.push(IntermediateBlock::Tool {
                        id: new_id(),
                        tool_call_id,
                        title,
                        kind: tool_kind,
                        status,
                        raw_input,
                        content,
                        raw_output,
                        collapsed: true,
                    });
                }
            } else {
                turn.intermediate.push(IntermediateBlock::Tool {
                    id: new_id(),
                    tool_call_id,
                    title,
                    kind: tool_kind,
                    status,
                    raw_input,
                    content,
                    raw_output,
                    collapsed: true,
                });
            }
        }
        "tool_call_update" => {
            let tool_call_id = json_str(&update, "toolCallId", "tool_call_id").unwrap_or("");
            let title = update
                .get("title")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let status = update
                .get("status")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let raw_input = json_val(&update, "rawInput", "raw_input").cloned();
            let content = update.get("content").cloned();
            let raw_output = json_val(&update, "rawOutput", "raw_output").cloned();

            // Prefer matching a Subagent card created from a Task spawn.
            let mut handled_as_subagent = false;
            if !tool_call_id.is_empty() {
                if turn.intermediate.iter().any(|b| match b {
                    IntermediateBlock::Subagent {
                        tool_call_id: Some(id),
                        ..
                    } => id == tool_call_id,
                    _ => false,
                }) {
                    upsert_subagent_from_spawn_tool(
                        turn,
                        tool_call_id,
                        &title,
                        status.as_deref().unwrap_or("running"),
                        raw_input.as_ref(),
                        content.as_ref(),
                        raw_output.as_ref(),
                    );
                    handled_as_subagent = true;
                }
            }
            if !handled_as_subagent
                && looks_like_subagent_wait(raw_input.as_ref(), &title)
            {
                // Only suppress normal tool handling when a real subagent matched.
                handled_as_subagent =
                    apply_subagent_wait_output(turn, content.as_ref(), raw_output.as_ref());
            }
            // MultiResult may mix shell rows and subagent rows — only suppress
            // the tool card when at least one subagent result was applied.
            if !handled_as_subagent && (raw_output.is_some() || content.is_some()) {
                if raw_output
                    .as_ref()
                    .map(|v| v.get("MultiResult").is_some())
                    .unwrap_or(false)
                {
                    handled_as_subagent =
                        apply_subagent_wait_output(turn, content.as_ref(), raw_output.as_ref());
                }
            }

            // Do not blanket-swallow tool updates while subagents run — parent
            // tools must still progress. Child spawn/wait are handled above.

            if !handled_as_subagent {
                if let Some(IntermediateBlock::Tool {
                    status: st,
                    content: c,
                    raw_output: ro,
                    raw_input: ri,
                    title: t,
                    kind,
                    ..
                }) = turn.intermediate.iter_mut().find(|b| match b {
                    IntermediateBlock::Tool { tool_call_id: id, .. } => id == tool_call_id,
                    _ => false,
                }) {
                    if let Some(s) = status {
                        *st = s;
                    }
                    if let Some(cv) = content {
                        *c = Some(cv);
                    }
                    if let Some(o) = raw_output {
                        *ro = Some(o);
                    }
                    if let Some(i) = raw_input {
                        *ri = Some(i);
                    }
                    if !title.is_empty() && title.len() >= t.len() {
                        *t = title;
                    }
                    if let Some(k) = update.get("kind").and_then(|s| s.as_str()) {
                        *kind = Some(k.to_string());
                    }
                }
            }
        }
        "plan" => {
            let entries = update
                .get("entries")
                .and_then(|e| e.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|e| PlanEntry {
                            content: e
                                .get("content")
                                .and_then(|c| c.as_str())
                                .unwrap_or("")
                                .to_string(),
                            priority: e
                                .get("priority")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string()),
                            status: e
                                .get("status")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string()),
                        })
                        .collect()
                })
                .unwrap_or_default();
            if let Some(IntermediateBlock::Plan {
                entries: existing, ..
            }) = turn.intermediate.iter_mut().rev().find(|b| {
                matches!(b, IntermediateBlock::Plan { .. })
            }) {
                *existing = entries;
            } else {
                turn.intermediate.push(IntermediateBlock::Plan {
                    id: new_id(),
                    entries,
                    collapsed: true,
                });
            }
        }
        "user_message_chunk" => {}
        "subagent_spawned" => {
            let subagent_id = update
                .get("subagent_id")
                .or_else(|| update.get("subagentId"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if subagent_id.is_empty() {
                // nothing
            } else if !turn.intermediate.iter().any(|b| match b {
                IntermediateBlock::Subagent { subagent_id: id, .. } => id == &subagent_id,
                _ => false,
            }) {
                let description = update
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Subagent")
                    .to_string();
                let model = update
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let subagent_type = update
                    .get("subagent_type")
                    .or_else(|| update.get("subagentType"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                turn.intermediate.push(IntermediateBlock::Subagent {
                    id: new_id(),
                    subagent_id,
                    tool_call_id: None,
                    description,
                    status: "running".into(),
                    model,
                    subagent_type,
                    output: String::new(),
                    collapsed: true,
                });
            }
        }
        "subagent_finished" => {
            let subagent_id = update
                .get("subagent_id")
                .or_else(|| update.get("subagentId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed")
                .to_string();
            let output = update
                .get("output")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(IntermediateBlock::Subagent {
                status: st,
                output: out,
                collapsed,
                ..
            }) = turn.intermediate.iter_mut().find(|b| match b {
                IntermediateBlock::Subagent { subagent_id: id, .. } => id == subagent_id,
                _ => false,
            }) {
                *st = status;
                if !output.is_empty() {
                    *out = output;
                }
                // Keep collapsed by default; user can expand the full report.
                *collapsed = true;
            } else if !subagent_id.is_empty() {
                // Finished without a spawn event (resume / missed spawn).
                turn.intermediate.push(IntermediateBlock::Subagent {
                    id: new_id(),
                    subagent_id: subagent_id.to_string(),
                    tool_call_id: None,
                    description: "Subagent".into(),
                    status,
                    model: None,
                    subagent_type: None,
                    output,
                    collapsed: true,
                });
            }
        }
        "task_backgrounded" => {
            let task_id = update
                .get("task_id")
                .or_else(|| update.get("taskId"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_call_id = update
                .get("tool_call_id")
                .or_else(|| update.get("toolCallId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let description = update
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("Background task")
                .to_string();
            let command = update
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // Prefer updating matching tool status if we know the toolCallId.
            if let Some(ref tcid) = tool_call_id {
                if let Some(IntermediateBlock::Tool { status, title, .. }) =
                    turn.intermediate.iter_mut().find(|b| match b {
                        IntermediateBlock::Tool { tool_call_id: id, .. } => id == tcid,
                        _ => false,
                    })
                {
                    *status = "in_progress".into();
                    if !description.is_empty() && title.len() < description.len() {
                        *title = format!("[bg] {description}");
                    }
                }
            }
            if !task_id.is_empty()
                && !turn.intermediate.iter().any(|b| match b {
                    IntermediateBlock::Task { task_id: id, .. } => id == &task_id,
                    _ => false,
                })
            {
                turn.intermediate.push(IntermediateBlock::Task {
                    id: new_id(),
                    task_id,
                    tool_call_id,
                    description,
                    command,
                    status: "running".into(),
                    output: String::new(),
                    collapsed: true,
                });
            }
        }
        "task_completed" => {
            let snap = update.get("task_snapshot").cloned().unwrap_or(Value::Null);
            let task_id = snap
                .get("task_id")
                .or_else(|| snap.get("taskId"))
                .or_else(|| update.get("task_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let output = snap
                .get("output")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let exit_failed = snap
                .get("exit_code")
                .and_then(|v| v.as_i64())
                .map(|c| c != 0)
                .unwrap_or(false)
                || snap
                    .get("explicitly_killed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            let status = if exit_failed {
                "failed".to_string()
            } else {
                "completed".to_string()
            };
            let linked_tool = {
                let mut linked = None;
                if let Some(IntermediateBlock::Task {
                    status: st,
                    output: out,
                    tool_call_id,
                    ..
                }) = turn.intermediate.iter_mut().find(|b| match b {
                    IntermediateBlock::Task { task_id: id, .. } => id == task_id,
                    _ => false,
                }) {
                    *st = status.clone();
                    if !output.is_empty() {
                        *out = output.clone();
                    }
                    linked = tool_call_id.clone();
                }
                linked
            };
            if let Some(tcid) = linked_tool {
                if let Some(IntermediateBlock::Tool {
                    status: ts,
                    content,
                    raw_output,
                    ..
                }) = turn.intermediate.iter_mut().find(|b| match b {
                    IntermediateBlock::Tool { tool_call_id: id, .. } => id == &tcid,
                    _ => false,
                }) {
                    *ts = status;
                    if !output.is_empty() {
                        *content = Some(json!([{
                            "type": "content",
                            "content": { "type": "text", "text": output }
                        }]));
                        *raw_output = Some(json!({ "output": output }));
                    }
                }
            }
        }
        "turn_completed" => {
            // Belt-and-suspenders if session/prompt response is delayed.
            let reason = update
                .get("stop_reason")
                .or_else(|| update.get("stopReason"))
                .and_then(|v| v.as_str())
                .unwrap_or("end_turn");
            if turn.status == "streaming" {
                if reason == "cancelled" {
                    turn.status = "cancelled".into();
                } else {
                    turn.status = "complete".into();
                }
                turn.intermediate_collapsed = true;
            }
        }
        _ => {}
    }

    Some(kind)
}


/// Text from an ACP content chunk update (`agent_message_chunk` / `agent_thought_chunk`).
fn extract_chunk_text(update: &Value) -> String {
    if let Some(text) = update.pointer("/content/text").and_then(|t| t.as_str()) {
        return text.to_string();
    }
    if let Some(content) = update.get("content") {
        if let Some(text) = content.as_str() {
            return text.to_string();
        }
        if let Some(text) = content.get("text").and_then(|t| t.as_str()) {
            return text.to_string();
        }
    }
    if let Some(text) = update.get("text").and_then(|t| t.as_str()) {
        return text.to_string();
    }
    String::new()
}


/// Grok's spawn_subagent ACP surface: tool_call with variant Task / spawn_subagent.
fn looks_like_subagent_spawn(raw_input: Option<&Value>, title: &str) -> bool {
    if title.eq_ignore_ascii_case("spawn_subagent") || title.contains("spawn_subagent") {
        // Avoid treating a Grep for the string "spawn_subagent" as a spawn.
        if let Some(v) = raw_input {
            let variant = v
                .get("variant")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if variant.eq_ignore_ascii_case("Grep") || variant.eq_ignore_ascii_case("ReadFile") {
                return false;
            }
        }
    }
    let Some(v) = raw_input else {
        return title.eq_ignore_ascii_case("spawn_subagent");
    };
    let variant = v
        .get("variant")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        variant.as_str(),
        "task" | "spawn_subagent" | "spawnsubagent" | "subagent"
    ) {
        // Task variant is spawn; TaskOutput is the waiter.
        return v.get("prompt").is_some()
            || v.get("subagent_type").is_some()
            || v.get("subagentType").is_some()
            || v.get("description").is_some();
    }
    if v.get("subagent_type").is_some() || v.get("subagentType").is_some() {
        return v.get("prompt").is_some() || v.get("description").is_some();
    }
    // Heuristic: prompt + description + capability_mode is the spawn shape.
    v.get("prompt").is_some()
        && v.get("description").is_some()
        && (v.get("capability_mode").is_some()
            || v.get("capabilityMode").is_some()
            || v.get("isolation").is_some())
}

fn looks_like_subagent_wait(raw_input: Option<&Value>, title: &str) -> bool {
    let t = title.to_ascii_lowercase();
    if t.contains("get_command_or_subagent_output")
        || t.contains("wait_commands_or_subagents")
        || t == "taskoutput"
    {
        return true;
    }
    let Some(v) = raw_input else {
        return false;
    };
    let variant = v
        .get("variant")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(variant.as_str(), "taskoutput" | "task_output" | "await_task") {
        return true;
    }
    v.get("task_ids").is_some() || v.get("taskIds").is_some()
}

fn value_text_blob(v: Option<&Value>) -> String {
    let Some(v) = v else {
        return String::new();
    };
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if let Some(s) = v.get("text").and_then(|t| t.as_str()) {
        return s.to_string();
    }
    if let Some(s) = v.pointer("/content/text").and_then(|t| t.as_str()) {
        return s.to_string();
    }
    // ACP content array: [{type, content:{text}}]
    if let Some(arr) = v.as_array() {
        let mut out = String::new();
        for item in arr {
            if let Some(t) = item
                .pointer("/content/text")
                .and_then(|x| x.as_str())
                .or_else(|| item.get("text").and_then(|x| x.as_str()))
            {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    v.to_string()
}

fn parse_spawned_subagent_id(blob: &str) -> Option<String> {
    for line in blob.lines() {
        let line = line.trim();
        if let Some(rest) = line
            .strip_prefix("subagent_id:")
            .or_else(|| line.strip_prefix("subagentId:"))
            .or_else(|| line.strip_prefix("task_id:"))
            .or_else(|| line.strip_prefix("taskId:"))
        {
            let id = rest.trim().trim_matches('`').trim().to_string();
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

fn map_tool_status_to_subagent(status: &str) -> String {
    match status {
        "completed" | "complete" | "success" => "running".into(), // spawn tool done ⇒ child still runs
        "failed" | "error" => "failed".into(),
        "cancelled" | "canceled" => "cancelled".into(),
        "pending" => "pending".into(),
        _ => "running".into(),
    }
}

fn upsert_subagent_from_spawn_tool(
    turn: &mut Turn,
    tool_call_id: &str,
    title: &str,
    status: &str,
    raw_input: Option<&Value>,
    content: Option<&Value>,
    raw_output: Option<&Value>,
) {
    let description = raw_input
        .and_then(|v| v.get("description").and_then(|d| d.as_str()))
        .filter(|s| !s.is_empty())
        .unwrap_or(title)
        .to_string();
    let subagent_type = raw_input
        .and_then(|v| {
            v.get("subagent_type")
                .or_else(|| v.get("subagentType"))
                .and_then(|x| x.as_str())
        })
        .map(|s| s.to_string());
    let model = raw_input
        .and_then(|v| v.get("model").and_then(|x| x.as_str()))
        .map(|s| s.to_string());

    let blob = {
        let mut s = value_text_blob(raw_output);
        if s.is_empty() {
            s = value_text_blob(content);
        }
        s
    };
    let parsed_id = parse_spawned_subagent_id(&blob);
    let provisional_id = if !tool_call_id.is_empty() {
        tool_call_id.to_string()
    } else {
        description.clone()
    };
    let mut sub_status = map_tool_status_to_subagent(status);
    // If spawn failed, mark failed; if we already have final-looking output without "started", keep running.
    if status == "failed" || status == "error" {
        sub_status = "failed".into();
    }

    // Find existing by tool_call_id, real id, or description.
    let existing = turn.intermediate.iter_mut().find(|b| match b {
        IntermediateBlock::Subagent {
            tool_call_id: Some(tid),
            ..
        } if !tool_call_id.is_empty() && tid == tool_call_id => true,
        IntermediateBlock::Subagent { subagent_id, .. }
            if parsed_id.as_ref().map(|p| p == subagent_id).unwrap_or(false)
                || subagent_id == &provisional_id =>
        {
            true
        }
        IntermediateBlock::Subagent {
            description: d,
            status: st,
            output,
            ..
        } if d == &description
            && (st == "running" || st == "pending" || st == "in_progress")
            && output.is_empty() =>
        {
            true
        }
        _ => false,
    });

    if let Some(IntermediateBlock::Subagent {
        subagent_id,
        tool_call_id: tid,
        description: d,
        status: st,
        model: m,
        subagent_type: ty,
        ..
    }) = existing
    {
        if let Some(pid) = parsed_id {
            *subagent_id = pid;
        }
        if !tool_call_id.is_empty() {
            *tid = Some(tool_call_id.to_string());
        }
        if !description.is_empty() {
            *d = description;
        }
        *st = sub_status;
        if model.is_some() {
            *m = model;
        }
        if subagent_type.is_some() {
            *ty = subagent_type;
        }
    } else {
        turn.intermediate.push(IntermediateBlock::Subagent {
            id: new_id(),
            subagent_id: parsed_id.unwrap_or(provisional_id),
            tool_call_id: if tool_call_id.is_empty() {
                None
            } else {
                Some(tool_call_id.to_string())
            },
            description: if description.is_empty() {
                "Subagent".into()
            } else {
                description
            },
            status: sub_status,
            model,
            subagent_type,
            output: String::new(),
            collapsed: false, // open by default so the rail is visible
        });
    }
}

/// Apply MultiResult / wait output to subagent cards.
/// Returns true if at least one real subagent row was matched or created
/// (caller should only then skip normal tool status/output handling).
fn apply_subagent_wait_output(
    turn: &mut Turn,
    content: Option<&Value>,
    raw_output: Option<&Value>,
) -> bool {
    let mut matched_any = false;
    // MultiResult.results[] with command like "[subagent:explore] Desc" + output
    if let Some(results) = raw_output
        .and_then(|v| v.pointer("/MultiResult/results"))
        .and_then(|r| r.as_array())
        .or_else(|| {
            raw_output
                .and_then(|v| v.get("results"))
                .and_then(|r| r.as_array())
        })
    {
        for res in results {
            let command = res
                .get("command")
                .and_then(|c| c.as_str())
                .unwrap_or("");
            let output = res
                .get("output")
                .and_then(|o| o.as_str())
                .unwrap_or("")
                .to_string();
            let exit_failed = res
                .get("exit_code")
                .and_then(|c| c.as_i64())
                .map(|c| c != 0)
                .unwrap_or(false);
            let status = if exit_failed {
                "failed".to_string()
            } else {
                "completed".to_string()
            };

            // Only "[subagent:…]" / "[subagent]" labels are child agents.
            // Shell MultiResult rows (cd && scripts/…) must not become Subagent cards.
            let is_subagent_cmd = command_looks_like_subagent_label(command);
            let (parsed_type, parsed_desc) = if is_subagent_cmd {
                parse_subagent_command_label(command)
            } else {
                (String::new(), String::new())
            };
            let task_id = res
                .get("task_id")
                .or_else(|| res.get("taskId"))
                .or_else(|| res.get("subagent_id"))
                .or_else(|| res.get("subagentId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            // Match an existing card only when this row is clearly a subagent
            // (label prefix or known subagent task id).
            let matched = if is_subagent_cmd || !task_id.is_empty() {
                turn.intermediate.iter_mut().find(|b| match b {
                    IntermediateBlock::Subagent { subagent_id, .. }
                        if !task_id.is_empty() && subagent_id == task_id =>
                    {
                        true
                    }
                    IntermediateBlock::Subagent { description, .. }
                        if is_subagent_cmd
                            && !parsed_desc.is_empty()
                            && description == &parsed_desc =>
                    {
                        true
                    }
                    IntermediateBlock::Subagent {
                        description,
                        subagent_type,
                        status: st,
                        ..
                    } if is_subagent_cmd
                        && !parsed_desc.is_empty()
                        && description.contains(&parsed_desc)
                        && (st == "running" || st == "pending" || st == "in_progress")
                        && (parsed_type.is_empty()
                            || subagent_type.as_deref() == Some(parsed_type.as_str())) =>
                    {
                        true
                    }
                    _ => false,
                })
            } else {
                None
            };

            if let Some(IntermediateBlock::Subagent {
                status: st,
                output: out,
                subagent_type: ty,
                description: d,
                subagent_id,
                collapsed,
                ..
            }) = matched
            {
                *st = status;
                if !output.is_empty() {
                    *out = output;
                }
                if ty.is_none() && !parsed_type.is_empty() {
                    *ty = Some(parsed_type);
                }
                if d.is_empty() && !parsed_desc.is_empty() {
                    *d = parsed_desc;
                }
                if !task_id.is_empty() && (subagent_id.is_empty() || subagent_id.starts_with("call-"))
                {
                    *subagent_id = task_id.to_string();
                }
                *collapsed = false;
                matched_any = true;
            } else if is_subagent_cmd && (!parsed_desc.is_empty() || !task_id.is_empty()) {
                // New subagent report we haven't seen yet (wait returned first).
                turn.intermediate.push(IntermediateBlock::Subagent {
                    id: new_id(),
                    subagent_id: if task_id.is_empty() {
                        new_id()
                    } else {
                        task_id.to_string()
                    },
                    tool_call_id: None,
                    description: if parsed_desc.is_empty() {
                        "Subagent".into()
                    } else {
                        parsed_desc
                    },
                    status,
                    model: None,
                    subagent_type: if parsed_type.is_empty() {
                        None
                    } else {
                        Some(parsed_type)
                    },
                    output,
                    collapsed: false,
                });
                matched_any = true;
            }
            // else: shell / non-subagent MultiResult row — ignore for the rail
        }
        return matched_any;
    }

    // Single-result wait: whole blob is one subagent report.
    let blob = {
        let mut s = value_text_blob(raw_output);
        if s.is_empty() {
            s = value_text_blob(content);
        }
        s
    };
    if blob.is_empty() {
        return false;
    }
    // Prefer the oldest running subagent without output.
    if let Some(IntermediateBlock::Subagent {
        status: st,
        output: out,
        collapsed,
        ..
    }) = turn.intermediate.iter_mut().find(|b| matches!(
        b,
        IntermediateBlock::Subagent { status, output, .. }
            if (status == "running" || status == "pending" || status == "in_progress")
                && output.is_empty()
    )) {
        *st = "completed".into();
        *out = blob;
        *collapsed = false;
        return true;
    }
    false
}

/// True when MultiResult.command is a subagent wait label, not a shell line.
fn command_looks_like_subagent_label(command: &str) -> bool {
    let c = command.trim();
    c.starts_with("[subagent:") || c.starts_with("[subagent]")
}

fn parse_subagent_command_label(command: &str) -> (String, String) {
    // "[subagent:explore] Summarize overall diff"
    let command = command.trim();
    if let Some(rest) = command.strip_prefix("[subagent:") {
        if let Some((ty, desc)) = rest.split_once(']') {
            return (
                ty.trim().to_string(),
                desc.trim().to_string(),
            );
        }
    }
    if let Some(rest) = command.strip_prefix("[subagent]") {
        return (String::new(), rest.trim().to_string());
    }
    // Not a subagent label — do not treat arbitrary shell as a description.
    (String::new(), String::new())
}

#[allow(dead_code)]
fn count_open_subagents(turn: &Turn) -> usize {
    turn.intermediate
        .iter()
        .filter(|b| matches!(
            b,
            IntermediateBlock::Subagent { status, .. }
                if status == "running" || status == "in_progress" || status == "pending"
        ))
        .count()
}

/// Append an ACP text delta literally (Grok Build contract).
///
/// The CLI forwards model SSE fragments with pure `push_str` and merges chunks
/// with `format!("{}{}", a, b)`. Clients must not invent spaces or newlines.
pub(crate) fn append_delta(existing: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    existing.push_str(text);
}

/// Append a thought chunk (ACP agent_thought_chunk / reasoning channel).
/// Walk back through tools/tasks so a tool call mid-think continues the same
/// Thought block when Grok resumes reasoning after tools.
///
/// A Message is a hard boundary (new Thought after answer text) — matches the
/// Grok TUI finishing thinking when agent_message_chunk arrives.
fn append_agent_thought(turn: &mut Turn, text: &str) {
    let mut target_idx: Option<usize> = None;
    for (i, b) in turn.intermediate.iter().enumerate().rev() {
        match b {
            IntermediateBlock::Thought { .. } => {
                target_idx = Some(i);
                break;
            }
            IntermediateBlock::Tool { .. }
            | IntermediateBlock::Task { .. }
            | IntermediateBlock::Subagent { .. }
            | IntermediateBlock::Plan { .. } => continue,
            IntermediateBlock::Message { .. } => break,
        }
    }

    if let Some(i) = target_idx {
        if let IntermediateBlock::Thought {
            text: existing,
            collapsed,
            ..
        } = &mut turn.intermediate[i]
        {
            append_delta(existing, text);
            *collapsed = false;
        }
        // Bubble the growing thought past *only* trailing tools — never past
        // a Message (remove+push-to-end used to reorder incorrectly).
        let mut j = i;
        while j + 1 < turn.intermediate.len() {
            let can_swap = matches!(
                turn.intermediate[j + 1],
                IntermediateBlock::Tool { .. }
                    | IntermediateBlock::Task { .. }
                    | IntermediateBlock::Subagent { .. }
                    | IntermediateBlock::Plan { .. }
            );
            if !can_swap {
                break;
            }
            turn.intermediate.swap(j, j + 1);
            j += 1;
        }
    } else {
        turn.intermediate.push(IntermediateBlock::Thought {
            id: new_id(),
            text: text.to_string(),
            collapsed: false,
        });
    }
}

/// Append an agent text chunk as a timeline message block.
///
/// Grok often interleaves `agent_thought_chunk` mid-sentence. Those must NOT
/// split the parent answer into multiple bubbles. We skip trailing Thoughts
/// when finding the open message, append there, then bubble past later
/// thoughts so the UI reads: [work/thoughts…] → [one continuous answer].
///
/// Tools / subagents / tasks / plans are hard boundaries (new message after).
pub(crate) fn append_agent_message(turn: &mut Turn, message_id: Option<String>, text: &str) {
    // Walk from the end: skip Thoughts only.
    let mut target_idx: Option<usize> = None;
    for (i, b) in turn.intermediate.iter().enumerate().rev() {
        match b {
            IntermediateBlock::Thought { .. } => continue,
            IntermediateBlock::Message {
                message_id: existing_id,
                ..
            } => {
                let same = match (existing_id.as_ref(), message_id.as_ref()) {
                    (Some(a), Some(b)) => a == b,
                    // No ids: keep gluing the open bubble until a tool seals it.
                    (None, None) => true,
                    (None, Some(_)) => true,
                    (Some(_), None) => true,
                };
                if same {
                    target_idx = Some(i);
                }
                break;
            }
            // Tool / Subagent / Task / Plan — hard boundary.
            _ => break,
        }
    }

    if let Some(i) = target_idx {
        if let IntermediateBlock::Message {
            message_id: existing_id,
            text: existing_text,
            ..
        } = &mut turn.intermediate[i]
        {
            if existing_id.is_none() {
                if let Some(id) = message_id {
                    *existing_id = Some(id);
                }
            }
            append_delta(existing_text, text);
        }
        // Bubble message past trailing thoughts only (not past tools).
        let mut j = i;
        while j + 1 < turn.intermediate.len() {
            if !matches!(turn.intermediate[j + 1], IntermediateBlock::Thought { .. }) {
                break;
            }
            turn.intermediate.swap(j, j + 1);
            j += 1;
        }
    } else {
        turn.intermediate.push(IntermediateBlock::Message {
            id: new_id(),
            message_id,
            text: text.to_string(),
        });
    }

    rebuild_assistant_message(turn);
}

fn rebuild_assistant_message(turn: &mut Turn) {
    let parts: Vec<&str> = turn
        .intermediate
        .iter()
        .filter_map(|b| match b {
            IntermediateBlock::Message { text, .. } if !text.is_empty() => Some(text.as_str()),
            _ => None,
        })
        .collect();
    turn.assistant_message = parts.join("\n\n");
}


#[cfg(test)]
mod stream_tests {
    use super::*;
    use crate::store::{ChatDocument, IntermediateBlock, Turn};

    fn empty_turn() -> Turn {
        Turn {
            id: "t1".into(),
            user_message: "hi".into(),
            intermediate: vec![],
            assistant_message: String::new(),
            status: "streaming".into(),
            intermediate_collapsed: false,
            attachments: vec![],
            created_at: chrono::Utc::now(),
        }
    }

    fn thought_text(turn: &Turn) -> String {
        turn.intermediate
            .iter()
            .filter_map(|b| match b {
                IntermediateBlock::Thought { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("|")
    }

    fn message_text(turn: &Turn) -> String {
        turn.intermediate
            .iter()
            .filter_map(|b| match b {
                IntermediateBlock::Message { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("|")
    }

    #[test]
    fn append_delta_is_pure_concat() {
        // Grok CLI / sampler / merge buffer all use push_str only.
        let mut s = String::from("min");
        append_delta(&mut s, "ion");
        assert_eq!(s, "minion");
        append_delta(&mut s, "-local");
        assert_eq!(s, "minion-local");

        // Spaces only appear when the wire already contains them.
        let mut t = String::from("Hello,");
        append_delta(&mut t, " world");
        assert_eq!(t, "Hello, world");

        // No invented space between bare fragments (matches agent merge tests).
        let mut u = String::from("change");
        append_delta(&mut u, "I");
        assert_eq!(u, "changeI");
    }

    #[test]
    fn thought_channel_stays_in_thought() {
        // TUI parity: agent_thought_chunk never re-routes to message by content.
        let mut turn = empty_turn();
        append_agent_thought(
            &mut turn,
            "The user wants me to:\n1. Restore the old fonts\n",
        );
        append_agent_thought(
            &mut turn,
            "Got it—I'll restore the original font classes.",
        );
        assert!(message_text(&turn).is_empty(), "msg={:?}", message_text(&turn));
        let th = thought_text(&turn);
        assert!(th.contains("Restore the old fonts"), "{th:?}");
        assert!(th.contains("Got it"), "{th:?}");
    }

    #[test]
    fn message_and_thought_channels_stay_separate() {
        let mut turn = empty_turn();
        append_agent_thought(&mut turn, "Planning step by step…\n");
        append_agent_message(&mut turn, None, "Here is the answer: ");
        // Later thought is a NEW thought block (message is hard boundary), not folded.
        append_agent_thought(&mut turn, "extra reasoning");
        assert_eq!(message_text(&turn), "Here is the answer: ");
        assert!(thought_text(&turn).contains("Planning"));
        assert!(thought_text(&turn).contains("extra reasoning"));
    }

    #[test]
    fn pure_reasoning_stays_in_thought() {
        let mut turn = empty_turn();
        append_agent_thought(
            &mut turn,
            "The problem asks to compute (17 × 23) + (41 × 19) − 88.\n",
        );
        append_agent_thought(&mut turn, "I need to show intermediate products.");
        assert!(message_text(&turn).is_empty(), "no false status route");
        assert!(thought_text(&turn).contains("17 × 23"));
    }

    fn doc_with_streaming_turn() -> ChatDocument {
        ChatDocument {
            id: "c1".into(),
            project_id: "p1".into(),
            title: "t".into(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            acp_session_id: Some("s1".into()),
            turns: vec![empty_turn()],
        }
    }

    #[test]
    fn apply_message_chunk_appends_to_streaming_turn() {
        let mut doc = doc_with_streaming_turn();
        let kind = apply_one_update(
            &mut doc,
            &serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Hello" }
            }),
        );
        assert_eq!(kind.as_deref(), Some("agent_message_chunk"));
        assert!(doc.turns[0].assistant_message.contains("Hello") || message_text(&doc.turns[0]).contains("Hello"));
    }

    #[test]
    fn apply_ignores_unknown_kind_on_complete_turn() {
        let mut doc = doc_with_streaming_turn();
        doc.turns[0].status = "complete".into();
        let kind = apply_one_update(
            &mut doc,
            &serde_json::json!({
                "sessionUpdate": "plan",
                "entries": []
            }),
        );
        // plan is not late-allowed → None
        assert!(kind.is_none());
    }

    #[test]
    fn apply_late_message_chunk_on_complete_allowed() {
        let mut doc = doc_with_streaming_turn();
        doc.turns[0].status = "complete".into();
        let kind = apply_one_update(
            &mut doc,
            &serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": " tail" }
            }),
        );
        assert_eq!(kind.as_deref(), Some("agent_message_chunk"));
        assert!(message_text(&doc.turns[0]).contains("tail") || doc.turns[0].assistant_message.contains("tail"));
    }

    #[test]
    fn apply_cancelled_turn_drops_updates() {
        let mut doc = doc_with_streaming_turn();
        doc.turns[0].status = "cancelled".into();
        let kind = apply_one_update(
            &mut doc,
            &serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": "nope" }
            }),
        );
        assert!(kind.is_none());
        assert!(message_text(&doc.turns[0]).is_empty());
    }

    #[test]
    fn apply_tool_call_creates_tool_block() {
        let mut doc = doc_with_streaming_turn();
        let kind = apply_one_update(
            &mut doc,
            &serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "tc1",
                "title": "Read file",
                "status": "pending",
                "kind": "read"
            }),
        );
        assert_eq!(kind.as_deref(), Some("tool_call"));
        let tools: Vec<_> = doc.turns[0]
            .intermediate
            .iter()
            .filter(|b| matches!(b, IntermediateBlock::Tool { .. }))
            .collect();
        assert_eq!(tools.len(), 1);
    }

    #[test]
    fn apply_routes_child_update_to_owning_turn() {
        use crate::store::IntermediateBlock;
        let mut doc = doc_with_streaming_turn();
        // First turn completed with a subagent; second turn streaming.
        doc.turns[0].status = "complete".into();
        doc.turns[0].intermediate.push(IntermediateBlock::Subagent {
            id: "b1".into(),
            subagent_id: "child-9".into(),
            tool_call_id: None,
            description: "worker".into(),
            status: "running".into(),
            model: None,
            subagent_type: None,
            output: String::new(),
            collapsed: true,
        });
        let mut t2 = empty_turn();
        t2.id = "t2".into();
        t2.status = "streaming".into();
        doc.turns.push(t2);

        let kind = apply_one_update(
            &mut doc,
            &serde_json::json!({
                "sessionUpdate": "subagent_finished",
                "subagent_id": "child-9",
                "status": "completed",
                "output": "done"
            }),
        );
        assert_eq!(kind.as_deref(), Some("subagent_finished"));
        // Must land on turn 0, not the streaming turn 1
        match &doc.turns[0].intermediate[0] {
            IntermediateBlock::Subagent { status, output, .. } => {
                assert_eq!(status, "completed");
                assert_eq!(output, "done");
            }
            _ => panic!("expected subagent on turn 0"),
        }
        assert!(doc.turns[1].intermediate.is_empty());
    }

    #[test]
    fn promote_legacy_spawn_tool_to_subagent_card() {
        let mut doc = doc_with_streaming_turn();
        doc.turns[0].status = "complete".into();
        doc.turns[0].intermediate.push(IntermediateBlock::Tool {
            id: "x".into(),
            tool_call_id: "tc-spawn".into(),
            title: "Task".into(),
            kind: Some("other".into()),
            status: "completed".into(),
            raw_input: Some(serde_json::json!({
                "variant": "Task",
                "description": "Explore codebase",
                "subagent_type": "explore",
                "prompt": "look around"
            })),
            content: None,
            raw_output: Some(serde_json::json!({
                "text": "subagent_id: sa-1\noutput: report"
            })),
            collapsed: true,
        });
        promote_subagent_tools_in_doc(&mut doc);
        assert!(
            doc.turns[0]
                .intermediate
                .iter()
                .any(|b| matches!(b, IntermediateBlock::Subagent { .. })),
            "expected Subagent card after promote"
        );
        assert!(
            !doc.turns[0]
                .intermediate
                .iter()
                .any(|b| matches!(b, IntermediateBlock::Tool { .. })),
            "spawn tool should be removed after promote"
        );
    }
}
