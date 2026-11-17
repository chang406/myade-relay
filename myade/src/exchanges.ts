import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import type { SessionStore } from "./state";

export const exchangeInput = z.object({
  sourcePaneId: z.string().min(1).max(128),
  targetPaneId: z.string().min(1).max(128),
  question: z.string().trim().min(1).max(8000),
  context: z.string().max(24000).default(""),
  allowCrossWorkspace: z.boolean().default(false),
});
const recordSchema = exchangeInput.extend({
  id: z.string(), createdAt: z.string(), updatedAt: z.string(),
  sourceSessionId: z.string().nullable(), targetSessionId: z.string().nullable(),
  status: z.enum(["queued", "received", "answered", "collected", "cancelled"]),
  answer: z.string().max(24000).nullable(),
});
type Exchange = z.infer<typeof recordSchema>;
export type ExchangeInput = z.input<typeof exchangeInput>;

function workspace(cwd: string) {
  return process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
}

/** Trusted local single-user mailbox, not a per-client authorization boundary.
 * No model calls, terminal writes, transcript parsing, or arbitrary file reads.
 * Only this daemon writes the file; failed persistence never commits in memory.
 */
export class ExchangeStore {
  private records: Exchange[] = [];
  constructor(private readonly sessions: SessionStore, private readonly file: string) {
    try {
      this.records = z.array(recordSchema).parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private commit(records: Exchange[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(records, null, 2), "utf8");
      fs.renameSync(temporary, this.file);
      this.records = records;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private pane(id: string) {
    const pane = this.sessions.list().find(p => p.paneId === id && !p.ended);
    if (!pane) throw new Error("Unknown or ended pane; reconnect before exchanging requests");
    return pane;
  }

  private owned(id: string, paneId: string, side: "source" | "target") {
    const record = this.records.find(r => r.id === id);
    if (!record || record[`${side}PaneId`] !== paneId) throw new Error("Request does not belong to this pane");
    const pane = this.pane(paneId);
    if (record[`${side}SessionId`] !== pane.claudeSessionId) {
      throw new Error("Agent session changed; cancel and create a new request");
    }
    return record;
  }

  send(raw: ExchangeInput) {
    const input = exchangeInput.parse(raw);
    if (input.sourcePaneId === input.targetPaneId) throw new Error("Choose a different target pane");
    const source = this.pane(input.sourcePaneId);
    const target = this.pane(input.targetPaneId);
    if (!input.allowCrossWorkspace && workspace(source.cwd) !== workspace(target.cwd)) {
      throw new Error("Different workspaces; explicit allowCrossWorkspace is required");
    }
    if (this.records.length >= 1000) throw new Error("Mailbox capacity reached; archive records before sending more");
    const now = new Date().toISOString();
    const record: Exchange = {
      ...input, id: randomUUID(), createdAt: now, updatedAt: now,
      sourceSessionId: source.claudeSessionId, targetSessionId: target.claudeSessionId,
      status: "queued", answer: null,
    };
    this.commit([...this.records, record]);
    return { ...record };
  }

  list(paneId: string) {
    this.pane(paneId);
    const sessions = new Map(this.sessions.list().map(p => [p.paneId, p]));
    // Summary only: polling must not repeatedly put full context in the model.
    return this.records.filter(r => r.sourcePaneId === paneId || r.targetPaneId === paneId)
      .slice(-50).reverse().map(({ context, answer, question, ...r }) => ({
        ...r, question: question.slice(0, 240), hasAnswer: answer !== null,
        sessionChanged: r.sourceSessionId !== sessions.get(r.sourcePaneId)?.claudeSessionId ||
          r.targetSessionId !== sessions.get(r.targetPaneId)?.claudeSessionId,
      }));
  }

  receive(id: string, paneId: string) {
    const record = this.owned(id, paneId, "target");
    if (record.status !== "queued" && record.status !== "received") throw new Error("Request is no longer pending");
    return this.update(record, { status: "received" });
  }

  reply(id: string, paneId: string, answer: string) {
    const record = this.owned(id, paneId, "target");
    const text = z.string().trim().min(1).max(24000).parse(answer);
    if (record.status === "answered" && record.answer === text) return { ...record };
    if (record.status !== "received") throw new Error("Receive the request before replying; answers cannot be overwritten");
    return this.update(record, { status: "answered", answer: text });
  }

  collect(id: string, paneId: string) {
    const record = this.owned(id, paneId, "source");
    if (record.status !== "answered" && record.status !== "collected") throw new Error("No answer available");
    return this.update(record, { status: "collected" });
  }

  cancel(id: string, paneId: string) {
    // Source terminal may cancel even after its agent session was replaced.
    this.pane(paneId);
    const record = this.records.find(r => r.id === id && r.sourcePaneId === paneId);
    if (!record) throw new Error("Request does not belong to this pane");
    if (record.status === "collected") throw new Error("Already collected");
    return this.update(record, { status: "cancelled" });
  }

  private update(record: Exchange, patch: Partial<Exchange>) {
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
    this.commit(this.records.map(r => r.id === record.id ? next : r));
    return { ...next };
  }
}
