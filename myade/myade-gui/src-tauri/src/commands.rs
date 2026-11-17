use crate::state::{AppState, PaneEntry};
use crate::{characters, companion, pane, pty};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize, Clone)]
pub struct PaneInfo {
    pub id: String,
    pub cwd: String,
    pub label: String,
    pub character: String,
}

#[derive(Serialize)]
pub struct AppInfo {
    #[serde(rename = "myadePort")]
    pub myade_port: u16,
    pub panes: Vec<PaneInfo>,
}

/// Panes are capped at the character roster size (see characters.rs) since
/// every pane running `claude` gets its own character and the PRD wants
/// them non-overlapping - once the roster is exhausted there's nothing
/// left to assign. `.max(1)` is just a defensive floor; in practice
/// `list_roster()` always self-heals to at least the default placeholder
/// roster (see `characters::ensure_default_roster`), so this only matters
/// if the characters directory is somehow unwritable.
fn max_pane_count() -> usize {
    characters::list_roster().len().max(1)
}

/// The exact substring the frontend checks for in a `create_pane` error to
/// tell "roster limit reached" apart from "user cancelled the folder
/// picker" (see App.tsx::addPane) - both surface as a plain `Err(String)`
/// over IPC, so they need a distinguishable marker somewhere in the text.
const PANE_LIMIT_MARKER: &str = "pane 최대 개수";

fn label_for(cwd: &str) -> String {
    std::path::Path::new(cwd)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "myade-gui".to_string())
}

/// Spawns one pane's PTY, registers it with the stage-1 daemon, and adds it
/// to `state.panes`. Shared by `init_app` (initial panes) and `create_pane`
/// (panes added later) so there's exactly one place that does this.
///
/// The character is picked *before* the shell is spawned (not reactively
/// once `claude` happens to print its banner, as an earlier version did) so
/// it can be passed to `pty::spawn_shell` as an env var the shell - and
/// anything launched inside it, including `claude`'s own SessionStart hook
/// subprocess - inherits from the start. Reactive assignment left the badge
/// purely cosmetic: it never had a way to tell the *actual* `claude` process
/// which personality it was supposed to be, since by the time the launch
/// banner appeared the hook that could have injected that had already fired
/// with nothing to say.
async fn spawn_pane(app: &AppHandle, state: &Arc<AppState>, cwd: String) -> Result<PaneInfo, String> {
    let pane_id = uuid::Uuid::new_v4().simple().to_string();

    let taken: HashSet<String> = state
        .panes
        .lock()
        .unwrap()
        .values()
        .map(|e| e.character.clone())
        .collect();
    let character_id = {
        let mut queue = state.character_queue.lock().unwrap();
        characters::draw(&mut queue, &taken)
    }
    .ok_or_else(|| "캐릭터 롤스터가 비어 있습니다".to_string())?;

    let label = label_for(&cwd);
    let myade_port = *state.myade_port.lock().unwrap();
    // Register before the shell starts: a profile can launch a CLI immediately.
    let daemon_pane_id = pane::register_start(myade_port, &cwd, &format!("gui:{label}"), &pane_id).await;
    let pty_handle = match pty::spawn_shell(app.clone(), &cwd, &pane_id, &character_id, daemon_pane_id.as_deref(), myade_port) {
        Ok(handle) => handle,
        Err(error) => {
            if let Some(id) = &daemon_pane_id {
                pane::register_end(myade_port, id).await;
            }
            return Err(error);
        }
    };

    let entry = Arc::new(PaneEntry {
        id: pane_id.clone(),
        cwd: cwd.clone(),
        pty: Arc::new(pty_handle),
        myade_pane_id: Mutex::new(daemon_pane_id),
        character: character_id.clone(),
    });
    state.panes.lock().unwrap().insert(pane_id.clone(), entry.clone());

    Ok(PaneInfo { id: pane_id, cwd, label, character: character_id })
}

/// Called once by the frontend on mount. Always starts with zero panes -
/// no folder picker, no restore-from-last-session. The user opens panes
/// explicitly via `create_pane` (see App.tsx's welcome screen / toolbar
/// button), which is also what assigns each new pane its character.
#[tauri::command]
pub async fn init_app(state: tauri::State<'_, Arc<AppState>>) -> Result<AppInfo, String> {
    let myade_port = *state.myade_port.lock().unwrap();
    Ok(AppInfo { myade_port, panes: Vec::new() })
}

