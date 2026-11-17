// Creates only isolated experiment data; leaves all evidence on disk.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const resume = process.argv[2];
  const dir = resume ? path.resolve(resume) : fs.mkdtempSync(path.join(root, 'node_modules', 'myade-p0-'));
  const probe = net.createServer();
  let port;
  if (resume) {
    port = Number(JSON.parse(fs.readFileSync(path.join(dir, 'lab.json'), 'utf8')).base.split(':').pop());
  } else {
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
  }
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, 'dist/server.js')], {
    env: { ...process.env, MYADE_DATA_DIR: dir, MYADE_PORT: String(port) }, windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.pipe(fs.createWriteStream(path.join(dir, 'daemon.log')));
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  process.on('SIGINT', () => child.kill());
  process.on('SIGTERM', () => child.kill());
  process.on('exit', () => child.kill());
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(base + '/health')).ok; } catch {}
    if (ready || child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 50));
  }
  if (!ready) { child.kill(); throw new Error('Isolated daemon did not start'); }
  for (const pane of resume ? [] : ['claude-p0', 'codex-p0']) {
    const response = await fetch(base + '/sessions/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paneId: pane, cwd: dir }) });
    if (!response.ok) { child.kill(); throw new Error(await response.text()); }
  }
  const adapter = path.join(__dirname, 'mailbox.cjs');
  if (!resume) fs.writeFileSync(path.join(dir, 'claude-mcp.json'), JSON.stringify({ mcpServers: { myade: {
    command: process.execPath, args: [adapter, base, 'claude-p0', 'channel', path.join(dir, 'claude-audit.jsonl')],
  } } }, null, 2));
  if (!resume) fs.writeFileSync(path.join(dir, 'lab.json'), JSON.stringify({ base, dir, adapter, node: process.execPath }, null, 2));
  console.log(JSON.stringify({ base, dir, adapter, node: process.execPath }));
  await once(child, 'exit');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
