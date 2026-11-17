#!/usr/bin/env node
// Extracts a commit's diff from any local repository into a case skeleton.
//
// Usage:
//   node eval/make-case.mjs --repo C:\path\to\repo --sha abc1234 [--id my-case]
//
// Picking cases: a good source of labelled defects is a commit that a later
// commit fixed. Review the buggy commit, and the fix tells you the ground truth.
//   git log --oneline --grep="fix" -20
// Take the parent of a fix commit, read what the fix changed, and write that
// into meta.json as a labelled defect.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.resolve(HERE, "..");

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = !next || next.startsWith("--") ? true : (i++, next);
  }
  return out;
}

const input = args(process.argv.slice(2));
const repo = typeof input.repo === "string" ? path.resolve(input.repo) : null;
const sha = typeof input.sha === "string" ? input.sha : null;
if (!repo || !sha) {
  console.error("Usage: node eval/make-case.mjs --repo PATH --sha SHA [--id ID] [--cases DIR]");
  process.exit(1);
}

const git = (...gitArgs) => execFileSync("git", ["-C", repo, ...gitArgs], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const resolved = git("rev-parse", sha).trim();
const subject = git("log", "-1", "--format=%s", resolved).trim();
const diff = git("show", "--no-color", "--format=", resolved);

if (diff.trim().length === 0) throw new Error(`Commit ${resolved} produced an empty diff.`);

const id = typeof input.id === "string" ? input.id : `${path.basename(repo)}-${resolved.slice(0, 8)}`;
const casesDir = path.resolve(ROOT, typeof input.cases === "string" ? input.cases : "eval/cases");
const caseDir = path.join(casesDir, id);
fs.mkdirSync(caseDir, { recursive: true });
fs.writeFileSync(path.join(caseDir, "diff.patch"), diff, "utf8");

const metaPath = path.join(caseDir, "meta.json");
if (fs.existsSync(metaPath)) {
  console.error(`[eval] kept existing ${metaPath}`);
} else {
  fs.writeFileSync(metaPath, JSON.stringify({
    id,
    source: `${repo}@${resolved}`,
    subject,
    note: "Fill in defects[] with the real problems this diff introduced. An empty defects[] means this case contributes no recall signal.",
    defects: [{ id: "d1", summary: "", file: "", line: 0 }],
  }, null, 2), "utf8");
}

const bytes = Buffer.byteLength(diff, "utf8");
console.error(`[eval] ${id}: ${bytes} bytes of diff from ${subject}`);
if (bytes > 60_000) console.error("[eval] warning: large diff. Big cases cost tokens and blur the signal; prefer focused commits.");
console.error(`[eval] now label the defects in ${metaPath}`);
