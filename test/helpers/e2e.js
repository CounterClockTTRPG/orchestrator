// End-to-end harness: the real server in this process, on a random port, with a scratch GUILD_HOME, scratch git
// repositories and test/fixtures/fake-claude.js as the claude binary, following a scenario (see its header).
//
//   const h = await startGuild({ scenario: { sessions: [...] } });
//   const repo = h.repo('game', { 'a.txt': 'one\n' });
//   const q = await h.createQuest({ goal: 'Map it', cwd: repo });
//   const done = await h.waitQuest(q.id, 'done');
//   after(() => h.stop());
//
// GUILD_HOME and GUILD_CLAUDE_BIN are read when lib/store.js and lib/claude.js are first imported, so this module
// sets them and then imports the server: one Guild per test file (node --test runs each file in its own process).
// Import nothing from lib/ statically in a test file that uses it; take it from h (h.guild) or import it after
// startGuild. The scenario may change between quests (h.scenario): fake-claude reads it at each session start.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const FINAL = /^The quest (is complete|ended)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let started = false;

/** A git repository with one commit of `files` ({ path: content }) on main. */
export function makeRepo(dir, files = { 'README.md': '# Scratch\n' }) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@guild.test', ...a], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

/**
 * Start a scratch Guild.
 * @param {object} [o]
 * @param {object} [o.scenario]  fake-claude's scenario
 * @param {object} [o.settings]  written to settings.json before the Guild loads it (e.g. { maxConcurrent: 1 });
 *                               values are taken as they are, unclamped (batchSeconds: 0.1 is fine)
 * @param {string} [o.host]      address to listen on (default 127.0.0.1; '0.0.0.0' to test requests from another address)
 * @param {string} [o.token]     the API token (default 'test-token')
 * @param {Set<string>} [o.hosts] names the Host header may carry (default: this machine's, as in production)
 */
export async function startGuild({ scenario = { sessions: [] }, settings = {}, host = '127.0.0.1', token = 'test-token', hosts } = {}) {
  if (started) throw new Error('One Guild per test file: GUILD_HOME is fixed once lib/store.js is imported.');
  started = true;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guild-e2e-')));
  const home = path.join(root, 'home'), fake = path.join(root, 'fake'), scenarioFile = path.join(root, 'scenario.json');
  fs.mkdirSync(home);
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  Object.assign(process.env, { GUILD_HOME: home, GUILD_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_SCENARIO: scenarioFile, FAKE_CLAUDE_DIR: fake });

  const { createServer } = await import('../../server.js');
  const { Guild } = await import('../../lib/guild.js');
  const guild = new Guild({ port: 0 });
  const server = createServer(guild, { token, hosts });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  const { port } = server.address();
  // The MCP servers reach the guild on the loopback address, as in production.
  guild.port = port;
  guild.url = `http://127.0.0.1:${port}`;
  return new Harness({ root, home, fake, scenarioFile, guild, server, port, token });
}

class Harness {
  constructor(o) {
    Object.assign(this, o);
    this.url = `http://127.0.0.1:${o.port}`;
    this.repoCount = 0;
  }

  /** Replace the scenario for the sessions started from now on. */
  scenario(s) { fs.writeFileSync(this.scenarioFile, JSON.stringify(s)); }

  /** A scratch git repository (see makeRepo), under the harness's temp directory. */
  repo(name = `repo${++this.repoCount}`, files) { return makeRepo(path.join(this.root, 'repos', name), files); }

