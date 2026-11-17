/**
 * File-based "fake memory" for myade: each myade-gui roster character gets
 * its own file, ~/.myade/persona-<characterId>.md (see personaPath()),
 * deliberately outside this repo so it survives the repo being moved/
 * reinstalled. It accumulates short notes about the user's tone/
 * communication preferences with that specific character across sessions.
 *
 * There used to also be a single common ~/.myade/persona.md, shared by
 * every character and by plain (non-myade-gui) sessions, back when this
 * project still supported working outside myade-gui panes. It was removed
 * once myade-gui became the only supported way to run sessions here, every
 * pane/companion session always carries a character, and there was nothing
 * left that legitimately needed a character-less persona file - see
 * git history / CLAUDE.md if you need the "why a common file used to
 * exist and why it was actively harmful" background (it doubled as both
 * "how the user likes to be talked to in general" and "what character am I
 * right now," which let a per-session roleplay instruction like "you're
 * Rho now" get recorded as if it were a permanent global preference and
 * leak into every *other* character's sessions).
 *
 * Every session that reaches server.ts's hook handlers is now expected to
 * carry a `myadeCharacterId` (see server.ts's SessionStart handler and
 * characters.ts). personaPath() throws if it's missing, and readPersona()/
 * appendPersonaLine() catch that and log loudly rather than silently
 * falling back to anything - there is no more "anything" to fall back to,
 * so a missing characterId at this point means the pane/companion wiring
 * itself is broken and should be investigated, not quietly worked around.
 *
 * Flow:
 *  - SessionStart hook -> server.ts reads this character's persona file and
 *    injects it as additionalContext (see readPersona()).
 *  - SessionEnd hook (fires once per session, unlike per-turn Stop) ->
 *    onSessionEnd() headlessly resumes that exact session with `claude -p
 *    --resume --fork-session`, asks it to reflect on its own conversation,
 *    and appends a one-line takeaway (to the same file readPersona() would
 *    have used for this session) unless it answers SKIP. server.ts looks
 *    up which character this session_id belongs to via
 *    recordSessionCharacter()/takeSessionCharacter() below, since the
 *    SessionEnd hook payload itself carries no character information (it's
 *    a plain `type: "http"` hook Claude Code posts directly - unlike
 *    SessionStart, there's no wrapper script of ours in that path to read
 *    MYADE_CHARACTER_ID from its own env and attach it).
 *
 * --resume resolves sessions by project directory, so the subprocess MUST
 * run with cwd = the original session's real project dir (input.cwd), not
 * some directory of our own choosing - otherwise it fails outright with
 * "No conversation found". --fork-session is what actually makes this
 * safe to run headlessly at all: it makes the resumed turn write to a
 * brand-new session id/file, leaving the original transcript untouched on
 * disk even if this subprocess is hard-killed mid-run (verified manually:
 * SIGKILL mid-generation left the original .jsonl's hash unchanged).
 *
 * Because the subprocess now legitimately shares cwd with the original
 * session (and any of *its* real siblings in the same project directory),
 * we can no longer tell our own hook traffic apart by cwd alone. Instead,
 * inFlightDirs tracks "a summarizer subprocess is currently running for
 * this project directory" for the exact lifetime of the spawn; hook
 * handlers in server.ts check isSummaryInFlight() and no-op while it's
 * set. This is what breaks the recursion (the forked session is itself a
 * full `claude` run, so it fires SessionStart/SessionEnd back at us) and
 * keeps ephemeral summarizer panes out of pane_list. It's a narrow race
 * window (a few seconds) rather than a hard guarantee - a second real
 * session in the same directory ending at that exact moment would have
 * that one hook silently skipped - which is an acceptable tradeoff for a
 * personal single-user tool given the alternative (writing into the
 * user's real session files) is what caused actual data loss.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
// Plain child_process.spawn can't exec a bare "claude" on Windows (the npm
// global install is a claude.cmd shim; Node's non-shell spawn throws
// ENOENT/EINVAL for it), and the naive fix (`shell: true`) would pass the
// prompt argument - which embeds accumulated persona file content - through
// cmd.exe's parser unescaped, an injection risk. cross-spawn resolves the
// shim and quotes arguments safely for cmd.exe instead.
import spawn from "cross-spawn";

const PERSONA_DIR = path.join(os.homedir(), ".myade");

// Roster ids are filename stems Rust already derived from real files in
// ~/.myade/characters/ (see characters.rs::list_roster), so in practice
// they're always filesystem-safe - this is defense in depth against a
// stray/crafted MYADE_CHARACTER_ID env value being used to build a path.
const SAFE_CHARACTER_ID = /^[A-Za-z0-9_-]+$/;

/** Path to the persona file for `characterId`. Throws if `characterId` is
 * missing or not a safe filename fragment - there is no character-less
 * fallback file anymore (see this file's header), so callers must catch
 * and log rather than let this pass through silently. */
