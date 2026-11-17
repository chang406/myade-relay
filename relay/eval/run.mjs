#!/usr/bin/env node
// Runs the cross-model review experiment.
//
//   A  = Claude, single pass           (baseline)
//   B2 = Claude, independent 2nd pass  (same-vendor second reviewer, fork-like)
//   C2 = Codex,  independent 2nd pass  (cross-vendor second reviewer)
//
// B and C differ only in the vendor of the second reviewer, so the comparison
// isolates the thing in question. Each pass is a fresh process with no shared
// context; that is the point of an independent reviewer.
//
// Usage:
//   node eval/run.mjs [--cases eval/cases] [--out eval/results]
//                     [--claude PATH] [--codex PATH] [--only CASE_ID]

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { reviewPrompt } from "./prompt.mjs";

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

function resolveBinary(name, override) {
  if (typeof override === "string") return override;
  let candidates;
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
    candidates = found.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  } catch {
    throw new Error(`Could not locate ${name}. Pass --${name} PATH explicitly.`);
  }
  if (candidates.length === 0) throw new Error(`Could not locate ${name}. Pass --${name} PATH explicitly.`);
  // npm installs both an extensionless shell script and a .cmd shim on Windows.
  // `where` lists the shell script first, and Node cannot spawn it.
  if (process.platform === "win32") {
    const runnable = candidates.find(candidate => /\.(cmd|bat|exe)$/i.test(candidate));
    if (!runnable) throw new Error(`Found ${name} but no .cmd/.exe shim to spawn. Pass --${name} PATH explicitly.`);
    return runnable;
  }
  return candidates[0];
}

// Windows npm shims are .cmd files, which Node refuses to spawn without a shell.
// Routing through cmd.exe with an argument array keeps the diff off the command
// line entirely -- it is always written to stdin.
function spawnCli(binary, cliArgs, stdin) {
  const useCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
  const command = useCmd ? process.env.ComSpec || "cmd.exe" : binary;
  const spawnArgs = useCmd ? ["/c", binary, ...cliArgs] : cliArgs;
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, spawnArgs, { cwd: ROOT, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", error => resolve({ stdout, stderr: String(error), code: -1, ms: Date.now() - started }));
    child.once("close", code => resolve({ stdout, stderr, code, ms: Date.now() - started }));
    child.stdin.end(stdin, "utf8");
  });
}

const claudeArgs = ["-p", "--output-format", "json"];
const codexArgs = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"];

// Best-effort token extraction. Formats differ per vendor and per version, so a
// miss records null rather than a guess.
export function claudeUsage(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const usage = parsed.usage ?? {};
    // Claude reports uncached input separately from cache reads, while Codex's
    // input_tokens already includes its cached portion. Summing here keeps the
    // two vendors' input columns comparable.
    const input = usage.input_tokens === undefined ? null
      : (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    return { input, output: usage.output_tokens ?? null, text: parsed.result ?? null };
  } catch {
    return { input: null, output: null, text: null };
  }
}

export function codexUsage(stdout) {
  let input = null;
  let output = null;
  let text = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const usage = event.usage ?? event.info?.usage ?? event.msg?.usage;
    if (usage) {
      input = usage.input_tokens ?? usage.prompt_tokens ?? input;
      output = usage.output_tokens ?? usage.completion_tokens ?? output;
    }
    // Codex 0.155.x emits {"type":"item.completed","item":{"type":"agent_message","text":...}}.
    // Older shapes put the message under `msg`. Take the last one either way.
    for (const candidate of [event.item, event.msg, event]) {
      if (!candidate || typeof candidate.text !== "string") continue;
      if (!String(candidate.type ?? "").includes("message")) continue;
      text = candidate.text;
    }
    if (typeof event.last_agent_message === "string") text = event.last_agent_message;
  }
  return { input, output, text };
}

export function parseDefects(text) {
  if (!text) return [];
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.toUpperCase().startsWith("DEFECT"))
    .map(line => line.replace(/^DEFECT\s*\|\s*/i, ""));
}

