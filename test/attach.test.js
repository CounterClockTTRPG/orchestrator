import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Agents and the Archmage attach files (screenshots, reports) for the human; the server keeps a copy.

let Quest;
before(async () => {
  process.env.GUILD_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'guild-test-'));
  ({ Quest } = await import('../lib/guild.js'));
});

function quest() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-cwd-'));
  fs.mkdirSync(path.join(process.env.GUILD_HOME, 'quests', 'q3'), { recursive: true });
  const q = new Quest({ settings: {}, emit() {} }, {
    id: 'q3', goal: 'g', status: 'questing', planning: 'auto', mode: 'read', maxAgents: 6, cwd,
    log: [], roles: {}, archmage: { name: 'Velothar', status: 'waiting', workdir: cwd },
    agents: [{ id: 'a1', name: 'Balin', status: 'working' }],
  });
  return { q, cwd };
}

test('an agent attaches a file from its working directory', () => {
  const { q, cwd } = quest();
  fs.mkdirSync(path.join(cwd, 'shots'));
  fs.writeFileSync(path.join(cwd, 'shots', 'title.png'), 'PNGDATA');
  const out = q.attach('a1', { path: 'shots/title.png', caption: 'Title screen, tablet layout' });
  assert.match(out, /title\.png/);
  const [f] = q.s.attachments;
  assert.deepEqual([f.who, f.name, f.type, f.size, f.caption], ['a1', 'title.png', 'image/png', 7, 'Title screen, tablet layout']);
  const file = q.attachmentFile(f.id);
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'PNGDATA');
  fs.rmSync(cwd, { recursive: true }); // the copy outlives the worktree
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'PNGDATA');
  const e = q.s.log.at(-1);
  assert.deepEqual([e.who, e.kind, e.attachment, e.text], ['a1', 'attach', f.id, 'Title screen, tablet layout']);
});

test('the Archmage attaches too; files outside the allowed folders are refused', () => {
  const { q, cwd } = quest();
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shot-')), 'report.md');
  fs.writeFileSync(tmp, '# Report');
  q.attach('archmage', { path: tmp });
  assert.equal(q.s.attachments.at(-1).type, 'text/markdown; charset=utf-8');
  assert.throws(() => q.attach('a1', { path: '/etc/hostname' }), /outside/);
  assert.throws(() => q.attach('a1', { path: path.join(cwd, 'missing.png') }), /no file/i);
  fs.symlinkSync('/etc/hostname', path.join(cwd, 'sneaky.txt'));
  assert.throws(() => q.attach('a1', { path: 'sneaky.txt' }), /outside/);
});