function personaPath(characterId: string | undefined): string {
  if (!characterId || !SAFE_CHARACTER_ID.test(characterId)) {
    throw new Error(
      `expected a valid characterId, got ${JSON.stringify(characterId)} - every session is expected to carry MYADE_CHARACTER_ID now that there is no common persona.md fallback (check server.ts's SessionStart handler / the pane's env)`
    );
  }
  return path.join(PERSONA_DIR, `persona-${characterId}.md`);
}

// No tool use is wanted for the summary call - it should only read the
// resumed conversation and answer in plain text. Blocking these outright
// avoids it ever stalling on a headless permission prompt.
const SUMMARY_DISALLOWED_TOOLS =
  "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,NotebookEdit,Task,TodoWrite";
const SUMMARY_TIMEOUT_MS = 60_000;
// buildSummaryPrompt() asks for one short Korean sentence; this is a code-
// level backstop for when the model doesn't comply (see onSessionEnd).
const MAX_SUMMARY_LINE_LENGTH = 150;

function normalize(p: string): string {
  return path.resolve(p).toLowerCase();
}

// Ref-counted (not boolean) so two summarizer subprocesses ending in the
// same project directory around the same time don't clear each other's
// entry early.
const inFlightDirs = new Map<string, number>();

function markSummaryInFlight(cwd: string): void {
  const key = normalize(cwd);
  inFlightDirs.set(key, (inFlightDirs.get(key) ?? 0) + 1);
}

function clearSummaryInFlight(cwd: string): void {
  const key = normalize(cwd);
  const next = (inFlightDirs.get(key) ?? 1) - 1;
  if (next <= 0) inFlightDirs.delete(key);
  else inFlightDirs.set(key, next);
}

export function isSummaryInFlight(cwd: string | undefined | null): boolean {
  if (!cwd) return false;
  return inFlightDirs.has(normalize(cwd));
}

/** Full contents of `characterId`'s persona file, or undefined if missing/
 * empty - also undefined (after logging) if `characterId` itself is
 * missing/invalid, since that should never happen but must not crash the
 * SessionStart hook response if it somehow does. */
export function readPersona(characterId?: string): string | undefined {
  let filePath: string;
  try {
    filePath = personaPath(characterId);
  } catch (err) {
    console.error("[persona] readPersona:", err instanceof Error ? err.message : err);
    return undefined;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    return raw.length ? raw : undefined;
  } catch {
    // File doesn't exist yet - normal for a character with no recorded
    // preferences so far, not worth logging.
    return undefined;
  }
}

