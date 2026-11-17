import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import TerminalPane from "./TerminalPane";
import WelcomeScreen from "./WelcomeScreen";
import CharacterBadge from "./CharacterBadge";
import type { AppInfo, CharacterInfo, PaneInfo } from "./types";
import "./App.css";

// Must match commands::PANE_LIMIT_MARKER on the Rust side - the substring
// that tells "roster limit reached" apart from "user cancelled the folder
// picker", since create_pane surfaces both as a plain Err(String).
const PANE_LIMIT_MARKER = "pane 최대 개수";

function App() {
  const [panes, setPanes] = useState<PaneInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  // Full roster, fetched once - also doubles as the pane cap (see
  // commands::max_pane_count on the Rust side, which enforces the same
  // number): one character per pane, so panes can't outnumber the roster.
  const [characters, setCharacters] = useState<CharacterInfo[]>([]);
  // React 18 StrictMode (see main.tsx) mounts effects twice in dev. init_app
  // has real, non-idempotent side effects on the backend (spawns PTYs,
  // registers panes with the stage-1 daemon) that can't be undone by an
  // effect cleanup, so without this guard dev mode would spawn two sets of
  // panes and the ones actually shown would be wired to whichever PTY lost
  // that race.
  const initStarted = useRef(false);
  // Ids of panes this window still owns, maintained *synchronously* - it is
  // the single gate deciding who gets to close a given pane. Every pane
  // reliably produces more than one close trigger (the × button, the waiter
  // thread's `pty://exit`, and the reader thread's fallback emit once the
  // handle is dropped), so they have to be deduplicated against something
  // that updates the instant a close starts. React state can't do that job:
  // `panes` only lands after a render, leaving a window where a second
  // trigger sees a pane that is already being torn down and calls
  // `close_pane` on a pane the backend has already forgotten - which came
  // back as an intermittent "알 수 없는 pane입니다" toast.
  const livePaneIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (initStarted.current) return;
    initStarted.current = true;
    invoke<AppInfo>("init_app")
      .then((info) => {
        // Empty today (init_app always starts with zero panes), but the
        // gate has to be seeded from whatever it returns or any pane it
        // ever hands back would be unclosable.
        for (const p of info.panes) livePaneIds.current.add(p.id);
        setPanes(info.panes);
      })
      .catch((err) => setError(String(err)));

    invoke<CharacterInfo[]>("list_characters")
      .then(setCharacters)
      .catch(() => {});
  }, []);

  // characters.length is 0 until list_characters resolves - don't treat
  // "not loaded yet" as "at the limit" (that would briefly disable the
  // button on every launch before the roster fetch lands).
  const atMax = characters.length > 0 && (panes?.length ?? 0) >= characters.length;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  async function addPane() {
    if (atMax) {
      setNotice(`캐릭터가 ${characters.length}명뿐이라 pane을 더 열 수 없어요. ~/.myade/characters/ 에 캐릭터를 추가하면 늘어나요.`);
      return;
    }
    try {
      const info = await invoke<PaneInfo>("create_pane");
      livePaneIds.current.add(info.id);
      setPanes((prev) => [...(prev ?? []), info]);
    } catch (err) {
      // The backend enforces the same cap (roster could've shrunk since we
      // last fetched it) - surface that specific error; anything else is
      // assumed to be the folder picker getting cancelled, not a real
      // error worth interrupting the user over.
      const msg = String(err);
      if (msg.includes(PANE_LIMIT_MARKER)) setNotice(msg);
      else if (!msg.includes("폴더를 선택하지 않았습니다")) setNotice(`터미널을 열지 못했습니다: ${msg}`);
    }
  }

  const removePane = useCallback(async (paneId: string) => {
    // Test-and-claim in one step: `delete` reports whether this call is the
    // one that found the pane still live. Everything that arrives after
    // loses and returns, so `close_pane` is invoked exactly once per pane
    // no matter how many close triggers fire.
    if (!livePaneIds.current.delete(paneId)) return;
    setClosing((prev) => new Set(prev).add(paneId));
    try {
      await invoke("close_pane", { paneId });
    } catch (err) {
      // Reaching here now means a real desync (this window thought it
      // owned the pane and the backend disagreed), not just a duplicate
      // trigger - so it's worth showing. The cell leaves the UI either
      // way, which is why the filter below lives in `finally`: a dead cell
      // left on screen keeps counting towards `atMax` and silently turns
      // "+ pane 추가" into a no-op.
      setNotice(`pane을 닫는 중 문제가 발생했습니다: ${String(err)}`);
    } finally {
      setPanes((prev) => (prev ?? []).filter((p) => p.id !== paneId));
      setClosing((prev) => {
        const next = new Set(prev);
        next.delete(paneId);
        return next;
      });
    }
  }, []);

  // A pane's shell can end on its own (the user types `exit`, or it
  // crashes), not just via the × button. Nothing used to consume
  // `pty://exit`, so that pane's PaneEntry stayed in the Rust-side
  // registry, its daemon registration stayed live, and - because
  // commands::spawn_pane derives the "taken" set from open panes - its
  // character stayed permanently consumed. A few of those and the roster
  // cap is reached, at which point creating panes just stops working.
  useEffect(() => {
    // Both this event and the × button funnel into removePane, which
    // deduplicates them itself - including the echo from a pane we closed
    // ourselves (killing the shell emits `pty://exit` too, twice: once
    // from the waiter thread and once more from the reader thread when the
    // handle is finally dropped).
    const unlistenPromise = listen<{ paneId: string }>("pty://exit", (event) => {
      void removePane(event.payload.paneId);
    });
    return () => {
      unlistenPromise.then((f) => f());
    };
  }, [removePane]);

  if (error) {
    return (
      <div className="startup-error">
        <h2>초기화 실패</h2>
        <pre>{error}</pre>
      </div>
    );
  }

  if (!panes) {
    return <div className="startup-loading">myade 시작 중...</div>;
  }

  return (
    <div className="app-shell">
      <div className="toolbar">
        <button className={atMax ? "at-max" : undefined} onClick={addPane} title={atMax ? "캐릭터 롤스터를 늘리면 더 열 수 있어요" : undefined}>
          + pane 추가{characters.length > 0 && ` (${panes.length}/${characters.length})`}
        </button>
        <button onClick={() => invoke("open_companion_window").catch(() => {})}>컴패니언 열기</button>
        {notice && <span className="toolbar-notice">{notice}</span>}
      </div>
      {panes.length === 0 ? (
        <WelcomeScreen onCreatePane={addPane} />
      ) : (
        <div className="pane-grid" data-count={panes.length}>
          {panes.map((p) => {
            const character = characters.find((c) => c.id === p.character);
            const characterName = character?.name ?? p.character;
            return (
              <div className="pane-cell" key={p.id}>
                <div className="pane-cell-header" title={p.cwd}>
                  <span className="pane-cell-label">{p.label}</span>
                  <CharacterBadge
                    name={characterName}
                    color={character?.color ?? "#555"}
                    iconDataUri={character?.iconDataUri}
                  />
                  <button
                    className="pane-close"
                    disabled={closing.has(p.id)}
                    onClick={() => removePane(p.id)}
                    title="pane 닫기"
                  >
                    ×
                  </button>
                </div>
                <div className="pane-cell-body">
                  <TerminalPane paneId={p.id} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default App;
