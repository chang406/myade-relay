// Registers this GUI window as a pane with the stage-1 myade daemon
// (the shared, always-on server from stage 1, default port 4317), the
// same way scripts/register.js does for a terminal launcher. Reused
// as-is per the stage-2 spec: the shared daemon needs no changes.

pub const DEFAULT_MYADE_PORT: u16 = 4317;

/// Returns `None` if the daemon didn't answer - the pane still works, it
/// just won't show up in `pane_list`. That used to be swallowed entirely
/// (`.ok()?`), which made "the daemon isn't running" indistinguishable
/// from "everything is fine" while every pane creation silently paid the
/// full 2s timeout, so each failure now says so on stderr.
pub async fn register_start(myade_port: u16, cwd: &str, label: &str, pane_id: &str) -> Option<String> {
    let url = format!("http://127.0.0.1:{myade_port}/sessions/start");
    let body = serde_json::json!({ "cwd": cwd, "label": label, "paneId": pane_id });
    let client = reqwest::Client::new();
    let resp = match client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(err) => {
            eprintln!(
                "[myade-gui] pane 등록 실패 ({url}): {err} - 이 pane은 pane_list에 나타나지 않습니다 (myade 데몬이 떠 있는지 확인하세요)"
            );
            return None;
        }
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(json) => json,
        Err(err) => {
            eprintln!("[myade-gui] pane 등록 응답을 읽지 못했습니다 ({url}): {err}");
            return None;
        }
    };
    json.get("paneId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Best-effort async version, used when a single pane is closed while the
/// app keeps running (an async Tauri command context, unlike shutdown).
pub async fn register_end(myade_port: u16, pane_id: &str) {
    let url = format!("http://127.0.0.1:{myade_port}/sessions/end");
    let client = reqwest::Client::new();
    if let Err(err) = client
        .post(&url)
        .json(&serde_json::json!({ "paneId": pane_id }))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        // Best-effort by design, but not silent: the daemon will now hold
        // this pane until its stale sweep expires it (see SessionStore's
        // STALE_PANE_MS), so it's worth knowing it happened.
        eprintln!("[myade-gui] pane {pane_id} 등록 해제 실패 ({url}): {err}");
    }
}

/// Best-effort, synchronous (non-tokio) call used at app shutdown, where
/// spinning up an async task to await isn't reliable.
pub fn register_end_blocking(myade_port: u16, pane_id: &str) {
    let url = format!("http://127.0.0.1:{myade_port}/sessions/end");
    let _ = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(2))
        .send_json(ureq::json!({ "paneId": pane_id }));
}
