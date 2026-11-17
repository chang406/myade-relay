// Real terminal (one per pane). Raw bytes are always forwarded to the
// frontend (xterm.js) as they arrive, so the human sees exactly what the
// shell prints - `claude` runs as a normal interactive foreground process
// the user types themselves, not something this app drives or intercepts.

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
fn shell_command() -> CommandBuilder {
    CommandBuilder::new("powershell.exe")
}

#[cfg(not(windows))]
fn shell_command() -> CommandBuilder {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    CommandBuilder::new(shell)
}

#[derive(Clone, serde::Serialize)]
struct PtyDataPayload {
    #[serde(rename = "paneId")]
    pane_id: String,
    data: String,
    seq: u64,
}

#[derive(Clone, serde::Serialize)]
struct PtyExitPayload {
    #[serde(rename = "paneId")]
    pane_id: String,
}

/// Rolling text buffer plus a monotonic counter of how many `pty://data`
/// chunks have been pushed so far. The counter lets a late-attaching
/// frontend listener (see `read_buffer`/`pty_read_backlog`) splice a
/// point-in-time snapshot together with the live event stream without
/// dropping or duplicating any bytes - it reads the snapshot and the
/// "next chunk index" atomically (same lock), and the live listener tags
/// every emitted chunk with its index so the frontend can discard any
/// live chunk whose index is already covered by the snapshot it fetched.
struct PtyBuffer {
    text: String,
    next_chunk_seq: u64,
}

pub struct PtyHandle {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    buffer: Arc<Mutex<PtyBuffer>>,
    /// A killer cloned off the child, rather than the `Child` itself: the
    /// child is owned by the waiter thread (which parks in `wait()` for the
    /// whole life of the pane), so holding it here behind the same lock
    /// `kill()` needs would deadlock the two against each other.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

const MAX_BUFFER_LEN: usize = 2_000_000;

/// Appends `chunk`, trims the buffer if it's grown past the cap, and
/// returns the sequence number assigned to this chunk (for `pty://data`).
fn push_and_trim(buffer: &Arc<Mutex<PtyBuffer>>, chunk: &str) -> u64 {
    let mut b = buffer.lock().unwrap();
    let seq = b.next_chunk_seq;
    b.next_chunk_seq += 1;
    b.text.push_str(chunk);
    if b.text.len() > MAX_BUFFER_LEN {
        let cut = b.text.len() - MAX_BUFFER_LEN;
        // cut on a char boundary
        let mut cut = cut;
        while cut < b.text.len() && !b.text.is_char_boundary(cut) {
            cut += 1;
        }
        b.text.drain(0..cut);
    }
    seq
}

impl PtyHandle {
    pub fn write_input(&self, data: &str) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|e| e.to_string())?;
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Point-in-time snapshot of everything printed so far, plus the
    /// sequence number the *next* live `pty://data` chunk will carry. A
    /// frontend that just mounted can write this snapshot once and then
    /// keep only live chunks whose seq is `>= next_chunk_seq`, without a
    /// gap or overlap.
    pub fn read_buffer(&self) -> Result<(String, u64), String> {
        let b = self.buffer.lock().map_err(|e| e.to_string())?;
        Ok((b.text.clone(), b.next_chunk_seq))
    }

    /// Kills the underlying shell process. Called when a pane is closed so
    /// it doesn't linger as an orphaned process after the last `Arc` to
    /// this handle is dropped (portable-pty does not kill on drop).
    pub fn kill(&self) {
        if let Ok(mut killer) = self.killer.lock() {
            // Failing here is expected when the shell already exited on
            // its own (that's what got us here via `pty://exit`), so this
            // isn't an error path - just don't swallow it silently.
            if let Err(err) = killer.kill() {
                eprintln!("[myade-gui] pane 셸 종료 실패 (이미 끝났을 수 있음): {err}");
            }
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }
}

pub fn spawn_shell(
    app: AppHandle,
    cwd: &str,
    pane_id: &str,
    character_id: &str,
    daemon_pane_id: Option<&str>,
    myade_port: u16,
) -> Result<PtyHandle, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = shell_command();
    cmd.cwd(cwd);
    // Without this, a pane's shell (and any `claude` the user launches inside
    // it) inherits this from wherever the Tauri dev process itself was
    // spawned - if that was ever a Claude Code Bash/Task subprocess, Claude
    // Code stamps this marker on it, and every descendant process disables
    // its own transcript saving as a nested-session safety measure. That
    // silently breaks persona.ts's SessionEnd summary (`--resume` has no
    // transcript file to resume) for every pane, with no user-visible error.
    cmd.env_remove("CLAUDE_CODE_CHILD_SESSION");
    // Read by scripts/session-start-hook.js (inherited all the way down
    // through this shell -> `claude` -> the hook's own subprocess) so the
    // SessionStart hook can inject this pane's character identity into the
    // session - see server.ts's /hooks/session-start handler. The character
    // is decided once, at pane creation (see commands::spawn_pane), rather
    // than reactively off pane output, specifically so it's already set
    // before the user ever launches `claude` in this shell.
    cmd.env("MYADE_CHARACTER_ID", character_id);
    cmd.env_remove("MYADE_PANE_ID");
    if let Some(id) = daemon_pane_id {
        cmd.env("MYADE_PANE_ID", id);
    }
    cmd.env("MYADE_PORT", myade_port.to_string());

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let killer = child.clone_killer();

    // Shell exit is detected by waiting on the process, NOT by the read
    // loop below hitting EOF. On Windows the ConPTY master's output pipe
    // stays open for as long as anything holds the master handle - and
    // PtyHandle holds it for the whole life of the pane - so when the user
    // types `exit`, `reader.read()` just blocks forever instead of
    // returning Ok(0). The read loop's own `pty://exit` emit is kept as a
    // fallback (it fires once the handle really is dropped), and the
    // frontend ignores the duplicate for a pane it has already removed.
    let app_for_waiter = app.clone();
    let pane_id_for_waiter = pane_id.to_string();
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = app_for_waiter.emit(
            "pty://exit",
            PtyExitPayload { pane_id: pane_id_for_waiter },
        );
    });

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let buffer: Arc<Mutex<PtyBuffer>> = Arc::new(Mutex::new(PtyBuffer {
        text: String::new(),
        next_chunk_seq: 0,
    }));
    let buffer_for_thread = buffer.clone();
    let app_for_thread = app.clone();
    let pane_id_for_thread = pane_id.to_string();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = app_for_thread.emit(
                        "pty://exit",
                        PtyExitPayload { pane_id: pane_id_for_thread.clone() },
                    );
                    break;
                }
                Ok(n) => {
                    let chunk = &buf[..n];
                    let text = String::from_utf8_lossy(chunk);
                    let seq = push_and_trim(&buffer_for_thread, &text);

                    let encoded = base64::engine::general_purpose::STANDARD.encode(chunk);
                    if app_for_thread
                        .emit(
                            "pty://data",
                            PtyDataPayload { pane_id: pane_id_for_thread.clone(), data: encoded, seq },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => {
                    let _ = app_for_thread.emit(
                        "pty://exit",
                        PtyExitPayload { pane_id: pane_id_for_thread.clone() },
                    );
                    break;
                }
            }
        }
    });

    Ok(PtyHandle {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
        buffer,
        killer: Mutex::new(killer),
    })
}
