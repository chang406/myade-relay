import { useEffect, useRef, useState } from "react";
import CharacterBadge from "./CharacterBadge";
import type { CharacterInfo } from "./types";

type CharacterDropdownProps = {
  characters: CharacterInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
};

// Trigger button (current character's badge + name) that opens a dropdown
// listing every roster character (also badge + name) to switch to. Closes
// on selection, outside click, or Escape.
function CharacterDropdown({ characters, activeId, onSelect, disabled }: CharacterDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = characters.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function selectAndClose(id: string) {
    onSelect(id);
    setOpen(false);
  }

  return (
    <div className="character-dropdown" ref={rootRef}>
      <button
        type="button"
        className="character-dropdown-trigger"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
      >
        {active ? (
          <CharacterBadge name={active.name} color={active.color} iconDataUri={active.iconDataUri} />
        ) : null}
        <span className="character-dropdown-trigger-name">{active?.name ?? "캐릭터 선택"}</span>
        <span className="character-dropdown-arrow">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="character-dropdown-menu">
          {characters.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`character-dropdown-item${c.id === activeId ? " active" : ""}`}
              onClick={() => selectAndClose(c.id)}
            >
              <CharacterBadge name={c.name} color={c.color} iconDataUri={c.iconDataUri} />
              <span>{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default CharacterDropdown;
