import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Integration with work outside the quest: a target branch to deliver to, outside branches merged in before
// finishing, and check-ins only the human may answer.

let Guild, Quest, store, G;
before(async () => {
  process.env.GUILD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-test-'));
  process.env.GUILD_CLAUDE_BIN = '/nonexistent/claude';
  ({ Guild, Quest } = await import('../lib/guild.js'));
  store = await import('../lib/store.js');
  G = await import('../lib/git.js');
});

const commitAll = (dir, msg) => G.git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', msg);

async function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-int-'));
  await G.git(dir, 'init', '-q', '-b', 'main');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(dir, f), 'base\n');
  await G.git(dir, 'add', '-A');
  await commitAll(dir, 'init');
  return dir;
}

test('fast-forward: moves a checked-out branch with its files, refuses over changes or when not a fast-forward', async () => {
  const dir = await repo();
  const wt = path.join(dir, '..', `${path.basename(dir)}-work`);
  await G.addWorktree(dir, wt, 'result', 'main');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'result\n');
  await commitAll(wt, 'result');

  fs.writeFileSync(path.join(dir, 'b.txt'), 'local edit\n');
  await assert.rejects(G.fastForward(dir, 'main', 'result'), /uncommitted changes/);
  await G.git(dir, 'checkout', '-q', '--', 'b.txt');
  const r = await G.fastForward(dir, 'main', 'result');
  assert.equal(r.dir, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'result\n', 'the checkout follows');

  await G.git(dir, 'branch', 'side', 'main~1');
  fs.writeFileSync(path.join(wt, 'c.txt'), 'more\n');
  await commitAll(wt, 'more');
  await G.fastForward(dir, 'side', 'result'); // not checked out: only the ref moves
  assert.equal(await G.resolve(dir, 'side'), await G.resolve(dir, 'result'));

  fs.writeFileSync(path.join(dir, 'b.txt'), 'main moved\n');
  await commitAll(dir, 'main moved');
  await assert.rejects(G.fastForward(dir, 'main', 'result'), /moved on/);
});

async function editQuest(id, dir, sync) {
  fs.mkdirSync(path.join(store.questDir(id), 'mcp'), { recursive: true });
  const base = await G.resolve(dir, 'main');
  const integrationDir = path.join(store.WORKTREES_DIR, id, '_archmage');
  await G.addWorktree(dir, integrationDir, `guild/${id}/party`, base);
  const q = new Quest(new Guild({ port: 0 }), {
    id, goal: 'g', status: 'questing', planning: 'auto', mode: 'edit', theme: 'fantasy', maxAgents: 6, cwd: dir,
    repo: { root: dir, base, branch: `guild/${id}/party`, integrationDir, target: 'main', sync, deliver: 'offer' },
    agents: [], log: [], roles: {}, merged: [], archmage: { name: 'Velothar', status: 'waiting', workdir: integrationDir },
    checkIn: '',
  });
  q.tell = () => {};
  return { q, integrationDir };
}

test('outside work is merged in before finishing, then the result can fast-forward the target', async () => {
  const dir = await repo();
  const { q, integrationDir } = await editQuest('i1', dir, ['main']);
  fs.writeFileSync(path.join(integrationDir, 'a.txt'), 'party work\n');
  await commitAll(integrationDir, 'party work');

  // Someone works on main meanwhile.
  fs.writeFileSync(path.join(dir, 'b.txt'), 'outside work\n');
  await commitAll(dir, 'outside work');
  await assert.rejects(q.finish('Done.'), /main has new work from outside the quest: call merge_party/);
  assert.match(await q.mergeParty(), /merged the latest main \(work outside the quest\)/);
  assert.equal(fs.readFileSync(path.join(integrationDir, 'b.txt'), 'utf8'), 'outside work\n');

  // A clash with outside work surfaces as a conflict for the Archmage.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'outside edit of a\n');
  await commitAll(dir, 'outside a');
  assert.match(await q.mergeParty(), /CONFLICT merging the latest main .* in a\.txt/);
  fs.writeFileSync(path.join(integrationDir, 'a.txt'), 'party work\noutside edit of a\n');
  await G.git(integrationDir, 'add', 'a.txt');
  await commitAll(integrationDir, 'resolve');
  assert.doesNotMatch(await q.mergeParty(), /CONFLICT/);

  q.finish('Done.');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(q.s.status, 'done');
  assert.equal(q.s.delivery.status, 'ready');
  await q.deliver('you');
  assert.equal(q.s.delivery.status, 'delivered');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'party work\noutside edit of a\n');
  assert.match(q.s.log.at(-1).text, /Fast-forwarded main/);
});

