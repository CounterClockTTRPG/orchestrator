#!/usr/bin/env node
// MCP server handed to the Archmage: the tools it uses to lead the party.
// Every tool is forwarded to the guild server, which owns the agents.

import { serveMcp, api } from './mcp.js';

const { GUILD_URL, GUILD_QUEST_ID, GUILD_SECRET } = process.env;
const call = (tool, args) => api(GUILD_URL, 'POST', `/internal/quests/${GUILD_QUEST_ID}/council/${tool}`, args, { headers: { 'x-guild-secret': GUILD_SECRET } }).then((r) => r.text ?? r);

const newRole = {
  type: 'object',
  description: 'Only when no catalog role fits: define a new role.',
  properties: {
    id: { type: 'string', description: 'Short lowercase id, e.g. "cartographer"' },
    title: { type: 'string', description: 'Display title, e.g. "Cartographer"' },
    describe: { type: 'string', description: 'Portrait description: a race (human, elf, dwarf, orc, tabaxi, lizardfolk or centaur) and a look, e.g. "centaur sage with a pendant"' },
    tools: { type: 'string', enum: ['read', 'edit'] },
    prompt: { type: 'string', description: 'Standing instructions for agents of this role' },
  },
  required: ['id', 'title', 'tools', 'prompt'],
  additionalProperties: false,
};
const member = {
  type: 'object',
  properties: {
    role: { type: 'string', description: 'A role id from the catalog, or the id of a role in newRoles' },
    task: { type: 'string', description: 'A complete, self-contained task: what to do, where, and what to report back' },
  },
  required: ['role', 'task'],
  additionalProperties: false,
};
const agentId = { type: 'string', description: 'The agent id, as shown by list_party' };

serveMcp({
  name: 'council',
  tools: [
    {
      name: 'propose_plan',
      description: 'Propose the party for this quest. In review mode the human approves or edits it before anyone is dispatched; in auto mode the party is dispatched at once.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One or two sentences: the approach' },
          agents: { type: 'array', items: member, minItems: 1 },
          newRoles: { type: 'array', items: newRole },
        },
        required: ['summary', 'agents'],
        additionalProperties: false,
      },
      handler: (a) => call('propose_plan', a),
    },
    {
      name: 'recruit_agent',
      description: 'Recruit one more agent into the party (after the plan was approved), e.g. to follow up on a finding.',
      inputSchema: {
        type: 'object',
        properties: { ...member.properties, newRole },
        required: ['role', 'task'],
        additionalProperties: false,
      },
      handler: (a) => call('recruit_agent', a),
    },
    {
      name: 'message_agent',
      description: 'Send guidance to an agent. A working agent sees it at its next progress report; a finished agent is woken up with it and reports again.',
      inputSchema: { type: 'object', properties: { agentId, text: { type: 'string' } }, required: ['agentId', 'text'], additionalProperties: false },
      handler: (a) => call('message_agent', a),
    },
    {
      name: 'answer_agent',
      description: 'Answer a blocked agent\'s question.',
      inputSchema: { type: 'object', properties: { agentId, text: { type: 'string' } }, required: ['agentId', 'text'], additionalProperties: false },
      handler: (a) => call('answer_agent', a),
    },
    {
      name: 'cancel_agent',
      description: 'Stop an agent (stuck, redundant or going the wrong way).',
      inputSchema: { type: 'object', properties: { agentId, reason: { type: 'string' } }, required: ['agentId'], additionalProperties: false },
      handler: (a) => call('cancel_agent', a),
    },
    {
      name: 'ask_human',
      description: 'Ask the human a question only they can answer: a decision about installs, downloads, money, scope or risk. The question is shown to them and the party keeps working; end your turn after asking. Their answer arrives as a message.',
      inputSchema: { type: 'object', properties: { question: { type: 'string', description: 'One clear question, with the options if there are any' } }, required: ['question'], additionalProperties: false },
      handler: (a) => call('ask_human', a),
    },
    {
      name: 'attach_file',
      description: 'Show the human a file you made: a screenshot, a rendered page, a chart, a PDF or a written report. Images, PDFs, HTML, markdown and text are previewed in the interface; other files can be downloaded. The file must be in your working directory or the temp folder, at most 20 MB.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file, absolute or relative to your working directory' },
          caption: { type: 'string', description: 'One line saying what it shows' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      handler: (a) => call('attach_file', a),
    },
    {
      name: 'list_party',
      description: 'The current party: each agent\'s id, name, role, status, progress, last report and final report.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (a) => call('list_party', a),
    },
    {
      name: 'merge_party',
      description: 'Edit mode only: merge every finished agent\'s branch into the quest branch, in your working directory. On a conflict it stops and lists the files; resolve them, `git add` and `git commit`, then call merge_party again to continue.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (a) => call('merge_party', a),
    },
    {
      name: 'finish_quest',
      description: 'End the quest with the chronicle: the final answer for the human, in markdown. In edit mode, merge the party first.',
      inputSchema: {
        type: 'object',
        properties: { chronicle: { type: 'string', description: 'The final result in markdown' } },
        required: ['chronicle'],
        additionalProperties: false,
      },
      handler: (a) => call('finish_quest', a),
    },
  ],
});
