// Drives a headless `claude -p` conversation for the companion chat popup.
// Same reasoning as claude.rs (one process per turn, continuity via
// `--resume`, Windows claude.cmd fallback), but with every tool disabled:
// the companion is a standalone personality chat, explicitly scoped out
// from touching the user's project (MULTI_PANE_ADE_PRD.md: "컴패니언 잡담
// 세션이 실제 작업 pane의 대화 내용을 아는 것"은 하지 않음) - so unlike
// claude.rs there is no MCP bridge / approval queue wiring here at all.
//
// Runs with cwd = ~/.myade/companion (created on demand) rather than any
// real project directory, so:
//   - `--resume` conversation continuity is scoped to companion chats only
//     and never collides with a real project's session history.
//   - the existing SessionStart hook (server.ts) still fires for it like
//     any other `claude` invocation and injects persona.md's tone-
//     preference notes into context "for free" - the character's own
//     personality (which persona.md knows nothing about) is prepended into
//     the prompt text itself by the caller instead, only on that
//     character's first turn (see commands::companion_send_message).

use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Clone, serde::Serialize)]
struct CompanionEventPayload {
    #[serde(rename = "characterId")]
    character_id: String,
    raw: Value,
}

pub struct CompanionTurnResult {
    pub session_id: Option<String>,
    pub final_text: Option<String>,
    pub is_error: bool,
}

const DISALLOWED_TOOLS: &str =
    "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,NotebookEdit,Task,TodoWrite";

fn companion_cwd() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let home =
        std::env::var("USERPROFILE").map_err(|_| "USERPROFILE 환경변수를 찾을 수 없습니다".to_string())?;
    #[cfg(not(windows))]
    let home = std::env::var("HOME").map_err(|_| "HOME 환경변수를 찾을 수 없습니다".to_string())?;

    let dir = PathBuf::from(home).join(".myade").join("companion");
    std::fs::create_dir_all(&dir).map_err(|e| format!("컴패니언 작업 폴더 생성 실패: {e}"))?;
    Ok(dir)
}

pub async fn run_turn(
    app: AppHandle,
    character_id: &str,
    prompt: &str,
    resume_session_id: Option<&str>,
) -> Result<CompanionTurnResult, String> {
    let cwd = companion_cwd()?;

    // `prompt` is deliberately NOT passed as `.arg(prompt)` - free-text
    // (in particular non-ASCII, e.g. Korean) content on the command line
    // hits a real Windows failure mode once the claude.cmd fallback below
    // triggers: CreateProcess invoking a .cmd file directly re-parses the
    // argument list as a batch-file command line rather than treating it
    // as an opaque string, and can reject or mangle it ("batch file
    // arguments are invalid"). `src/persona.ts` (the 1단계 Node server)
    // already solved exactly this by writing the prompt to the child's
    // stdin instead of argv - `-p` with no following value makes `claude`
    // read the prompt from stdin. Mirrored here rather than reinvented.
    let build_cmd = |bin: &str| {
        let mut cmd = Command::new(bin);
        // Same reasoning as pty.rs::spawn_shell: without this, an inherited
        // CLAUDE_CODE_CHILD_SESSION marker disables this process's own
        // transcript saving, which breaks the `--resume` continuity below on
        // the very next turn.
        cmd.env_remove("CLAUDE_CODE_CHILD_SESSION");
        // Read by scripts/session-start-hook.js, same as pty.rs::spawn_shell -
        // makes the SessionStart hook inject this character's roster-file
        // identity with explicit precedence over persona.md (see
        // server.ts). Belt-and-suspenders alongside the blurb this module
        // already prepends to the first-turn prompt below: persona.md can
        // accumulate stale "you're now character X" notes from earlier
        // per-character testing sessions (it has no way to know those were
        // roleplay, not a real global tone preference), and without this a
        // later turn could latch onto one of those instead of the character
        // this conversation is actually supposed to be.
        cmd.env("MYADE_CHARACTER_ID", character_id);
        cmd.current_dir(&cwd)
            .arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--include-partial-messages")
            .arg("--disallowedTools")
            .arg(DISALLOWED_TOOLS)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped());

        if let Some(sid) = resume_session_id {
            cmd.arg("--resume").arg(sid);
        }
        cmd
    };

    // Same Windows `claude.cmd` shim fallback as claude.rs::run_turn - see
    // that file's comment for why Command::new("claude") alone fails here.
    // (This handles "claude not found" specifically; it's a separate
    // concern from the argv-vs-stdin fix above.)
    let mut spawn_result = build_cmd("claude").spawn();
    if let Err(ref e) = spawn_result {
        if e.kind() == std::io::ErrorKind::NotFound {
            spawn_result = build_cmd("claude.cmd").spawn();
        }
    }

    let mut child = spawn_result
        .map_err(|e| format!("claude 실행 실패 (PATH에 claude가 있는지 확인하세요): {e}"))?;

    {
        let mut stdin = child.stdin.take().ok_or("claude stdin을 열 수 없습니다")?;
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("claude stdin 쓰기 실패: {e}"))?;
        // Explicit drop closes the pipe (EOF) so `claude -p` (reading the
        // prompt from stdin) knows the prompt is complete - done before
        // the stdout read loop starts below, not concurrently with it, so
        // there's no risk of a full-pipe-buffer deadlock either way for a
        // chat-sized prompt.
    }

    let stdout = child.stdout.take().ok_or("claude stdout을 열 수 없습니다")?;
    let stderr = child.stderr.take();
    let mut reader = BufReader::new(stdout).lines();

    let stderr_handle = stderr.map(|stderr| {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut collected = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                collected.push_str(&line);
                collected.push('\n');
            }
            collected
        })
    });

    let mut session_id: Option<String> = None;
    let mut final_text: Option<String> = None;
    let mut is_error = false;

    while let Ok(Some(line)) = reader.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(sid) = value.get("session_id").and_then(|v| v.as_str()) {
            session_id = Some(sid.to_string());
        }

        if value.get("type").and_then(|v| v.as_str()) == Some("result") {
            is_error = value.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
            final_text = value.get("result").and_then(|v| v.as_str()).map(|s| s.to_string());
        }

        let _ = app.emit(
            "companion://event",
            CompanionEventPayload { character_id: character_id.to_string(), raw: value },
        );
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;

    let stderr_text = match stderr_handle {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    };

    if !status.success() && final_text.is_none() {
        is_error = true;
        let trimmed = stderr_text.trim();
        let detail = if trimmed.is_empty() { String::new() } else { format!("\nstderr: {trimmed}") };
        final_text = Some(format!("claude 프로세스가 오류로 종료됐습니다 (status: {status}){detail}"));
    }

    Ok(CompanionTurnResult { session_id, final_text, is_error })
}
