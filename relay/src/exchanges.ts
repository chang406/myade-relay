import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JsonFile } from "./json-file.js";
import type { DeliveryAttempt, DeliveryKind, Exchange } from "./types.js";
import { SessionRegistry } from "./sessions.js";

const attemptSchema = z.object({
  direction: z.enum(["request", "answer"]), transport: z.enum(["claude_channel", "codex_queue", "manual"]),
  outcome: z.enum(["sent", "failed"]), trigger: z.enum(["automatic", "explicit"]).default("automatic"), at: z.string(), detail: z.string(),
});
const exchangeSchema = z.object({
  id: z.string(), sourceSessionId: z.string(), targetSessionId: z.string(), question: z.string(), context: z.string(),
  status: z.enum(["queued", "delivery_attempted", "accepted", "replied", "delivered", "cancelled"]),
  answer: z.string().nullable(), attempts: z.array(attemptSchema),
  retryRequested: z.object({ request: z.boolean(), answer: z.boolean() }).default({ request: false, answer: false }),
  createdAt: z.string(), updatedAt: z.string(),
});
export const sendSchema = z.object({
  targetSessionId: z.string().min(1), question: z.string().trim().min(1).max(8000),
  context: z.string().max(24000).default(""), allowCrossWorkspace: z.boolean().default(false),
});
const normalized = (cwd: string) => process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);

export class ExchangeStore {
  private records: Exchange[];
  constructor(private readonly sessions: SessionRegistry, private readonly file: JsonFile<Exchange[]>) { this.records = file.read(); }
  static at(sessions: SessionRegistry, filename: string): ExchangeStore {
    return new ExchangeStore(sessions, new JsonFile<Exchange[]>(filename, z.array(exchangeSchema), []));
  }
  send(sourceSessionId: string, raw: z.input<typeof sendSchema>): Exchange {
    const input = sendSchema.parse(raw);
    if (sourceSessionId === input.targetSessionId) throw new Error("Choose another session");
    const source = this.sessions.require(sourceSessionId);
    const target = this.sessions.require(input.targetSessionId);
    if (!input.allowCrossWorkspace && normalized(source.cwd) !== normalized(target.cwd)) throw new Error("Different workspaces require allowCrossWorkspace=true");
    const now = new Date().toISOString();
    const record: Exchange = { id: randomUUID(), sourceSessionId, targetSessionId: target.id, question: input.question,
      context: input.context, status: "queued", answer: null, attempts: [], retryRequested: { request: false, answer: false }, createdAt: now, updatedAt: now };
    this.commit([...this.records, record]);
    return structuredClone(record);
  }
  list(sessionId: string): Array<Omit<Exchange, "context" | "answer"> & { question: string; hasAnswer: boolean }> {
    this.sessions.require(sessionId);
    return this.records.filter(r => r.sourceSessionId === sessionId || r.targetSessionId === sessionId).slice(-100).reverse()
      .map(({ context: _context, answer, ...r }) => ({ ...structuredClone(r), question: r.question.slice(0, 240), hasAnswer: answer !== null }));
  }
  receive(id: string, targetSessionId: string): Exchange {
    const record = this.owned(id, targetSessionId, "target");
    if (!["queued", "delivery_attempted", "accepted"].includes(record.status)) throw new Error("Request is no longer pending");
    return record.status === "accepted" ? structuredClone(record) : this.update(record, { status: "accepted", retryRequested: { ...record.retryRequested, request: false } });
  }
  reply(id: string, targetSessionId: string, answer: string): Exchange {
    const record = this.owned(id, targetSessionId, "target");
    const text = z.string().trim().min(1).max(24000).parse(answer);
    if (record.status === "replied" && record.answer === text) return structuredClone(record);
    if (record.status !== "accepted") throw new Error("Accept the request before replying");
    return this.update(record, { status: "replied", answer: text, retryRequested: { ...record.retryRequested, request: false } });
  }
  collect(id: string, sourceSessionId: string): Exchange {
    const record = this.owned(id, sourceSessionId, "source");
    if (!["replied", "delivered"].includes(record.status)) throw new Error("No answer is available");
    return record.status === "delivered" ? structuredClone(record) : this.update(record, { status: "delivered", retryRequested: { ...record.retryRequested, answer: false } });
  }
  cancel(id: string, sourceSessionId: string): Exchange {
    const record = this.owned(id, sourceSessionId, "source");
    if (record.status === "delivered") throw new Error("The answer was already delivered");
    return this.update(record, { status: "cancelled", retryRequested: { request: false, answer: false } });
  }
  candidates(sessionId: string): Exchange[] {
    this.sessions.require(sessionId);
    return this.records.filter(r => (r.targetSessionId === sessionId && (r.status === "queued" ||
      (r.status === "delivery_attempted" && r.retryRequested.request))) ||
      (r.sourceSessionId === sessionId && r.status === "replied" && (!this.wasSent(r, "answer") || r.retryRequested.answer))).map(r => structuredClone(r));
  }
  requestRetry(id: string, sessionId: string, direction: "request" | "answer"): Exchange {
    const side = direction === "request" ? "source" : "target";
    const record = this.owned(id, sessionId, side);
    if (direction === "request" && !["queued", "delivery_attempted"].includes(record.status)) throw new Error("The request was already accepted or completed");
    if (direction === "answer" && record.status !== "replied") throw new Error("The answer is not awaiting collection");
    if (!record.attempts.some(attempt => attempt.direction === direction)) throw new Error("No delivery attempt is available to retry");
    if (record.retryRequested[direction]) return structuredClone(record);
    return this.update(record, { retryRequested: { ...record.retryRequested, [direction]: true } });
  }
  recordAttempt(id: string, sessionId: string, direction: "request" | "answer", transport: DeliveryKind, outcome: "sent" | "failed", detail: string, trigger: "automatic" | "explicit" = "automatic"): Exchange {
    const side = direction === "request" ? "target" : "source";
    const record = this.owned(id, sessionId, side);
    const attempt: DeliveryAttempt = { direction, transport, outcome, trigger, detail: detail.slice(0, 1000), at: new Date().toISOString() };
    const status = direction === "request" && outcome === "sent" && record.status === "queued" ? "delivery_attempted" : record.status;
    return this.update(record, { status, attempts: [...record.attempts, attempt], retryRequested: { ...record.retryRequested, [direction]: false } });
  }
  wasSent(record: Exchange, direction: "request" | "answer"): boolean {
    return record.attempts.some(a => a.direction === direction && a.outcome === "sent");
  }
  all(): Exchange[] { return this.records.map(r => structuredClone(r)); }
  private owned(id: string, sessionId: string, side: "source" | "target"): Exchange {
    this.sessions.require(sessionId);
    const record = this.records.find(r => r.id === id && (side === "source" ? r.sourceSessionId : r.targetSessionId) === sessionId);
    if (!record) throw new Error("Request does not belong to this session");
    return record;
  }
  private update(record: Exchange, patch: Partial<Exchange>): Exchange {
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
    this.commit(this.records.map(r => r.id === record.id ? next : r));
    return structuredClone(next);
  }
  private commit(records: Exchange[]): void { this.file.write(records); this.records = records; }
}