async function main() {
  const input = args(process.argv.slice(2));
  const casesDir = path.resolve(ROOT, typeof input.cases === "string" ? input.cases : "eval/cases");
  const outDir = path.resolve(ROOT, typeof input.out === "string" ? input.out : "eval/results");
  const claude = resolveBinary("claude", input.claude);
  const codex = resolveBinary("codex", input.codex);

  if (!fs.existsSync(casesDir)) throw new Error(`No cases directory at ${casesDir}. See eval/README.md.`);
  let cases = fs.readdirSync(casesDir).filter(name => fs.existsSync(path.join(casesDir, name, "diff.patch")));
  if (typeof input.only === "string") cases = cases.filter(name => name === input.only);
  if (cases.length === 0) throw new Error(`No cases with a diff.patch found in ${casesDir}.`);

  fs.mkdirSync(outDir, { recursive: true });
  console.error(`[eval] claude: ${claude}`);
  console.error(`[eval] codex:  ${codex}`);
  console.error(`[eval] cases:  ${cases.length}`);

  const runs = [];
  for (const id of cases) {
    const diff = fs.readFileSync(path.join(casesDir, id, "diff.patch"), "utf8");
    const prompt = reviewPrompt(diff);
    const caseOut = path.join(outDir, id);
    fs.mkdirSync(caseOut, { recursive: true });

    const passes = [
      { pass: "A", vendor: "claude", binary: claude, cliArgs: claudeArgs, usage: claudeUsage },
      { pass: "B2", vendor: "claude", binary: claude, cliArgs: claudeArgs, usage: claudeUsage },
      { pass: "C2", vendor: "codex", binary: codex, cliArgs: codexArgs, usage: codexUsage },
    ];

    for (const entry of passes) {
      process.stderr.write(`[eval] ${id} ${entry.pass} (${entry.vendor}) ... `);
      const result = await spawnCli(entry.binary, entry.cliArgs, prompt);
      const usage = entry.usage(result.stdout);
      const defects = parseDefects(usage.text ?? result.stdout);
      fs.writeFileSync(path.join(caseOut, `${entry.pass}.raw.txt`), result.stdout + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""), "utf8");
      fs.writeFileSync(path.join(caseOut, `${entry.pass}.defects.txt`), defects.join("\n"), "utf8");
      runs.push({ case: id, pass: entry.pass, vendor: entry.vendor, exitCode: result.code, ms: result.ms,
        inputTokens: usage.input, outputTokens: usage.output, parsed: usage.text !== null, defects });
      console.error(`exit ${result.code}, ${result.ms}ms, ${defects.length} defect line(s)`);
    }
  }

  fs.writeFileSync(path.join(outDir, "runs.json"), JSON.stringify(runs, null, 2), "utf8");

  // Scoring skeleton: every reported defect line needs a human verdict, because
  // an LLM judge would reintroduce exactly the correlated-error problem this
  // experiment exists to measure.
  const scoringPath = path.join(outDir, "scoring.json");
  const skeleton = runs.map(run => ({
    case: run.case, pass: run.pass,
    reported: run.defects.map(text => ({ text, verdict: "", matchesDefectId: "" })),
  }));
  if (fs.existsSync(scoringPath)) {
    console.error(`[eval] ${scoringPath} already exists; wrote skeleton to scoring.new.json instead.`);
    fs.writeFileSync(path.join(outDir, "scoring.new.json"), JSON.stringify(skeleton, null, 2), "utf8");
  } else {
    fs.writeFileSync(scoringPath, JSON.stringify(skeleton, null, 2), "utf8");
  }

  const unparsed = runs.filter(run => !run.parsed);
  if (unparsed.length > 0) console.error(`[eval] warning: ${unparsed.length} run(s) had unparsed output; check the .raw.txt files.`);
  console.error(`[eval] wrote ${path.join(outDir, "runs.json")}`);
  console.error(`[eval] next: fill in verdicts in ${scoringPath}, then run node eval/tally.mjs`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(HERE, "run.mjs");
if (invokedDirectly) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