function appendPersonaLine(line: string, characterId?: string): void {
  const clean = line.replace(/\s+/g, " ").trim();
  if (!clean) return;
  let filePath: string;
  try {
    filePath = personaPath(characterId);
  } catch (err) {
    console.error(
      "[persona] appendPersonaLine:",
      err instanceof Error ? err.message : err,
      "- discarding line instead of writing it nowhere useful:",
      clean
    );
    return;
  }
  fs.mkdirSync(PERSONA_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(filePath, `- ${date}: ${clean}\n`, "utf-8");
  console.error(`[persona] appended (${characterId}): ${clean}`);
}

// session_id -> characterId, populated by server.ts's SessionStart handler
// (the only place MYADE_CHARACTER_ID is visible - see server.ts) so the
// SessionEnd handler, which gets no character info in its own hook payload,
// can still know which persona file this session's summary belongs to.
// Entries are removed once read (see takeSessionCharacter) - a session ends
// exactly once, so nothing should ever look this up twice for real.
const sessionCharacters = new Map<string, string>();

export function recordSessionCharacter(sessionId: string, characterId: string): void {
  sessionCharacters.set(sessionId, characterId);
}

export function takeSessionCharacter(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const characterId = sessionCharacters.get(sessionId);
  sessionCharacters.delete(sessionId);
  return characterId;
}

function buildSummaryPrompt(existing: string | undefined): string {
  return [
    "지금까지의 이 대화(세션)를 돌아보고, 사용자의 말투/톤/커뮤니케이션 선호가 이번 세션에서 새로 드러났는지만 판단해줘.",
    "",
    "이미 기록된 선호:",
    existing ? existing : "(아직 없음)",
    "",
    "규칙:",
    "- 코드 스타일, 반복되는 실수, 작업 내용/주제는 기록 대상이 아니다. 오직 말투/톤/커뮤니케이션 선호만.",
    "- 이미 기록된 것과 같은 내용이거나, 이번 세션이 단순 질의응답이라 새로 배울 게 없으면 다른 말 없이 정확히 `SKIP` 한 단어만 출력해라.",
    "- 새로 배울 게 있다면, 한국어로 한 줄(1문장)만 출력해라. 설명, 인사, 따옴표, 마크다운 없이 그 한 줄만 출력해라.",
  ].join("\n");
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// The prompt goes over stdin rather than as a CLI arg. On Windows,
// cross-spawn ultimately hands the whole command line to cmd.exe /c, which
// parses it as text - a literal newline inside an argument value (our
// prompt is multi-line) truncates the line there, silently dropping
// --resume/--output-format/etc that come after it. stdin sidesteps that
// class of quoting/escaping issue entirely (and keeps persona file content,
// which flows into this prompt, out of any command-line parsing).
function spawnOnce(bin: string, args: string[], stdinText: string, cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), SUMMARY_TIMEOUT_MS);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end(stdinText);
  });
}

async function runClaude(args: string[], stdinText: string, cwd: string): Promise<string> {
  const res = await spawnOnce("claude", args, stdinText, cwd);
  if (res.code !== 0) {
    throw new Error(`claude exited with code ${res.code}: ${res.stderr.slice(0, 500)}`);
  }
  return res.stdout;
}

/**
 * Fire-and-forget: called from the SessionEnd hook handler. Never throws -
 * callers just log-and-forget, since this is best-effort and must not
 * affect the hook response (SessionEnd already can't block anyway).
 */
export async function onSessionEnd(
  input: { session_id?: string; cwd?: string },
  characterId?: string
): Promise<void> {
  if (!input.session_id || !input.cwd || isSummaryInFlight(input.cwd)) return;

  const args = [
    "-p",
    "--resume",
    input.session_id,
    "--fork-session",
    "--output-format",
    "json",
    "--disallowedTools",
    SUMMARY_DISALLOWED_TOOLS,
  ];

  markSummaryInFlight(input.cwd);
  let raw: string;
  try {
    raw = await runClaude(args, buildSummaryPrompt(readPersona(characterId)), input.cwd);
  } catch (err) {
    console.error("[persona] summary subprocess failed:", err);
    return;
  } finally {
    clearSummaryInFlight(input.cwd);
  }

  let resultText = "";
  try {
    const parsed = JSON.parse(raw);
    resultText = typeof parsed.result === "string" ? parsed.result : "";
  } catch {
    console.error("[persona] could not parse claude -p output as JSON, skipping");
    return;
  }

  const trimmed = resultText.trim();
  if (!trimmed || /^skip\.?$/i.test(trimmed)) return;

  // buildSummaryPrompt() *asks* for a single short line with no preamble,
  // but the resumed model doesn't always comply (e.g. it can pick up a
  // chattier tone from earlier in that session's own history and answer
  // conversationally, sometimes even trailing off into "...SKIP" after a
  // paragraph of explanation - which the exact-match check above won't
  // catch). Never trust that formatting instruction alone: anything that
  // isn't a single short line is discarded rather than appended, since
  // this file gets re-injected as context into every future session and
  // a malformed entry compounds forever otherwise.
  if (trimmed.includes("\n") || trimmed.length > MAX_SUMMARY_LINE_LENGTH) {
    console.error(
      `[persona] summary response didn't follow the one-line format (${trimmed.length} chars) - discarding instead of appending: ${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}`
    );
    return;
  }

  appendPersonaLine(trimmed, characterId);
}
