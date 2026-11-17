import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JsonFile } from "./json-file.js";
import type { DeliveryKind, Provider, RelaySession, SessionStatus } from "./types.js";

const sessionSchema = z.object({
  id: z.string().min(1), provider: z.enum(["claude", "codex"]), providerSessionId: z.string().min(1).nullable(),
  cwd: z.string().min(1), label: z.string().min(1), delivery: z.enum(["claude_channel", "codex_queue", "manual"]),
  deliveryCommand: z.string().min(1).nullable().default(null),
  deliveryRemote: z.string().regex(/^ws:\/\/127\.0\.0\.1:\d+$/).nullable().default(null),
  status: z.enum(["starting", "idle", "busy", "waiting_permission", "ended"]),
  startedAt: z.string(), updatedAt: z.string(), endedAt: z.string().nullable(),
});

export const registerSessionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), provider: z.enum(["claude", "codex"]),
  providerSessionId: z.string().trim().min(1).max(256).nullable().optional(), cwd: z.string().trim().min(1),
  label: z.string().trim().min(1).max(128).optional(), delivery: z.enum(["claude_channel", "codex_queue", "manual"]).optional(),
  deliveryCommand: z.string().trim().min(1).max(2048).nullable().optional(),
  deliveryRemote: z.string().regex(/^ws:\/\/127\.0\.0\.1:\d+$/).nullable().optional(),
});

export class SessionRegistry {
  private records: RelaySession[];
  constructor(private readonly file: JsonFile<RelaySession[]>) { this.records = file.read(); }
  static at(filename: string): SessionRegistry { return new SessionRegistry(new JsonFile(filename, z.array(sessionSchema), [])); }

  register(raw: z.input<typeof registerSessionSchema>): RelaySession {
    const input = registerSessionSchema.parse(raw);
    if (input.id && this.records.some(r => r.id === input.id && r.status !== "ended")) throw new Error("An active session already uses this id");
    if (input.providerSessionId && this.records.some(r => r.provider === input.provider && r.providerSessionId === input.providerSessionId && r.status !== "ended")) {
      throw new Error("This provider session is already registered");
    }
    const now = new Date().toISOString();
    const resolved = path.resolve(input.cwd);
    const delivery: DeliveryKind = input.delivery ?? (input.provider === "claude" ? "claude_channel" : "codex_queue");
    const record: RelaySession = {
      id: input.id ?? randomUUID(), provider: input.provider, providerSessionId: input.providerSessionId ?? null,
      cwd: resolved, label: input.label ?? (path.basename(resolved) || input.provider), delivery,
      deliveryCommand: input.deliveryCommand ?? null,
      deliveryRemote: input.deliveryRemote ?? null,
      status: "starting", startedAt: now, updatedAt: now, endedAt: null,
    };
    this.commit([...this.records.filter(r => r.id !== record.id), record]);
    return structuredClone(record);
  }

  update(id: string, patch: { providerSessionId?: string; deliveryRemote?: string | null; status?: SessionStatus }): RelaySession {
    const record = this.require(id, true);
    if (patch.providerSessionId && this.records.some(r => r.id !== id && r.provider === record.provider && r.providerSessionId === patch.providerSessionId && r.status !== "ended")) {
      throw new Error("This provider session is already registered");
    }
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
    if (patch.status === "ended") next.endedAt = next.updatedAt;
    this.commit(this.records.map(r => r.id === id ? next : r));
    return structuredClone(next);
  }

  end(id: string): RelaySession { return this.update(id, { status: "ended" }); }
  list(includeEnded = false): RelaySession[] {
    return this.records.filter(r => includeEnded || r.status !== "ended").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(r => structuredClone(r));
  }
  require(id: string, allowEnded = false): RelaySession {
    const record = this.records.find(r => r.id === id);
    if (!record || (!allowEnded && record.status === "ended")) throw new Error("Unknown or ended relay session");
    return record;
  }
  private commit(records: RelaySession[]): void { this.file.write(records); this.records = records; }
}

export function provider(value: string): Provider {
  if (value !== "claude" && value !== "codex") throw new Error("provider must be claude or codex");
  return value;
}
