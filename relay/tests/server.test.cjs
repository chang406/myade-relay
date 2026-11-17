const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('HTTP server completes an isolated request roundtrip', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-http-'));
  const { startServer } = await import('../dist/src/server.js');
  const relay = await startServer({ port: 0, dataDir: dir, startDelivery: false });
  t.after(async () => { await relay.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = async (pathname, method = 'GET', value) => {
    const response = await fetch(relay.base + pathname, { method, headers: { 'content-type': 'application/json' }, body: value && JSON.stringify(value) });
    const text = await response.text();
    assert.equal(response.ok, true, text);
    return JSON.parse(text);
  };
  await call('/api/sessions', 'POST', { id: 'a', provider: 'claude', cwd: dir });
  await call('/api/sessions', 'POST', { id: 'b', provider: 'codex', cwd: dir });
  const sent = await call('/api/exchanges', 'POST', { sourceSessionId: 'a', targetSessionId: 'b', question: '2+2?' });
  assert.equal(sent.status, 'queued');
  await call(`/api/exchanges/${sent.id}/attempt`, 'POST', { sessionId: 'b', direction: 'request', transport: 'codex_queue', outcome: 'failed', detail: 'initial failure' });
  const retry = await call(`/api/exchanges/${sent.id}/retry`, 'POST', { sessionId: 'a', direction: 'request' });
  assert.equal(retry.retryRequested.request, true);
  assert.equal((await call(`/api/exchanges/${sent.id}/receive`, 'POST', { sessionId: 'b' })).status, 'accepted');
  assert.equal((await call(`/api/exchanges/${sent.id}/reply`, 'POST', { sessionId: 'b', answer: '4' })).status, 'replied');
  assert.equal((await call(`/api/exchanges/${sent.id}/collect`, 'POST', { sessionId: 'a' })).status, 'delivered');
});
