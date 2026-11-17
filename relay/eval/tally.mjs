#!/usr/bin/env node
// Turns filled-in human verdicts into the comparison that decides the question:
// does a cross-vendor second reviewer beat a same-vendor one?
//
// Usage: node eval/tally.mjs [--cases eval/cases] [--out eval/results]

import fs from "node:fs";
import path from "node:path";

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
const casesDir = path.resolve(ROOT, typeof input.cases === "string" ? input.cases : "eval/cases");
const outDir = path.resolve(ROOT, typeof input.out === "string" ? input.out : "eval/results");

const runs = JSON.parse(fs.readFileSync(path.join(outDir, "runs.json"), "utf8"));
const scoring = JSON.parse(fs.readFileSync(path.join(outDir, "scoring.json"), "utf8"));

const blank = scoring.flatMap(entry => entry.reported.filter(item => item.verdict.trim() === ""));
if (blank.length > 0) {
  console.error(`${blank.length} reported line(s) still have an empty verdict. Fill every verdict with tp, fp or extra.`);
  process.exitCode = 1;
}

const key = (caseId, pass) => `${caseId}::${pass}`;
const scored = new Map(scoring.map(entry => [key(entry.case, entry.pass), entry.reported]));

const labelled = new Map();
for (const id of fs.readdirSync(casesDir)) {
  const metaPath = path.join(casesDir, id, "meta.json");
  if (!fs.existsSync(metaPath)) continue;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  labelled.set(id, (meta.defects ?? []).map(defect => defect.id));
}

function collect(caseId, passes) {
  const found = new Set();
  let falsePositives = 0;
  let extras = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let ms = 0;
  for (const pass of passes) {
    for (const item of scored.get(key(caseId, pass)) ?? []) {
      if (item.verdict === "tp" && item.matchesDefectId) found.add(item.matchesDefectId);
      else if (item.verdict === "fp") falsePositives++;
      else if (item.verdict === "extra") extras++;
    }
    const run = runs.find(entry => entry.case === caseId && entry.pass === pass);
    if (run) {
      inputTokens += run.inputTokens ?? 0;
      outputTokens += run.outputTokens ?? 0;
      ms += run.ms ?? 0;
    }
  }
  return { found, falsePositives, extras, inputTokens, outputTokens, ms };
}

const conditions = {
  "A  (Claude alone)": ["A"],
  "B  (Claude + Claude)": ["A", "B2"],
  "C  (Claude + Codex)": ["A", "C2"],
};

const caseIds = [...new Set(runs.map(run => run.case))].sort();
const totals = {};
for (const name of Object.keys(conditions)) {
  totals[name] = { found: 0, possible: 0, fp: 0, extra: 0, inputTokens: 0, outputTokens: 0, ms: 0 };
}

const lines = ["# Cross-model review evaluation", "", `Cases: ${caseIds.length}`, ""];
for (const caseId of caseIds) {
  const ids = labelled.get(caseId) ?? [];
  lines.push(`## ${caseId} (${ids.length} labelled defect(s))`, "");
  lines.push("| Condition | Found | Missed | False positives | Unlabelled real | Tokens in/out | Wall ms |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const [name, passes] of Object.entries(conditions)) {
    const result = collect(caseId, passes);
    const hit = ids.filter(id => result.found.has(id)).length;
    totals[name].found += hit;
    totals[name].possible += ids.length;
    totals[name].fp += result.falsePositives;
    totals[name].extra += result.extras;
    totals[name].inputTokens += result.inputTokens;
    totals[name].outputTokens += result.outputTokens;
    totals[name].ms += result.ms;
    lines.push(`| ${name} | ${hit}/${ids.length} | ${ids.length - hit} | ${result.falsePositives} | ${result.extras} | ${result.inputTokens}/${result.outputTokens} | ${result.ms} |`);
  }
  lines.push("");
}

lines.push("## Totals", "");
lines.push("| Condition | Recall | False positives | Unlabelled real | Tokens in/out | Wall ms |");
lines.push("|---|---|---|---|---|---|");
for (const [name, total] of Object.entries(totals)) {
  const recall = total.possible === 0 ? "n/a" : `${total.found}/${total.possible} (${Math.round((total.found / total.possible) * 100)}%)`;
  lines.push(`| ${name} | ${recall} | ${total.fp} | ${total.extra} | ${total.inputTokens}/${total.outputTokens} | ${total.ms} |`);
}

const b = totals["B  (Claude + Claude)"];
const c = totals["C  (Claude + Codex)"];
lines.push("", "## Reading this", "");
lines.push(`Same-vendor second reviewer found ${b.found}/${b.possible}; cross-vendor found ${c.found}/${c.possible}.`);
lines.push("");
lines.push("A meaningful gap in favour of C means the cross-vendor argument holds as data rather than theory, and a narrowed Relay has a reason to exist. A negligible gap means the second reviewer's vendor does not matter, and the cheapest available path wins.");
lines.push("");
lines.push(`Sample size here is ${caseIds.length} case(s). Treat a small gap on a small sample as no gap.`);

const reportPath = path.join(outDir, "report.md");
fs.writeFileSync(reportPath, lines.join("\n"), "utf8");
console.log(lines.join("\n"));
console.error(`\n[eval] wrote ${reportPath}`);
