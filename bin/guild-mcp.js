#!/usr/bin/env node
// MCP server for Claude Code sessions in other projects: start and follow guild quests.
//
//   claude mcp add guild -- node ~/claude/orchestrator/bin/guild-mcp.js
//
// GUILD_URL (http://127.0.0.1:7777) selects the server. If it is not running, this starts it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveMcp, api } from '../lib/mcp.js';
import { agentElapsed, questElapsed, duration } from '../web/elapsed.js';
import { agentTitle } from '../web/titles.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const URL_ = process.env.GUILD_URL || `http://127.0.0.1:${process.env.GUILD_PORT || 7777}`;
const HOME = process.env.GUILD_HOME || path.join(os.homedir(), '.guild');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const call = async (method, p, b) => { await ensureServer(); return api(URL_, method, p, b); };
const browserUrl = (id) => `${URL_.replace('127.0.0.1', 'localhost')}/#/quest/${id}`;

function status(q) {
  const lines = [
    `Quest ${q.id} — ${q.status}, ${duration(questElapsed(q))}${q.costUsd ? ` ($${q.costUsd.toFixed(2)})` : ''}`,
    `Goal: ${q.goal}`,
    `Watch: ${browserUrl(q.id)}`,
  ];
  if (q.archmage?.thought) lines.push(`Archmage: ${q.archmage.thought}`);
  if (q.status === 'awaiting-approval') lines.push('The plan awaits approval in the browser.');
  for (const a of q.agents ?? []) {
    const t = agentElapsed(a);
    lines.push(`- ${a.name} the ${a.title} (${a.id}), “${agentTitle(a)}”: ${a.checkIn && a.status === 'blocked' ? 'CHECK-IN, needs the human' : a.status} ${a.percent}%${t == null ? '' : ` in ${duration(t)}`}${a.phase ? `, ${a.phase}` : ''}${a.question ? ` — asks: ${a.question}` : a.lastReport ? ` — ${a.lastReport}` : ''}`);
  }
  if (q.repo?.branch && q.status === 'done') lines.push(`Branch for review: ${q.repo.branch}`);
  return lines.join('\n');
}

function result(q) {
  let out = `${status(q)}\n\n## Chronicle\n\n${q.chronicle ?? '(none)'}`;
  if (q.diff?.stat) out += `\n\n## Changes (${q.repo?.branch ?? 'quest branch'})\n\n${q.diff.stat}`;
  const d = q.delivery;
  if (d?.target) {
    out += `\n\n## Delivery\n\n${{
      delivered: `${d.target} was fast-forwarded to ${d.commit.slice(0, 8)}.`,
      ready: `${q.repo.branch} (${d.commit.slice(0, 8)}) can fast-forward ${d.target}: call deliver_quest.`,
      moved: `${d.target} moved on since the last merge: merge ${q.repo.branch} into it yourself.`,
    }[d.status] ?? ''}`;
  }
  return out;
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
          mode: { type: 'string', enum: ['read', 'edit'], description: 'read: research only (default). edit: agents change code on branches; the result is a branch to review' },
          planning: { type: 'string', enum: ['review', 'auto'], description: 'review: the human approves the plan in the browser. auto: dispatch at once (default here)' },
          maxAgents: { type: 'number', description: 'Party size limit (default 6)' },
          target: { type: 'string', description: 'Edit mode: the branch the result is for (default: the one checked out in cwd). The party starts from it and its latest work is merged in before finishing' },
          sync: { type: 'array', items: { type: 'string' }, description: 'Edit mode: more branches with work in progress elsewhere, merged in before finishing so clashes surface inside the quest' },
          deliver: { type: 'string', enum: ['offer', 'auto'], description: 'Edit mode: auto fast-forwards the target when done; offer (default) waits for deliver_quest or the button' },
          checkIn: { type: 'string', description: 'Changes the party must ask the human about first, e.g. "any balance number by more than 20%" (default: the server setting; empty string for none)' },
        },
        required: ['goal'],
        additionalProperties: false,
      },
      handler: async ({ goal, cwd, mode = 'read', planning = 'auto', maxAgents, target, sync, deliver, checkIn }) => {
        const q = await call('POST', '/api/quests', { goal, cwd: cwd || process.cwd(), mode, planning, maxAgents, target, sync, deliver, checkIn });
        return `Quest ${q.id} started (${mode}, ${planning} planning).\nWatch it at ${browserUrl(q.id)}\nUse wait_for_quest to get the result.`;
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
        return qs.slice(0, 20).map((q) => `${q.id}  ${String(q.status ?? '?').padEnd(17)} ${String(q.goal ?? '').slice(0, 80)}`).join('\n') || 'No quests yet.';
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
