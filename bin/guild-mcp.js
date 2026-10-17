#!/usr/bin/env node
// MCP server for Claude Code sessions in other projects: start and follow guild quests.
//
//   claude mcp add guild -- node ~/claude/orchestrator/bin/guild-mcp.js
//
// GUILD_URL (http://127.0.0.1:7777) selects the server. If it is not running, this starts it.
// GUILD_TOKEN is the server's access token; a server on this machine needs none.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveMcp, api } from '../lib/mcp.js';
import { agentElapsed, questElapsed, duration } from '../web/elapsed.js';
import { agentTitle } from '../web/titles.js';
import { appForDir } from '../lib/apps.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const URL_ = process.env.GUILD_URL || `http://127.0.0.1:${process.env.GUILD_PORT || 7777}`;
const HOME = process.env.GUILD_HOME || path.join(os.homedir(), '.guild');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A remote server needs its token (from its GUILD_HOME/token); a local one also accepts the local file.
function token() {
  if (process.env.GUILD_TOKEN) return process.env.GUILD_TOKEN;
  try { return fs.readFileSync(path.join(HOME, 'token'), 'utf8').trim(); } catch { return undefined; }
}

async function up() {
  try { await api(URL_, 'GET', '/api/health', undefined, { timeoutMs: 1500 }); return true; } catch { return false; }
}

async function ensureServer() {
  if (await up()) return;
  const { hostname } = new URL(URL_);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
    throw new Error(`The guild server at ${URL_} is not reachable (it is on another host, so it can't be started from here).`);
  }
  fs.mkdirSync(HOME, { recursive: true });
  const log = fs.openSync(path.join(HOME, 'server.log'), 'a');
  const port = new URL(URL_).port || '7777';
  spawn(process.execPath, [path.join(ROOT, 'server.js')], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, GUILD_PORT: port } }).unref();
  for (let i = 0; i < 40; i++) { await sleep(250); if (await up()) return; }
  throw new Error(`Could not start the guild server; see ${path.join(HOME, 'server.log')}`);
}

const call = async (method, p, b) => {
  await ensureServer();
  const t = token();
  return api(URL_, method, p, b, { headers: t ? { 'x-guild-token': t } : {} });
};
const browserUrl = (id) => `${URL_.replace('127.0.0.1', 'localhost')}/#/quest/${id}`;

function status(q) {
  const lines = [
    `Quest ${q.id} — ${q.status}, ${duration(questElapsed(q))}${q.costUsd ? ` ($${q.costUsd.toFixed(2)})` : ''}${q.app ? ` · application ${q.app}` : ''}`,
    `Goal: ${q.goal}`,
    `Watch: ${browserUrl(q.id)}`,
  ];
  if (q.archmage?.thought) lines.push(`Archmage: ${q.archmage.thought}`);
  if (q.status === 'awaiting-approval') lines.push('The plan awaits approval in the browser.');
  for (const a of q.agents ?? []) {
    const t = agentElapsed(a);
    lines.push(`- ${a.name} the ${a.title} (${a.id}), “${agentTitle(a)}”: ${a.checkIn && a.status === 'blocked' ? 'CHECK-IN, needs the human' : a.status} ${a.percent}%${t == null ? '' : ` in ${duration(t)}`}${a.phase ? `, ${a.phase}` : ''}${a.question ? ` — asks: ${a.question}` : a.lastReport ? ` — ${a.lastReport}` : ''}`);
  }
  const repos = q.repos ?? (q.repo ? [{ name: 'repository', ...q.repo }] : []);
  if (repos.length && q.status === 'done') lines.push(`Branch for review: ${repos[0].branch}${repos.length > 1 ? ` in ${repos.map((r) => `${r.name} (${r.root})`).join(', ')}` : ''}`);
  return lines.join('\n');
}

function result(q) {
  let out = `${status(q)}\n\n## Chronicle\n\n${q.chronicle ?? '(none)'}`;
  const diffs = q.diffs ?? (q.diff ? [{ ...q.diff, repo: null, branch: q.repo?.branch }] : []);
  for (const d of diffs) if (d.stat) out += `\n\n## Changes${d.repo ? ` in ${d.repo}` : ''} (${d.branch ?? 'quest branch'})\n\n${d.stat}`;
  const party = q.repos?.[0]?.branch ?? q.repo?.branch;
  const deliveries = q.delivery ? (q.delivery.repos ?? [q.delivery]) : [];
  const lines = deliveries.filter((d) => d.target).map((d) => {
    const where = deliveries.length > 1 ? ` (${d.name})` : '';
    return {
      delivered: `${d.target}${where} was fast-forwarded to ${d.commit.slice(0, 8)}.`,
      ready: `${party} (${d.commit.slice(0, 8)}) can fast-forward ${d.target}${where}: call deliver_quest.`,
      moved: `${d.target}${where} moved on since the last merge: merge ${party} into it yourself.`,
    }[d.status] ?? '';
  }).filter(Boolean);
  if (lines.length) out += `\n\n## Delivery\n\n${lines.join('\n')}`;
  return out;
}

/** The application to use: the one named, none for 'none', else the one whose directories hold `cwd`. */
async function pickApp(app, cwd) {
  if (app === 'none') return null;
  if (app) return app;
  const apps = Object.fromEntries((await call('GET', '/api/applications')).map((a) => [a.id, a]));
  return appForDir(apps, cwd)?.id ?? null;
}

const id = { type: 'string', description: 'Quest id' };

