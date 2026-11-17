import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { requestJson } from "./http-client.js";
import type { Provider, RelaySession } from "./types.js";

export interface LaunchOptions {
  provider: Provider;
  id: string;
  base: string;
  cwd: string;
  binary: string;
  runtimeDir: string;
  thread?: string;
  remote?: string;
  extraArgs?: string[];
}

interface JsonRpcResponse {
  id?: number;
  result?: { thread?: { id?: string } };
  error?: { code?: number; message?: string };
}

interface CodexRemoteServer {
  remote: string;
  threadStarted: Promise<string>;
  close(): Promise<void>;
}

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port for Codex app-server");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function connectWebSocket(url: string, child: ReturnType<typeof spawn>, stderr: () => string, timeoutMs: number): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Codex app-server exited before accepting WebSocket connections (code ${child.exitCode})${stderr() ? `: ${stderr().trim()}` : ""}`);
    try {
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket connection timed out")), 1_000);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); }, { once: true });
      });
      return socket;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Codex app-server did not open ${url} within ${timeoutMs}ms${stderr() ? `: ${stderr().trim()}` : ""}`);
}

export async function startCodexRemoteServer(options: LaunchOptions, adapterEntry: string, timeoutMs = 60_000): Promise<CodexRemoteServer> {
  const port = await freeLoopbackPort();
  const remote = `ws://127.0.0.1:${port}`;
  const adapterArgs = [adapterEntry, "adapter", "--base", options.base, "--session", options.id];
  const configArgs = [
    "-c", `mcp_servers.relay.command=${JSON.stringify(process.execPath)}`,
    "-c", `mcp_servers.relay.args=${JSON.stringify(adapterArgs)}`,
  ];
  const child = spawn(options.binary, [...configArgs, "app-server", "--listen", remote], {
    cwd: options.cwd, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let errorText = "";
  const capture = (chunk: unknown): void => { errorText = (errorText + String(chunk)).slice(-4096); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let socket: WebSocket | undefined;
  const close = async (): Promise<void> => {
    socket?.close();
    if (child.exitCode === null) child.kill();
    await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
  };

  try {
    socket = await connectWebSocket(remote, child, () => errorText, Math.min(timeoutMs, 10_000));
    const response = (id: number): Promise<JsonRpcResponse> => new Promise((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); socket?.removeEventListener("message", onMessage); socket?.removeEventListener("close", onClose); };
      const onMessage = (event: MessageEvent): void => {
        try {
          const message = JSON.parse(String(event.data)) as JsonRpcResponse;
          if (message.id === id) { cleanup(); resolve(message); }
        } catch { /* Ignore unrelated notifications. */ }
      };
      const onClose = (): void => { cleanup(); reject(new Error(`Codex app-server WebSocket closed before response ${id}${errorText ? `: ${errorText.trim()}` : ""}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Codex app-server did not answer within ${timeoutMs}ms${errorText ? `: ${errorText.trim()}` : ""}`)); }, timeoutMs);
      socket?.addEventListener("message", onMessage);
      socket?.addEventListener("close", onClose, { once: true });
    });
    const initialized = response(1);
    socket.send(JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "myade-relay", title: "Relay", version: "0.1.0" }, capabilities: {} } }));
    const init = await initialized;
    if (init.error) throw new Error(`Codex app-server initialize failed: ${init.error.message ?? init.error.code ?? "unknown error"}`);
    socket.send(JSON.stringify({ method: "initialized" }));
    const threadStarted = new Promise<string>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); socket?.removeEventListener("message", onMessage); socket?.removeEventListener("close", onClose); };
      const onMessage = (event: MessageEvent): void => {
        try {
          const message = JSON.parse(String(event.data)) as { method?: string; params?: { thread?: { id?: string } } };
          const thread = message.method === "thread/started" ? message.params?.thread?.id : undefined;
          if (thread) { cleanup(); resolve(thread); }
        } catch { /* Ignore unrelated notifications. */ }
      };
      const onClose = (): void => { cleanup(); reject(new Error("Codex app-server closed before thread/started")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Codex app-server did not emit thread/started within ${timeoutMs}ms`)); }, timeoutMs);
      socket?.addEventListener("message", onMessage);
      socket?.addEventListener("close", onClose, { once: true });
    });
    return { remote, threadStarted, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function providerArgs(options: LaunchOptions, adapterEntry: string): { args: string[]; configFile?: string } {
  const adapterArgs = [adapterEntry, "adapter", "--base", options.base, "--session", options.id];
  if (options.provider === "claude") {
    adapterArgs.push("--channel");
    fs.mkdirSync(options.runtimeDir, { recursive: true });
    const configFile = path.join(options.runtimeDir, `${options.id}.claude-mcp.json`);
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { relay: { command: process.execPath, args: adapterArgs } } }, null, 2), "utf8");
    return { configFile, args: ["--strict-mcp-config", "--mcp-config", configFile, "--dangerously-load-development-channels", "server:relay", ...(options.extraArgs ?? [])] };
  }
  if (!options.thread && !options.remote) throw new Error("Codex launch requires a thread or remote app-server");
  if (!options.thread) return { args: [
    "-c", `mcp_servers.relay.command=${JSON.stringify(process.execPath)}`,
    "-c", `mcp_servers.relay.args=${JSON.stringify(adapterArgs)}`,
    ...(options.extraArgs ?? []), "--remote", options.remote!,
  ] };
  return { args: [
    "-c", `mcp_servers.relay.command=${JSON.stringify(process.execPath)}`,
    "-c", `mcp_servers.relay.args=${JSON.stringify(adapterArgs)}`,
    ...(options.extraArgs ?? []), "resume", ...(options.remote ? ["--remote", options.remote] : []), options.thread,
  ] };
}

export async function launch(options: LaunchOptions, adapterEntry: string): Promise<number> {
  const registered = await requestJson<RelaySession>(options.base, "/api/sessions", {
    method: "POST", body: JSON.stringify({ id: options.id, provider: options.provider, providerSessionId: options.thread,
      cwd: options.cwd, deliveryCommand: options.provider === "codex" ? options.binary : undefined }),
  });
  let remoteServer: CodexRemoteServer | undefined;
  try {
    let resolved = options;
    if (options.provider === "codex" && !options.thread) {
      remoteServer = await startCodexRemoteServer(options, adapterEntry);
      resolved = { ...options, remote: remoteServer.remote };
    }
    const invocation = providerArgs(resolved, adapterEntry);
    const env: NodeJS.ProcessEnv = { ...process.env, RELAY_BASE: options.base, RELAY_SESSION_ID: registered.id };
    delete env.MYADE_CHARACTER_ID;
    const child = spawn(options.binary, invocation.args, { cwd: options.cwd, env, shell: false, stdio: "inherit", windowsHide: true });
    if (remoteServer) {
      const thread = await remoteServer.threadStarted;
      await requestJson(options.base, `/api/sessions/${encodeURIComponent(registered.id)}`, {
        method: "PATCH", body: JSON.stringify({ providerSessionId: thread, deliveryRemote: remoteServer.remote }),
      });
      console.error(`[relay] registered Codex thread ${thread}`);
    }
    return await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
  } finally {
    await remoteServer?.close();
    await requestJson(options.base, `/api/sessions/${encodeURIComponent(registered.id)}`, { method: "DELETE" }).catch(error => console.error(`[relay] failed to end session: ${String(error)}`));
  }
}
