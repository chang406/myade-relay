export type Provider = "claude" | "codex";
export type SessionStatus = "starting" | "idle" | "busy" | "waiting_permission" | "ended";
export type DeliveryKind = "claude_channel" | "codex_queue" | "manual";

export interface RelaySession {
  id: string;
  provider: Provider;
  providerSessionId: string | null;
  cwd: string;
  label: string;
  delivery: DeliveryKind;
  deliveryCommand?: string | null;
  deliveryRemote?: string | null;
  status: SessionStatus;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export type ExchangeStatus = "queued" | "delivery_attempted" | "accepted" | "replied" | "delivered" | "cancelled";

export interface DeliveryAttempt {
  direction: "request" | "answer";
  transport: DeliveryKind;
  outcome: "sent" | "failed";
  trigger: "automatic" | "explicit";
  at: string;
  detail: string;
}

export interface Exchange {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  question: string;
  context: string;
  status: ExchangeStatus;
  answer: string | null;
  attempts: DeliveryAttempt[];
  retryRequested: { request: boolean; answer: boolean };
  createdAt: string;
  updatedAt: string;
}