test('a target that moves after the last merge is reported, not forced', async () => {
  const dir = await repo();
  const { q, integrationDir } = await editQuest('i2', dir, []);
  q.s.repo.deliver = 'auto';
  fs.writeFileSync(path.join(integrationDir, 'a.txt'), 'party\n');
  await commitAll(integrationDir, 'party');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'late outside work\n');
  await commitAll(dir, 'late');
  q.finish('Done.');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(q.s.delivery.status, 'moved');
  await assert.rejects(q.deliver('you'), /moved on/);
});

test('quest creation checks the target and defaults it to the branch checked out there', async () => {
  const dir = await repo();
  const g = new Guild({ port: 0 });
  const begin = Quest.prototype.begin;
  Quest.prototype.begin = async function () {};
  try {
    await assert.rejects(g.createQuest({ goal: 'g', cwd: dir, mode: 'edit', target: 'nope' }), /no branch "nope"/);
    await assert.rejects(g.createQuest({ goal: 'g', cwd: dir, mode: 'edit', sync: 'missing' }), /no branch or ref "missing"/);
    const q = await g.createQuest({ goal: 'g', cwd: dir, mode: 'edit', sync: 'main' });
    assert.equal(q.s.repo.target, 'main');
    assert.deepEqual(q.s.repo.sync, ['main']);
    assert.equal(q.s.checkIn, g.settings.checkIn);
    await G.git(dir, 'branch', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'only on main\n');
    await commitAll(dir, 'main only');
    const f = await g.createQuest({ goal: 'g', cwd: dir, mode: 'edit', target: 'feature', checkIn: '' });
    assert.equal(f.s.repo.base, await G.resolve(dir, 'feature'), 'the party starts from the target');
    assert.equal(f.s.checkIn, '');
  } finally {
    Quest.prototype.begin = begin;
  }
});

test('a check-in waits for the human: the Archmage cannot answer it', async () => {
  fs.mkdirSync(store.questDir('c1'), { recursive: true });
  const q = new Quest(new Guild({ port: 0 }), {
    id: 'c1', goal: 'g', status: 'questing', planning: 'auto', mode: 'read', theme: 'fantasy', maxAgents: 6,
    agents: [], log: [], roles: {}, merged: [], archmage: { name: 'Velothar', status: 'waiting' },
    checkIn: 'Ask before changing any balance number by more than 20%.',
  });
  q.schedule = (a) => { a.status = 'working'; };
  const told = [];
  q.tell = (t) => told.push(t);
  q.proposePlan({ summary: 's', agents: [{ role: 'implementer', title: 'Balance', task: 'Tune the fights.' }] });
  assert.match(q.agentSystemPrompt(q.s.agents[0], q.guild.role('implementer')), /call mcp__guild__ask with human: true/);
  assert.match(q.archmageSystemPrompt(), /Do not make or approve such a change yourself/);

  const { askId } = q.ask('a1', 'Cut the conduit chance from 30% to 10%?', true);
  assert.equal(q.s.agents[0].checkIn, true);
  assert.match(told.at(-1), /\[check-in\][^]*Only the human can answer/);
  assert.match(q.answerAgent('a1', 'Yes, do it.', 'archmage'), /only the human can answer/);
  assert.equal(q.asks.get(askId).answer, undefined);
  q.answerAgent('a1', 'Keep 30%.', 'you');
  assert.equal(q.asks.get(askId).answer, '(from the human) Keep 30%.');
  assert.equal(q.s.agents[0].checkIn, false);
});
