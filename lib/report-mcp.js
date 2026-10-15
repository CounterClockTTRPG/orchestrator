#!/usr/bin/env node
// MCP server handed to each subagent: reports go back to the Archmage through the guild server.
// The server passes its URL and the agent's identity in the environment.

import { serveMcp, api } from './mcp.js';

const { GUILD_URL, GUILD_QUEST_ID, GUILD_AGENT_ID } = process.env;
const base = `/internal/quests/${GUILD_QUEST_ID}/agents/${GUILD_AGENT_ID}`;

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
