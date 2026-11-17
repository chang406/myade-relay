import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type {
  PaneRecord,
  PaneStatus,
  RegisterStartInput,
  NotificationHookInput,
  HookCommonInput,
} from "./types";

const DATA_DIR = process.env.MYADE_DATA_DIR || path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

/** How long a launcher-registered pane can wait for its SessionStart hook
 * before we stop trying to auto-correlate it by cwd. */
const PENDING_MATCH_WINDOW_MS = 60_000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * A pane only stops being "live" when something explicitly tells us so -
 * the launcher's end call, the SessionEnd hook, or the GUI closing a pane.
 * Every abnormal exit (`tauri dev`'s file-watcher restart, a crash, closing
 * a cmd window with the X button, taskkill) sends none of those, so without
 * a sweep those records stay `ended: false` forever and pane_list fills up
 * with corpses. Liveness can't be checked by pid: almost none of the
 * accumulated records have one (hook-created panes never get a pid at all).
 * So staleness is judged purely on how long it's been since anything
 * touched the record.
 */
const STALE_PANE_MS = envNumber("MYADE_STALE_PANE_HOURS", 6) * 60 * 60 * 1000;

/** Ended records are kept around this long (so `pane_list includeEnded` and
 * post-mortem debugging still have something to show) and then dropped
 * entirely - otherwise state.json only ever grows. */
const PANE_RETENTION_MS = envNumber("MYADE_PANE_RETENTION_DAYS", 7) * 24 * 60 * 60 * 1000;

/**
 * In-memory store of pane state, persisted to a JSON file on every change
 * so a server restart doesn't lose the picture. This module has no
 * knowledge of MCP or HTTP - it's reused as-is by the MCP tool
 * definitions (tools.ts) and by the HTTP hook/register routes (server.ts),
 * and will be reused by stage 2 unchanged.
 */
export class SessionStore {
  private panes = new Map<string, PaneRecord>();

  constructor(private readonly stateFile = STATE_FILE) {
    this.load();
    // Anything that accumulated while the server was down is swept once up
    // front, so a restart is also the way to clean up after a crash.
    if (this.sweep()) this.persist();
  }