/// Opens one additional pane. `cwd` is reused as-is if it's a real
/// directory; otherwise (including when omitted) the user is prompted to
/// pick a folder.
#[tauri::command]
pub async fn create_pane(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    cwd: Option<String>,
) -> Result<PaneInfo, String> {
    let max = max_pane_count();
    let current = state.panes.lock().unwrap().len();
    if current >= max {
        return Err(format!(
            "캐릭터가 {max}명뿐이라 {PANE_LIMIT_MARKER}({max}개)를 넘을 수 없습니다. ~/.myade/characters/ 에 캐릭터 파일을 추가하면 한도가 늘어납니다."
        ));
    }

    let cwd = match cwd {
        Some(c) if std::path::Path::new(&c).is_dir() => c,
        _ => {
            let picked = app
                .dialog()
                .file()
                .set_title("새 pane이 작업할 폴더를 선택하세요")
                .blocking_pick_folder();
            picked
                .and_then(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .ok_or("폴더를 선택하지 않았습니다")?
        }
    };

    let info = spawn_pane(&app, state.inner(), cwd).await?;
    Ok(info)
}

/// Kills the pane's shell process, unregisters it from the stage-1 daemon,
/// and drops it from this window's layout.
#[tauri::command]
pub async fn close_pane(
    state: tauri::State<'_, Arc<AppState>>,
    pane_id: String,
) -> Result<(), String> {
    // Read the daemon-side id *before* dropping the entry. This used to
    // remove first and read after, so if the unregister call below failed
    // the only copy of that id was already gone and the daemon kept the
    // pane in pane_list until its stale sweep eventually caught it.
    let entry = state
        .panes
        .lock()
        .unwrap()
        .get(&pane_id)
        .cloned()
        .ok_or("알 수 없는 pane입니다")?;
    let daemon_pane_id = entry.myade_pane_id.lock().unwrap().clone();

    // Drop it from the registry before the await so the character slot is
    // released immediately - `spawn_pane` builds its "taken" set from the
    // open panes, and the unregister round trip can take up to 2s.
    state.panes.lock().unwrap().remove(&pane_id);
    entry.pty.kill();

    let myade_port = *state.myade_port.lock().unwrap();
    if let Some(daemon_pane_id) = daemon_pane_id {
        pane::register_end(myade_port, &daemon_pane_id).await;
    }

    Ok(())
}

#[tauri::command]
pub fn list_panes(state: tauri::State<'_, Arc<AppState>>) -> Vec<PaneInfo> {
    state
        .panes
        .lock()
        .unwrap()
        .values()
        .map(|e| PaneInfo {
            id: e.id.clone(),
            cwd: e.cwd.clone(),
            label: label_for(&e.cwd),
            character: e.character.clone(),
        })
        .collect()
}

#[derive(Serialize, Clone)]
pub struct CharacterInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(rename = "iconDataUri")]
    pub icon_data_uri: Option<String>,
}

#[tauri::command]
pub fn list_characters() -> Vec<CharacterInfo> {
    characters::list_roster()
        .into_iter()
        .map(|c| {
            let icon_data_uri = c.icon.as_deref().and_then(characters::icon_data_uri);
            CharacterInfo { id: c.id, name: c.name, color: c.color, icon_data_uri }
        })
        .collect()
}

// ---------------------------------------------------------------------
// Companion chat popup - a standalone window (label "companion", see
// CompanionApp.tsx/main.tsx's hash-based routing) where the user picks a
// roster character and chats with just that personality. Deliberately
// knows nothing about any pane's conversation (see companion.rs's doc
// comment) - the only things it shares with the rest of the app are the
// character roster and (indirectly, via the SessionStart hook that fires
// for its headless `claude -p` process same as any other) persona.md.
// ---------------------------------------------------------------------

