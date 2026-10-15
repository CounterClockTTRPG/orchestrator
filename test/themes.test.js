import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { themedName, themedRole, THEME_IDS } from '../web/themes.js';

let Quest;
before(async () => {
  process.env.GUILD_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'guild-test-'));
  ({ Quest } = await import('../lib/guild.js'));
});

test('themed names are deterministic and unique; fantasy defers to race names', () => {
  assert.equal(themedName('fantasy', new Set(), 's'), null);
  const a = themedName('scifi', new Set(), 'q1:0');
  assert.equal(themedName('scifi', new Set(), 'q1:0'), a);
  const taken = new Set();
  for (let i = 0; i < 80; i++) taken.add(themedName('modern', taken, `q:${i}`));
  assert.equal(taken.size, 80);
});

test('themed roles change only the look', () => {
  const smith = { title: 'Smith', describe: 'stout dwarf', tools: 'edit', prompt: 'Implement.' };
  assert.equal(themedRole('fantasy', 'implementer', smith), smith);
  assert.equal(themedRole(undefined, 'implementer', smith), smith);
  const eng = themedRole('modern', 'implementer', smith);
  assert.equal(eng.title, 'Engineer');
  assert.doesNotMatch(eng.describe, /dwarf/);
  assert.equal(eng.tools, 'edit');
  assert.equal(eng.prompt, 'Implement.');
  const odd = themedRole('scifi', 'cartographer', { title: 'Cartographer', describe: 'centaur sage' });
  assert.equal(odd.title, 'Cartographer');
  assert.doesNotMatch(odd.describe, /centaur/);
  for (const id of THEME_IDS) assert.ok(themedRole(id, 'archmage', { title: 'Archmage' }).title);
});

test("a quest's theme picks its agents' names and the leader's voice", () => {
  fs.mkdirSync(path.join(process.env.GUILD_HOME, 'quests', 'q2'), { recursive: true });
  const roles = { archmage: { orchestrator: true, title: 'Archmage' }, researcher: { title: 'Scout', describe: 'tabaxi rogue', tools: 'read' } };
  const guild = { settings: { batchSeconds: 0 }, roles, emit() {}, role: (id) => roles[id], enqueue() {} };
  const q = new Quest(guild, {
    id: 'q2', goal: 'g', status: 'questing', planning: 'auto', mode: 'read', maxAgents: 6, theme: 'scifi',
    agents: [], log: [], roles: {}, archmage: { name: 'Vega', title: 'Archmage', status: 'waiting' },
  });
  q.schedule = () => {};
  const a = q.recruit('researcher', 'look around');
  assert.ok(themedName('scifi', new Set(), 'x') !== null);
  assert.doesNotMatch(a.name, /\s|Whisker|Paw|Shadow/); // not a tabaxi name
  assert.match(q.archmageSystemPrompt(), /starship commander/);
});
