const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('stdio MCP adapter binds tool identity to one relay session', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-adapter-'));
  const [{ startServer }, { Client }, { StdioClientTransport }] = await Promise.all([
    import('../dist/src/server.js'),
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  const relay = await startServer({ port: 0, dataDir: dir, startDelivery: false });
  relay.sessions.register({ id: 'source', provider: 'codex', cwd: dir });
  relay.sessions.register({ id: 'target', provider: 'claude', cwd: dir });
  const client = new Client({ name: 'relay-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist/src/cli.js'), 'adapter', '--base', relay.base, '--session', 'source'],
  });
  await client.connect(transport);
  t.after(async () => { await client.close(); await relay.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['relay_cancel', 'relay_collect', 'relay_list', 'relay_receive', 'relay_reply', 'relay_send']);
  const sent = await client.callTool({ name: 'relay_send', arguments: { targetSessionId: 'target', question: 'Bound identity?' } });
  assert.equal(sent.isError, undefined);
  assert.equal(relay.exchanges.all()[0].sourceSessionId, 'source');
  assert.equal(Object.hasOwn(tools.tools.find(tool => tool.name === 'relay_send').inputSchema.properties, 'sourceSessionId'), false);
});
