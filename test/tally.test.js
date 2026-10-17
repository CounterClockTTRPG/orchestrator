import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questTally } from '../web/tally.js';

test('quests are counted per state for the application badges, in badge order, empty groups left out', () => {
  const qs = ['done', 'questing', 'planning', 'done', 'failed', 'awaiting-approval', 'done'].map((status) => ({ status }));
  assert.deepEqual(questTally(qs), [
    { key: 'awaiting-approval', n: 1 },
    { key: 'questing', n: 2 },
    { key: 'done', n: 3 },
    { key: 'failed', n: 1 },
  ]);
  assert.deepEqual(questTally([]), []);
});
