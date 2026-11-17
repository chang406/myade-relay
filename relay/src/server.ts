import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { SessionRegistry, registerSessionSchema } from "./sessions.js";
import { ExchangeStore, sendSchema } from "./exchanges.js";
import { DeliveryCoordinator } from "./delivery.js";

const updateSchema = z.object({ providerSessionId: z.string().trim().min(1).max(256).optional(), deliveryRemote: z.string().regex(/^ws:\/\/127\.0\.0\.1:\d+$/).nullable().optional(), status: z.enum(["starting", "idle", "busy", "waiting_permission", "ended"]).optional() });
const sessionBody = z.object({ sessionId: z.string().min(1) });
const direction = z.enum(["request", "answer"]);
const attemptBody = sessionBody.extend({ direction, transport: z.enum(["claude_channel", "codex_queue", "manual"]), outcome: z.enum(["sent", "failed"]), trigger: z.enum(["automatic", "explicit"]).default("automatic"), detail: z.string() });
const retryBody = sessionBody.extend({ direction });

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export interface RelayServer { base: string; close(): Promise<void>; sessions: SessionRegistry; exchanges: ExchangeStore; delivery: DeliveryCoordinator }

export async function startServer(options: { host?: string; port?: number; dataDir: string; codexBinary?: string; startDelivery?: boolean }): Promise<RelayServer> {
  const host = options.host ?? "127.0.0.1";
  const sessions = SessionRegistry.at(path.join(options.dataDir, "sessions.json"));
  const exchanges = ExchangeStore.at(sessions, path.join(options.dataDir, "exchanges.json"));
  const delivery = new DeliveryCoordinator(sessions, exchanges, options.codexBinary ?? process.env.RELAY_CODEX_BIN ?? "codex");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      const match = (pattern: RegExp) => url.pathname.match(pattern);
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, sessions: sessions.list().length });
      if (req.method === "GET" && url.pathname === "/api/sessions") return json(res, 200, sessions.list(url.searchParams.get("includeEnded") === "true"));
      if (req.method === "POST" && url.pathname === "/api/sessions") return json(res, 201, sessions.register(registerSessionSchema.parse(await body(req))));
      let route = match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === "PATCH" && route) return json(res, 200, sessions.update(decodeURIComponent(route[1]), updateSchema.parse(await body(req))));
      if (req.method === "DELETE" && route) return json(res, 200, sessions.end(decodeURIComponent(route[1])));
      if (req.method === "GET" && url.pathname === "/api/exchanges") return json(res, 200, exchanges.list(z.string().min(1).parse(url.searchParams.get("sessionId"))));
      if (req.method === "POST" && url.pathname === "/api/exchanges") {
        const input = z.object({ sourceSessionId: z.string().min(1) }).merge(sendSchema).parse(await body(req));
        return json(res, 201, exchanges.send(input.sourceSessionId, input));
      }
      if (req.method === "GET" && url.pathname === "/api/delivery/candidates") return json(res, 200, exchanges.candidates(z.string().min(1).parse(url.searchParams.get("sessionId"))));
      route = match(/^\/api\/exchanges\/([^/]+)\/(receive|reply|collect|cancel|attempt|retry)$/);
      if (req.method === "POST" && route) {
        const id = decodeURIComponent(route[1]); const action = route[2]; const raw = await body(req);
        if (action === "receive") { const v = sessionBody.parse(raw); return json(res, 200, exchanges.receive(id, v.sessionId)); }
        if (action === "reply") { const v = sessionBody.extend({ answer: z.string() }).parse(raw); return json(res, 200, exchanges.reply(id, v.sessionId, v.answer)); }
        if (action === "collect") { const v = sessionBody.parse(raw); return json(res, 200, exchanges.collect(id, v.sessionId)); }
        if (action === "cancel") { const v = sessionBody.parse(raw); return json(res, 200, exchanges.cancel(id, v.sessionId)); }
        if (action === "retry") { const v = retryBody.parse(raw); return json(res, 200, exchanges.requestRetry(id, v.sessionId, v.direction)); }
        const v = attemptBody.parse(raw); return json(res, 200, exchanges.recordAttempt(id, v.sessionId, v.direction, v.transport, v.outcome, v.detail, v.trigger));
      }
      json(res, 404, { error: "Not found" });
    } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 4318, host, resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay server did not bind a TCP port");
  if (options.startDelivery !== false) delivery.start();
  return {
    base: `http://${host}:${address.port}`, sessions, exchanges, delivery,
    close: async () => { delivery.stop(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
