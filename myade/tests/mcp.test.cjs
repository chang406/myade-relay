const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

test('two MCP clients exchange a request through the real HTTP server', { timeout: 20000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'myade-mcp-test-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [path.resolve('dist/server.js')], {
    env: { ...process.env, MYADE_PORT: String(port), MYADE_DATA_DIR: temporary },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const closed = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await closed;
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { ready = (await fetch(`${base}/health`)).ok; } catch {}
    if (ready) break;
    if (child.exitCode !== null) throw new Error(errors);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, errors);
  const post = (route, body) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const paneId of ['a', 'b']) {
    assert.equal((await post('/sessions/start', { paneId, cwd: temporary })).status, 200);
    const response = await post('/hooks/session-start', {
      myadePaneId: paneId, session_id: `session-${paneId}`, cwd: temporary, hook_event_name: 'SessionStart',
    });
    const body = await response.json();
    assert.equal(body.paneId, paneId);
    assert.match(body.hookSpecificOutput.additionalContext, /exchange_send/);
  }
  assert.equal((await post('/sessions/start', { paneId: 'a', cwd: temporary })).status, 409);
  assert.equal((await post('/hooks/stop', {})).status, 400);
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); });
  for (const name of ['sender', 'receiver']) {
    const client = new Client({ name, version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  }
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  assert.ok((await clients[0].listTools()).tools.some(tool => tool.name === 'exchange_send'));
  const request = await call(clients[0], 'exchange_send', { sourcePaneId: 'a', targetPaneId: 'b', question: '문서 구조를 검토해줘' });
  assert.equal((await call(clients[1], 'exchange_list', { paneId: 'b' }))[0].id, request.id);
  await call(clients[1], 'exchange_receive', { paneId: 'b', requestId: request.id });
  await call(clients[1], 'exchange_reply', { paneId: 'b', requestId: request.id, answer: '목표를 먼저 설명하세요.' });
  assert.equal((await call(clients[0], 'exchange_collect', { paneId: 'a', requestId: request.id })).answer, '목표를 먼저 설명하세요.');
});
