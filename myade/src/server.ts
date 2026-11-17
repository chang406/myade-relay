import express from "express";
import * as path from "path";
import { z } from "zod";
import { ExchangeStore } from "./exchanges";
import { registerExchangeTools } from "./exchange-tools";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SessionStore } from "./state";
import { registerTools } from "./tools";
import {
  readPersona,
  isSummaryInFlight,
  onSessionEnd,
  recordSessionCharacter,
  takeSessionCharacter,
} from "./persona";
import { readCharacter } from "./characters";
import type {
  RegisterStartInput,
  RegisterEndInput,
  SessionStartHookInput,
  HookCommonInput,
  NotificationHookInput,
  SessionEndHookInput,
} from "./types";

const PORT = Number(process.env.MYADE_PORT || 4317);
const HOST = "127.0.0.1";

const store = new SessionStore();
const exchanges = new ExchangeStore(store, path.join(process.env.MYADE_DATA_DIR || path.join(__dirname, "..", "data"), "exchanges.json"));

const app = express();
app.use(express.json());
const hookSchema = z.object({
  session_id: z.string().min(1), cwd: z.string().min(1), hook_event_name: z.string().min(1),
  myadePaneId: z.string().min(1).max(128).optional(),
}).passthrough();
app.use("/hooks", (req, res, next) => {
  if (!hookSchema.safeParse(req.body).success) {
    res.status(400).json({ ok: false, error: "Invalid hook payload" });
    return;
  }
  next();
});

// ---------------------------------------------------------------------
// MCP endpoint (stateless Streamable HTTP transport). A fresh McpServer +
// transport pair is created per request; all of them share the same
// SessionStore, which is what actually holds cross-session state. This
// is what every `claude` process (in every terminal) connects to via
// `claude mcp add --transport http`.
// ---------------------------------------------------------------------
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "myade", version: "0.1.0" });
  registerTools(server, store);
  registerExchangeTools(server, exchanges);
  return server;
}

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server has no SSE stream)." },
    id: null,
  });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

// ---------------------------------------------------------------------
// Hook endpoints - Claude Code's `type: "http"` hooks POST their event
// JSON straight here, no wrapper script involved for Stop/Notification/
// SessionEnd. SessionStart is the one exception: Claude Code's client
// silently skips `type: "http"` hooks for that event specifically ("HTTP
// hooks are not supported for SessionStart", confirmed via debug log), so
// settings.snippet.json instead registers scripts/session-start-hook.js
// as a `type: "command"` hook that reads the same JSON from stdin and
// POSTs it here itself. This endpoint's contract (request/response shape)
// is unchanged either way.
// ---------------------------------------------------------------------
app.post("/hooks/session-start", (req: Request, res: Response) => {
  const input = req.body as SessionStartHookInput;
  // The background persona-summary subprocess (persona.ts) is itself a
  // `claude` invocation running in the SAME project directory as the
  // session it's summarizing (--resume requires that), so it fires this
  // same hook back at us while it's running. isSummaryInFlight() is true
  // for that directory only for the subprocess's lifetime - skip it so it
  // doesn't show up as a pane and doesn't get persona.md re-injected into
  // itself.
  if (isSummaryInFlight(input?.cwd)) {
    res.json({ ok: true });
    return;
  }
  const pane = store.onSessionStart(input);
  // Every session that reaches here is expected to be a myade-gui pane or
  // companion session and therefore carry myadeCharacterId - there is no
  // longer a common, character-less persona file to fall back to (see
  // persona.ts's file header). recordSessionCharacter() remembers the
  // mapping for this session_id so the SessionEnd handler below, whose hook
  // payload carries no character info of its own, knows which file to
  // append to. If myadeCharacterId is ever actually missing, readPersona()
  // logs it loudly itself rather than silently reading nothing.
  const characterId = input?.myadeCharacterId;
  if (characterId) {
    recordSessionCharacter(input.session_id, characterId);
  }
  const persona = characterId ? readPersona(characterId) : undefined;
  const character = characterId ? readCharacter(characterId) : undefined;
  const contextParts: string[] = [
    `[myade terminal] Your paneId is ${pane.paneId}. For cross-session questions use exchange_send/list/receive/reply/collect when requested. Queued requests do not automatically wake another CLI. Do not repeatedly poll or copy entire transcripts.`,
  ];
  if (character) {
    // Precedence note is defense in depth, not the primary fix - the real
    // fix is that persona (this character's own file) can no longer
    // contain another character's identity at all.
    contextParts.push(
      `[이 세션의 캐릭터 정체성 - 아래 톤 선호와 충돌하면 이쪽을 우선한다]\n${character}`
    );
  }
  if (persona) {
    contextParts.push(`[이전 세션들에서 기록된 이 캐릭터의 말투/커뮤니케이션 선호]\n${persona}`);
  }
  const response: Record<string, unknown> = { ok: true, paneId: pane.paneId };
  if (contextParts.length > 0) {
    response.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext: contextParts.join("\n\n"),
    };
  }
  res.json(response);
});

