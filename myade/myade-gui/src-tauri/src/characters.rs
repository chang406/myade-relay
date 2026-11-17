// Static character roster for per-pane auto-assignment (this file) and,
// later, the companion chat popup's persona prompt. Lives outside the repo
// at ~/.myade/characters/ - same rationale as persona.ts's persona.md
// (survives repo reinstalls) - but is deliberately a *separate* file from
// persona.md: persona.md accumulates HOW the user likes to be talked to
// (tone/communication preferences, shared across every character);
// these files define WHO is speaking (a fixed roster of personalities).
// A pane's assignment only ever reads this roster - it never writes back
// to it, so hand-editing a file here (rename, rewrite the blurb) takes
// effect on the next `claude` launch with no other code changes needed.

use base64::Engine;
use rand::seq::SliceRandom;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;

/// Ships as placeholder content on first run so the roster isn't empty -
/// rename/rewrite these files freely, nothing in the code depends on the
/// specific ids or wording.
const DEFAULT_ROSTER: &[(&str, &str, &str)] = &[
    ("ari", "Ari", "차분하고 논리적인 성격. 군더더기 없이 핵심만 말한다."),
    ("rho", "Rho", "장난기 있고 유쾌한 성격. 가벼운 농담을 섞어 말한다."),
    ("momo", "Momo", "다정하고 세심한 성격. 격려하는 말투를 쓴다."),
    ("yuki", "Yuki", "무뚝뚝하지만 핵심은 정확히 짚는 성격."),
];

pub struct Character {
    pub id: String,
    pub name: String,
    /// CSS color value (hex, `rgb()`/`hsl()`, or a standard CSS color name
    /// like `"blue"` - passed straight through to the frontend and used as
    /// a `style.backgroundColor`, so anything the browser understands
    /// works). From the `color:` frontmatter field if the roster file has
    /// one, otherwise `deterministic_color(&id)`.
    pub color: String,
    /// Path to a custom icon image, relative to `characters_dir()` (e.g.
    /// `icons/ari.svg`). `None` if the file has no `icon:` frontmatter
    /// field - the frontend falls back to an initial-letter badge.
    pub icon: Option<String>,
}

fn home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
    }
}

fn characters_dir() -> PathBuf {
    home_dir().join(".myade").join("characters")
}

/// Splits a roster file's raw content into its optional `---`-delimited
/// frontmatter (just `color`/`icon`, the only two fields this app reads -
/// no need for a real YAML parser) and the body underneath. A file that
/// doesn't start with a `---` line has no frontmatter at all - the whole
/// thing is body, unchanged from before this feature existed, so old
/// hand-written roster files keep working exactly as they did.
fn parse_frontmatter(raw: &str) -> (Option<String>, Option<String>, String) {
    let mut lines = raw.lines();
    let Some(first_line) = lines.next() else {
        return (None, None, String::new());
    };
    if first_line.trim() != "---" {
        return (None, None, raw.to_string());
    }

    let mut color = None;
    let mut icon = None;
    let mut in_frontmatter = true;
    let mut body_lines: Vec<&str> = Vec::new();
    for line in lines {
        if in_frontmatter {
            if line.trim() == "---" {
                in_frontmatter = false;
                continue;
            }
            if let Some((key, value)) = line.split_once(':') {
                let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
                if value.is_empty() {
                    continue;
                }
                match key.trim() {
                    "color" => color = Some(value),
                    "icon" => icon = Some(value),
                    _ => {}
                }
            }
        } else {
            body_lines.push(line);
        }
    }
    (color, icon, body_lines.join("\n"))
}

