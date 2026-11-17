import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { requestJson } from "./http-client.js";
import type { RelaySession } from "./types.js";

export type DoctorStatus = "pass" | "warn" | "fail";
export interface DoctorCheck { name: string; status: DoctorStatus; detail: string }
export interface DoctorReport { ok: boolean; checks: DoctorCheck[] }
export interface DoctorOptions {
  base: string;
  claudeBinary: string;
  codexBinary: string;
  dataDir: string;
  runtimeDir: string;
  sessionId?: string;
}

type CommandResult = { ok: boolean; output: string };
type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
type JsonRequester = <T>(base: string, pathname: string) => Promise<T>;

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (ok: boolean, detail?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: (output || detail || "no output").trim() });
    };
    const capture = (chunk: unknown): void => { output = (output + String(chunk)).slice(-262_144); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", error => finish(false, String(error)));
    child.once("close", code => finish(code === 0, output || `exit code ${code ?? "unknown"}`));
    const timer = setTimeout(() => { child.kill(); finish(false, "timed out after 5 seconds"); }, 5_000);
  });
}

function writableCheck(name: string, target: string): DoctorCheck {
  let candidate = path.resolve(target);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return { name, status: "fail", detail: `No existing parent for ${path.resolve(target)}` };
    candidate = parent;
  }
  try {
    if (!fs.statSync(candidate).isDirectory()) return { name, status: "fail", detail: `${candidate} is not a directory` };
    fs.accessSync(candidate, fs.constants.W_OK);
    return { name, status: "pass", detail: `${path.resolve(target)} (writable at ${candidate})` };
  } catch (error) {
    return { name, status: "fail", detail: String(error) };
  }
}

export async function runDoctor(options: DoctorOptions, dependencies: { run?: CommandRunner; request?: JsonRequester } = {}): Promise<DoctorReport> {
  const run = dependencies.run ?? runCommand;
  const request = dependencies.request ?? requestJson;
  const checks: DoctorCheck[] = [];
  let sessions: RelaySession[] | undefined;

  try {
    const health = await request<{ ok?: boolean }>(options.base, "/health");
    checks.push({ name: "relay-health", status: health.ok ? "pass" : "fail", detail: health.ok ? `${options.base}/health` : "Relay returned ok=false" });
  } catch (error) {
    checks.push({ name: "relay-health", status: "fail", detail: String(error) });
  }
  try {
    sessions = await request<RelaySession[]>(options.base, "/api/sessions");
  } catch (error) {
    checks.push({ name: "relay-sessions", status: "fail", detail: String(error) });
  }

  const claudeVersion = await run(options.claudeBinary, ["--version"]);
  checks.push({ name: "claude-version", status: claudeVersion.ok ? "pass" : "fail", detail: claudeVersion.output });
  const codexVersion = await run(options.codexBinary, ["--version"]);
  checks.push({ name: "codex-version", status: codexVersion.ok ? "pass" : "fail", detail: codexVersion.output });

  const codexQueue = await run(options.codexBinary, ["queue", "--help"]);
  checks.push({ name: "codex-queue", status: codexQueue.ok ? "pass" : "fail", detail: codexQueue.ok ? "queue subcommand is available" : codexQueue.output.slice(0, 4000) });
  const claudeHelp = await run(options.claudeBinary, ["--help"]);
  const visibleClaudeFlags = ["--mcp-config", "--strict-mcp-config"];
  const missingClaudeFlags = claudeHelp.ok ? visibleClaudeFlags.filter(flag => !claudeHelp.output.includes(flag)) : visibleClaudeFlags;
  let channelAvailable = claudeHelp.ok && claudeHelp.output.includes("--dangerously-load-development-channels");
  if (claudeHelp.ok && !channelAvailable) {
    const channelProbe = await run(options.claudeBinary, ["--dangerously-load-development-channels", "server:relay", "--help"]);
    channelAvailable = channelProbe.ok && !/unknown (option|argument)/i.test(channelProbe.output);
  }
  if (!channelAvailable) missingClaudeFlags.push("--dangerously-load-development-channels");
  checks.push({ name: "claude-channel-flags", status: claudeHelp.ok && missingClaudeFlags.length === 0 ? "pass" : "fail",
    detail: claudeHelp.ok ? (missingClaudeFlags.length ? `Missing or unsupported: ${missingClaudeFlags.join(", ")}` : "development Channel and MCP flags are available") : claudeHelp.output.slice(0, 4000) });

  checks.push(writableCheck("data-directory", options.dataDir));
  checks.push(writableCheck("runtime-directory", options.runtimeDir));

  if (sessions) {
    if (options.sessionId) {
      const duplicate = sessions.find(session => session.id === options.sessionId && session.status !== "ended");
      checks.push({ name: "session-id", status: duplicate ? "fail" : "pass", detail: duplicate ? `Active session already uses ${options.sessionId}` : `${options.sessionId} is available` });
    }
    const missingThreads = sessions.filter(session => session.provider === "codex" && session.status !== "ended" && !session.providerSessionId);
    checks.push({ name: "codex-thread-registration", status: missingThreads.length ? "warn" : "pass",
      detail: missingThreads.length ? `Active Codex sessions without a thread: ${missingThreads.map(session => session.id).join(", ")}` : "All active Codex sessions have a thread id" });
  }

  return { ok: !checks.some(check => check.status === "fail"), checks };
}
