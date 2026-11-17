const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SessionStore } = require('../dist/state');
const { ExchangeStore } = require('../dist/exchanges');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myade-exchange-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = new SessionStore(path.join(dir, 'state.json'));
  const cwd = path.join(dir, '문서 작업');
  sessions.registerStart({ paneId: 'a', cwd });
  sessions.registerStart({ paneId: 'b', cwd });
  const file = path.join(dir, 'exchanges.json');
  const store = new ExchangeStore(sessions, file);
  const send = () => store.send({ sourcePaneId: 'a', targetPaneId: 'b', question: '기획 대안은?', context: '가설과 제약' });
  return { sessions, store, send, file, cwd, dir };
}

test('non-Git workspace roundtrip, summaries, replay and persistence', t => {
  const { sessions, store, send, file } = setup(t);
  const r = send();
  assert.equal(r.status, 'queued');
  assert.equal(store.list('b')[0].context, undefined);
  assert.throws(() => store.reply(r.id, 'b', 'too early'), /Receive/);
  assert.throws(() => store.collect(r.id, 'a'), /No answer/);
  assert.equal(store.receive(r.id, 'b').context, '가설과 제약');
  store.reply(r.id, 'b', '결론·근거·불확실성');
  store.reply(r.id, 'b', '결론·근거·불확실성');
  assert.throws(() => store.reply(r.id, 'b', 'overwrite'), /overwritten/);
  assert.equal(new ExchangeStore(sessions, file).collect(r.id, 'a').answer, '결론·근거·불확실성');
  const reloaded = new ExchangeStore(sessions, file);
  assert.equal(reloaded.collect(r.id, 'a').status, 'collected');
  assert.throws(() => reloaded.cancel(r.id, 'a'), /Already collected/);
});

test('wrong recipient, cross-workspace, self-send, ended pane and bounds', t => {
  const { sessions, store, send, dir } = setup(t);
  const r = send();
  assert.throws(() => store.receive(r.id, 'a'), /belong/);
  assert.throws(() => store.reply(r.id, 'a', 'x'), /belong/);
  assert.throws(() => store.send({ sourcePaneId: 'a', targetPaneId: 'a', question: 'x' }), /different target/);
  sessions.registerStart({ paneId: 'c', cwd: path.join(dir, 'other') });
  assert.throws(() => store.send({ sourcePaneId: 'a', targetPaneId: 'c', question: 'x' }), /Different workspaces/);
  assert.equal(store.send({ sourcePaneId: 'a', targetPaneId: 'c', question: 'x', allowCrossWorkspace: true }).status, 'queued');
  assert.throws(() => store.send({ sourcePaneId: 'a', targetPaneId: 'b', question: ' '.repeat(2) }));
  assert.throws(() => store.send({ sourcePaneId: 'a', targetPaneId: 'b', question: 'x', context: 'x'.repeat(24001) }));
  sessions.registerEnd('b');
  assert.throws(send, /ended pane/);
});

test('cancel is explicit, does not fabricate an answer', t => {
  const { store, send } = setup(t);
  const r = send();
  store.cancel(r.id, 'a');
  assert.throws(() => store.receive(r.id, 'b'), /no longer pending/);
  assert.throws(() => store.collect(r.id, 'a'), /No answer/);
});

test('CLI replacement invalidates old requests but permits cancellation', t => {
  const { sessions, store, send, cwd } = setup(t);
  const r = send();
  sessions.onSessionStart({ myadePaneId: 'b', session_id: 'new-b', cwd, hook_event_name: 'SessionStart' });
  assert.equal(store.list('b')[0].sessionChanged, true);
  assert.throws(() => store.receive(r.id, 'b'), /session changed/);
  store.cancel(r.id, 'a');
});

test('stable identity separates same-directory panes and survives clear/restart', t => {
  const { sessions, cwd } = setup(t);
  const start = (paneId, id) => sessions.onSessionStart({ myadePaneId: paneId, session_id: id, cwd, hook_event_name: 'SessionStart' });
  assert.equal(start('a', 's1').paneId, 'a');
  assert.equal(start('b', 's2').paneId, 'b');
  sessions.onSessionEnd({ session_id: 's1', cwd, hook_event_name: 'SessionEnd' });
  assert.equal(start('a', 's3').paneId, 'a');
  assert.equal(sessions.list().length, 2);
  assert.equal(sessions.find('a')[0].ended, false);
  assert.throws(() => sessions.onStop({ myadePaneId: 'a', session_id: 's1', cwd, hook_event_name: 'Stop' }), /previous session/);
  assert.throws(() => start('unknown', 's4'), /Unknown explicit/);
  assert.equal(sessions.list().length, 2);
  assert.throws(() => sessions.registerStart({ paneId: 'a', cwd }), /already registered/);
});

test('corrupt storage fails explicitly; failed writes do not commit in memory', t => {
  const { sessions, file, dir } = setup(t);
  fs.writeFileSync(file, 'bad JSON');
  assert.throws(() => new ExchangeStore(sessions, file));
  const blocked = path.join(dir, 'not-a-directory');
  const store = new ExchangeStore(sessions, path.join(blocked, 'mail.json'));
  fs.writeFileSync(blocked, 'file');
  assert.throws(() => store.send({ sourcePaneId: 'a', targetPaneId: 'b', question: 'x' }));
  assert.deepEqual(store.list('a'), []);
});
