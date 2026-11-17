import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface PtyDataPayload {
  paneId: string;
  data: string;
  seq: number;
}

interface PtyExitPayload {
  paneId: string;
}

interface PtyBacklog {
  content: string;
  nextSeq: number;
}

/**
 * One terminal pane: a real, interactive shell backed by its own PTY on
 * the Rust side (see pty.rs::spawn_shell), identified by `paneId`.
 * `pty://data`/`pty://exit` are emitted for every pane on the same event
 * name and carry a `paneId` field, so each mounted TerminalPane filters
 * the shared stream down to just its own pane instead of the backend
 * needing a dynamic per-pane event name.
 */
export default function TerminalPane({ paneId }: { paneId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      convertEol: true,
      fontSize: 13,
      fontFamily: "Menlo, Consolas, 'Courier New', monospace",
      theme: { background: "#12141a", foreground: "#e6e6e6" },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    invoke("pty_resize", { paneId, cols: term.cols, rows: term.rows }).catch(() => {});

    const dataDisposable = term.onData((data) => {
      invoke("pty_write", { paneId, data }).catch(() => {});
    });

    // Same reconciliation trick as before (see git history / PRD notes):
    // this component can mount before pty_read_backlog would return
    // anything meaningful, and listen() itself needs an IPC round trip to
    // register - so live chunks are queued until the one-time backlog
    // fetch resolves, then replayed past whatever seq the backlog already
    // covered.
    let disposed = false;
    let reconciled = false;
    const queued: PtyDataPayload[] = [];

    const unlistenDataPromise = listen<PtyDataPayload>("pty://data", (event) => {
      if (event.payload.paneId !== paneId) return;
      if (!reconciled) {
        queued.push(event.payload);
        return;
      }
      term.write(base64ToUint8Array(event.payload.data));
    });
    const unlistenExitPromise = listen<PtyExitPayload>("pty://exit", (event) => {
      if (event.payload.paneId !== paneId) return;
      term.write("\r\n\x1b[31m[셸이 종료되었습니다]\x1b[0m\r\n");
    });

    (async () => {
      // Listener registration is asynchronous. Capture backlog only after
      // registration completes, otherwise output in the gap can disappear.
      await unlistenDataPromise;
      for (let attempt = 0; attempt < 100 && !disposed; attempt++) {
        try {
          const backlog = await invoke<PtyBacklog>("pty_read_backlog", { paneId });
          if (disposed) return;
          if (backlog.content) term.write(backlog.content);
          reconciled = true;
          for (const chunk of queued) {
            if (chunk.seq >= backlog.nextSeq) {
              term.write(base64ToUint8Array(chunk.data));
            }
          }
          queued.length = 0;
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (disposed) return;
      reconciled = true;
      for (const chunk of queued) term.write(base64ToUint8Array(chunk.data));
      queued.length = 0;
    })();

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      invoke("pty_resize", { paneId, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unlistenDataPromise.then((f) => f());
      unlistenExitPromise.then((f) => f());
      term.dispose();
    };
  }, [paneId]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