serveMcp({
  name: 'guild',
  instructions: 'Guild runs a party of Claude Code agents led by an orchestrator (the Archmage) and shows it live in the browser. Start a quest, then wait_for_quest for the result.',
  tools: [
    {
      name: 'start_quest',
      description: 'Start a quest: the Archmage plans a party of agents, they work in parallel and report back, and the Archmage writes a chronicle (the result). Returns the quest id and a browser link to watch it.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the party should achieve, with any context it needs' },
          cwd: { type: 'string', description: 'Directory to work on (default: this project)' },
          app: { type: 'string', description: 'Application id (see list_applications): the party works on all its directories, briefed with its context and earlier quests. Default: the application that contains cwd, if any; "none" for just cwd' },
          mode: { type: 'string', enum: ['read', 'edit'], description: 'read: research only (default). edit: agents change code on branches; the result is a branch to review' },
          planning: { type: 'string', enum: ['review', 'auto'], description: 'review: the human approves the plan in the browser. auto: dispatch at once (default here, unless the application sets it)' },
          maxAgents: { type: 'number', description: 'Party size limit (default 6, or the application\'s)' },
          target: { type: 'string', description: 'Edit mode: the branch the result is for (default: the one checked out in cwd, or in each repository of an application). The party starts from it and its latest work is merged in before finishing' },
          sync: { type: 'array', items: { type: 'string' }, description: 'Edit mode: more branches with work in progress elsewhere, merged in before finishing so clashes surface inside the quest' },
          deliver: { type: 'string', enum: ['offer', 'auto'], description: 'Edit mode: auto fast-forwards the target when done; offer (default) waits for deliver_quest or the button' },
          checkIn: { type: 'string', description: 'Changes the party must ask the human about first, e.g. "any balance number by more than 20%" (default: the server setting; empty string for none)' },
        },
        required: ['goal'],
        additionalProperties: false,
      },
      handler: async ({ goal, cwd, app, mode, planning, maxAgents, target, sync, deliver, checkIn }) => {
        cwd = cwd || process.cwd();
        app = await pickApp(app, cwd);
        if (!planning) {
          const defaults = app ? (await call('GET', `/api/applications/${app}`)).defaults : {};
          planning = defaults.planning ?? 'auto';
        }
        const q = await call('POST', '/api/quests', { goal, cwd, app: app ?? undefined, mode, planning, maxAgents, target, sync, deliver, checkIn });
        return `Quest ${q.id} started (${q.mode}, ${q.planning} planning${app ? `, application ${app}: ${q.dirs.map((d) => d.name).join(', ')}` : ''}).\nWatch it at ${browserUrl(q.id)}\nUse wait_for_quest to get the result.`;
      },
    },
    {
      name: 'list_applications',
      description: 'Applications: named groups of directories (e.g. a backend and its client) that quests can work on together.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const apps = await call('GET', '/api/applications');
        return apps.map((a) => `${a.id}  ${a.name}${a.description ? ` — ${a.description}` : ''}\n  ${a.repos.map((r) => `${r.name}: ${r.path}`).join('\n  ')}`).join('\n') || 'No applications yet.';
      },
    },
    {
      name: 'quest_status',
      description: 'Current state of a quest: the Archmage, every agent\'s progress and last report.',
      inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
      handler: async ({ id }) => status(await call('GET', `/api/quests/${id}`)),
    },
    {
      name: 'wait_for_quest',
      description: 'Wait until the quest ends (or the timeout passes) and return the chronicle, or the current status on timeout.',
      inputSchema: {
        type: 'object',
        properties: { id, timeoutSec: { type: 'number', description: 'Max seconds to wait (default 600)' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id, timeoutSec = 600 }) => {
        const until = Date.now() + timeoutSec * 1000;
        for (;;) {
          const q = await call('GET', `/api/quests/${id}`);
          if (!['planning', 'awaiting-approval', 'questing'].includes(q.status)) return result(q);
          if (Date.now() > until) return `Still running after ${timeoutSec}s.\n\n${status(q)}`;
          await sleep(5000);
        }
      },
    },
    {
      name: 'list_quests',
      description: 'Recent quests with their status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const qs = await call('GET', '/api/quests');
        return qs.slice(0, 20).map((q) => `${q.id}  ${String(q.status ?? '?').padEnd(17)} ${q.app ? `[${q.app}] ` : ''}${String(q.goal ?? '').slice(0, 80)}`).join('\n') || 'No quests yet.';
      },
    },
    {
      name: 'message_quest',
      description: 'Send a message to the Archmage of a running quest, or to one agent with agentId.',
      inputSchema: {
        type: 'object',
        properties: { id, text: { type: 'string' }, agentId: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false,
      },
      handler: async ({ id, text, agentId }) => {
        if (agentId) return (await call('POST', `/api/quests/${id}/agents/${agentId}/message`, { text })).text;
        await call('POST', `/api/quests/${id}/message`, { text });
        return 'The Archmage has your message.';
      },
    },
    {
      name: 'resume_quest',
      description: 'Resume a quest that a server restart interrupted (status "interrupted"): the Archmage and the interrupted agents carry on from their sessions.',
      inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
      handler: async ({ id }) => `Quest ${id} resumed.\n\n${status(await call('POST', `/api/quests/${id}/resume`))}`,
    },
    {
      name: 'deliver_quest',
      description: 'Fast-forward a finished edit quest\'s target branch to its result (refused if the branch moved on, or is checked out with uncommitted changes).',
      inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
      handler: async ({ id }) => { const d = await call('POST', `/api/quests/${id}/deliver`); return `${d.target} is now at ${d.commit.slice(0, 8)}.`; },
    },
    {
      name: 'cancel_quest',
      description: 'Cancel a running quest and recall its party.',
      inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
      handler: async ({ id }) => { await call('POST', `/api/quests/${id}/cancel`); return `Quest ${id} cancelled.`; },
    },
  ],
});