fn fnv1a(s: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Deterministic per-id color, used both to seed the placeholder roster's
/// `color:` frontmatter (see `ensure_default_roster`) and as a runtime
/// fallback for any character whose file doesn't set `color` (field
/// removed by hand, or a roster file added without frontmatter at all).
/// Both call sites go through this same function, so a file with no
/// `color` field always renders identically to one that has this exact
/// value written in - only diverges once a human edits it. Saturation/
/// lightness are fixed at values that read well with white badge text
/// across every hue; only the hue varies per id.
fn deterministic_color(id: &str) -> String {
    let hue = (fnv1a(id) % 360) as f64;
    hsl_to_hex(hue, 0.60, 0.45)
}

fn hsl_to_hex(h: f64, s: f64, l: f64) -> String {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let to_u8 = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", to_u8(r1), to_u8(g1), to_u8(b1))
}

fn ensure_default_roster(dir: &PathBuf) {
    let has_entries = fs::read_dir(dir).map(|mut it| it.next().is_some()).unwrap_or(false);
    if has_entries {
        return;
    }
    let _ = fs::create_dir_all(dir);
    for (id, name, blurb) in DEFAULT_ROSTER {
        let path = dir.join(format!("{id}.md"));
        if path.exists() {
            continue;
        }
        let color = deterministic_color(id);
        let content = format!(
            "---\ncolor: \"{color}\"\n---\n\n# {name}\n\n<!-- placeholder - 이름/성격을 자유롭게 바꿔도 됩니다 -->\n\n{blurb}\n"
        );
        let _ = fs::write(path, content);
    }
}

/// Reads every `*.md` file in ~/.myade/characters/ (seeding the default
/// placeholder roster first if the directory is empty/missing). The id is
/// the filename stem; the display name is the first non-empty line of the
/// body (after any frontmatter) with leading `#`/markdown stripped, falling
/// back to the id itself. `color`/`icon` come from frontmatter if present,
/// otherwise `color` falls back to `deterministic_color(&id)` and `icon` to
/// `None` (initial-letter badge).
pub fn list_roster() -> Vec<Character> {
    let dir = characters_dir();
    ensure_default_roster(&dir);

    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            let raw = fs::read_to_string(&path).unwrap_or_default();
            let (color, icon, body) = parse_frontmatter(&raw);
            let name = body
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim_start_matches('#').trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| id.clone());
            let color = color.unwrap_or_else(|| deterministic_color(&id));
            out.push(Character { id, name, color, icon });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Full file contents for one roster entry, with any frontmatter stripped
/// (used to seed the companion chat's first turn with that character's
/// personality - see commands::companion_send_message - which should only
/// ever see the personality blurb, not `color`/`icon` metadata). `None` if
/// the id doesn't exist, e.g. a stale id from a previous roster.
pub fn character_content(id: &str) -> Option<String> {
    let path = characters_dir().join(format!("{id}.md"));
    let raw = fs::read_to_string(path).ok()?;
    let (_, _, body) = parse_frontmatter(&raw);
    Some(body)
}

/// Reads `icon` (a path relative to `characters_dir()`) and returns it as a
/// data URI ready for an `<img src>`, or `None` if the field is unset, the
/// file doesn't exist, or the extension isn't a recognized image type - the
/// frontend treats all of those the same way (fall back to the initial-
/// letter badge) so it only needs to check one `Option`.
pub fn icon_data_uri(icon: &str) -> Option<String> {
    let path = characters_dir().join(icon);
    let bytes = fs::read(&path).ok()?;
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => return None,
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

/// A freshly shuffled draw order for one cycle through the roster - the
/// "bag" in shuffle-bag. Every id appears exactly once per bag, so a full
/// cycle guarantees no repeats before every character has had a turn.
pub fn shuffled_queue() -> VecDeque<String> {
    shuffle_ids(list_roster().into_iter().map(|c| c.id).collect())
}

fn shuffle_ids(mut ids: Vec<String>) -> VecDeque<String> {
    ids.shuffle(&mut rand::thread_rng());
    ids.into()
}

/// Draws the next character id from `queue` (the app's session-lifetime
/// shuffle bag, see `state::AppState::character_queue`), refilling with a
/// fresh shuffle when it runs dry. `taken` is the set of characters
/// currently assigned to *open* panes - closing a pane does not return its
/// character to the bag (it stays "already drawn" for the rest of the
/// cycle), but a same-cycle collision is still possible right after a
/// refill: the new shuffle can put an id at the front that some other pane,
/// opened in a *previous* cycle, is still holding. So the draw scans from
/// the front for the first id not in `taken` and removes only that one,
/// leaving anything it skipped in place for the next draw. This always
/// finds a candidate as long as the caller only draws while
/// `taken.len() < roster size` (enforced by the pane cap in
/// `commands::create_pane`, which uses the same `list_roster().len()`).
pub fn draw(queue: &mut VecDeque<String>, taken: &HashSet<String>) -> Option<String> {
    if queue.is_empty() {
        *queue = shuffled_queue();
    }
    draw_from(queue, taken)
}

fn draw_from(queue: &mut VecDeque<String>, taken: &HashSet<String>) -> Option<String> {
    let pos = queue.iter().position(|id| !taken.contains(id))?;
    queue.remove(pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(strs: &[&str]) -> Vec<String> {
        strs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_frontmatter_reads_color_and_icon() {
        let raw = "---\ncolor: \"#4f8dfb\"\nicon: icons/ari.svg\n---\n\n# Ari\n\nblurb here\n";
        let (color, icon, body) = parse_frontmatter(raw);
        assert_eq!(color.as_deref(), Some("#4f8dfb"));
        assert_eq!(icon.as_deref(), Some("icons/ari.svg"));
        assert_eq!(body, "\n# Ari\n\nblurb here");
    }

    #[test]
    fn parse_frontmatter_handles_missing_frontmatter() {
        let raw = "# Ari\n\nblurb here\n";
        let (color, icon, body) = parse_frontmatter(raw);
        assert_eq!(color, None);
        assert_eq!(icon, None);
        assert_eq!(body, raw);
    }

    #[test]
    fn parse_frontmatter_allows_color_only() {
        let raw = "---\ncolor: blue\n---\n\n# Ari\n";
        let (color, icon, body) = parse_frontmatter(raw);
        assert_eq!(color.as_deref(), Some("blue"));
        assert_eq!(icon, None);
        assert_eq!(body, "\n# Ari");
    }

    #[test]
    fn deterministic_color_is_stable_and_differs_by_id() {
        assert_eq!(deterministic_color("ari"), deterministic_color("ari"));
        assert_ne!(deterministic_color("ari"), deterministic_color("yuki"));
        assert!(deterministic_color("ari").starts_with('#'));
        assert_eq!(deterministic_color("ari").len(), 7);
    }

    #[test]
    fn shuffle_ids_is_a_permutation() {
        let mut before = ids(&["a", "b", "c", "d"]);
        let after: HashSet<String> = shuffle_ids(before.clone()).into_iter().collect();
        before.sort();
        let mut after_sorted: Vec<String> = after.into_iter().collect();
        after_sorted.sort();
        assert_eq!(before, after_sorted);
    }

    #[test]
    fn draw_from_skips_taken_and_leaves_them_queued() {
        let mut queue: VecDeque<String> = ids(&["a", "b", "c", "d"]).into();
        let taken: HashSet<String> = ["a".to_string(), "c".to_string()].into_iter().collect();

        // "a" is taken (skipped), "b" is the first free id.
        assert_eq!(draw_from(&mut queue, &taken).as_deref(), Some("b"));
        // "b" was removed; "a" and "c" stay queued (still taken, skipped again),
        // "d" is free.
        assert_eq!(queue, ids(&["a", "c", "d"]).into_iter().collect::<VecDeque<_>>());
        assert_eq!(draw_from(&mut queue, &taken).as_deref(), Some("d"));
        assert_eq!(queue, ids(&["a", "c"]).into_iter().collect::<VecDeque<_>>());
    }

    #[test]
    fn draw_from_returns_none_when_everything_queued_is_taken() {
        let mut queue: VecDeque<String> = ids(&["a", "b"]).into();
        let taken: HashSet<String> = ["a".to_string(), "b".to_string()].into_iter().collect();
        assert_eq!(draw_from(&mut queue, &taken), None);
        // Nothing removed - both still queued for when one frees up.
        assert_eq!(queue, ids(&["a", "b"]).into_iter().collect::<VecDeque<_>>());
    }

    #[test]
    fn full_cycle_draws_every_id_exactly_once() {
        let roster = ids(&["a", "b", "c", "d"]);
        let mut queue = shuffle_ids(roster.clone());
        let taken: HashSet<String> = HashSet::new();

        let mut drawn = Vec::new();
        for _ in 0..roster.len() {
            drawn.push(draw_from(&mut queue, &taken).expect("roster not exhausted yet"));
        }
        assert!(queue.is_empty());
        drawn.sort();
        let mut expected = roster;
        expected.sort();
        assert_eq!(drawn, expected);
    }

    #[test]
    fn reshuffle_after_exhaustion_skips_ids_still_held_by_open_panes() {
        // Simulates: roster of 4, all drawn once, one pane closes and one
        // stays open holding "b" - a fresh shuffle that happens to put "b"
        // first must not hand "b" out again while that pane is still open.
        let roster = ids(&["a", "b", "c", "d"]);
        let mut queue: VecDeque<String> = vec!["b".to_string(), "a".to_string(), "c".to_string(), "d".to_string()].into();
        let taken: HashSet<String> = ["b".to_string()].into_iter().collect();

        let drawn = draw(&mut queue, &taken).expect("a free id must exist");
        assert_ne!(drawn, "b");
        assert!(roster.contains(&drawn));
    }
}