  /**
   * A raw request. `body`: an object is sent as JSON, a string as it is. `headers` are sent as given (set host to
   * test the Host check). `address`: where to connect (default 127.0.0.1), to come from another address.
   * Resolves to { status, headers, text, body } (body: the parsed JSON, or null).
   */
  request(method, p, { body, headers = {}, address = '127.0.0.1' } = {}) {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { host: `127.0.0.1:${this.port}`, ...(typeof body === 'object' ? { 'content-type': 'application/json' } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k]; // { 'content-type': undefined } sends none
    if (data !== undefined) h['content-length'] = Buffer.byteLength(data);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: address, port: this.port, method, path: p, headers: h }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, body: parsed });
        });
      });
      req.on('error', reject);
      req.end(data);
    });
  }

  /** A JSON call that must succeed: its body, or an Error with .status and the server's message. */
  async call(method, p, body, opts = {}) {
    const r = await this.request(method, p, { ...opts, body });
    if (r.status >= 400) throw Object.assign(new Error(`${method} ${p}: ${r.status} ${r.body?.error ?? r.text}`), { status: r.status, body: r.body });
    return r.body;
  }
  get(p, opts) { return this.call('GET', p, undefined, opts); }
  post(p, body = {}, opts) { return this.call('POST', p, body, opts); }
  put(p, body = {}, opts) { return this.call('PUT', p, body, opts); }
  del(p, opts) { return this.call('DELETE', p, undefined, opts); }

  /** POST /api/quests; read mode and automatic planning unless given. */
  createQuest(o) { return this.post('/api/quests', { mode: 'read', planning: 'auto', ...o }); }
  quest(id) { return this.get(`/api/quests/${id}`); }
  /** The in-process Quest object (secret, sessions, inbox…). */
  live(id) { return this.guild.quests.get(id); }

  /** Poll `fn` until it returns something truthy; a timeout throws with `what` and the last value described. */
  async waitFor(fn, { timeout = 10_000, interval = 40, what = 'a condition', describe = () => '' } = {}) {
    const end = Date.now() + timeout;
    let last;
    for (;;) {
      last = await fn();
      if (last) return last;
      if (Date.now() > end) throw new Error(`Timed out after ${timeout} ms waiting for ${what}. ${describe()}`);
      await sleep(interval);
    }
  }

  /**
   * Wait until the quest has `status` (or `pred(state)` holds). For done, failed and cancelled it also waits until
   * the quest has settled (worktrees cleaned up, chronicle event sent), so nothing runs on after the test.
   */
  async waitQuest(id, want, opts = {}) {
    const pred = typeof want === 'function' ? want
      : (s) => s.status === want && (!['done', 'failed', 'cancelled'].includes(want) || s.log.some((e) => e.who === 'guild' && FINAL.test(e.text)));
    let state;
    return this.waitFor(async () => { state = await this.quest(id); return pred(state) && state; }, {
      what: typeof want === 'function' ? `quest ${id} to match` : `quest ${id} to be ${want}`, ...opts,
      describe: () => (state ? describeQuest(state) : ''),
    });
  }

  /** Wait until an agent has `status` (or `pred(agent, state)` holds); resolves to the agent. */
  async waitAgent(id, agentId, want, opts = {}) {
    const pred = typeof want === 'function' ? want : (a) => a.status === want;
    let state;
    const s = await this.waitFor(async () => {
      state = await this.quest(id);
      const a = state.agents.find((x) => x.id === agentId);
      return a && pred(a, state) && state;
    }, { what: `agent ${agentId} of ${id} to be ${typeof want === 'function' ? 'as wanted' : want}`, ...opts, describe: () => (state ? describeQuest(state) : '') });
    return s.agents.find((x) => x.id === agentId);
  }

  /** fake-claude's log: { pid, event: start|script|message|tool|run|commit|result|mcp|exit|killed|hang|error, … }. */
  fakeLog(filter = {}) {
    let text = '';
    try { text = fs.readFileSync(path.join(this.fake, 'log.jsonl'), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => Object.entries(filter).every(([k, v]) => e[k] === v));
  }
  /** The MCP tool calls fake-claude made: [{ pid, server, tool, input, text, isError }]. */
  toolCalls(tool) { return this.fakeLog({ event: 'tool' }).filter((e) => !tool || e.tool === tool); }
  /** The start entries (argv, args, cwd, env, mcpServers) of the sessions, in order. */
  starts() { return this.fakeLog({ event: 'start' }); }

  /** Read an SSE stream until `until(events)` holds; events are { event, id, data }. */
  sse(p, { until = (ev) => ev.length > 0, timeout = 5000, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const events = [];
      let buf = '';
      const req = http.get({ host: '127.0.0.1', port: this.port, path: p, headers: { host: `127.0.0.1:${this.port}`, ...headers } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const e = {};
            for (const line of block.split('\n')) {
              const m = /^(\w+): ?(.*)$/.exec(line);
              if (m) e[m[1]] = m[1] === 'data' ? JSON.parse(m[2]) : m[2];
            }
            if (e.event) events.push(e);
          }
          if (until(events)) { clearTimeout(t); req.destroy(); resolve(events); }
        });
      });
      const t = setTimeout(() => { req.destroy(); reject(new Error(`SSE ${p}: timed out with ${events.length} events`)); }, timeout);
      req.on('error', (err) => { if (!req.destroyed) reject(err); });
    });
  }

  /**
   * Stop everything: quests are marked interrupted first (so no Archmage is revived), every session is killed and
   * awaited, the server is closed, leftover fake-claude and MCP processes are killed, and the temp files removed.
   */
  async stop() {
    const sessions = [];
    for (const q of this.guild.quests.values()) {
      clearInterval(q.timer);
      q.markInterrupted();
      sessions.push(...[q.arch, ...q.sessions.values()].filter(Boolean));
    }
    for (const s of sessions) s.kill();
    await this.waitFor(() => sessions.every((s) => s.exited || !s.proc), { timeout: 5000, what: 'the sessions to exit' }).catch(() => {});
    for (const q of this.guild.quests.values()) { clearTimeout(q.saveTimer); for (const ask of q.asks.values()) for (const w of ask.waiters.splice(0)) w('The quest has ended.'); }
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
    // Every fake-claude logs its pid; its 'mcp' entries carry the MCP servers' pids instead.
    // Only processes still running our scripts: a pid may have been reused since.
    const ours = (pid) => { try { return /fake-claude\.js|-mcp\.js/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')); } catch { return false; } };
    const pids = [...new Set(this.fakeLog().map((e) => e.pid))].filter((pid) => pid && ours(pid));
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    await this.waitFor(() => pids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } }), { timeout: 3000, what: 'leftover processes to die' }).catch(() => {});
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/** One line per agent and the last log lines, for timeout messages. */
export function describeQuest(s) {
  const agents = s.agents.map((a) => `${a.id} ${a.name} ${a.status}`).join(', ');
  const log = s.log.slice(-6).map((e) => `  [${e.who}/${e.kind}] ${String(e.text).slice(0, 160)}`).join('\n');
  return `Quest ${s.id} is ${s.status}; archmage ${s.archmage?.status}; agents: ${agents || 'none'}.\nLast log:\n${log}`;
}
