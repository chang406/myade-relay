const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Claude launch uses an explicit development channel without permission bypass flags', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-launch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { providerArgs } = await import('../dist/src/launch.js');
  const invocation = providerArgs({ provider: 'claude', id: 'claude-a', base: 'http://127.0.0.1:4318', cwd: dir, binary: 'claude', runtimeDir: dir }, 'cli.js');
  assert.equal(invocation.args.includes('--dangerously-load-development-channels'), true);
  assert.equal(invocation.args.some(value => /bypass-permissions/.test(value)), false);
  const config = JSON.parse(fs.readFileSync(invocation.configFile, 'utf8'));
  const sessionFlag = config.mcpServers.relay.args.indexOf('--session');
  assert.equal(config.mcpServers.relay.args[sessionFlag + 1], 'claude-a');
  assert.equal(config.mcpServers.relay.args.includes('--channel'), true);
});

test('Codex launch resumes the exact queue-addressable thread and preserves normal approvals', async () => {
  const { providerArgs } = await import('../dist/src/launch.js');
  const invocation = providerArgs({ provider: 'codex', id: 'codex-a', thread: 'thread-123', base: 'http://127.0.0.1:4318', cwd: process.cwd(), binary: 'codex', runtimeDir: '.' }, 'cli.js');
  assert.deepEqual(invocation.args.slice(-2), ['resume', 'thread-123']);
  assert.equal(invocation.args.some(value => /approval|sandbox|dangerously/.test(value)), false);
});

test('Codex remote launch lets the TUI create a new app-server thread', async () => {
  const { providerArgs } = await import('../dist/src/launch.js');
  const invocation = providerArgs({ provider: 'codex', id: 'codex-a', remote: 'ws://127.0.0.1:4567', base: 'http://127.0.0.1:4318', cwd: process.cwd(), binary: 'codex', runtimeDir: '.' }, 'cli.js');
  assert.deepEqual(invocation.args.slice(-2), ['--remote', 'ws://127.0.0.1:4567']);
  assert.equal(invocation.args.includes('resume'), false);
});
