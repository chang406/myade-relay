#!/usr/bin/env node
"use strict";

/**
 * Command-hook wrapper for SessionStart, registered in
 * claude-config/settings.snippet.json as `type: "command"`.
 *
 * Why this exists: Claude Code silently skips `type: "http"` hooks for the
 * SessionStart event specifically (confirmed via a debug log:
 * "Skipping HTTP hook ... HTTP hooks are not supported for SessionStart") -
 * every other event this project uses (Stop, Notification, SessionEnd)
 * accepts `type: "http"` directly. This script exists only to route around
 * that one gap: it reads the same hook JSON from stdin that an http hook
 * would receive as a POST body, forwards it to the SAME /hooks/session-start
 * endpoint server.ts already serves for consistency, and relays that
 * endpoint's response back out as this process's stdout - so all the actual
 * logic (persona.md lookup, pane registration, isSummaryInFlight recursion
 * guard) stays in server.ts, not duplicated here.
 *
 * Failure handling: command hooks on Windows can fail silently in ways http
 * hooks can't (wrong PATH resolving `node` to nothing, a `.cmd` shim eating
 * the process with no visible error, console codepage mangling stdout) -
 * exactly the class of bug already hit once with the SessionEnd/persona
 * subprocess (see persona.ts's cross-spawn comment). So every failure path
 * here writes a distinct, greppable line to stderr - which Claude Code
 * surfaces in `claude --debug` hook output - before falling back. The
 * fallback is always the same: exit 0 with empty stdout, i.e. the session
 * starts with no persona context injected, rather than blocking startup.
 * A missing/unreachable myade server should never be able to prevent
 * `claude` from starting.
 */

const http = require("http");

const PORT = process.env.MYADE_PORT || "4317";
const HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 3000;
const LOG_PREFIX = "[myade:session-start-hook]";

function fail(message) {
  // stderr only - never stdout, since Claude Code tries to JSON-parse
  // stdout on exit 0 and a stray error line there would corrupt that parse
  // for the WHOLE hook response, not just fail to add context.
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function postSessionStart(bodyText) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: "/hooks/session-start",
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(bodyText, "utf-8"),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, raw }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`)));
    req.end(bodyText, "utf-8");
  });
}

async function main() {
  const stdinText = await readStdin().catch((err) => {
    fail(`could not read hook input from stdin: ${err.message}`);
  });

  if (!stdinText || !stdinText.trim()) {
    // No stdin at all usually means this was invoked wrong (e.g. run by
    // hand without piping input) rather than a real SessionStart event.
    fail("received empty stdin (expected SessionStart hook JSON) - skipping");
    return;
  }

  let parsedInput;
  try {
    parsedInput = JSON.parse(stdinText);
  } catch (err) {
    fail(`stdin was not valid JSON, cannot forward: ${err.message}`);
    return;
  }

  // Not part of Claude Code's own hook JSON - this process's own env is the
  // only place this is visible. It's set on a myade-gui pane's shell (or the
  // companion's headless process) at spawn time and inherited down through
  // `claude` to this wrapper script, so its presence/absence here is exactly
  // "did this session start inside a myade-gui character pane."
  if (process.env.MYADE_CHARACTER_ID) {
    parsedInput.myadeCharacterId = process.env.MYADE_CHARACTER_ID;
  }
  if (process.env.MYADE_PANE_ID) {
    parsedInput.myadePaneId = process.env.MYADE_PANE_ID;
  }

  let result;
  try {
    result = await postSessionStart(JSON.stringify(parsedInput));
  } catch (err) {
    if (err.code === "ECONNREFUSED") {
      fail(
        `myade server is not reachable at http://${HOST}:${PORT} (ECONNREFUSED) - is it running? ` +
          `Continuing session with no persona context.`
      );
    } else {
      fail(`request to myade server failed: ${err.message}`);
    }
    return;
  }

  if (result.status !== 200) {
    fail(`myade server responded with HTTP ${result.status}: ${result.raw.slice(0, 300)}`);
    return;
  }

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(result.raw);
  } catch (err) {
    fail(`myade server response was not valid JSON: ${err.message} - raw: ${result.raw.slice(0, 300)}`);
    return;
  }

  // Re-serialize (rather than piping result.raw through verbatim) so a
  // malformed-but-JSON-parseable response can't smuggle stray bytes past us.
  process.stdout.write(Buffer.from(JSON.stringify(parsedResponse), "utf-8"));
  process.exit(0);
}

main().catch((err) => {
  fail(`unexpected error: ${err && err.stack ? err.stack : err}`);
});
