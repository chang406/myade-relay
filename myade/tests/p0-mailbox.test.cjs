const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pending, hint } = require('../experiments/p0/mailbox.cjs');

test('P0 notification candidates do not claim receipt or cross panes', () => {
  const rows = [
    { id: 'incoming', sourcePaneId: 'a', targetPaneId: 'b', status: 'queued', sessionChanged: false },
    { id: 'outgoing', sourcePaneId: 'b', targetPaneId: 'a', status: 'answered', sessionChanged: false },
    { id: 'received', sourcePaneId: 'a', targetPaneId: 'b', status: 'received', sessionChanged: false },
    { id: 'stale', sourcePaneId: 'a', targetPaneId: 'b', status: 'queued', sessionChanged: true },
  ];
  assert.deepEqual(pending(rows, 'b').map(row => row.id), ['incoming', 'outgoing']);
  assert.match(hint(rows[0]), /Use exchange_receive/);
  assert.doesNotMatch(hint(rows[0]), /has been received/i);
});
