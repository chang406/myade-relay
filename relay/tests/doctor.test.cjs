const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('doctor reports healthy CLI capabilities and registration state', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { runDoctor } = await import('../dist/src/doctor.js');
  const run = async (command, args) => {
    if (args[0] === '--version') return { ok: true, output: `${command} 1.0` };
    if (command === 'codex') return { ok: true, output: 'queue help' };
    return { ok: true, output: '--mcp-config --strict-mcp-config --dangerously-load-development-channels' };
  };
  const request = async (_base, pathname) => pathname === '/health' ? { ok: true } : [];
  const report = await runDoctor({ base: 'http://127.0.0.1:4318', claudeBinary: 'claude', codexBinary: 'codex', dataDir: dir, runtimeDir: path.join(dir, 'runtime'), sessionId: 'new-session' }, { run, request });
  assert.equal(report.ok, true);
  assert.equal(report.checks.every(check => check.status === 'pass'), true);
});

test('doctor fails missing capabilities and duplicate session but only warns for a missing Codex thread', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-doctor-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { runDoctor } = await import('../dist/src/doctor.js');
  const run = async (command, args) => {
    if (command === 'codex' && args[0] === 'queue') return { ok: false, output: 'unknown command' };
    if (command === 'claude' && args[0] === '--help') return { ok: true, output: '--mcp-config only' };
    if (command === 'claude' && args[0] === '--dangerously-load-development-channels') return { ok: false, output: 'unknown option' };
    return { ok: true, output: '1.0' };
  };
  const sessions = [
    { id: 'duplicate', provider: 'claude', providerSessionId: null, cwd: dir, label: 'duplicate', delivery: 'claude_channel', status: 'idle', startedAt: '', updatedAt: '', endedAt: null },
    { id: 'codex-starting', provider: 'codex', providerSessionId: null, cwd: dir, label: 'codex', delivery: 'codex_queue', status: 'starting', startedAt: '', updatedAt: '', endedAt: null },
  ];
  const request = async (_base, pathname) => pathname === '/health' ? { ok: true } : sessions;
  const report = await runDoctor({ base: 'http://127.0.0.1:4318', claudeBinary: 'claude', codexBinary: 'codex', dataDir: dir, runtimeDir: dir, sessionId: 'duplicate' }, { run, request });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.name === 'codex-queue').status, 'fail');
  assert.equal(report.checks.find(check => check.name === 'claude-channel-flags').status, 'fail');
  assert.equal(report.checks.find(check => check.name === 'session-id').status, 'fail');
  assert.equal(report.checks.find(check => check.name === 'codex-thread-registration').status, 'warn');
});