  private load() {
    try {
      const raw = fs.readFileSync(this.stateFile, "utf-8");
      const arr = JSON.parse(raw) as PaneRecord[];
      for (const p of arr) this.panes.set(p.paneId, p);
      console.error(`[state] loaded ${this.panes.size} pane(s) from ${this.stateFile}`);
    } catch {
      // no existing state file yet - fine on first run
    }
  }

  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const arr = Array.from(this.panes.values());
      fs.writeFileSync(this.stateFile, JSON.stringify(arr, null, 2), "utf-8");
    } catch (err) {
      console.error("[state] failed to persist state.json:", err);
    }
  }

  /** Called by the myade launcher script before it execs `claude`. */
  registerStart(input: RegisterStartInput): PaneRecord {
    if (input.paneId && this.panes.has(input.paneId)) {
      throw new Error("paneId already registered");
    }
    const now = new Date().toISOString();
    const label = input.label || path.basename(input.cwd) || "session";
    const pane: PaneRecord = {
      paneId: input.paneId || randomUUID(),
      claudeSessionId: null,
      cwd: input.cwd,
      label,
      pid: input.pid ?? null,
      status: "starting",
      lastEvent: "launcher:start",
      startedAt: now,
      updatedAt: now,
      ended: false,
    };
    this.panes.set(pane.paneId, pane);
    this.persist();
    return pane;
  }

  /** The one place a pane is marked dead, so every path (launcher end,
   * SessionEnd hook, stale sweep) leaves the record in the same shape. */
  private markEnded(pane: PaneRecord, lastEvent: string) {
    pane.status = "stopped";
    pane.ended = true;
    pane.lastEvent = lastEvent;
    pane.updatedAt = new Date().toISOString();
  }

  /**
   * Marks panes nothing has touched in STALE_PANE_MS as ended, then drops
   * ended records older than PANE_RETENTION_MS. Returns true if anything
   * changed (callers persist only then). Deliberately does not persist or
   * log by itself so it can be called from `list()` on every read.
   */
  private sweep(): boolean {
    const now = Date.now();
    let marked = 0;
    let dropped = 0;
    for (const pane of this.panes.values()) {
      const age = now - new Date(pane.updatedAt).getTime();
      if (!pane.ended) {
        if (age > STALE_PANE_MS) {
          this.markEnded(pane, "gc:stale");
          marked++;
        }
      } else if (age > PANE_RETENTION_MS) {
        this.panes.delete(pane.paneId);
        dropped++;
      }
    }
    if (marked || dropped) {
      console.error(`[state] gc: marked ${marked} stale, dropped ${dropped}`);
      return true;
    }
    return false;
  }

  /** Called by the myade launcher script after `claude` exits. */
  registerEnd(paneId: string): PaneRecord | null {
    const pane = this.panes.get(paneId);
    if (!pane) return null;
    this.markEnded(pane, "launcher:end");
    this.persist();
    return pane;
  }

  /**
   * Find the launcher-registered pane a hook event belongs to. We can't
   * pass our paneId through Claude Code's "http" hooks (they only send
   * Claude's own fixed JSON body), so we correlate by:
   *   1) an existing pane that already has this claudeSessionId, else
   *   2) a "starting" pane with the same cwd, registered recently
   *      (covers the normal case: launcher started it, SessionStart
   *      hook is the first event we see for it), else
   *   3) create a fresh ad-hoc pane (covers `claude` run without the
   *      launcher script, or hooks pointed at us from an unrelated
   *      project).
   */
  private resolvePaneForHook(input: HookCommonInput): PaneRecord {
    // Stable pane identity wins over cwd heuristics, including CLI restart
    // and /clear within the same terminal. Never guess when an explicit id
    // is supplied but registration failed.
    if (input.myadePaneId) {
      const pane = this.panes.get(input.myadePaneId);
      if (!pane) throw new Error("Unknown explicit myadePaneId; register the terminal first");
      if (input.hook_event_name !== "SessionStart" && pane.claudeSessionId &&
          pane.claudeSessionId !== input.session_id) {
        throw new Error("Hook belongs to a previous session in this terminal");
      }
      pane.ended = false;
      return pane;
    }
    for (const p of this.panes.values()) {
      if (p.claudeSessionId !== input.session_id) continue;
      // A session we'd already written off can legitimately come back
      // (`--resume`, or a hook arriving after the stale sweep marked the
      // pane dead). It's live again by definition - undo `ended` here or
      // the record would keep reporting a status pane_list won't show.
      p.ended = false;
      return p;
    }

    let best: PaneRecord | null = null;
    const now = Date.now();
    for (const p of this.panes.values()) {
      if (p.claudeSessionId) continue;
      if (p.status !== "starting") continue;
      if (p.cwd !== input.cwd) continue;
      const age = now - new Date(p.startedAt).getTime();
      if (age > PENDING_MATCH_WINDOW_MS) continue;
      if (!best || new Date(p.startedAt) > new Date(best.startedAt)) best = p;
    }
    if (best) return best;

    const nowIso = new Date().toISOString();
    const pane: PaneRecord = {
      paneId: randomUUID(),
      claudeSessionId: input.session_id,
      cwd: input.cwd,
      label: path.basename(input.cwd) || "session",
      pid: null,
      status: "starting",
      lastEvent: null,
      startedAt: nowIso,
      updatedAt: nowIso,
      ended: false,
    };
    this.panes.set(pane.paneId, pane);
    return pane;
  }

  onSessionStart(input: import("./types").SessionStartHookInput) {
    const pane = this.resolvePaneForHook(input);
    pane.claudeSessionId = input.session_id;
    pane.cwd = input.cwd;
    pane.status = "idle";
    pane.lastEvent = `SessionStart(${input.source ?? "unknown"})`;
    pane.updatedAt = new Date().toISOString();
    this.persist();
    return pane;
  }

  onStop(input: HookCommonInput) {
    const pane = this.resolvePaneForHook(input);
    pane.claudeSessionId = input.session_id;
    pane.status = "idle";
    pane.lastEvent = "Stop";
    pane.updatedAt = new Date().toISOString();
    this.persist();
    return pane;
  }

  onNotification(input: NotificationHookInput) {
    const pane = this.resolvePaneForHook(input);
    pane.claudeSessionId = input.session_id;
    const type = input.notification_type ?? "unknown";
    let status: PaneStatus = pane.status;
    if (type === "permission_prompt") status = "waiting_permission";
    else if (type === "idle_prompt") status = "idle";
    pane.status = status;
    pane.lastEvent = `Notification(${type})`;
    pane.updatedAt = new Date().toISOString();
    this.persist();
    return pane;
  }

  /**
   * SessionEnd fires exactly once when a session really ends. Until this
   * existed, a `claude` that exited normally left its pane sitting at
   * `idle`/`ended: false` forever - the single biggest source of the
   * corpses that used to flood pane_list.
   *
   * Note this ends the *pane record*, not just the session, including when
   * `reason` is "clear"/"resume" (where the terminal itself lives on). That
   * is intentional: the next session gets its own record via
   * resolvePaneForHook, and leaving this one open would just make it a
   * ghost that never gets closed by anything.
   */
  onSessionEnd(input: import("./types").SessionEndHookInput) {
    const pane = this.resolvePaneForHook(input);
    pane.claudeSessionId = input.session_id;
    this.markEnded(pane, `SessionEnd(${input.reason ?? "unknown"})`);
    this.persist();
    return pane;
  }

  list(): PaneRecord[] {
    if (this.sweep()) this.persist();
    return Array.from(this.panes.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /** Looks a pane up by paneId, claudeSessionId, exact label, or a cwd/label substring. */
  find(query: string): PaneRecord[] {
    const q = query.trim();
    if (!q) return this.list();
    const exact = this.list().filter(
      (p) => p.paneId === q || p.claudeSessionId === q || p.label === q
    );
    if (exact.length) return exact;
    const lower = q.toLowerCase();
    return this.list().filter(
      (p) => p.cwd.toLowerCase().includes(lower) || p.label.toLowerCase().includes(lower)
    );
  }
}
