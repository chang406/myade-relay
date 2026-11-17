#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startServer } from "./server.js";
import { runAdapter } from "./adapter.js";
import { requestJson } from "./http-client.js";
import { provider } from "./sessions.js";
import { launch } from "./launch.js";
import { runDoctor } from "./doctor.js";

function args(values: string[]): { _: string[]; [key: string]: string | string[] | boolean } {
  const parsed: { _: string[]; [key: string]: string | string[] | boolean } = { _: [] };
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!value.startsWith("--")) { parsed._.push(value); continue; }
    const key = value.slice(2); const next = values[i + 1];
    parsed[key] = !next || next.startsWith("--") ? true : (i++, next);
  }
  return parsed;
}
const value = (input: ReturnType<typeof args>, key: string, fallback?: string): string => {
  const found = input[key] ?? fallback;
  if (typeof found !== "string") throw new Error(`--${key} is required`);
  return found;
};

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv; const input = args(rest);
  const base = value(input, "base", process.env.RELAY_BASE ?? "http://127.0.0.1:4318");
  if (command === "serve") {
    const dataDir = value(input, "data-dir", process.env.RELAY_DATA_DIR ?? path.join(os.homedir(), ".myade-relay"));
    const server = await startServer({ port: Number(value(input, "port", process.env.RELAY_PORT ?? "4318")), dataDir });
    console.error(`[relay] listening on ${server.base}`); console.error(`[relay] data: ${dataDir}`);
    return;
  }
  if (command === "register") {
    const record = await requestJson(base, "/api/sessions", { method: "POST", body: JSON.stringify({
      id: typeof input.id === "string" ? input.id : undefined, provider: provider(value(input, "provider")),
      providerSessionId: typeof input.thread === "string" ? input.thread : undefined,
      cwd: value(input, "cwd", process.cwd()), label: typeof input.label === "string" ? input.label : undefined,
      delivery: typeof input.delivery === "string" ? input.delivery : undefined,
      deliveryCommand: typeof input.binary === "string" ? input.binary : undefined,
      deliveryRemote: typeof input.remote === "string" ? input.remote : undefined,
    }) });
    console.log(JSON.stringify(record, null, 2)); return;
  }
  if (command === "sessions") { console.log(JSON.stringify(await requestJson(base, "/api/sessions"), null, 2)); return; }
  if (command === "requests") { console.log(JSON.stringify(await requestJson(base, `/api/exchanges?sessionId=${encodeURIComponent(value(input, "session"))}`), null, 2)); return; }
  if (command === "retry") {
    const direction = value(input, "direction");
    if (direction !== "request" && direction !== "answer") throw new Error("--direction must be request or answer");
    const record = await requestJson(base, `/api/exchanges/${encodeURIComponent(value(input, "request"))}/retry`, {
      method: "POST", body: JSON.stringify({ sessionId: value(input, "session"), direction }),
    });
    console.log(JSON.stringify(record, null, 2)); return;
  }
  if (command === "doctor") {
    const report = await runDoctor({ base,
      claudeBinary: value(input, "claude", "claude"), codexBinary: value(input, "codex", "codex"),
      dataDir: value(input, "data-dir", process.env.RELAY_DATA_DIR ?? path.join(os.homedir(), ".myade-relay")),
      runtimeDir: value(input, "runtime-dir", path.join(process.cwd(), ".relay", "runtime")),
      sessionId: typeof input.session === "string" ? input.session : undefined,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "adapter") { await runAdapter(base, value(input, "session"), input.channel === true); return; }
  if (command === "launch") {
    const selected = provider(value(input, "provider"));
    const entry = path.resolve(process.argv[1]);
    process.exitCode = await launch({ provider: selected, id: value(input, "id"), base,
      cwd: value(input, "cwd", process.cwd()), binary: value(input, "binary", selected),
      runtimeDir: value(input, "runtime-dir", path.join(process.cwd(), ".relay", "runtime")),
      thread: typeof input.thread === "string" ? input.thread : undefined,
      extraArgs: input._.slice(0),
    }, entry);
    return;
  }
  console.error("Usage:\n  myade-relay serve [--port 4318] [--data-dir PATH]\n  myade-relay launch --provider claude|codex --id ID [--thread CODEX_THREAD] [--binary PATH] [--cwd PATH]\n    Codex launch creates a new thread through app-server when --thread is omitted.\n  myade-relay register --provider claude|codex [--id ID] [--thread CODEX_THREAD] [--cwd PATH]\n  myade-relay sessions\n  myade-relay requests --session ID\n  myade-relay retry --session ID --request REQUEST_ID --direction request|answer\n  myade-relay doctor [--claude PATH] [--codex PATH] [--session ID] [--data-dir PATH] [--runtime-dir PATH]\n  myade-relay adapter --session ID [--channel]");
  process.exitCode = command ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
