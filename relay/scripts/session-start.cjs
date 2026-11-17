// Optional provider hook: binds the real provider session id to the launcher-created relay session.
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const base = process.env.RELAY_BASE;
    const relaySession = process.env.RELAY_SESSION_ID;
    const providerSessionId = event.session_id || event.sessionId || event.thread_id || event.threadId;
    if (!base || !relaySession || !providerSessionId) throw new Error('RELAY_BASE, RELAY_SESSION_ID and provider session id are required');
    const response = await fetch(new URL(`/api/sessions/${encodeURIComponent(relaySession)}`, base), {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerSessionId, status: 'idle' }),
    });
    if (!response.ok) throw new Error(await response.text());
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Your relay session id is ${relaySession}. Use myade-relay tools for explicit cross-session requests.` } }));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
});
