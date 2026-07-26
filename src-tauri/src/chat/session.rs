//! Pure session/history helpers used by the prompt lifecycle.
//!
//! No AppState, Tauri, or disk — safe for unit tests without a live agent.

use crate::store::ChatDocument;

/// Whether an ACP error indicates the session id is gone (recreate + re-seed).
pub(crate) fn is_unknown_session_error(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    // Prefer exact agent wording — avoid retrying on unrelated -32602 invalid params.
    e.contains("unknown session id")
        || e.contains("unknown session")
        || e.contains("\"data\":\"unknown session id\"")
}

/// Build a history rehydrate prompt when ACP session was recreated.
pub(crate) fn build_history_seed(doc: &ChatDocument, new_message: &str) -> String {
    let mut parts = Vec::new();
    parts.push(
        "The previous agent session could not be restored, so this is a fresh ACP session \
with the same project folder. Below is the conversation so far from the local transcript. \
Continue naturally from that context.\n"
            .to_string(),
    );
    for (i, turn) in doc.turns.iter().enumerate() {
        if i + 1 == doc.turns.len()
            && turn.status == "streaming"
            && turn.user_message == new_message
            && turn.assistant_message.is_empty()
        {
            continue;
        }
        parts.push(format!("User:\n{}\n", turn.user_message));
        if !turn.assistant_message.trim().is_empty() {
            parts.push(format!("Assistant:\n{}\n", turn.assistant_message));
        }
    }
    parts.push(format!(
        "---\nUser's new message (respond to this):\n{}",
        new_message
    ));
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Turn;
    use chrono::Utc;

    fn empty_doc(turns: Vec<Turn>) -> ChatDocument {
        ChatDocument {
            id: "c1".into(),
            project_id: "p1".into(),
            title: "t".into(),
            acp_session_id: Some("s1".into()),
            turns,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn turn(user: &str, assistant: &str, status: &str) -> Turn {
        Turn {
            id: "t1".into(),
            user_message: user.into(),
            intermediate: vec![],
            assistant_message: assistant.into(),
            status: status.into(),
            intermediate_collapsed: false,
            attachments: vec![],
            created_at: Utc::now(),
        }
    }

    #[test]
    fn unknown_session_matches_agent_wording() {
        assert!(is_unknown_session_error("Unknown session id"));
        assert!(is_unknown_session_error(r#"{"data":"unknown session id"}"#));
        assert!(!is_unknown_session_error("invalid params"));
    }

    #[test]
    fn history_seed_includes_prior_turns_and_new_message() {
        let doc = empty_doc(vec![
            turn("first", "reply one", "complete"),
            turn("second", "", "streaming"),
        ]);
        let seed = build_history_seed(&doc, "second");
        assert!(seed.contains("User:\nfirst"));
        assert!(seed.contains("Assistant:\nreply one"));
        // Current empty streaming turn with same user text is skipped.
        assert!(!seed.contains("User:\nsecond\n"));
        assert!(seed.contains("User's new message"));
        assert!(seed.contains("second"));
    }

    #[test]
    fn history_seed_keeps_completed_last_turn() {
        let doc = empty_doc(vec![turn("done", "answer", "complete")]);
        let seed = build_history_seed(&doc, "new");
        assert!(seed.contains("User:\ndone"));
        assert!(seed.contains("Assistant:\nanswer"));
        assert!(seed.contains("new"));
    }
}
