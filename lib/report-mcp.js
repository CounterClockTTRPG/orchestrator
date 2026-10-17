#!/usr/bin/env node
// MCP server handed to each subagent: reports go back to the Archmage through the guild server.
// The server passes its URL, the agent's identity and the quest's secret in the environment.

import { serveMcp, api as rawApi } from './mcp.js';

const { GUILD_URL, GUILD_QUEST_ID, GUILD_AGENT_ID, GUILD_SECRET } = process.env;
const base = `/internal/quests/${GUILD_QUEST_ID}/agents/${GUILD_AGENT_ID}`;
const api = (url, method, p, body) => rawApi(url, method, p, body, { headers: { 'x-guild-secret': GUILD_SECRET } });

serveMcp({
  name: 'guild',
  instructions: 'You are a member of a party led by the Archmage. Report with report_progress; use ask when blocked.',
  tools: [
    {
      name: 'report_progress',
      description:
        'Send a short dispatch to the Archmage (the orchestrator) about your progress. Call it when you start, ' +
        'after each meaningful step, and once at the end with percent 100.',
      inputSchema: {
        type: 'object',
        properties: {
          percent: { type: 'number', minimum: 0, maximum: 100, description: 'Estimated completion, 0-100' },
          phase: { type: 'string', description: 'A few words naming the current step, e.g. "reading the parser"' },
          message: { type: 'string', description: 'One or two sentences: what you found or did since the last report' },
        },
        required: ['percent', 'message'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const { notes } = await api(GUILD_URL, 'POST', `${base}/report`, args);
        return notes?.length
          ? `Dispatch received. Messages for you:\n${notes.map((n) => `- ${n}`).join('\n')}`
          : 'Dispatch received. Carry on.';
      },
    },
    {
      name: 'attach_file',
      description: 'Show the human a file you made: a screenshot, a rendered page, a chart, a PDF or a written report. Images, PDFs, HTML, markdown and text are previewed in the interface; other files can be downloaded. The file must be in your working directory or the temp folder, at most 20 MB.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file, absolute or relative to your working directory' },
          caption: { type: 'string', description: 'One line saying what it shows, e.g. "Title screen, tablet layout"' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args) => (await api(GUILD_URL, 'POST', `${base}/attach`, args)).text,
    },
    {
      name: 'ask',
      description:
        'Ask the Archmage (or the human overseeing the quest) a question when you are blocked and cannot ' +
        'reasonably decide yourself. Waits for the answer and returns it.',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string', description: 'The question, with the context needed to answer it' } },
        required: ['question'],
        additionalProperties: false,
      },
      handler: async ({ question }) => {
        // Register the question, then long-poll in short slices (fetch gives up on headers after 300 s).
        const { askId } = await api(GUILD_URL, 'POST', `${base}/ask`, { question });
        for (;;) {
          const r = await api(GUILD_URL, 'GET', `${base}/ask/${askId}?wait=50`);
          if (r.answer !== undefined) return `Answer: ${r.answer}`;
        }
      },
    },
  ],
});
