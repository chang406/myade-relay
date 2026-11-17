import type { Exchange } from "./types.js";
import { SessionRegistry } from "./sessions.js";
import { ExchangeStore } from "./exchanges.js";
import { codexMessage, runCodexQueue, type QueueRunner } from "./codex-queue.js";

export class DeliveryCoordinator {
  private timer?: NodeJS.Timeout;
  private readonly active = new Set<string>();
  constructor(private readonly sessions: SessionRegistry, private readonly exchanges: ExchangeStore,
    private readonly codexBinary: string, private readonly runner: QueueRunner = runCodexQueue) {}
  start(intervalMs = 1500): void {
    const tick = async () => { await this.tick(); this.timer = setTimeout(tick, intervalMs); };
    this.timer = setTimeout(tick, 100);
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); }
  async tick(): Promise<void> {
    const sessions = this.sessions.list().filter(s => s.delivery === "codex_queue" && s.provider === "codex" && s.providerSessionId);
    for (const session of sessions) {
      for (const row of this.exchanges.candidates(session.id)) {
        const direction = row.targetSessionId === session.id ? "request" : "answer";
        const key = `${row.id}:${direction}`;
        const trigger = row.retryRequested[direction] ? "explicit" : "automatic";
        if (this.active.has(key) || (trigger === "automatic" && this.failureCount(row, direction) >= 2)) continue;
        this.active.add(key);
        try {
          const result = await this.runner(session.deliveryCommand ?? this.codexBinary, session.providerSessionId!, codexMessage(row, session), session.deliveryRemote);
          this.exchanges.recordAttempt(row.id, session.id, direction, "codex_queue", result.ok ? "sent" : "failed", result.detail, trigger);
        } finally { this.active.delete(key); }
      }
    }
  }
  private failureCount(row: Exchange, direction: "request" | "answer"): number {
    return row.attempts.filter(a => a.direction === direction && a.transport === "codex_queue" && a.outcome === "failed").length;
  }
}
