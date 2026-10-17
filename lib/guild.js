// The guild: quests, their Archmage and party processes, the global agent queue, and the event stream.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClaudeSession, describeTool } from './claude.js';
import * as G from './git.js';
import { raceOf, pickName, hash, CAST_RACES } from './names.js';
import { theme, themedName, themedRole, THEME_IDS } from '../web/themes.js';
import * as store from './store.js';
import { normalizeApp, focusDir, appBriefing, appForDir, findApp, repoNotes, standingContext, tooBroad } from './apps.js';

const LIB = path.dirname(fileURLToPath(import.meta.url));
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];
const NO_NESTING = ['Task', 'Agent'];
// Built-ins a headless agent must never use: they reach outside the quest (other sessions, schedules,
// publishing, the human's UI) or would block on a prompt nobody sees.
const DENIED = [
  ...NO_NESTING, 'Workflow', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup',
  'PushNotification', 'SendMessage', 'ListAgents', 'TaskStop', 'Monitor', 'ShareOnboardingGuide', 'PublishPlugin',
  'Artifact', 'ArtifactComments', 'ArtifactData', 'DesignSync', 'SendFeedback', 'EnterWorktree', 'ExitWorktree',
  'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion',
];
const ACTIVE = new Set(['planning', 'awaiting-approval', 'questing']);
const FINISHED_AGENT = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const LOG_LIMIT = 3000;

const now = () => new Date().toISOString();
const ATTACH_LIMIT = 20 * 1024 * 1024;
const FILE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  json: 'application/json', csv: 'text/csv; charset=utf-8', mp4: 'video/mp4', webm: 'video/webm',
};
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const within = (file, dir) => file === dir || file.startsWith(dir + path.sep);

