import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Exchange } from "./types.js";
import { requestJson } from "./http-client.js";
import { registerBoundTools } from "./tools.js";

export function notificationText(row: Exchange): string {
  if (row.status === "queued") {
    return `Relay request ${row.id} is available. Call relay_receive with this requestId, analyze it with normal permissions, then call relay_reply. A notification is not proof that you received the request.`;
  }
  return `Relay answer ${row.id} is available. Call relay_collect with this requestId, verify the evidence, and report the result to the user.`;
}

export async function runAdapter(base: string, sessionId: string, channel: boolean): Promise<void> {
  const server = new McpServer(
    { name: "myade-relay", version: "0.1.0" },
    { capabilities: channel ? { experimental: { "claude/channel": {} } } : undefined },
  );
  registerBoundTools(server, base, sessionId);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const poll = async () => {
    try {
      const rows = await requestJson<Exchange[]>(base, `/api/delivery/candidates?sessionId=${encodeURIComponent(sessionId)}`);
      for (const row of rows) {
        const direction = row.targetSessionId === sessionId ? "request" : "answer";
        const trigger = row.retryRequested[direction] ? "explicit" : "automatic";
        try {
          await server.server.notification({ method: "notifications/claude/channel", params: { content: notificationText(row), meta: { request_id: row.id, direction } } });
          await requestJson(base, `/api/exchanges/${encodeURIComponent(row.id)}/attempt`, {
            method: "POST", body: JSON.stringify({ sessionId, direction, transport: "claude_channel", outcome: "sent", trigger, detail: "Channel notification sent; agent receipt is unconfirmed" }),
          });
        } catch (error) {
          await requestJson(base, `/api/exchanges/${encodeURIComponent(row.id)}/attempt`, {
            method: "POST", body: JSON.stringify({ sessionId, direction, transport: "claude_channel", outcome: "failed", trigger, detail: String(error) }),
          });
        }
      }
    } catch (error) {
      console.error(`[relay adapter] poll failed: ${String(error)}`);
    } finally {
      if (!stopped) timer = setTimeout(poll, 1500);
    }
  };
  server.server.oninitialized = () => {
    requestJson(base, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: "PATCH", body: JSON.stringify({ status: "idle" }) }).catch(console.error);
    if (channel) timer = setTimeout(poll, 250);
  };
  server.server.onclose = () => { stopped = true; if (timer) clearTimeout(timer); };
  await server.connect(new StdioServerTransport());
}
