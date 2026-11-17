/**
 * Node-side counterpart to myade-gui/src-tauri/src/characters.rs's
 * `character_content` - same roster directory (~/.myade/characters/,
 * outside the repo, shared with the Tauri app), read-only here too. This
 * side never assigns/writes characters; it only reads a roster file's
 * content by id so server.ts's SessionStart hook handler can inject it as
 * additionalContext (see server.ts).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CHARACTERS_DIR = path.join(os.homedir(), ".myade", "characters");

/** Full contents of one roster file, or undefined if the id doesn't exist. */
export function readCharacter(id: string): string | undefined {
  try {
    return fs.readFileSync(path.join(CHARACTERS_DIR, `${id}.md`), "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}