export { tooBroad };

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** A muted clothing colour (#rrggbb) from a hash: hue from the hash, 35% saturation, 32% lightness. */
function mutedColor(h) {
  const hue = h % 360, s = 0.35, l = 0.32;
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * A role with only known fields of the right types. Roles end up in prompts, portraits and the page,
 * and can be set over the API.
 */
export function cleanRole(r) {
  if (!r || typeof r !== 'object') throw new Error('A role must be an object.');
  const str = (v, n) => (v === undefined || v === null ? undefined : clip(String(v), n));
  const out = {
    title: str(r.title, 40), name: str(r.name, 40), describe: str(r.describe, 160), blurb: str(r.blurb, 300),
    prompt: str(r.prompt, 4000), model: r.model ? str(r.model, 80) : r.model === null ? null : undefined,
  };
  if (r.orchestrator) out.orchestrator = true;
  if (r.tools !== undefined) {
    if (Array.isArray(r.tools)) out.tools = r.tools.filter((t) => typeof t === 'string' && /^[\w:*()., -]{1,120}$/.test(t));
    else if (['read', 'edit'].includes(r.tools)) out.tools = r.tools;
    else throw new Error(`Role tools must be "read", "edit" or a list of tool names.`);
  }
  if (r.colors && typeof r.colors === 'object') {
    out.colors = Object.fromEntries(Object.entries(r.colors).filter(([k, v]) => /^\w{1,30}$/.test(k) && /^#[0-9a-f]{3,8}$/i.test(String(v))));
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

// ───────────────────────────── the guild (all quests) ─────────────────────────────

export class Guild extends EventEmitter {
  constructor({ port }) {
    super();
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.settings = store.loadSettings();
    this.roles = store.loadRoles();
    this.apps = store.loadApps();
    this.quests = new Map();
    this.running = 0;
    this.queue = [];
    for (const state of store.loadAllQuests()) {
      const q = new Quest(this, state);
      q.markInterrupted();
      this.quests.set(q.id, q);
    }
  }

  list() {
    return [...this.quests.values()].sort((a, b) => b.state.createdAt.localeCompare(a.state.createdAt));
  }

  /**
   * A quest works on one directory (`cwd`), or on all the directories of an application (`app`),
   * starting from `cwd` if given. Unset mode, planning and maxAgents come from the application's
   * defaults, then the global ones.
   */
  async createQuest({ goal, app: appId, cwd, mode, planning, maxAgents }) {
    if (!goal?.trim()) throw new Error('A quest needs a goal.');
    const app = findApp(this.apps, appId);
    if (appId && !app) throw new Error(`No application "${appId}".`);
    mode ??= app?.defaults.mode ?? 'read';
    planning ??= app?.defaults.planning ?? 'review';
    maxAgents = Number(maxAgents) || app?.defaults.maxAgents || this.settings.maxAgents;
    if (app) cwd = focusDir(app, cwd);
    else cwd = path.resolve(String(cwd || this.settings.lastCwd || process.cwd()).replace(/^~(?=\/|$)/, process.env.HOME));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
    if (tooBroad(cwd)) throw new Error(`${cwd} is too broad for a quest (the agents could read everything under it); choose a project directory.`);
    if (!['read', 'edit'].includes(mode)) throw new Error('mode must be "read" or "edit"');
    if (!['review', 'auto'].includes(planning)) throw new Error('planning must be "review" or "auto"');
    const dirs = app ? app.repos.map(({ name, path: p }) => ({ name, path: p })) : [{ name: path.basename(cwd), path: cwd }];
    const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
    let repos = null;
    if (mode === 'edit') {
      repos = [];
      for (const d of dirs) {
        const info = await G.repoInfo(d.path);
        if (!info) throw new Error(`Edit mode needs git repositories; ${d.path} is not in one. Use read-only mode, or run git init first.`);
        const twin = repos.find((r) => r.root === info.root);
        if (twin) throw new Error(`${twin.name} and ${d.name} are in the same git repository (${info.root}); list the repository once.`);
        repos.push({ name: d.name, root: info.root, base: info.head, dirty: info.dirty, branch: `guild/${id}/party` });
      }
    }
    const q = new Quest(this, {
      id, goal: goal.trim(), app: app?.id ?? null, cwd, dirs, mode, planning, theme: this.settings.theme ?? 'fantasy',
      maxAgents: Math.max(1, Math.min(20, maxAgents)),
      status: 'planning', createdAt: now(), updatedAt: now(),
      repos, archmage: null, plan: null, roles: {}, agents: [], log: [], chronicle: null, diffs: null, costUsd: 0,
    });
    this.quests.set(id, q);
    try {
      await q.begin();
    } catch (err) {
      // Leave no half-made quest behind (in memory, on disk, or as a worktree).
      this.quests.delete(id);
      q.arch?.kill();
      clearInterval(q.timer);
      for (const r of repos ?? []) {
        if (r.integrationDir) await G.removeWorktree(r.root, r.integrationDir);
        await G.git(r.root, 'branch', '-D', r.branch).catch(() => {});
      }
      fs.rmSync(store.questDir(id), { recursive: true, force: true });
      throw err;
    }
    if (!app) {
      this.settings.lastCwd = cwd;
      store.saveSettings(this.settings);
    }
    return q;
  }

  // ── applications ──

  listApps() {
    return Object.values(this.apps).sort((a, b) => a.name.localeCompare(b.name));
  }

  app(id) {
    const a = findApp(this.apps, id);
    if (!a) throw new Error(`No application "${id}".`);
    return a;
  }

  /** Create an application (no `id`) or update one. */
  saveApp(id, input) {
    const prev = id ? this.app(id) : null;
    const app = normalizeApp(input ?? {}, prev);
    if (!prev && findApp(this.apps, app.id)) throw new Error(`There is already an application "${app.id}".`);
    this.apps[app.id] = app;
    if (input?.adopt) this.adopt(app);
    this.appsChanged();
    return app;
  }

  /** File the quests in no application whose directory lies in this one's under it. */
  adopt(app) {
    for (const q of this.quests.values()) {
      if (!findApp(this.apps, q.s.app) && appForDir({ [app.id]: app }, q.s.cwd)) q.setApp(app.id);
    }
  }

  /** Delete an application. Its quests stay, ungrouped. */
  deleteApp(id) {
    this.app(id);
    delete this.apps[id];
    for (const q of this.quests.values()) if (q.s.app === id) q.setApp(null);
    this.appsChanged();
  }

  appsChanged() {
    store.saveApps(this.apps);
    this.emit('global', { type: 'apps', apps: this.listApps() });
  }

  /**
   * Earlier quests on an application, newest first, with their chronicle files and, for edit quests,
   * whether their branch has reached the human's checkout (for briefings).
   */
  async appHistory(appId, except) {
    const out = [];
    for (const q of this.list()) {
      if (q.s.app !== appId || q.id === except || ACTIVE.has(q.s.status)) continue;
      const repos = [];
      if (q.s.mode === 'edit' && q.s.status === 'done') {
        for (const r of q.s.repos ?? []) repos.push({ name: r.name, branch: r.branch, merged: await G.isAncestor(r.root, r.branch, 'HEAD') });
      }
      out.push({ id: q.id, goal: q.s.goal, status: q.s.status, mode: q.s.mode, createdAt: q.s.createdAt, chronicleFile: store.chronicleFile(q.s), repos });
    }
    return out;
  }

  role(id, quest) {
    return quest?.state.roles[id] ?? this.roles[id];
  }

  // Global concurrency cap on party members (the Archmages are not counted).
  acquire(start) {
    if (this.running < this.settings.maxConcurrent) { this.running++; start(); } else this.queue.push(start);
  }
  release() {
    this.running = Math.max(0, this.running - 1);
    this.drain();
  }
  dequeue(start) {
    const i = this.queue.indexOf(start);
    if (i >= 0) this.queue.splice(i, 1);
    return i >= 0;
  }
  drain() {
    while (this.queue.length && this.running < this.settings.maxConcurrent) { this.running++; this.queue.shift()(); }
  }

  updateSettings(patch) {
    if (patch.theme !== undefined && !THEME_IDS.includes(patch.theme)) throw new Error(`theme must be one of ${THEME_IDS.join(', ')}`);
    for (const k of ['style', 'theme', 'maxConcurrent', 'maxAgents', 'batchSeconds']) if (patch[k] !== undefined) this.settings[k] = patch[k];
    const clamp = (v, lo, hi, dflt) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || dflt));
    this.settings.maxConcurrent = clamp(this.settings.maxConcurrent, 1, 32, 4);
    this.settings.maxAgents = clamp(this.settings.maxAgents, 1, 20, 6);
    this.settings.batchSeconds = clamp(this.settings.batchSeconds, 5, 600, 60);
    store.saveSettings(this.settings);
    this.drain();
    this.emit('global', { type: 'settings', settings: this.settings });
    return this.settings;
  }

  saveRole(id, role) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error('Role id: lowercase letters, digits and dashes');
    this.roles[id] = cleanRole(role);
    store.saveRoles(this.roles);
    this.emit('global', { type: 'roles', roles: this.roles });
    return this.roles;
  }

  replaceRoles(roles) {
    if (!roles || typeof roles !== 'object' || !Object.values(roles).some((r) => r?.orchestrator)) throw new Error('The catalog needs an orchestrator role.');
    for (const id of Object.keys(roles)) if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error(`Role id "${id}": lowercase letters, digits and dashes`);
    roles = Object.fromEntries(Object.entries(roles).map(([id, r]) => [id, cleanRole(r)]));
    this.roles = roles;
    store.saveRoles(roles);
    this.emit('global', { type: 'roles', roles });
    return roles;
  }
}

// ───────────────────────────── one quest ─────────────────────────────

export class Quest {
  constructor(guild, state) {
    this.guild = guild;
    this.state = state;
    this.id = state.id;
    // Quests from before applications had one directory and at most one repository.
    state.dirs ??= state.cwd ? [{ name: path.basename(state.cwd), path: state.cwd }] : [];
    if (state.repo && !state.repos) state.repos = [{ name: path.basename(state.repo.root), ...state.repo }];
    this.sessions = new Map(); // agentId -> ClaudeSession
    this.asks = new Map(); // askId -> { agentId, question, answer, waiters: [] }
    this.queued = new Map(); // agentId -> scheduler callback
    this.inbox = []; // messages waiting for the Archmage
    this.urgent = false;
    this.humanWaiting = false; // the inbox holds a message from the human
    this.conversing = false; // the Archmage's current turn answers the human
    this.lastFlush = Date.now();
    this.nudges = 0;
    this.archRestarts = 0;
    this.saveTimer = null;
    // Shared with this quest's MCP servers only; the internal routes check it. A new one each server start.
    this.secret = crypto.randomBytes(24).toString('hex');
  }

  get s() { return this.state; }
  get dir() { return store.questDir(this.id); }
  /** An edit-mode quest on several repositories: each workspace holds one worktree per repository. */
  get multi() { return (this.s.repos?.length ?? 0) > 1; }

  summary() {
    const { id, goal, app, cwd, mode, planning, status, createdAt, updatedAt, finishedAt, costUsd } = this.s;
    return {
      id, goal, app: app ?? null, cwd, dirs: this.s.dirs.map((d) => d.name), mode, planning, status, createdAt, updatedAt, finishedAt, costUsd,
      party: this.s.agents.map(({ id, name, role, status, percent }) => ({ id, name, role, status, percent })),
    };
  }

  // ── events and persistence ──

  emit(type, data) {
    this.s.updatedAt = now();
    const event = { type, quest: this.id, ts: this.s.updatedAt, ...data };
    if (type !== 'activity') store.appendEvent(this.id, event);
    this.guild.emit('quest', event);
    this.guild.emit('global', { type: 'summary', quest: this.summary() });
    this.save();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => store.saveQuest(this.s), 300);
  }

  log(who, kind, text, extra = {}) {
    if (who === 'archmage' && this.conversing && !extra.to) extra = { ...extra, to: 'you' };
    const entry = { ts: now(), who, kind, text, ...extra };
    this.s.log.push(entry);
    if (this.s.log.length > LOG_LIMIT) this.s.log.splice(0, this.s.log.length - LOG_LIMIT);
    this.emit('log', { entry });
  }

  /** File the quest under an application (or none). Only the grouping changes, not its directories. */
  setApp(appId) {
    if (appId && !findApp(this.guild.apps, appId)) throw new Error(`No application "${appId}".`);
    this.s.app = appId || null;
    this.emit('app', { app: this.s.app });
  }

  setStatus(status) {
    this.s.status = status;
    if (!ACTIVE.has(status)) this.s.finishedAt = now();
    this.emit('quest', { status, finishedAt: this.s.finishedAt });
  }

  agent(id) {
    const a = this.s.agents.find((x) => x.id === id);
    if (!a) throw new Error(`No agent ${id} in this quest. Use list_party.`);
    return a;
  }

  updateAgent(a, patch) {
    Object.assign(a, patch);
    this.emit('agent', { agent: a });
  }

  addCost() {
    let total = this.s.archmage?.costUsd ?? 0;
    for (const a of this.s.agents) total += a.costUsd ?? 0;
    this.s.costUsd = total;
  }

  markInterrupted() {
    let changed = false;
    if (ACTIVE.has(this.s.status)) { this.s.status = 'interrupted'; this.s.finishedAt = now(); changed = true; }
    for (const a of this.s.agents) {
      if (!FINISHED_AGENT.has(a.status)) { a.status = 'interrupted'; a.activity = null; changed = true; }
    }
    if (this.s.archmage && !['done', 'idle'].includes(this.s.archmage.status)) this.s.archmage.status = 'idle';
    if (changed) store.saveQuest(this.s);
  }

  // ── the Archmage ──

  async begin() {
    fs.mkdirSync(path.join(this.dir, 'mcp'), { recursive: true });
    const roleEntry = Object.entries(this.guild.roles).find(([, r]) => r.orchestrator) ?? ['archmage', { title: 'Archmage', name: 'Velothar', model: 'opus' }];
    const [roleId, role] = roleEntry;
    let workdir = this.s.cwd;
    if (this.s.mode === 'edit') {
      const integration = path.join(store.WORKTREES_DIR, this.id, '_archmage');
      for (const r of this.s.repos) {
        r.integrationDir = this.multi ? path.join(integration, r.name) : integration;
        await G.addWorktree(r.root, r.integrationDir, r.branch, r.base);
      }
      workdir = this.multi ? integration : path.join(integration, path.relative(this.s.repos[0].root, this.s.cwd));
    }
    this.s.archmage = {
      role: roleId, name: this.s.theme && this.s.theme !== 'fantasy' ? theme(this.s.theme).leader.name : role.name ?? 'Velothar',
      title: themedRole(this.s.theme, roleId, role).title ?? 'Archmage', model: role.model ?? null,
      status: 'thinking', thought: 'Studying the quest…', costUsd: 0, sessionId: null, workdir,
    };
    this.save();
    store.appendEvent(this.id, { type: 'created', ts: now(), quest: this.id, goal: this.s.goal });
    this.log('guild', 'system', `Quest posted: ${this.s.goal}`);
    this.startArchmage(await this.archmageBriefing());
    this.timer = setInterval(() => this.flush(), 5000);
    this.timer.unref();
  }

  archmageSystemPrompt() {
    const a = this.s.archmage;
    const roles = Object.entries(this.guild.roles)
      .filter(([, r]) => !r.orchestrator)
      .map(([id, r]) => `- ${id}: ${themedRole(this.s.theme, id, r).title} — ${r.blurb ?? ''} (tools: ${r.tools ?? 'read'}${r.model ? `, model ${r.model}` : ''})`)
      .join('\n');
    const edit = this.s.mode === 'edit';
    return [
      `You are ${a.name} the ${a.title}, leader of a guild party of Claude Code agents. You orchestrate; the party does the work.`,
      ``,
      `Quest mode: ${edit ? 'EDIT — party members change code, each in its own git worktree and branch' : 'READ-ONLY — nobody modifies files'}.`,
      `Planning: ${this.s.planning === 'review' ? 'REVIEW — the human approves your plan before dispatch' : 'AUTO — your plan is dispatched at once'}.`,
      `Party limit: at most ${this.s.maxAgents} agents in total for this quest.`,
      ``,
      `Role catalog:`,
      roles,
      ``,
      `How a quest goes:`,
      `1. Look around briefly if it helps you plan (Read/Glob/Grep). Keep it short; the party does the deep work.`,
      `2. Call propose_plan once. Each member gets a role and a complete, self-contained task: they do not see the quest or each other's work unless you tell them. Prefer parallel tasks that do not overlap${edit ? ' (in edit mode, avoid two agents editing the same files)' : ''}. Invent a role (newRoles) only if no catalog role fits. Then end your turn.`,
      `3. You then receive dispatches as messages: progress reports, questions from blocked agents, and final reports. React only when it helps: answer_agent for questions, message_agent to correct course, recruit_agent for follow-up work, cancel_agent for a stuck or redundant agent. Otherwise end your turn at once with a one-line remark; every turn costs tokens.`,
      edit
        ? `4. When everyone is finished, call merge_party. ${this.multi
          ? `Your working directory holds one integration worktree per repository (${this.s.repos.map((r) => `${r.name}/`).join(', ')}), each on branch ${this.s.repos[0].branch}. Resolve any conflicts in the repository merge_party names (edit, git add, git commit there)`
          : `Your working directory is the integration worktree on branch ${this.s.repos[0].branch}. Resolve any conflicts there (edit, git add, git commit)`} and call merge_party again until all is merged. Run a cheap build or test if there is one. Then call finish_quest.`
        : `4. When everyone is finished, call finish_quest.`,
      `   The chronicle is the deliverable: a complete markdown answer to the quest for the human, synthesised from the reports (not a list of who did what), crediting agents by name where useful.`,
      ``,
      `Voice: your visible text is shown on the council table, so keep it to one or two lines, in character as ${theme(this.s.theme).leader.voice}. Write tasks and the chronicle in plain, precise language.`,
      `Messages from "the human" come from the person overseeing the quest; their instructions override yours.`,
      ``,
      `Talking with the human: they can message you at any time, to give guidance, ask you questions or make requests ("add a tester", "explain the plan").`,
      `- When a message comes from the human, answer them directly. That reply may be as long as it needs to be and may use markdown; the one-or-two-line rule is for your other remarks.`,
      `- Act on their requests with your tools: in review mode before approval, call propose_plan again with the revised party; once the party is dispatched, use recruit_agent, message_agent or cancel_agent. Say what you did.`,
      `- To show the human a file (a screenshot, a page, a report), call attach_file; your party attaches their own files the same way.`,
      `- When you need a decision only the human can make (an install or download, spending, a change of scope, anything risky), call ask_human instead of writing the question in your text, then end your turn. Do not wait idle: the party keeps working meanwhile.`,
    ].join('\n');
  }

  async archmageBriefing() {
    const app = findApp(this.guild.apps, this.s.app);
    const edit = this.s.mode === 'edit';
    const lines = [`The quest: ${this.s.goal}`, ``];
    const context = this.standingContext();
    if (context) lines.push(context, ``, `Agents get this context too; you need not repeat it in their tasks.`, ``);
    if (app) {
      lines.push(appBriefing(app, await this.guild.appHistory(app.id, this.id), { edit }), ``,
        `Start directory: ${this.s.cwd}${edit ? ` (you work in ${this.s.archmage.workdir}, which holds ${this.multi ? 'an integration worktree of each repository' : 'the integration worktree'})` : ''}`);
    } else {
      lines.push(`Directory: ${this.s.cwd}${edit ? ` (you work in the integration worktree ${this.s.archmage.workdir})` : ''}`);
    }
    for (const r of this.s.repos ?? []) {
      if (r.dirty) lines.push(`Note: the human's checkout of ${r.name} has uncommitted changes; the party works from the last commit (${r.base.slice(0, 8)}).`);
    }
    lines.push(``, `Plan the party and call propose_plan.`);
    return lines.join('\n');
  }

  /** The application's standing context and the GUILD.md of each directory, for every prompt. */
  standingContext() {
    return standingContext(findApp(this.guild.apps, this.s.app), repoNotes(this.s.dirs));
  }

  /** Directories outside `workdir` that a session must be allowed into (read mode on an application). */
  extraDirs(workdir) {
    if (this.s.mode === 'edit') return [];
    return this.s.dirs.map((d) => d.path).filter((p) => !within(p, workdir));
  }

  startArchmage(firstMessage, resume) {
    const a = this.s.archmage;
    const mcpConfig = path.join(this.dir, 'mcp', 'archmage.json');
    fs.writeFileSync(mcpConfig, JSON.stringify({
      mcpServers: { council: { command: process.execPath, args: [path.join(LIB, 'council-mcp.js')], env: { GUILD_URL: this.guild.url, GUILD_QUEST_ID: this.id, GUILD_SECRET: this.secret } } },
    }), { mode: 0o600 });
    const council = ['propose_plan', 'recruit_agent', 'message_agent', 'answer_agent', 'cancel_agent', 'list_party', 'ask_human', 'attach_file', 'merge_party', 'finish_quest'].map((t) => `mcp__council__${t}`);
    const sess = new ClaudeSession({
      cwd: a.workdir,
      addDirs: this.extraDirs(a.workdir),
      model: a.model,
      systemPrompt: this.archmageSystemPrompt(),
      allowedTools: [...READ_TOOLS, ...(this.s.mode === 'edit' ? EDIT_TOOLS : []), ...council],
      disallowedTools: DENIED,
      permissionMode: this.s.mode === 'edit' ? 'acceptEdits' : undefined,
      mcpConfig,
      resume,
    });
    const baseCost = a.costUsd;
    this.arch = sess;
    sess.on('init', ({ sessionId }) => { a.sessionId = sessionId; this.save(); });
    sess.on('text', (text) => this.onArchmageText(text));
    sess.on('tool', (t) => {
      if (t.name.startsWith('mcp__council__')) return; // logged by the tool handlers
      const d = describeTool(t);
      if (d) { a.activity = d; this.emit('archmage', { archmage: a }); }
    });
    sess.on('result', (r) => {
      a.costUsd = baseCost + sess.costUsd;
      this.addCost();
      this.onArchmageResult(r);
    });
    sess.on('exit', ({ code, stderr }) => {
      if (this.arch !== sess) return;
      this.arch = null;
      if (!ACTIVE.has(this.s.status)) return;
      if (this.archRestarts++ < 2 && a.sessionId) {
        this.log('guild', 'system', `The Archmage's session ended unexpectedly (exit ${code}); reviving.`);
        this.startArchmage('Your session was restarted. Continue the quest from where you were (list_party shows the party).', a.sessionId);
      } else {
        this.log('guild', 'system', `The Archmage is gone (exit ${code}). ${clip(stderr, 400)}`);
        this.fail('The Archmage session ended before the quest was finished.');
      }
    });
    a.status = 'thinking';
    this.emit('archmage', { archmage: a });
    sess.start(firstMessage);
  }

  onArchmageText(text) {
    const a = this.s.archmage;
    a.thought = clip(text, 4000);
    this.emit('archmage', { archmage: a });
    this.log('archmage', 'say', clip(text, this.conversing ? 8000 : 2000));
  }

  onArchmageResult(r) {
    const a = this.s.archmage;
    this.conversing = false;
    a.replying = false;
    a.activity = null;
    a.status = ACTIVE.has(this.s.status) ? 'waiting' : 'done';
    this.emit('archmage', { archmage: a });
    if (r.is_error) this.log('guild', 'system', `The Archmage's turn ended in an error: ${clip(r.result ?? r.subtype, 300)}`);
    this.afterArchmageTurn(r);
  }

  /** Queue a message for the Archmage. Urgent ones are delivered as soon as it is idle. */
  tell(text, urgent = false) {
    this.inbox.push(text);
    if (urgent) this.urgent = true;
    this.flush();
  }

  flush() {
    if (!ACTIVE.has(this.s.status) || !this.arch || this.arch.busy || !this.inbox.length) return;
    if (this.s.status === 'awaiting-approval' && !this.urgent) return;
    const due = this.urgent || Date.now() - this.lastFlush >= this.guild.settings.batchSeconds * 1000;
    if (!due) return;
    const batch = this.inbox.splice(0);
    this.urgent = false;
    this.lastFlush = Date.now();
    if (!this.arch.send(batch.join('\n\n'))) {
      this.inbox.unshift(...batch); // the session is gone; the revived one gets them
      return;
    }
    this.conversing = this.humanWaiting;
    this.humanWaiting = false;
    this.s.archmage.replying = this.conversing;
    this.s.archmage.status = 'thinking';
    this.emit('archmage', { archmage: this.s.archmage });
  }

  afterArchmageTurn() {
    if (!ACTIVE.has(this.s.status)) { this.arch?.close(); return; }
    if (this.inbox.length) return this.flush();
    if (this.s.status === 'planning') {
      if (this.nudges++ < 2) return this.tell('You have not proposed a plan yet. Call propose_plan now.', true);
      return this.fail('The Archmage did not propose a plan.');
    }
    if (this.s.status === 'questing' && this.s.agents.length && this.s.agents.every((a) => FINISHED_AGENT.has(a.status)) && !this.queued.size) {
      if (this.nudges++ < 3) {
        const edit = this.s.mode === 'edit';
        return this.tell(`The whole party has finished. ${edit ? 'Call merge_party, then finish_quest' : 'Call finish_quest'} with the chronicle, or recruit more agents if the quest is not answered yet.`, true);
      }
      return this.fail('The Archmage did not finish the quest.');
    }
  }

  fail(reason) {
    if (!ACTIVE.has(this.s.status)) return;
    this.s.chronicle = this.s.chronicle ?? `**The quest failed.** ${reason}`;
    this.end('failed');
  }

  async end(status) {
    clearInterval(this.timer);
    for (const [id, start] of this.queued) { this.guild.dequeue(start); this.queued.delete(id); }
    for (const a of this.s.agents) {
      if (!FINISHED_AGENT.has(a.status)) this.updateAgent(a, { status: 'cancelled', activity: null, finishedAt: now() });
      this.sessions.get(a.id)?.kill();
    }
    for (const ask of this.asks.values()) if (ask.answer === undefined) this.resolveAsk(ask, 'The quest has ended. Stop now.');
    if (this.s.archmage) this.s.archmage.status = status === 'done' ? 'done' : 'idle';
    const arch = this.arch;
    if (status !== 'done') arch?.kill(); else arch?.close();
    this.setStatus(status);
    if (arch && !arch.exited) {
      // Let the Archmage finish its last turn before its worktree goes away.
      await new Promise((r) => { const t = setTimeout(r, 60_000); arch.once('exit', () => { clearTimeout(t); r(); }); });
    }
    if (this.s.mode === 'edit') await this.cleanupWorktrees(status === 'done');
    this.log('guild', 'system', status === 'done' ? 'The quest is complete.' : `The quest ended: ${status}.`);
    this.emit('chronicle', { chronicle: this.s.chronicle, diffs: this.s.diffs });
    store.saveQuest(this.s);
    try { store.chronicleFile(this.s); } catch { /* the briefing of a later quest tries again */ }
  }

  async cleanupWorktrees(withDiff) {
    if (withDiff) {
      this.s.diffs = [];
      for (const { name, root, base, branch } of this.s.repos) {
        try {
          this.s.diffs.push({ repo: name, root, base, branch, ...(await G.diff(root, base, branch)) });
        } catch (err) { this.log('guild', 'system', `Could not compute the diff of ${name}: ${err.message}`); }
      }
    }
    for (const a of this.s.agents) {
      for (const w of this.worktreesOf(a)) {
        // Keep whatever a recalled or unfinished agent left behind: commit it to its branch first.
        try { await G.commitLeftovers(w.dir, `${a.name} (${a.title}): work in progress (${a.status})`); } catch { /* nothing to keep */ }
        await G.removeWorktree(w.root, w.dir);
      }
    }
    for (const r of this.s.repos) {
      if (r.integrationDir) await G.removeWorktree(r.root, r.integrationDir);
      try { await G.git(r.root, 'worktree', 'prune'); } catch { /* ignore */ }
    }
    if (this.multi) {
      // The workspaces that held one worktree per repository, if nothing else is left in them.
      const shells = new Set([...this.s.agents.flatMap((a) => this.worktreesOf(a)), ...this.s.repos.map((r) => ({ dir: r.integrationDir }))]
        .filter((w) => w.dir).map((w) => path.dirname(w.dir)));
      for (const d of shells) try { fs.rmdirSync(d); } catch { /* not empty, or gone */ }
    }
  }

  cancel(reason = 'Cancelled by the human.') {
    if (!ACTIVE.has(this.s.status)) throw new Error('The quest is not running.');
    this.s.chronicle = `**Cancelled.** ${reason}`;
    this.log('you', 'message', 'Cancelled the quest.');
    return this.end('cancelled');
  }

  messageArchmage(text) {
    if (!ACTIVE.has(this.s.status)) throw new Error('The quest is not running.');
    this.log('you', 'message', text, { to: 'archmage' });
    const a = this.s.archmage, asked = a?.question;
    if (asked) { a.question = null; this.emit('archmage', { archmage: a }); }
    this.humanWaiting = true;
    this.tell(asked ? `The human answers your question ("${asked}"): ${text}` : `Message from the human: ${text}`, true);
  }

  /** Keep a copy of a file an agent or the Archmage wants the human to see (a screenshot, a report). */
  attach(who, { path: given, caption } = {}) {
    const agent = who === 'archmage' ? null : this.s.agents.find((x) => x.id === who);
    if (who !== 'archmage' && !agent) throw new Error(`Unknown agent ${who}`);
    if (!String(given ?? '').trim()) throw new Error('Give the path of the file to attach.');
    const base = agent ? agent.dir ?? this.s.cwd : this.s.archmage.workdir ?? this.s.cwd;
    const wanted = path.resolve(base, String(given).replace(/^~(?=\/|$)/, os.homedir()));
    const file = realOrNull(wanted);
    if (!file || !fs.statSync(file).isFile()) throw new Error(`There is no file at ${wanted}.`);
    const roots = [base, this.s.cwd, ...this.s.dirs.map((d) => d.path), ...(this.s.repos ?? []).map((r) => r.root), os.tmpdir()].filter(Boolean).map(realOrNull).filter(Boolean);
    if (!roots.some((r) => within(file, r))) throw new Error(`${wanted} is outside your working directory and the temp folder; copy it into one of them first.`);
    const size = fs.statSync(file).size;
    if (size > ATTACH_LIMIT) throw new Error(`${path.basename(file)} is ${(size / 1048576).toFixed(1)} MB; the limit is 20 MB.`);
    this.s.attachments ??= [];
    const name = path.basename(wanted).replace(/[^\w.-]+/g, '_').slice(-120) || 'file';
    const f = {
      id: `f${this.s.attachments.length + 1}`, who, name, caption: caption?.trim() || null, size, ts: now(),
      type: FILE_TYPES[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream',
    };
    const dir = path.join(this.dir, 'files');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${f.id}-${name}`));
    this.s.attachments.push(f);
    this.emit('attachment', { attachment: f });
    this.log(who, 'attach', f.caption ?? name, { attachment: f.id });
    return `Attached ${name} (${f.type}); the human can see it in the interface.`;
  }

  attachmentFile(fid) {
    const f = this.s.attachments?.find((x) => x.id === fid);
    if (!f) return null;
    return { ...f, path: path.join(this.dir, 'files', `${f.id}-${f.name}`) };
  }

  askHuman(question) {
    if (!question?.trim()) throw new Error('Ask a question.');
    this.s.archmage.question = question.trim();
    this.emit('archmage', { archmage: this.s.archmage });
    this.log('archmage', 'ask', question.trim(), { to: 'you' });
    return 'Your question is shown to the human. The party keeps working. End your turn now; their answer arrives as a message.';
  }

  // ── plan and recruiting ──

  resolveRole(roleId, newRoles = []) {
    const invented = newRoles.find((r) => r.id === roleId);
    if (invented && !this.guild.roles[roleId]) {
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(roleId)) throw new Error(`Role id "${roleId}": use lowercase letters, digits and dashes.`);
      // Only known fields: the role ends up in prompts and portraits.
      const r = {
        title: clip(invented.title || roleId, 40),
        describe: invented.describe ? clip(invented.describe, 160) : undefined,
        tools: invented.tools === 'edit' ? 'edit' : 'read',
        prompt: clip(invented.prompt ?? '', 2000),
        invented: true,
        model: null,
      };
      if (!r.describe) {
        const h = hash(roleId);
        const race = CAST_RACES[h % CAST_RACES.length];
        r.describe = `${race} ${['sage', 'wanderer', 'knight', 'mystic', 'artificer'][h % 5]}`;
      }
      r.colors = r.colors ?? { clothing: mutedColor(hash(`${roleId}:colour`)) };
      this.s.roles[roleId] = r;
      this.emit('roles', { roles: this.s.roles });
    }
    const role = this.guild.role(roleId, this);
    if (!role || role.orchestrator) throw new Error(`Unknown role "${roleId}". Use a catalog role or define it in newRoles.`);
    return role;
  }

  council(tool, args) {
    if (!ACTIVE.has(this.s.status)) return 'The quest has ended. End your turn.';
    const fn = {
      propose_plan: () => this.proposePlan(args),
      recruit_agent: () => this.recruitByArchmage(args),
      message_agent: () => this.messageAgent(args.agentId, args.text, 'archmage'),
      answer_agent: () => this.answerAgent(args.agentId, args.text, 'archmage'),
      cancel_agent: () => this.cancelAgent(args.agentId, 'archmage', args.reason),
      list_party: () => this.partyReport(),
      ask_human: () => this.askHuman(args.question),
      attach_file: () => this.attach('archmage', args),
      merge_party: () => this.mergeParty(args),
      finish_quest: () => this.finish(args.chronicle),
    }[tool];
    if (!fn) throw new Error(`Unknown council tool ${tool}`);
    return fn();
  }

  proposePlan({ summary, agents, newRoles = [] }) {
    if (this.s.plan?.status === 'approved') throw new Error('The plan is already approved; use recruit_agent for more members.');
    if (!agents?.length) throw new Error('A plan needs at least one agent.');
    if (agents.length > this.s.maxAgents) throw new Error(`At most ${this.s.maxAgents} agents for this quest; you proposed ${agents.length}.`);
    for (const m of agents) this.resolveRole(m.role, newRoles);
    this.s.plan = { summary, agents: agents.map(({ role, task }) => ({ role, task })), status: 'pending', proposedAt: now() };
    this.log('archmage', 'action', `Proposed a party of ${agents.length}: ${summary}`);
    this.emit('plan', { plan: this.s.plan, roles: this.s.roles });
    if (this.s.planning === 'review') {
      this.setStatus('awaiting-approval');
      return 'Your plan awaits the human\'s approval; they may edit it. End your turn now. You will be told when the party is dispatched.';
    }
    return this.dispatch(this.s.plan.agents, false);
  }

  approvePlan(agents) {
    if (this.s.status !== 'awaiting-approval') throw new Error('No plan is waiting for approval.');
    agents = (agents ?? this.s.plan.agents).filter((m) => m.task?.trim());
    if (!agents.length) throw new Error('The plan has no tasks.');
    if (agents.length > this.s.maxAgents) throw new Error(`At most ${this.s.maxAgents} agents.`);
    for (const m of agents) this.resolveRole(m.role);
    const edited = JSON.stringify(agents.map(({ role, task }) => ({ role, task }))) !== JSON.stringify(this.s.plan.agents);
    this.s.plan.agents = agents.map(({ role, task }) => ({ role, task }));
    this.log('you', 'message', edited ? 'Approved the plan with changes.' : 'Approved the plan.');
    this.setStatus('questing');
    const party = this.dispatch(this.s.plan.agents, true);
    this.tell(`The human approved the plan${edited ? ' with changes' : ''}. The party is on its way:\n${party}\nEnd your turn; dispatches will follow.`, true);
    return party;
  }

  dispatch(members, approved) {
    this.s.plan.status = 'approved';
    if (this.s.status !== 'questing') this.setStatus('questing');
    const lines = members.map((m) => {
      const a = this.recruit(m.role, m.task);
      return `- ${a.id}: ${a.name} the ${a.title}`;
    });
    this.emit('plan', { plan: this.s.plan, roles: this.s.roles });
    return (approved ? '' : 'The party is dispatched:\n') + lines.join('\n');
  }

  recruitByArchmage({ role, task, newRole }) {
    if (this.s.status !== 'questing') throw new Error('Recruit only after the plan is dispatched; use propose_plan first.');
    const active = this.s.agents.filter((a) => a.status !== 'cancelled').length;
    if (active >= this.s.maxAgents) throw new Error(`The party is at its limit of ${this.s.maxAgents} agents.`);
    if (newRole) this.resolveRole(newRole.id, [newRole]);
    const a = this.recruit(role, task);
    this.log('archmage', 'action', `Recruited ${a.name} the ${a.title}: ${clip(task, 300)}`);
    return `Recruited ${a.id}: ${a.name} the ${a.title}.`;
  }

  recruit(roleId, task) {
    const role = this.resolveRole(roleId);
    const race = raceOf(role.describe);
    const taken = new Set(this.s.agents.map((a) => a.name));
    const a = {
      id: `a${this.s.agents.length + 1}`,
      name: themedName(this.s.theme, taken, `${this.id}:${this.s.agents.length}`) ?? pickName(race, taken, `${this.id}:${this.s.agents.length}`),
      role: roleId, title: themedRole(this.s.theme, roleId, role).title, task,
      status: 'queued', percent: 0, phase: null, lastReport: null, activity: null, result: null,
      question: null, notes: [], costUsd: 0, sessionId: null, createdAt: now(),
    };
    this.s.agents.push(a);
    this.emit('agent', { agent: a });
    this.schedule(a, null);
    return a;
  }

  // ── party members ──

  schedule(a, message) {
    const start = () => {
      this.queued.delete(a.id);
      if (!ACTIVE.has(this.s.status) || a.status === 'cancelled') return this.guild.release();
      this.startAgent(a, message).catch((err) => {
        this.updateAgent(a, { status: 'failed', result: `Could not start: ${err.message}`, finishedAt: now() });
        this.log(a.id, 'failed', `Could not start: ${err.message}`);
        this.guild.release();
        this.tell(`[failed] ${a.name} (${a.id}) could not start: ${err.message}`, true);
      });
    };
    this.queued.set(a.id, start);
    this.updateAgent(a, { status: 'queued', activity: this.guild.running >= this.guild.settings.maxConcurrent ? 'Waiting for a free slot' : null });
    this.guild.acquire(start);
  }

  agentSystemPrompt(a, role) {
    const edit = this.s.mode === 'edit';
    const canEdit = edit && role.tools !== 'read';
    const lines = [
      `You are ${a.name}, the ${role.title} in a guild party of Claude Code agents led by ${this.s.archmage.name} the Archmage.`,
      role.prompt ?? '',
      ``,
      `Reporting: call mcp__guild__report_progress when you start (a low percent and your plan in one sentence), after each meaningful step, and with percent 100 at the end. Its reply may carry messages from the Archmage or the human: follow them.`,
      `If you are blocked on a decision you cannot reasonably make yourself, call mcp__guild__ask; it waits for the answer. Do not ask about things you can find out.`,
      `When you make something the human should look at (screenshots, rendered pages, charts, a PDF or a written report), call mcp__guild__attach_file with its path and a one-line caption; it is shown in the interface. Mention attached files in your report.`,
      `Your final message is your report to the Archmage: concise but complete and concrete (paths with line numbers, commands, results, open questions).`,
      canEdit && this.multi
        ? `You work in your own workspace at ${a.dir}: it holds a git worktree of each repository (${this.s.repos.map((r) => `${r.name}/`).join(', ')}), all on branch ${a.branch}; other agents work in parallel on their own branches. Stay inside that directory. Commit your work in each repository you change, with clear messages, before your final report. Do not push and do not switch branches.`
        : canEdit
          ? `You work in your own git worktree at ${a.dir} on branch ${a.branch}; other agents work in parallel on their own branches. Stay inside that directory. Commit your work with clear messages before your final report. Do not push and do not switch branches.`
          : `This is a read-only task: do not modify any files.`,
    ];
    if (!edit && this.s.dirs.length > 1) lines.push(`The quest's directories: ${this.s.dirs.map((d) => `${d.name} (${d.path})`).join(', ')}.`);
    const context = this.standingContext();
    if (context) lines.push(``, context);
    return lines.join('\n');
  }

  /** An agent's own worktree (or, on several repositories, a workspace with one worktree each). */
  async prepareWorkspace(a) {
    if (a.dir) return;
    const slug = `${a.id}-${a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const ws = path.join(store.WORKTREES_DIR, this.id, slug);
    a.branch = `guild/${this.id}/${slug}`;
    a.worktrees = [];
    for (const r of this.s.repos) {
      const dir = this.multi ? path.join(ws, r.name) : ws;
      await G.addWorktree(r.root, dir, a.branch, r.base);
      a.worktrees.push({ repo: r.name, dir });
    }
    a.dir = this.multi ? ws : path.join(ws, path.relative(this.s.repos[0].root, this.s.cwd));
  }

  /** [{ repo, root, base, dir }] for each worktree of an agent; quests from before applications had one. */
  worktreesOf(a) {
    const list = a.worktrees ?? (a.worktree ? [{ repo: this.s.repos[0].name, dir: a.worktree }] : []);
    return list.map((w) => ({ ...w, ...this.s.repos.find((r) => r.name === w.repo), dir: w.dir }));
  }

  /** Commit what an agent left uncommitted and count its commits per repository. Returns a note for the Archmage. */
  async tallyCommits(a) {
    let note = '';
    try {
      a.commitsByRepo = {};
      for (const w of this.worktreesOf(a)) {
        if (await G.commitLeftovers(w.dir, `${a.name} (${a.title}): uncommitted work`)) note = ' (Guild committed uncommitted leftovers.)';
        a.commitsByRepo[w.repo] = await G.commitCount(w.root, w.base, a.branch);
      }
      a.commits = Object.values(a.commitsByRepo).reduce((n, c) => n + c, 0);
    } catch (err) { note = ` (Commit check failed: ${err.message})`; }
    return note;
  }

  /**
   * The repositories where the agent's branch has commits the quest branch lacks. Git decides, not a
   * list of merged agents: an agent woken after its merge may have committed again.
   */
  async unmerged(a) {
    const out = [];
    for (const w of this.worktreesOf(a)) {
      const n = await G.commitCount(w.root, w.branch, a.branch);
      if (n > 0) out.push({ ...w, commits: n });
    }
    return out;
  }

  async startAgent(a, message) {
    const role = this.guild.role(a.role, this);
    const edit = this.s.mode === 'edit';
    const canEdit = edit && role.tools !== 'read';
    let cwd = this.s.cwd;
    if (edit) {
      await this.prepareWorkspace(a);
      cwd = a.dir;
    }
    const mcpConfig = path.join(this.dir, 'mcp', `${a.id}.json`);
    fs.writeFileSync(mcpConfig, JSON.stringify({
      mcpServers: { guild: { command: process.execPath, args: [path.join(LIB, 'report-mcp.js')], env: { GUILD_URL: this.guild.url, GUILD_QUEST_ID: this.id, GUILD_AGENT_ID: a.id, GUILD_SECRET: this.secret } } },
    }), { mode: 0o600 });
    const tools = Array.isArray(role.tools) ? role.tools : [...READ_TOOLS, ...(canEdit ? EDIT_TOOLS : [])];
    const sess = new ClaudeSession({
      cwd,
      addDirs: this.extraDirs(cwd),
      model: role.model ?? null,
      systemPrompt: this.agentSystemPrompt(a, role),
      allowedTools: [...tools.filter((t) => canEdit || !EDIT_TOOLS.includes(t)), 'mcp__guild__report_progress', 'mcp__guild__ask', 'mcp__guild__attach_file'],
      disallowedTools: [...DENIED, ...(canEdit ? [] : EDIT_TOOLS)],
      permissionMode: canEdit ? 'acceptEdits' : undefined,
      mcpConfig,
      resume: message ? a.sessionId : undefined,
    });
    this.sessions.set(a.id, sess);
    const baseCost = a.costUsd ?? 0;

    let first;
    if (message) {
      first = message;
    } else {
      const notes = a.notes.splice(0);
      first = [
        `Your task:\n${a.task}`,
        ``,
        `(For context, the party's quest: ${this.s.goal})`,
        notes.length ? `\nMessages for you:\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
      ].join('\n');
    }

    sess.on('init', ({ sessionId }) => { a.sessionId = sessionId; this.save(); });
    sess.on('text', (text) => this.updateAgent(a, { activity: `“${clip(text.split('\n')[0], 90)}”` }));
    sess.on('tool', (t) => {
      const d = describeTool(t);
      if (d) { a.activity = d; this.emit('activity', { agentId: a.id, activity: d }); }
    });
    sess.on('result', async (r) => {
      a.costUsd = baseCost + sess.costUsd;
      this.addCost();
      if (a.status === 'cancelled') return;
      if (a.notes.length && !r.is_error) {
        // Messages arrived after its last report: hand them over as a new turn.
        const notes = a.notes.splice(0);
        this.log('guild', 'system', `Delivered ${notes.length} message(s) to ${a.name}.`);
        sess.send(`Messages for you:\n${notes.map((n) => `- ${n}`).join('\n')}\n\nAct on them, then give your final report again.`);
        return;
      }
      const ok = !r.is_error && r.subtype === 'success';
      const commits = edit && canEdit && a.worktrees ? await this.tallyCommits(a) : '';
      const result = String(r.result ?? '').trim() || '(no final message)';
      this.updateAgent(a, { status: ok ? 'done' : 'failed', percent: ok ? 100 : a.percent, activity: null, result, finishedAt: now() });
      this.log(a.id, ok ? 'done' : 'failed', clip(result, 4000));
      const perRepo = this.multi && a.commitsByRepo ? ` (${Object.entries(a.commitsByRepo).map(([r, n]) => `${r} ${n}`).join(', ')})` : '';
      const branchNote = edit && canEdit ? `\nBranch ${a.branch}: ${a.commits ?? 0} commit(s)${perRepo}.${commits}` : '';
      this.tell(`[${ok ? 'done' : 'failed'}] ${a.name} the ${a.title} (${a.id}) has returned. Final report:\n${result}${branchNote}`, true);
      sess.close();
    });
    sess.on('exit', ({ code, stderr }) => {
      if (this.sessions.get(a.id) === sess) this.sessions.delete(a.id);
      this.guild.release();
      if (!FINISHED_AGENT.has(a.status)) {
        const why = clip(stderr.trim().split('\n').pop() || `exit code ${code}`, 300);
        this.updateAgent(a, { status: 'failed', activity: null, result: a.result ?? `The session ended unexpectedly: ${why}`, finishedAt: now() });
        this.log(a.id, 'failed', `Session ended unexpectedly: ${why}`);
        this.tell(`[failed] ${a.name} (${a.id}) fell: the session ended unexpectedly (${why}).`, true);
      }
    });
    this.updateAgent(a, { status: 'working', activity: 'Setting out…', startedAt: a.startedAt ?? now() });
    if (!message) this.log(a.id, 'action', `${a.name} the ${a.title} sets out: ${clip(a.task, 300)}`);
    sess.start(first);
  }

  report(agentId, { percent, phase, message }) {
    const a = this.agent(agentId);
    const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    this.updateAgent(a, { percent: pct, phase: phase ?? a.phase, lastReport: message, reportedAt: now() });
    this.log(a.id, 'report', message, { percent: pct, phase });
    this.emit('report', { agentId: a.id, percent: pct, phase, message });
    this.tell(`[report] ${a.name} the ${a.title} (${a.id}) ${pct}%${phase ? ` — ${phase}` : ''}: ${message}`);
    const notes = a.notes.splice(0);
    if (notes.length) this.log('guild', 'system', `Delivered ${notes.length} message(s) to ${a.name}.`);
    return { notes };
  }

  ask(agentId, question) {
    const a = this.agent(agentId);
    const askId = crypto.randomBytes(4).toString('hex');
    this.asks.set(askId, { agentId, question, answer: undefined, waiters: [] });
    this.updateAgent(a, { status: 'blocked', question, askId, activity: 'Waiting for an answer' });
    this.log(a.id, 'question', question);
    this.emit('report', { agentId: a.id, percent: a.percent, phase: 'blocked', message: question });
    this.tell(`[blocked] ${a.name} the ${a.title} (${a.id}) asks: ${question}\nAnswer with answer_agent (the human may answer first).`, true);
    return { askId };
  }

  waitAnswer(askId, seconds, res) {
    const ask = this.asks.get(askId);
    if (!ask) return res({ answer: 'This question is no longer open. Carry on.' });
    if (ask.answer !== undefined) return res({ answer: ask.answer });
    const done = (answer) => { clearTimeout(t); res(answer === undefined ? { pending: true } : { answer }); };
    const t = setTimeout(() => { ask.waiters = ask.waiters.filter((w) => w !== done); done(undefined); }, Math.min(55, seconds) * 1000);
    ask.waiters.push(done);
  }

  resolveAsk(ask, answer) {
    ask.answer = answer;
    for (const w of ask.waiters.splice(0)) w(answer);
  }

  answerAgent(agentId, text, from) {
    const a = this.agent(agentId);
    const ask = a.askId && this.asks.get(a.askId);
    if (!ask || ask.answer !== undefined) {
      if (from === 'archmage') return `${a.name} has no open question (perhaps the human already answered). Use message_agent to send guidance.`;
      throw new Error(`${a.name} has no open question.`);
    }
    this.resolveAsk(ask, from === 'you' ? `(from the human) ${text}` : text);
    this.updateAgent(a, { status: 'working', question: null, askId: null, activity: 'Considering the answer' });
    this.log(from, 'answer', text, { to: a.id });
    if (from === 'you') this.tell(`The human answered ${a.name} (${a.id}): ${text}`);
    return `Answered ${a.name}.`;
  }

  messageAgent(agentId, text, from) {
    const a = this.agent(agentId);
    const who = from === 'you' ? 'the human' : 'the Archmage';
    this.log(from, 'message', text, { to: a.id });
    if (from === 'you') this.tell(`The human sent ${a.name} (${a.id}) a message: ${text}`);
    if (a.status === 'cancelled' || a.status === 'interrupted') throw new Error(`${a.name} has left the party (${a.status}).`);
    if (a.status === 'done' || a.status === 'failed') {
      if (!a.sessionId) throw new Error(`${a.name} cannot be woken (no session).`);
      this.schedule(a, `A message from ${who}:\n${text}\n\nAct on it (report progress as before), then give your final report again.`);
      return `${a.name} has been woken up with your message and will report again.`;
    }
    a.notes.push(`From ${who}: ${text}`);
    this.save();
    return `${a.name} will receive the message at the next progress report.`;
  }

  cancelAgent(agentId, from, reason) {
    const a = this.agent(agentId);
    if (FINISHED_AGENT.has(a.status)) return `${a.name} is already ${a.status}.`;
    const start = this.queued.get(a.id);
    if (start && this.guild.dequeue(start)) this.queued.delete(a.id); // it never held a slot
    this.updateAgent(a, { status: 'cancelled', activity: null, finishedAt: now(), result: a.result ?? `Cancelled${reason ? `: ${reason}` : ''}.` });
    this.sessions.get(a.id)?.kill();
    if (a.askId && this.asks.get(a.askId)) this.resolveAsk(this.asks.get(a.askId), 'You have been recalled. Stop now.');
    this.log(from, 'action', `Recalled ${a.name}${reason ? `: ${reason}` : ''}.`, { to: a.id });
    if (from === 'you') this.tell(`The human recalled ${a.name} (${a.id}).`, true);
    else this.afterAgentChange();
    return `${a.name} has been recalled.`;
  }

  afterAgentChange() {
    if (this.arch && !this.arch.busy) this.afterArchmageTurn();
  }

  async partyReport() {
    if (!this.s.agents.length) return 'The party is empty.';
    const pending = new Map();
    for (const a of this.s.agents) if (a.branch) pending.set(a.id, (await this.unmerged(a)).length);
    return this.s.agents.map((a) => [
      `${a.id}: ${a.name} the ${a.title} — ${a.status}, ${a.percent}%${a.phase ? ` (${a.phase})` : ''}`,
      `  task: ${clip(a.task, 300)}`,
      a.question ? `  open question: ${a.question}` : '',
      a.lastReport ? `  last report: ${clip(a.lastReport, 300)}` : '',
      a.result ? `  final report: ${clip(a.result, 1500)}` : '',
      a.branch ? `  branch: ${a.branch} (${a.commits ?? 0} commits)${pending.get(a.id) ? ', not merged yet' : a.commits ? ', merged' : ''}${this.s.leftOut?.includes(a.id) ? ', left out' : ''}` : '',
    ].filter(Boolean).join('\n')).join('\n\n');
  }

  async mergeInProgress() {
    for (const r of this.s.repos) if (await G.mergeInProgress(r.integrationDir)) return r;
    return null;
  }

  /** `leaveOut`: agent ids whose remaining work the Archmage decides not to merge (say why in the chronicle). */
  async mergeParty({ leaveOut = [] } = {}) {
    if (this.s.mode !== 'edit') throw new Error('merge_party is only for edit-mode quests.');
    const busy = await this.mergeInProgress();
    if (busy) throw new Error(`A merge is still in progress${this.multi ? ` in ${busy.name}/` : ''}: resolve the conflicts, git add, git commit (or git merge --abort and pass leaveOut), then call merge_party again.`);
    for (const id of leaveOut) {
      const a = this.agent(id);
      this.s.leftOut = [...new Set([...(this.s.leftOut ?? []), a.id])];
      this.log('archmage', 'action', `Left ${a.name}'s unmerged work out of the quest branch.`);
    }
    const lines = [];
    const working = this.s.agents.filter((a) => !FINISHED_AGENT.has(a.status));
    const branch = this.s.repos[0].branch;
    for (const a of this.s.agents) {
      if (!a.branch || this.s.leftOut?.includes(a.id)) continue;
      const todo = await this.unmerged(a);
      if (!todo.length) continue;
      if (a.status !== 'done') { if (FINISHED_AGENT.has(a.status)) lines.push(`skipped ${a.name}: ${a.status}`); continue; }
      for (const w of todo) {
        const n = w.commits;
        const where = this.multi ? ` into ${w.repo}` : '';
        const r = await G.merge(w.integrationDir, a.branch, `Merge ${a.name} the ${a.title} (${a.branch})`);
        if (!r.ok && !r.conflicts.length) {
          this.save();
          throw new Error(`Merging ${a.name} (${a.branch})${where} failed without conflicts: ${r.error}. Inspect the working directory and fix it, then call merge_party again.`);
        }
        if (!r.ok) {
          this.log('archmage', 'action', `Merging ${a.name}${where}: conflicts in ${r.conflicts.join(', ')}`);
          this.save();
          return [...lines, `CONFLICT merging ${a.name} (${a.branch})${where} in ${r.conflicts.join(', ')}.`,
            `Resolve the conflicts in ${this.multi ? `${w.repo}/ of ` : ''}your working directory, git add the files and git commit, then call merge_party again. To drop this work instead: git merge --abort, then merge_party with leaveOut: ["${a.id}"].`].join('\n');
        }
        lines.push(`merged ${a.name}${where} (${n} commits)`);
      }
    }
    this.save();
    this.log('archmage', 'action', `Merged the party into ${branch}${this.multi ? ` in ${this.s.repos.map((r) => r.name).join(', ')}` : ''}.`);
    if (working.length) lines.push(`Still working (not merged): ${working.map((a) => a.name).join(', ')}`);
    return `${lines.join('\n') || 'Nothing new to merge.'}\nQuest branch: ${branch}${this.multi ? ' (in each repository)' : ''}.`;
  }

  async finish(chronicle) {
    if (!chronicle?.trim()) throw new Error('The chronicle is empty.');
    if (this.s.mode === 'edit') {
      const busy = await this.mergeInProgress();
      if (busy) throw new Error(`Finish the merge in progress${this.multi ? ` in ${busy.name}/` : ''} first (git add, git commit).`);
      for (const r of this.s.repos) await G.commitLeftovers(r.integrationDir, 'Archmage: final touches');
      const unmerged = [];
      for (const a of this.s.agents) {
        if (a.status === 'done' && a.branch && !this.s.leftOut?.includes(a.id) && (await this.unmerged(a)).length) unmerged.push(a);
      }
      if (unmerged.length) throw new Error(`Unmerged work from ${unmerged.map((a) => `${a.name} (${a.id})`).join(', ')}: call merge_party first, or leave it out with merge_party's leaveOut.`);
    }
    this.s.chronicle = chronicle;
    this.log('archmage', 'action', 'Wrote the chronicle.');
    setImmediate(() => this.end('done'));
    return 'The chronicle is written and the quest is complete. End your turn.';
  }
}
