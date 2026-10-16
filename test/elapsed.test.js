import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentElapsed, questElapsed, duration } from '../web/elapsed.js';

const t0 = Date.parse('2026-10-16T10:00:00Z');
const at = (s) => new Date(t0 + s * 1000).toISOString();

test('durations read as seconds, minutes or hours', () => {
  assert.equal(duration(42_000), '42s');
  assert.equal(duration(185_000), '3m 05s');
  assert.equal(duration(4_020_000), '1h 07m');
  assert.equal(duration(null), '');
});

test('an agent counts from setting out to finishing, or to now while it works', () => {
  assert.equal(agentElapsed({ status: 'queued' }), null);
  assert.equal(agentElapsed({ status: 'working', startedAt: at(0) }, t0 + 90_000), 90_000);
  assert.equal(agentElapsed({ status: 'done', startedAt: at(0), finishedAt: at(60) }, t0 + 999_000), 60_000);
  // Woken by a message after it finished: counting again.
  assert.equal(agentElapsed({ status: 'working', startedAt: at(0), finishedAt: at(60) }, t0 + 120_000), 120_000);
  assert.equal(agentElapsed({ status: 'interrupted', startedAt: at(0), interruptedAt: at(30) }, t0 + 999_000), 30_000);
});

test('time the server was down is left out', () => {
  assert.equal(agentElapsed({ status: 'working', startedAt: at(0), pausedMs: 50_000 }, t0 + 80_000), 30_000);
  assert.equal(questElapsed({ createdAt: at(0), finishedAt: at(100), pausedMs: 40_000 }), 60_000);
  assert.equal(questElapsed({ createdAt: at(0) }, t0 + 5_000), 5_000);
});
