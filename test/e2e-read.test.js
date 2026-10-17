import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startGuild } from './helpers/e2e.js';

// A full read quest through the real server, MCP servers and internal routes, with fake-claude as every session:
// the Archmage plans two scouts, they report and return, the Archmage writes the chronicle.

const archmage = {
  match: { archmage: true },
  steps: [
    { tool: 'Glob', input: { pattern: '**/*.js' } },
    { say: 'The map is unrolled; two scouts will do.' },
    {
      call: 'propose_plan', as: 'party',
      args: {
        summary: 'Two scouts map the code and the docs.',
        agents: [
          { key: 'code', role: 'researcher', title: 'Map the code', task: 'Map the code in ${cwd}. TASK-CODE' },
          { key: 'docs', role: 'researcher', title: 'Read the docs', task: 'Read the docs. TASK-DOCS' },
        ],
      },
    },
    { result: 'Plan proposed.', cost: 0.25 },
    { wait: ['\\(a1\\) has returned', '\\(a2\\) has returned'] },
    { call: 'list_party', as: 'roster' },
    { call: 'finish_quest', args: { chronicle: '# The map\n\nThe code lives in lib/; the docs in README.md.' } },
    { result: 'Done.', cost: 0.1 },
  ],
};

const scout = (task, report) => ({
  match: { role: 'Scout', task },
  steps: [
    { call: 'report_progress', args: { percent: 10, phase: 'setting out', message: `Starting ${task} as \${agentId}` } },
    { tool: 'Read', input: { file_path: 'README.md' } },
    { say: 'Reading.' },
    { call: 'report_progress', args: { percent: 100, message: 'All read.' } },
    { result: report, cost: 0.05 },
  ],
});

let h, repo;
before(async () => {
  h = await startGuild({ scenario: { sessions: [archmage, scout('TASK-CODE', 'Code: lib/guild.js:1 runs it all.'), scout('TASK-DOCS', 'Docs: README.md explains.')] } });
  repo = h.repo('lore', { 'README.md': '# Lore\n', 'lib/a.js': 'export const a = 1;\n' });
});
after(() => h?.stop());

test('a read quest: plan, dispatch, reports, finish and chronicle', async () => {
  const posted = await h.createQuest({ goal: 'Map the lore', cwd: repo });
  assert.equal(posted.status, 'planning');
  const q = await h.waitQuest(posted.id, 'done');

  assert.equal(q.plan.status, 'approved');
  assert.deepEqual(q.agents.map((a) => [a.id, a.status, a.percent, a.taskTitle]), [['a1', 'done', 100, 'Map the code'], ['a2', 'done', 100, 'Read the docs']]);
  assert.equal(q.agents[0].result, 'Code: lib/guild.js:1 runs it all.');
  assert.equal(q.agents[0].task, `Map the code in ${q.archmage.workdir}. TASK-CODE`, 'the Archmage works in the quest directory');
  assert.equal(q.agents[1].lastReport, 'All read.');
  assert.match(q.chronicle, /^# The map/);
  assert.equal(q.archmage.status, 'done');
  assert.ok(Math.abs(q.costUsd - 0.45) < 1e-9, `cost adds up across sessions (${q.costUsd})`);

  // What happened, as the log tells it.
  const said = q.log.filter((e) => e.who === 'archmage' && e.kind === 'say').map((e) => e.text);
  assert.ok(said.includes('The map is unrolled; two scouts will do.'));
  assert.ok(q.log.some((e) => e.who === 'a1' && e.kind === 'report' && /Starting TASK-CODE as a1/.test(e.text)), 'reports reach the quest through the internal route');
  assert.ok(q.log.some((e) => e.who === 'a2' && e.kind === 'done'));

  // The chronicle is a file of its own, and the stored event log ends with it.
  const dir = path.join(h.home, 'quests', q.id);
  assert.match(fs.readFileSync(path.join(dir, 'chronicle.md'), 'utf8'), /^# Map the lore\n\n# The map/);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === 'chronicle' && /The map/.test(e.chronicle)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'quest.json'), 'utf8')).status, 'done');

  // The Archmage was told of both returns, and its tools answered.
  const roster = h.toolCalls('list_party')[0].text;
  assert.match(roster, /a1: .* done, 100%/);
  assert.match(h.toolCalls('propose_plan')[0].text, /The party is dispatched:\n- a1: .+\n- a2: /);
  assert.equal(h.toolCalls('finish_quest')[0].isError, false);
});

test('sessions get the flags, tools and MCP servers Guild means them to have', async () => {
  const starts = h.starts();
  assert.equal(starts.length, 3);
  const [arch, ...rest] = starts;
  // The agents start in parallel, so their log lines come in either order.
  const party = rest.sort((a, b) => a.mcpServers.guild.env.GUILD_AGENT_ID.localeCompare(b.mcpServers.guild.env.GUILD_AGENT_ID));
  assert.match(arch.args.appendSystemPrompt, /leader of a guild party/);
  assert.equal(arch.args.model, 'opus');
  assert.ok(arch.args.allowedTools.includes('mcp__council__finish_quest'));
  assert.ok(!arch.args.allowedTools.includes('Edit'), 'read mode: no edit tools');
  assert.ok(arch.args.disallowedTools.includes('Task'));
  assert.equal(arch.args.permissionMode, undefined);
  assert.equal(arch.args.strictMcpConfig, true);
  assert.equal(arch.env.MCP_TOOL_TIMEOUT, '86400000');
  assert.equal(arch.env.CLAUDECODE, undefined, 'nested-session variables are stripped');
  assert.deepEqual(Object.keys(arch.mcpServers), ['council']);
  assert.match(arch.mcpServers.council.args[0], /lib\/council-mcp\.js$/);
  assert.equal(arch.mcpServers.council.env.GUILD_URL, h.url);
  assert.equal(arch.mcpServers.council.env.GUILD_SECRET, h.live(arch.mcpServers.council.env.GUILD_QUEST_ID).secret);
  assert.equal(arch.args.resume, undefined);

  for (const [i, s] of party.entries()) {
    assert.match(s.args.appendSystemPrompt, /the Scout in a guild party/);
    assert.match(s.args.appendSystemPrompt, /read-only task/);
    assert.equal(s.args.model, 'sonnet');
    assert.deepEqual(Object.keys(s.mcpServers), ['guild']);
    assert.equal(s.mcpServers.guild.env.GUILD_AGENT_ID, `a${i + 1}`);
    assert.ok(s.args.allowedTools.includes('mcp__guild__report_progress'));
    assert.ok(s.args.disallowedTools.includes('Edit') && s.args.disallowedTools.includes('Bash'));
    assert.equal(s.cwd, fs.realpathSync(repo));
  }
  // Every session exited by itself once Guild closed its input.
  const exits = await h.waitFor(() => h.fakeLog({ event: 'exit' }).length === 3 && h.fakeLog({ event: 'exit' }), { what: 'three exits' });
  assert.deepEqual(exits.map((e) => e.code), [0, 0, 0]);
});
