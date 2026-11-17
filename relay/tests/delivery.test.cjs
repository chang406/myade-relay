const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Codex queue addresses an active remote app-server when configured', async () => {
  const { codexQueueArgs } = await import('../dist/src/codex-queue.js');
  assert.deepEqual(codexQueueArgs('thread-1', 'wake up', 'ws://127.0.0.1:4567'), [
    'queue', '--thread', 'thread-1', '--message', 'wake up', '--remote', 'ws://127.0.0.1:4567',
  ]);
});

test('Codex queue success records only a delivery attempt', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [{ SessionRegistry }, { ExchangeStore }, { DeliveryCoordinator }] = await Promise.all([
    import('../dist/src/sessions.js'), import('../dist/src/exchanges.js'), import('../dist/src/delivery.js'),
  ]);
  const sessions = SessionRegistry.at(path.join(dir, 'sessions.json'));
  const exchanges = ExchangeStore.at(sessions, path.join(dir, 'exchanges.json'));
  sessions.register({ id: 'source', provider: 'claude', cwd: dir });
  sessions.register({ id: 'target', provider: 'codex', providerSessionId: 'thread-1', cwd: dir, deliveryCommand: 'C:/tools/codex.exe', deliveryRemote: 'ws://127.0.0.1:4567' });
  const row = exchanges.send('source', { targetSessionId: 'target', question: 'Check this' });
  const calls = [];
  const coordinator = new DeliveryCoordinator(sessions, exchanges, 'codex', async (...args) => {
    calls.push(args); return { ok: true, detail: 'queue accepted; receipt unconfirmed' };
  });
  await coordinator.tick();
  const updated = exchanges.all().find(item => item.id === row.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'C:/tools/codex.exe');
  assert.equal(calls[0][3], 'ws://127.0.0.1:4567');
  assert.equal(updated.status, 'delivery_attempted');
  assert.equal(updated.attempts[0].outcome, 'sent');
  assert.notEqual(updated.status, 'accepted');
});

test('Codex queue stops after two failed attempts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [{ SessionRegistry }, { ExchangeStore }, { DeliveryCoordinator }] = await Promise.all([
    import('../dist/src/sessions.js'), import('../dist/src/exchanges.js'), import('../dist/src/delivery.js'),
  ]);
  const sessions = SessionRegistry.at(path.join(dir, 'sessions.json'));
  const exchanges = ExchangeStore.at(sessions, path.join(dir, 'exchanges.json'));
  sessions.register({ id: 'source', provider: 'claude', cwd: dir });
  sessions.register({ id: 'target', provider: 'codex', providerSessionId: 'thread-1', cwd: dir });
  const row = exchanges.send('source', { targetSessionId: 'target', question: 'Check this' });
  let calls = 0;
  const coordinator = new DeliveryCoordinator(sessions, exchanges, 'codex', async () => { calls++; return { ok: false, detail: 'failed' }; });
  await coordinator.tick(); await coordinator.tick(); await coordinator.tick();
  assert.equal(calls, 2);
  exchanges.requestRetry(row.id, 'source', 'request');
  await coordinator.tick(); await coordinator.tick();
  assert.equal(calls, 3);
  const updated = exchanges.all().find(item => item.id === row.id);
  assert.equal(updated.attempts.length, 3);
  assert.equal(updated.attempts.at(-1).trigger, 'explicit');
  assert.equal(updated.retryRequested.request, false);
});
