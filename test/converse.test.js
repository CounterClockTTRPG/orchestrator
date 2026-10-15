import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Conversation with the Archmage: replies to the human are marked `to: 'you'`, and ask_human
// questions are shown to the human and answered by their next message.

let Quest;
before(async () => {
  process.env.GUILD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-test-'));
  ({ Quest } = await import('../lib/guild.js'));
});

function questing() {
  fs.mkdirSync(path.join(process.env.GUILD_HOME, 'quests', 'q1'), { recursive: true });
  const guild = { settings: { batchSeconds: 0 }, emit() {} };
  const q = new Quest(guild, {
    id: 'q1', goal: 'g', status: 'questing', planning: 'review', mode: 'read', maxAgents: 6,
    agents: [], log: [], archmage: { name: 'Velothar', status: 'waiting' },
  });
  const sent = [];
  q.arch = { busy: false, send: (t) => { sent.push(t); return true; } };
  return { q, sent };
}

test('a reply to the human is addressed to them; later remarks are not', () => {
  const { q, sent } = questing();
  q.messageArchmage('Can you add a tester?');
  assert.match(sent[0], /Message from the human: Can you add a tester\?/);
  assert.equal(q.s.archmage.replying, true);
  q.onArchmageText('Gladly, I shall recruit one.');
  q.log('archmage', 'action', 'Recruited Hilda the Tester: write tests');
  q.onArchmageResult({});
  assert.equal(q.s.archmage.replying, false);
  q.onArchmageText('The party works on.');
  const [reply, action, remark] = q.s.log.filter((e) => e.who === 'archmage');
  assert.equal(reply.to, 'you');
  assert.equal(reply.kind, 'say');
  assert.equal(action.to, 'you');
  assert.equal(remark.to, undefined);
});

test('ask_human shows the question and the next message answers it', () => {
  const { q, sent } = questing();
  const out = q.council('ask_human', { question: 'May the party download Godot (400 MB)?' });
  assert.match(out, /end your turn/i);
  assert.equal(q.s.archmage.question, 'May the party download Godot (400 MB)?');
  const ask = q.s.log.at(-1);
  assert.deepEqual([ask.who, ask.kind, ask.to, ask.text], ['archmage', 'ask', 'you', 'May the party download Godot (400 MB)?']);
  q.messageArchmage('Yes, go ahead.');
  assert.match(sent.at(-1), /May the party download Godot \(400 MB\)\?/);
  assert.match(sent.at(-1), /Yes, go ahead\./);
  assert.equal(q.s.archmage.question, null);
});
