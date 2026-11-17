import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionStore } from "./state";
import type { PaneRecord } from "./types";

function summarize(pane: PaneRecord) {
  return {
    paneId: pane.paneId,
    label: pane.label,
    cwd: pane.cwd,
    claudeSessionId: pane.claudeSessionId,
    status: pane.status,
    lastEvent: pane.lastEvent,
    startedAt: pane.startedAt,
    updatedAt: pane.updatedAt,
    ended: pane.ended,
  };
}

/**
 * Registers the myade MCP tools against a McpServer instance. Kept
 * separate from state.ts (the actual state logic) so stage 2's GUI
 * shell can reuse SessionStore directly without going through MCP, and
 * so new tools can be added here later without touching state logic.
 */
export function registerTools(server: McpServer, store: SessionStore) {
  server.registerTool(
    "pane_ping",
    {
      description:
        "Health check for the myade session-tracking server. Use this first to confirm the MCP connection to myade is alive before calling pane_list / pane_status.",
    },
    async () => {
      const panes = store.list();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                serverTime: new Date().toISOString(),
                paneCount: panes.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "pane_list",
    {
      description:
        "Returns registered terminal panes across all terminals, most recently updated first. paneId is the routing identity. Status currently comes from launcher/Claude hooks, not proof of Codex activity. Each entry has label, cwd, status, lastEvent and timestamps.",
      inputSchema: {
        includeEnded: z
          .boolean()
          .optional()
          .describe("Include panes whose claude process has already exited. Default false."),
      },
    },
    async ({ includeEnded }) => {
      let panes = store.list();
      if (!includeEnded) panes = panes.filter((p) => !p.ended);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(panes.map(summarize), null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "pane_status",
    {
      description:
        "Looks up one or more panes by paneId, Claude session_id, exact label, or a substring of the label/working-directory. Returns the matching pane(s) with their current status. If the query is omitted, returns all panes (same as pane_list).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "paneId, claude session_id, exact label, or a substring to search for in label/cwd. Omit to list everything."
          ),
      },
    },
    async ({ query }) => {
      const panes = query ? store.find(query) : store.list();
      return {
        content: [
          {
            type: "text",
            text:
              panes.length === 0
                ? `No pane found matching "${query ?? ""}".`
                : JSON.stringify(panes.map(summarize), null, 2),
          },
        ],
      };
    }
  );
}