app.post("/hooks/stop", (req: Request, res: Response) => {
  const input = req.body as HookCommonInput;
  if (isSummaryInFlight(input?.cwd)) {
    res.json({ ok: true });
    return;
  }
  const pane = store.onStop(input);
  res.json({ ok: true, paneId: pane.paneId });
});

app.post("/hooks/notification", (req: Request, res: Response) => {
  const input = req.body as NotificationHookInput;
  if (isSummaryInFlight(input?.cwd)) {
    res.json({ ok: true });
    return;
  }
  const pane = store.onNotification(input);
  res.json({ ok: true, paneId: pane.paneId });
});

// SessionEnd fires exactly once per session (unlike Stop, which fires
// after every turn) but can't block or inject context back - the session
// is already over by the time it arrives. So it's used purely to kick off
// the fire-and-forget persona summary in the background; the HTTP
// response goes back immediately regardless of how that turns out.
app.post("/hooks/session-end", (req: Request, res: Response) => {
  const input = req.body as SessionEndHookInput;
  // Same guard the other three hook handlers have (this one was missing
  // it): the persona summary subprocess fires SessionEnd at us too, and
  // without this it would end the pane belonging to the session it was
  // summarizing rather than being ignored.
  if (isSummaryInFlight(input?.cwd)) {
    res.json({ ok: true });
    return;
  }
  store.onSessionEnd(input);
  res.json({ ok: true });
  const characterId = takeSessionCharacter(input?.session_id);
  if (!characterId) return;
  onSessionEnd(input, characterId).catch((err) => {
    console.error("[persona] onSessionEnd failed:", err);
  });
});

// ---------------------------------------------------------------------
// Launcher registration endpoints - called by myade.bat / myade.sh.
// ---------------------------------------------------------------------
app.post("/sessions/start", (req: Request, res: Response) => {
  const input = req.body as RegisterStartInput;
  if (!z.object({ cwd: z.string().min(1), paneId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), label: z.string().optional(), pid: z.number().int().positive().optional() }).safeParse(input).success) {
    res.status(400).json({ ok: false, error: "cwd is required" });
    return;
  }
  if (input.paneId && store.list().some(p => p.paneId === input.paneId)) {
    res.status(409).json({ ok: false, error: "paneId already registered" });
    return;
  }
  const pane = store.registerStart(input);
  res.json({ ok: true, paneId: pane.paneId });
});

app.post("/sessions/end", (req: Request, res: Response) => {
  const input = req.body as RegisterEndInput;
  if (!input || !input.paneId) {
    res.status(400).json({ ok: false, error: "paneId is required" });
    return;
  }
  const pane = store.registerEnd(input.paneId);
  if (!pane) {
    res.status(404).json({ ok: false, error: "unknown paneId" });
    return;
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: process.uptime(), panes: store.list().length });
});

// Plain-JSON debug view of everything the server knows - handy for
// `curl http://127.0.0.1:4317/debug/panes` while testing without going
// through MCP at all.
app.get("/debug/panes", (_req: Request, res: Response) => {
  res.json(store.list());
});

app.use((error: Error, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error("[myade] request rejected:", error.message);
  res.status(400).json({ ok: false, error: error.message });
});

app.listen(PORT, HOST, () => {
  console.error(`[myade] server listening on http://${HOST}:${PORT}`);
  console.error(`[myade] MCP endpoint:   http://${HOST}:${PORT}/mcp`);
  console.error(`[myade] hooks:          http://${HOST}:${PORT}/hooks/{session-start,stop,notification,session-end}`);
});