/// Opens the companion popup, or focuses it if it's already open. Points
/// at plain "index.html" - main.tsx picks CompanionApp vs App by reading
/// this window's own Tauri label (set to "companion" right below), not a
/// URL hash/query string. A `#companion` fragment was tried first, but
/// Tauri's dev-server URL resolution didn't carry it through correctly
/// (the window loaded blank, nothing rendered) - the window label doesn't
/// go through any URL parsing at all, so it doesn't have that failure mode.
///
/// Window/webview creation is Windows-GUI-thread-affine, so it's explicitly
/// dispatched onto the main thread via `run_on_main_thread` rather than
/// relying on `WebviewWindowBuilder::build()`'s own internal blocking
/// dispatch: this command was first written as a plain sync `fn`, whose own
/// IPC response back to the calling window's `invoke()` also needs the main
/// thread's event loop - with `.build()` blocking that same thread waiting
/// on itself, the observed symptom was the whole window (title bar
/// included, not just the page content) going "Not Responding" and staying
/// that way. Making the command `async` and doing the actual build via an
/// explicit, non-blocking main-thread dispatch (a channel instead of a
/// synchronous wait) avoids that self-deadlock.
#[tauri::command]
pub async fn open_companion_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("companion") {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let result = WebviewWindowBuilder::new(&app_for_main, "companion", WebviewUrl::App("index.html".into()))
            .title("myade 컴패니언")
            .inner_size(420.0, 640.0)
            .min_inner_size(320.0, 420.0)
            .build()
            .map(|_| ())
            .map_err(|e| e.to_string());
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;

    rx.await.map_err(|_| "컴패니언 창 생성 응답을 받지 못했습니다".to_string())?
}

#[derive(Serialize, Clone)]
struct CompanionTurnDonePayload {
    #[serde(rename = "characterId")]
    character_id: String,
    #[serde(rename = "isError")]
    is_error: bool,
    #[serde(rename = "finalText")]
    final_text: Option<String>,
}

/// Runs one companion chat turn for `characterId`. On that character's
/// first turn in this app session (no session id recorded yet in
/// `state.companion_sessions`), the character's roster file content is
/// prepended to the prompt so the persona is established from the start;
/// later turns just resume that character's own session and send the raw
/// text, same shape as commands::send_chat_message.
#[tauri::command]
pub async fn companion_send_message(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    character_id: String,
    text: String,
) -> Result<(), String> {
    let _guard = state.companion_turn_lock.lock().await;

    let resume_id = state.companion_sessions.lock().unwrap().get(&character_id).cloned();

    let prompt = if resume_id.is_none() {
        let blurb = characters::character_content(&character_id)
            .unwrap_or_else(|| "(캐릭터 설정을 찾을 수 없습니다 - 기본 성격으로 대화해줘)".to_string());
        format!(
            "다음은 네가 지금부터 대화 내내 유지할 캐릭터 설정이야. 실제 프로젝트 작업과는 무관한 잡담이니 도구는 쓰지 마.\n\n{blurb}\n\n---\n\n{text}"
        )
    } else {
        text
    };

    let result =
        companion::run_turn(app.clone(), &character_id, &prompt, resume_id.as_deref()).await?;

    if let Some(sid) = &result.session_id {
        state
            .companion_sessions
            .lock()
            .unwrap()
            .insert(character_id.clone(), sid.clone());
    }

    let _ = app.emit(
        "companion://turn-done",
        CompanionTurnDonePayload {
            character_id,
            is_error: result.is_error,
            final_text: result.final_text,
        },
    );

    Ok(())
}

fn pty_for(state: &tauri::State<'_, Arc<AppState>>, pane_id: &str) -> Result<Arc<pty::PtyHandle>, String> {
    state
        .panes
        .lock()
        .unwrap()
        .get(pane_id)
        .map(|e| e.pty.clone())
        .ok_or_else(|| "알 수 없는 pane입니다".to_string())
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, Arc<AppState>>, pane_id: String, data: String) -> Result<(), String> {
    pty_for(&state, &pane_id)?.write_input(&data)
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, Arc<AppState>>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty_for(&state, &pane_id)?.resize(cols, rows)
}

#[derive(Serialize)]
pub struct PtyBacklog {
    content: String,
    #[serde(rename = "nextSeq")]
    next_seq: u64,
}

/// `spawn_pane` starts the PTY before the frontend's terminal component for
/// that pane has mounted and attached its `pty://data` listener, so the
/// shell's startup banner/first prompt would otherwise be emitted into the
/// void and never shown. The frontend calls this once per pane on mount to
/// fetch what's already happened, then reconciles it with the live event
/// stream using `nextSeq` (see `pty.rs::read_buffer`).
#[tauri::command]
pub fn pty_read_backlog(state: tauri::State<'_, Arc<AppState>>, pane_id: String) -> Result<PtyBacklog, String> {
    let (content, next_seq) = pty_for(&state, &pane_id)?.read_buffer()?;
    Ok(PtyBacklog { content, next_seq })
}
