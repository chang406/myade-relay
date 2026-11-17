import { FormEvent, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CharacterInfo, CompanionEventPayload, CompanionTurnDonePayload } from "./types";
import CharacterDropdown from "./CharacterDropdown";
import "./App.css";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `c${idCounter}`;
}

/**
 * The companion popup (separate window, see commands::open_companion_window
 * and main.tsx's hash routing): pick a roster character, chat with just
 * that personality. Deliberately has no notion of any terminal pane's
 * conversation - each character's thread is independent, backed by its own
 * `claude -p --resume` session on the Rust side (companion.rs), keyed by
 * character id for the lifetime of the app.
 */
export default function CompanionApp() {
  const [characters, setCharacters] = useState<CharacterInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messagesByCharacter, setMessagesByCharacter] = useState<Record<string, ChatMessage[]>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    invoke<CharacterInfo[]>("list_characters")
      .then((list) => {
        setCharacters(list);
        if (list.length > 0) setActiveId((prev) => prev ?? list[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unlistenEvent = listen<CompanionEventPayload>("companion://event", (e) => {
      const { characterId, raw } = e.payload;
      const delta = raw?.event?.delta;
      if (raw?.type === "stream_event" && delta?.type === "text_delta" && typeof delta.text === "string") {
        setMessagesByCharacter((prev) => {
          const list = prev[characterId] ?? [];
          if (streamingIdRef.current) {
            return {
              ...prev,
              [characterId]: list.map((m) =>
                m.id === streamingIdRef.current ? { ...m, text: m.text + delta.text } : m
              ),
            };
          }
          const id = nextId();
          streamingIdRef.current = id;
          return { ...prev, [characterId]: [...list, { id, role: "assistant", text: delta.text }] };
        });
      }
    });

    const unlistenDone = listen<CompanionTurnDonePayload>("companion://turn-done", (e) => {
      const { characterId, isError, finalText } = e.payload;
      setMessagesByCharacter((prev) => {
        const list = prev[characterId] ?? [];
        const withoutStreaming = streamingIdRef.current
          ? list.filter((m) => m.id !== streamingIdRef.current)
          : list;
        return {
          ...prev,
          [characterId]: [
            ...withoutStreaming,
            {
              id: nextId(),
              role: isError ? "system" : "assistant",
              text: finalText || (isError ? "(오류로 응답을 받지 못했습니다)" : "(빈 응답)"),
            },
          ],
        };
      });
      streamingIdRef.current = null;
      setSending(false);
    });

    return () => {
      unlistenEvent.then((f) => f());
      unlistenDone.then((f) => f());
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messagesByCharacter, activeId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending || !activeId) return;
    setMessagesByCharacter((prev) => ({
      ...prev,
      [activeId]: [...(prev[activeId] ?? []), { id: nextId(), role: "user", text }],
    }));
    setInput("");
    setSending(true);
    try {
      await invoke("companion_send_message", { characterId: activeId, text });
    } catch (err) {
      setSending(false);
      setMessagesByCharacter((prev) => ({
        ...prev,
        [activeId]: [...(prev[activeId] ?? []), { id: nextId(), role: "system", text: `오류: ${err}` }],
      }));
    }
  }

  const messages = activeId ? messagesByCharacter[activeId] ?? [] : [];

  return (
    <div className="companion-shell">
      <CharacterDropdown characters={characters} activeId={activeId} onSelect={setActiveId} disabled={sending} />

      <div className="chat-pane">
        <div className="chat-log">
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
              <div className="chat-msg-role">
                {m.role === "user" ? "나" : m.role === "assistant" ? characters.find((c) => c.id === activeId)?.name ?? "?" : "·"}
              </div>
              <div className="chat-msg-text">{m.text}</div>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>

        <form className="chat-input-row" onSubmit={handleSubmit}>
          <input
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            placeholder={sending ? "응답 기다리는 중..." : "메시지 보내기"}
            disabled={sending || !activeId}
          />
          <button type="submit" disabled={sending || !input.trim() || !activeId}>
            보내기
          </button>
        </form>
      </div>
    </div>
  );
}
