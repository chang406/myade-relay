const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function modules() {
  return Promise.all([import('../dist/src/sessions.js'), import('../dist/src/exchanges.js')]);
}

test('request states distinguish queue, transport attempt, acceptance, reply and delivery', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [{ SessionRegistry }, { ExchangeStore }] = await modules();
  const sessions = SessionRegistry.at(path.join(dir, 'sessions.json'));
  const exchanges = ExchangeStore.at(sessions, path.join(dir, 'exchanges.json'));
  const source = sessions.register({ id: 'source', provider: 'codex', providerSessionId: 'thread-a', cwd: dir });
  const target = sessions.register({ id: 'target', provider: 'claude', cwd: dir });
  let row = exchanges.send(source.id, { targetSessionId: target.id, question: 'Review this design' });
  assert.equal(row.status, 'queued');
  assert.deepEqual(row.retryRequested, { request: false, answer: false });
  row = exchanges.recordAttempt(row.id, target.id, 'request', 'claude_channel', 'sent', 'notification sent; receipt unknown');
  assert.equal(row.status, 'delivery_attempted');
  assert.equal(row.attempts[0].detail.includes('receipt unknown'), true);
  assert.equal(row.attempts[0].trigger, 'automatic');
  row = exchanges.receive(row.id, target.id);
  assert.equal(row.status, 'accepted');
  row = exchanges.reply(row.id, target.id, 'Conclusion with evidence');
  assert.equal(row.status, 'replied');
  row = exchanges.collect(row.id, source.id);
  assert.equal(row.status, 'delivered');
});

test('explicit retry enforces directional ownership and terminal-state guards', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-explicit-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [{ SessionRegistry }, { ExchangeStore }] = await modules();
  const sessions = SessionRegistry.at(path.join(dir, 'sessions.json'));
  const exchanges = ExchangeStore.at(sessions, path.join(dir, 'exchanges.json'));
  for (const id of ['source', 'target', 'other']) sessions.register({ id, provider: 'claude', cwd: dir });
  let row = exchanges.send('source', { targetSessionId: 'target', question: 'retry me' });
  assert.throws(() => exchanges.requestRetry(row.id, 'source', 'request'), /No delivery attempt/);
  row = exchanges.recordAttempt(row.id, 'target', 'request', 'claude_channel', 'failed', 'initial failure');
  assert.throws(() => exchanges.requestRetry(row.id, 'other', 'request'), /does not belong/);
  row = exchanges.requestRetry(row.id, 'source', 'request');
  assert.equal(row.retryRequested.request, true);
  row = exchanges.recordAttempt(row.id, 'target', 'request', 'claude_channel', 'sent', 'resent', 'explicit');
  assert.equal(row.retryRequested.request, false);
  assert.equal(row.attempts.at(-1).trigger, 'explicit');
  row = exchanges.receive(row.id, 'target');
  assert.throws(() => exchanges.requestRetry(row.id, 'source', 'request'), /already accepted/);
  row = exchanges.reply(row.id, 'target', 'answer');
  assert.throws(() => exchanges.requestRetry(row.id, 'target', 'answer'), /No delivery attempt/);
  row = exchanges.recordAttempt(row.id, 'source', 'answer', 'claude_channel', 'sent', 'answer notification');
  assert.throws(() => exchanges.requestRetry(row.id, 'source', 'answer'), /does not belong/);
  row = exchanges.requestRetry(row.id, 'target', 'answer');
  assert.equal(row.retryRequested.answer, true);
  row = exchanges.collect(row.id, 'source');
  assert.throws(() => exchanges.requestRetry(row.id, 'target', 'answer'), /not awaiting collection/);
});

test('legacy exchanges load with retry compatibility defaults', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-legacy-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [{ SessionRegistry }, { ExchangeStore }] = await modules();
  const sessions = SessionRegistry.at(path.join(dir, 'sessions.json'));
  sessions.register({ id: 'source', provider: 'claude', cwd: dir });
  sessions.register({ id: 'target', provider: 'codex', cwd: dir });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'exchanges.json'), JSON.stringify([{
    id: 'legacy', sourceSessionId: 'source', targetSessionId: 'target', question: 'old', context: '',
    status: 'queued', answer: null, attempts: [{ direction: 'request', transport: 'codex_queue', outcome: 'failed', at: now, detail: 'old failure' }],
    createdAt: now, updatedAt: now,
  }]));
  const row = ExchangeStore.at(sessions, path.join(dir, 'exchanges.json')).all()[0];
  assert.deepEqual(row.retryRequested, { request: false, answer: false });
  assert.equal(row.attempts[0].trigger, 'automatic');
});

test('session-bound identity blocks another session from receiving a request', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [{ SessionRegistry }, { ExchangeStore }] = await modules();
  const sessions = SessionRegistry.at(path.join(dir, 'sessions.json'));
  const exchanges = ExchangeStore.at(sessions, path.join(dir, 'exchanges.json'));
  for (const id of ['a', 'b', 'c']) sessions.register({ id, provider: 'claude', cwd: dir });
  const row = exchanges.send('a', { targetSessionId: 'b', question: 'private request' });
  assert.throws(() => exchanges.receive(row.id, 'c'), /does not belong/);
});

test('cross-workspace delivery requires an explicit opt-in', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cwd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [{ SessionRegistry }, { ExchangeStore }] = await modules();
  const sessions = SessionRegistry.at(path.join(dir, 'sessions.json'));
  const exchanges = ExchangeStore.at(sessions, path.join(dir, 'exchanges.json'));
  sessions.register({ id: 'a', provider: 'claude', cwd: path.join(dir, 'one') });
  sessions.register({ id: 'b', provider: 'codex', cwd: path.join(dir, 'two') });
  assert.throws(() => exchanges.send('a', { targetSessionId: 'b', question: 'q' }), /Different workspaces/);
  assert.equal(exchanges.send('a', { targetSessionId: 'b', question: 'q', allowCrossWorkspace: true }).status, 'queued');
});
