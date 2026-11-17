#!/usr/bin/env node
"use strict";

/**
 * Helper used by myade.bat / myade.sh. Not meant to be run by hand
 * (though `node register.js start` / `node register.js end <paneId>`
 * work fine standalone for debugging).
 *
 * `start`:
 *   1. Checks whether the myade server is already running
 *      (GET /health). If not, spawns it detached (so it keeps running
 *      after this script and the launcher script exit) and waits up
 *      to ~8s for it to come up.
 *   2. POSTs /sessions/start with the current working directory, the
 *      parent process's pid, and an optional MYADE_LABEL env var.
 *   3. Prints the returned paneId to stdout (and ONLY that, so batch/
 *      shell scripts can capture it with backticks / `for /f`).
 *
 * `end <paneId>`:
 *   POSTs /sessions/end. Safe to call even if the server is gone.
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = process.env.MYADE_PORT || "4317";
const HOST = "127.0.0.1";
const ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(ROOT, "dist", "server.js");
const LOG_FILE = path.join(ROOT, "data", "server.log");

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: urlPath,
        method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
        timeout: 3000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode, body: null });
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(data);
    req.end();
  });
}

async function isHealthy() {
  try {
    const r = await request("GET", "/health");
    return r.status === 200;
  } catch {
    return false;
  }
}

function startServerDetached() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    process.stderr.write(
      `[myade] cannot find ${SERVER_ENTRY} - did you run "npm install && npm run build" in ${ROOT}?\n`
    );
    return;
  }
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  const err = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
}

async function ensureServer() {
  if (await isHealthy()) return;
  process.stderr.write("[myade] server not responding, starting it...\n");
  startServerDetached();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (await isHealthy()) {
      process.stderr.write("[myade] server is up.\n");
      return;
    }
  }
  process.stderr.write(
    "[myade] WARNING: server still not responding after 8s - continuing anyway. Check " +
      LOG_FILE +
      "\n"
  );
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === "start") {
    await ensureServer();
    const cwd = process.cwd();
    const label = process.env.MYADE_LABEL || path.basename(cwd) || "session";
    const pid = process.ppid || null;
    try {
      const r = await request("POST", "/sessions/start", { cwd, pid, label });
      if (r.status === 200 && r.body && r.body.paneId) {
        process.stdout.write(r.body.paneId + "\n");
      } else {
        process.stderr.write("[myade] failed to register session start: " + JSON.stringify(r) + "\n");
      }
    } catch (e) {
      process.stderr.write("[myade] could not reach myade server to register session: " + e.message + "\n");
    }
    return;
  }

  if (cmd === "end") {
    const paneId = rest[0];
    if (!paneId) return;
    try {
      await request("POST", "/sessions/end", { paneId });
    } catch {
      // server may already be gone by the time claude exits - nothing to clean up
    }
    return;
  }

  process.stderr.write("usage: register.js start | register.js end <paneId>\n");
  process.exitCode = 1;
}

main();
