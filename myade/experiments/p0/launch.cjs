// Node argv avoids Windows PowerShell dropping empty arguments. No shell input injection.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [provider, binary, labDir, resumeThread] = process.argv.slice(2);
if (!['claude', 'codex'].includes(provider) || !binary || !labDir) throw new Error('launch.cjs claude|codex EXECUTABLE LAB_DIR');
const lab = JSON.parse(fs.readFileSync(path.join(labDir, 'lab.json'), 'utf8'));
const args = provider === 'claude' ? [
  '--setting-sources', 'local', '--strict-mcp-config', '--mcp-config', path.join(labDir, 'claude-mcp.json'),
  '--dangerously-load-development-channels', 'server:myade', '--tools', '',
] : [
  '--no-alt-screen', '--sandbox', 'read-only', '--ask-for-approval', 'on-request',
  '-c', `mcp_servers.myade.command=${JSON.stringify(lab.node)}`,
  '-c', `mcp_servers.myade.args=${JSON.stringify([lab.adapter, lab.base, 'codex-p0', 'manual', path.join(labDir, 'codex-audit.jsonl')])}`,
];
if (provider === 'codex' && resumeThread) args.push('resume', resumeThread);
const env = { ...process.env };
delete env.MYADE_CHARACTER_ID;
delete env.MYADE_PANE_ID;
delete env.MYADE_PORT;
const child = spawn(binary, args, { cwd: lab.dir, env, stdio: 'inherit', windowsHide: true });
child.on('error', e => { console.error(e); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
