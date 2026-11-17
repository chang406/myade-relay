/**
 * Shared types for the myade state store.
 *
 * A "pane" represents one terminal window running the `myade` launcher
 * (and, inside it, one `claude` CLI process). A pane can go through
 * multiple Claude "sessions" over its lifetime (e.g. after /clear or
 * /compact), but for stage 1 we treat pane == session for simplicity:
 * the most recent Claude session_id we've seen for a pane is what we
 * report.
 */

export type PaneStatus =
  | "starting" // launcher registered the pane, no SessionStart hook seen yet
  | "idle" // SessionStart or Stop fired most recently -> waiting for user input
  | "waiting_permission" // Notification(permission_prompt) fired -> Claude needs approval
  | "stopped" // launcher told us the claude process exited
  | "unknown"; // fallback

export interface PaneRecord {
  /** Server-issued id for the pane (terminal/process), minted at launcher registration. */
  paneId: string;
  /** Most recent Claude Code session_id observed via hooks for this pane, if any. */
  claudeSessionId: string | null;
  /** Working directory the pane was launched in / that hooks reported. */
  cwd: string;
  /** Human-friendly label, defaults to the folder name. */
  label: string;
  /** OS process id of the `claude` process, if known. */
  pid: number | null;
  status: PaneStatus;
  /** Free-text description of the last thing that happened (event name, notification type, etc). */
  lastEvent: string | null;
  /** ISO timestamp of when this pane was registered by the launcher. */
  startedAt: string;
  /** ISO timestamp of the last hook/launcher update. */
  updatedAt: string;
  /** true once the launcher has told us the claude process exited. */
  ended: boolean;
}

export interface RegisterStartInput {
  /** Optional stable GUI terminal id, also inherited by hook subprocesses. */
  paneId?: string;
  cwd: string;
  pid?: number;
  label?: string;
}

export interface RegisterEndInput {
  paneId: string;
}

/** Common fields Claude Code sends to every hook, per the hooks reference. */
export interface HookCommonInput {
  myadePaneId?: string;
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
  prompt_id?: string;
  permission_mode?: string;
}

export interface SessionStartHookInput extends HookCommonInput {
  source?: "startup" | "resume" | "compact" | "clear" | "fork";
  /**
   * Roster character id (see myade-gui/src-tauri/src/characters.rs), present
   * only when this session started inside a myade-gui pane or the companion
   * popup. Not part of Claude Code's own hook payload - scripts/session-
   * start-hook.js reads it from its own process.env.MYADE_CHARACTER_ID
   * (inherited from the pane's shell via pty.rs::spawn_shell /
   * companion.rs::run_turn) and adds it here before forwarding.
   */
  myadeCharacterId?: string;
}

export interface NotificationHookInput extends HookCommonInput {
  notification_type?: string;
  message?: string;
}

/** Fires once when a session truly ends (terminal closed, /clear, -p exit,
 * etc.) - unlike Stop, which fires after every turn. Cannot block or inject
 * context back (the session is already over), so it's fire-and-forget. */
export interface SessionEndHookInput extends HookCommonInput {
  reason?: "clear" | "logout" | "prompt_input_exit" | "other" | "resume" | "bypass_permissions_disabled";
}
