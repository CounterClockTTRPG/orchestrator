#!/usr/bin/env node
// Guild server: REST + SSE API, the web UI, and the internal endpoints the agents' MCP tools call.
//
//   GUILD_PORT (7777)  GUILD_HOST (0.0.0.0)  GUILD_HOME (~/.guild)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Guild } from './lib/guild.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GUILD_PORT) || 7777;
const HOST = process.env.GUILD_HOST || '0.0.0.0';
const guild = new Guild({ port: PORT });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const STATIC = { '/web/': path.join(ROOT, 'web'), '/vendor/': path.join(ROOT, 'vendor') };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000_000) throw new HttpError(413, 'Body too large');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function serveStatic(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

function sse(req, res, onOpen) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  const cleanup = onOpen(send);
  req.on('close', () => { clearInterval(ping); cleanup(); });
}

const questOf = (id) => {
  const q = guild.quests.get(id);
  if (!q) throw new HttpError(404, `No quest ${id}`);
  return q;
};

// [method, pattern, handler(params, req, res, url)] — a handler returning a value sends it as JSON.
const routes = [
  ['GET', '/api/health', () => ({ ok: true, name: 'guild' })],
  ['GET', '/api/state', () => ({ settings: guild.settings, roles: guild.roles, quests: guild.list().map((q) => q.summary()) })],
  ['GET', '/api/events', (p, req, res) => sse(req, res, (send) => {
    send('state', { settings: guild.settings, roles: guild.roles, quests: guild.list().map((q) => q.summary()) });
    const on = (e) => send(e.type, e);
    guild.on('global', on);
    return () => guild.off('global', on);
  })],

  ['GET', '/api/quests', () => guild.list().map((q) => q.summary())],
  ['POST', '/api/quests', async (p, req) => (await guild.createQuest(await body(req))).state],
  ['GET', '/api/quests/:id', ({ id }) => questOf(id).state],
  ['GET', '/api/quests/:id/events', ({ id }, req, res) => {
    const q = questOf(id);
    sse(req, res, (send) => {
      send('snapshot', q.state);
      const on = (e) => { if (e.quest === id) send(e.type, e); };
      guild.on('quest', on);
      return () => guild.off('quest', on);
    });
  }],
  ['POST', '/api/quests/:id/plan/approve', async ({ id }, req) => ({ party: questOf(id).approvePlan((await body(req)).agents) })],
  ['POST', '/api/quests/:id/cancel', async ({ id }) => { await questOf(id).cancel(); return { ok: true }; }],
  ['POST', '/api/quests/:id/message', async ({ id }, req) => { questOf(id).messageArchmage(need((await body(req)).text)); return { ok: true }; }],
  ['POST', '/api/quests/:id/agents/:aid/cancel', ({ id, aid }) => ({ text: questOf(id).cancelAgent(aid, 'you') })],
  ['POST', '/api/quests/:id/agents/:aid/message', async ({ id, aid }, req) => ({ text: questOf(id).messageAgent(aid, need((await body(req)).text), 'you') })],
  ['POST', '/api/quests/:id/agents/:aid/answer', async ({ id, aid }, req) => ({ text: questOf(id).answerAgent(aid, need((await body(req)).text), 'you') })],

  ['GET', '/api/roles', () => guild.roles],
  ['PUT', '/api/roles', async (p, req) => guild.replaceRoles(await body(req))],
  ['POST', '/api/roles/:rid', async ({ rid }, req) => {
    const b = await body(req);
    const role = b.role ?? (b.quest && questOf(b.quest).state.roles[rid]);
    if (!role) throw new HttpError(400, 'Pass { role } or { quest } holding an invented role');
    return guild.saveRole(rid, role);
  }],
  ['GET', '/api/settings', () => guild.settings],
  ['PUT', '/api/settings', async (p, req) => guild.updateSettings(await body(req))],

  // Internal: called by the MCP servers of the Archmage and the party.
  ['POST', '/internal/quests/:id/agents/:aid/report', async ({ id, aid }, req) => questOf(id).report(aid, await body(req))],
  ['POST', '/internal/quests/:id/agents/:aid/ask', async ({ id, aid }, req) => questOf(id).ask(aid, need((await body(req)).question))],
  ['GET', '/internal/quests/:id/agents/:aid/ask/:askId', ({ id, askId }, req, res, url) => {
    questOf(id).waitAnswer(askId, Number(url.searchParams.get('wait')) || 30, (r) => json(res, 200, r));
  }],
  ['POST', '/internal/quests/:id/council/:tool', async ({ id, tool }, req) => {
    const out = await questOf(id).council(tool, await body(req));
    return { text: typeof out === 'string' ? out : JSON.stringify(out) };
  }],
].map(([method, pattern, handler]) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { method, re, keys, handler };
});

function need(text) {
  if (!String(text ?? '').trim()) throw new HttpError(400, 'Text is required');
  return String(text).trim();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, path.join(ROOT, 'web', 'index.html'));
    for (const [prefix, dir] of Object.entries(STATIC)) {
      if (req.method === 'GET' && p.startsWith(prefix)) {
        const file = path.join(dir, p.slice(prefix.length));
        if (!file.startsWith(dir + path.sep)) throw new HttpError(403, 'Forbidden');
        return serveStatic(res, file);
      }
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = p.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const out = await r.handler(params, req, res, url);
      if (out !== undefined && !res.headersSent) json(res, 200, out);
      return;
    }
    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (res.headersSent) return res.end();
    json(res, err.status ?? 400, { error: err.message });
  }
});

// Stop the Archmages and agents with the server; their quests show as interrupted on the next start.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const q of guild.quests.values()) {
      q.arch?.kill();
      for (const s of q.sessions.values()) s.kill();
    }
    setTimeout(() => process.exit(0), 300);
  });
}

server.requestTimeout = 0; // long-polls and SSE
server.listen(PORT, HOST, () => {
  console.log(`Guild is open at http://localhost:${PORT}/ (listening on ${HOST}:${PORT})`);
});
