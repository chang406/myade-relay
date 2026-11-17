use crate::pty::PtyHandle;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

/// One terminal pane: its own real shell PTY, the folder it's working in,
/// and the pane id it's registered under with the stage-1 daemon (kept in
/// its own Mutex since registration is an async round trip that finishes
/// slightly after the pane is inserted into `AppState::panes`).
pub struct PaneEntry {
    pub id: String,
    pub cwd: String,
    pub pty: Arc<PtyHandle>,
    pub myade_pane_id: Mutex<Option<String>>,
    /// Roster id (see characters.rs) assigned to this pane at creation time
    /// (see commands::spawn_pane) and never changed after - plain `String`,
    /// no `Mutex`/`Option`, since by the time a `PaneEntry` exists it's
    /// already fully decided and immutable for the pane's whole lifetime.
    pub character: String,
}

pub struct AppState {
    /// Every terminal pane currently open in this window, keyed by pane id.
    pub panes: Mutex<HashMap<String, Arc<PaneEntry>>>,
    pub myade_port: Mutex<u16>,
    /// Shuffle-bag draw order for character assignment (see
    /// `characters::draw`) - shuffled once at app startup and refilled with
    /// a fresh shuffle each time it runs dry. Session-lifetime only, not
    /// persisted to disk: restarting the app starts a brand new bag.
    pub character_queue: Mutex<VecDeque<String>>,
    /// Character id -> that character's claude session id, so switching
    /// between characters in the companion popup and back resumes each
    /// one's own conversation (for the lifetime of the app - nothing here
    /// is persisted to disk).
    pub companion_sessions: Mutex<HashMap<String, String>>,
    /// Serializes companion turns - only one `claude -p` companion process
    /// runs at a time, matching the single companion popup window.
    pub companion_turn_lock: AsyncMutex<()>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            panes: Mutex::new(HashMap::new()),
            myade_port: Mutex::new(crate::pane::DEFAULT_MYADE_PORT),
            character_queue: Mutex::new(crate::characters::shuffled_queue()),
            companion_sessions: Mutex::new(HashMap::new()),
            companion_turn_lock: AsyncMutex::new(()),
        }
    }
}
