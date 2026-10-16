import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The real server on a spare port, with a GUILD_HOME holding one quest that was running when it last stopped.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 17000 + Math.floor(Math.random() * 2000);
const URL_ = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-http-'));
  const dir = path.join(home, 'quests', 'q1');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'quest.json'), JSON.stringify({
    id: 'q1', goal: 'g', cwd: home, mode: 'read', planning: 'auto', status: 'questing', createdAt: ts, updatedAt: ts,
    agents: [], log: [], archmage: { name: 'Velothar', status: 'thinking', sessionId: 's' }, seq: 1,
  }));
  // The log is one event ahead of quest.json, as after a crash.
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [1, 2].map((seq) => JSON.stringify({ type: 'log', quest: 'q1', seq, entry: { text: `e${seq}` } })).join('\n') + '\n');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, GUILD_HOME: home, GUILD_PORT: String(PORT), GUILD_HOST: '127.0.0.1', GUILD_CLAUDE_BIN: '/nonexistent' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${URL_}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the server did not start');
});
after(() => server?.kill());

const post = (p, body, headers = {}) => fetch(URL_ + p, { method: 'POST', headers, body });

test('a JSON body must say it is JSON', async () => {
  const r = await post('/api/quests', JSON.stringify({ goal: 'x', cwd: '/nonexistent' }), { 'content-type': 'text/plain' });
  assert.equal(r.status, 415);
  const ok = await post('/api/quests', JSON.stringify({ goal: 'x', cwd: '/nonexistent' }), { 'content-type': 'application/json' });
  assert.match((await ok.json()).error, /Not a directory/);
});

test('cross-site requests are refused', async () => {
  const r = await post('/api/quests', '{}', { 'content-type': 'application/json', origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const same = await post('/api/quests', '{}', { 'content-type': 'application/json', origin: URL_ });
  assert.equal(same.status, 400); // past the guard: "A quest needs a goal."
});

test('an interrupted quest is listed as such, and a body-less POST still works', async () => {
  const q = await (await fetch(`${URL_}/api/quests/q1`)).json();
  assert.equal(q.status, 'interrupted');
  assert.equal(q.seq, 2, 'numbering carries on from the event log');
  const r = await post('/api/quests/q1/cancel');
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not running/);
});

async function firstEvents(query, headers = {}, want = 1) {
  const ctl = new AbortController();
  const res = await fetch(`${URL_}/api/quests/q1/events${query}`, { headers, signal: ctl.signal });
  const reader = res.body.getReader();
  let text = '';
  while ((text.match(/\n\n/g) ?? []).length < want) text += new TextDecoder().decode((await reader.read()).value);
  ctl.abort();
  return text.split('\n\n').filter(Boolean).map((block) => Object.fromEntries(block.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)])));
}

test('the event stream replays what a reconnecting client missed', async () => {
  const [snap] = await firstEvents('');
  assert.equal(snap.event, 'snapshot');
  assert.equal(snap.id, '2');
  const replay = await firstEvents('?since=0', {}, 2);
  assert.deepEqual(replay.slice(0, 2).map((e) => [e.id, e.event]), [['1', 'log'], ['2', 'log']]);
  const [one] = await firstEvents('', { 'last-event-id': '1' });
  assert.equal(one.id, '2');
});
