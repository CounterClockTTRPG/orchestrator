import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Edit mode: an agent that waits for others starts on a branch that already holds their work.

let Guild, Quest, store, G;
before(async () => {
  process.env.GUILD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-test-'));
  process.env.GUILD_CLAUDE_BIN = '/nonexistent/claude'; // the session itself is not under test
  ({ Guild, Quest } = await import('../lib/guild.js'));
  store = await import('../lib/store.js');
  G = await import('../lib/git.js');
});

async function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-git-'));
  await G.git(dir, 'init', '-q');
  for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(dir, f), 'base\n');
  await G.git(dir, 'add', '-A');
  await G.git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return { dir, base: await G.git(dir, 'rev-parse', 'HEAD') };
}

async function doneWith(q, a, file, text) {
  const wt = path.join(store.WORKTREES_DIR, q.id, a.id);
  a.branch = `guild/${q.id}/${a.id}`;
  await G.addWorktree(q.s.repo.root, wt, a.branch, q.s.repo.base);
  fs.writeFileSync(path.join(wt, file), text);
  await G.commitLeftovers(wt, `${a.id} work`);
  Object.assign(a, { status: 'done', commits: 1, result: `Changed ${file}.` });
}

test('a dependent branch starts from its prerequisites and counts only its own commits', async () => {
  const { dir, base } = await repo();
  fs.mkdirSync(path.join(store.questDir('g1'), 'mcp'), { recursive: true });
  const q = new Quest(new Guild({ port: 0 }), {
    id: 'g1', goal: 'g', status: 'questing', planning: 'auto', mode: 'edit', theme: 'fantasy', maxAgents: 6, cwd: dir,
    repo: { root: dir, base, branch: 'guild/g1/party' }, agents: [], log: [], roles: {}, merged: [],
    archmage: { name: 'Velothar', status: 'waiting' },
  });
  const one = q.recruit('implementer', 'one');
  const two = q.recruit('implementer', 'two');
  const three = q.recruit('tester', 'three', { after: [one.id, two.id] });
  await doneWith(q, one, 'a.txt', 'one\n');
  await doneWith(q, two, 'b.txt', 'two\n');

  await q.startAgent(three, null);
  assert.equal(fs.readFileSync(path.join(three.dir, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(path.join(three.dir, 'b.txt'), 'utf8'), 'two\n');
  assert.equal(await G.commitCount(dir, three.startRef, three.branch), 0, 'their commits are not counted as its own');
  assert.match(q.handoff(three), /Their branch guild\/g1\/a1 is merged into yours/);
  q.sessions.get(three.id)?.kill();
});
