// Output-shape regression tests for the eval harness parsers. These shapes were
// captured from real Claude Code 2.1.219 and Codex 0.155.1 runs; a vendor
// changing them is exactly the failure that would silently score every run zero.
import test from "node:test";
import assert from "node:assert/strict";
import { claudeUsage, codexUsage, parseDefects } from "./run.mjs";

const codexReal = [
  '{"type":"thread.started","thread_id":"01a0ce50-4b17-7050-b24c-f9881d128a72"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"DEFECT | src/cart.js:3 | Loop reads past the end.\\nDEFECT | src/cart.js:6 | toFixed changes the return type."}}',
  '{"type":"turn.completed","usage":{"input_tokens":18989,"cached_input_tokens":12160,"output_tokens":70}}',
].join("\n");

test("codex item.completed carries the agent message and turn.completed the usage", () => {
  const usage = codexUsage(codexReal);
  assert.equal(usage.input, 18989);
  assert.equal(usage.output, 70);
  assert.equal(parseDefects(usage.text).length, 2);
});

test("codex legacy msg-shaped events still parse", () => {
  const legacy = '{"msg":{"type":"agent_message","text":"DEFECT | a.js:1 | boom"},"usage":{"input_tokens":5,"output_tokens":6}}';
  const usage = codexUsage(legacy);
  assert.equal(usage.input, 5);
  assert.equal(parseDefects(usage.text).length, 1);
});

test("claude print json exposes result text and token usage", () => {
  const usage = claudeUsage(JSON.stringify({ result: "DEFECT | a.js:1 | boom\nNo other issues.", usage: { input_tokens: 11, output_tokens: 22 } }));
  assert.equal(usage.input, 11);
  assert.equal(usage.output, 22);
  assert.deepEqual(parseDefects(usage.text), ["a.js:1 | boom"]);
});

test("claude cache reads count as input so both vendors are comparable", () => {
  // Real shape: almost all of a repeated review prompt arrives as a cache read,
  // so ignoring it would report ~2 input tokens against Codex's ~19000.
  const usage = claudeUsage(JSON.stringify({ result: "NO DEFECTS",
    usage: { input_tokens: 2, cache_read_input_tokens: 19906, cache_creation_input_tokens: 0, output_tokens: 696 } }));
  assert.equal(usage.input, 19908);
  assert.equal(usage.output, 696);
});

test("a clean review yields no defects and unparsable output stays null", () => {
  assert.deepEqual(parseDefects("NO DEFECTS"), []);
  assert.equal(claudeUsage("not json").text, null);
  assert.equal(codexUsage("not json").text, null);
});
