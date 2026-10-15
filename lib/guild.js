// The guild: quests, their Archmage and party processes, the global agent queue, and the event stream.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClaudeSession, describeTool } from './claude.js';
import * as G from './git.js';
import { raceOf, pickName, hash, RACES } from './names.js';
import * as store from './store.js';

const LIB = path.dirname(fileURLToPath(import.meta.url));
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];
const NO_NESTING = ['Task', 'Agent'];
const ACTIVE = new Set(['planning', 'awaiting-approval', 'questing']);
const FINISHED_AGENT = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const LOG_LIMIT = 3000;

const now = () => new Date().toISOString();
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

// ───────────────────────────── the guild (all quests) ─────────────────────────────

export class Guild extends EventEmitter {
  constructor({ port }) {
    super();
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.settings = store.loadSettings();
    this.roles = store.loadRoles();
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

  async createQuest({ goal, cwd, mode = 'read', planning = 'review', maxAgents }) {
    if (!goal?.trim()) throw new Error('A quest needs a goal.');
    cwd = path.resolve(String(cwd || this.settings.lastCwd || process.cwd()).replace(/^~(?=\/|$)/, process.env.HOME));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
    if (!['read', 'edit'].includes(mode)) throw new Error('mode must be "read" or "edit"');
    if (!['review', 'auto'].includes(planning)) throw new Error('planning must be "review" or "auto"');
    let repo = null;
    if (mode === 'edit') {
      repo = await G.repoInfo(cwd);
      if (!repo) throw new Error('Edit mode needs a git repository; this directory is not in one. Use read-only mode, or run git init first.');
    }
    const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
    const q = new Quest(this, {
      id, goal: goal.trim(), cwd, mode, planning,
      maxAgents: Math.max(1, Math.min(20, Number(maxAgents) || this.settings.maxAgents)),
      status: 'planning', createdAt: now(), updatedAt: now(),
      repo: repo && { root: repo.root, base: repo.head, dirty: repo.dirty, branch: `guild/${id}/party` },
      archmage: null, plan: null, roles: {}, agents: [], log: [], chronicle: null, diff: null, merged: [], costUsd: 0,
    });
    this.quests.set(id, q);
    try {
      await q.begin();
    } catch (err) {
      // Leave no half-made quest behind (in memory, on disk, or as a worktree).
      this.quests.delete(id);
      q.arch?.kill();
      clearInterval(q.timer);
      if (repo) {
        await G.removeWorktree(repo.root, path.join(store.WORKTREES_DIR, id, '_archmage'));
        await G.git(repo.root, 'branch', '-D', `guild/${id}/party`).catch(() => {});
      }
      fs.rmSync(store.questDir(id), { recursive: true, force: true });
      throw err;
    }
    this.settings.lastCwd = cwd;
    store.saveSettings(this.settings);
    return q;
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
    for (const k of ['style', 'maxConcurrent', 'maxAgents', 'batchSeconds']) if (patch[k] !== undefined) this.settings[k] = patch[k];
    this.settings.maxConcurrent = Math.max(1, Number(this.settings.maxConcurrent) || 4);
    store.saveSettings(this.settings);
    this.drain();
    this.emit('global', { type: 'settings', settings: this.settings });
    return this.settings;
  }

  saveRole(id, role) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error('Role id: lowercase letters, digits and dashes');
    const { invented, ...clean } = role;
    this.roles[id] = clean;
    store.saveRoles(this.roles);
    this.emit('global', { type: 'roles', roles: this.roles });
    return this.roles;
  }

  replaceRoles(roles) {
    if (!roles || typeof roles !== 'object' || !Object.values(roles).some((r) => r.orchestrator)) throw new Error('The catalog needs an orchestrator role.');
    this.roles = roles;
    store.saveRoles(roles);
    this.emit('global', { type: 'roles', roles });
    return roles;
  }
}

// ───────────────────────────── one quest ─────────────────────────────

class Quest {
  constructor(guild, state) {
    this.guild = guild;
    this.state = state;
    this.id = state.id;
    this.sessions = new Map(); // agentId -> ClaudeSession
    this.asks = new Map(); // askId -> { agentId, question, answer, waiters: [] }
    this.queued = new Map(); // agentId -> scheduler callback
    this.inbox = []; // messages waiting for the Archmage
    this.urgent = false;
    this.lastFlush = Date.now();
    this.nudges = 0;
    this.archRestarts = 0;
    this.saveTimer = null;
  }

  get s() { return this.state; }
  get dir() { return store.questDir(this.id); }

  summary() {
    const { id, goal, cwd, mode, planning, status, createdAt, updatedAt, finishedAt, costUsd } = this.s;
    return {
      id, goal, cwd, mode, planning, status, createdAt, updatedAt, finishedAt, costUsd,
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
    const entry = { ts: now(), who, kind, text, ...extra };
    this.s.log.push(entry);
    if (this.s.log.length > LOG_LIMIT) this.s.log.splice(0, this.s.log.length - LOG_LIMIT);
    this.emit('log', { entry });
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
      await G.addWorktree(this.s.repo.root, integration, this.s.repo.branch, this.s.repo.base);
      this.s.repo.integrationDir = integration;
      workdir = path.join(integration, path.relative(this.s.repo.root, this.s.cwd));
    }
    this.s.archmage = {
      role: roleId, name: role.name ?? 'Velothar', title: role.title ?? 'Archmage', model: role.model ?? null,
      status: 'thinking', thought: 'Studying the quest…', costUsd: 0, sessionId: null, workdir,
    };
    this.save();
    store.appendEvent(this.id, { type: 'created', ts: now(), quest: this.id, goal: this.s.goal });
    this.log('guild', 'system', `Quest posted: ${this.s.goal}`);
    this.startArchmage(this.archmageBriefing());
    this.timer = setInterval(() => this.flush(), 5000);
    this.timer.unref();
  }

  archmageSystemPrompt() {
    const a = this.s.archmage;
    const roles = Object.entries(this.guild.roles)
      .filter(([, r]) => !r.orchestrator)
      .map(([id, r]) => `- ${id}: ${r.title} — ${r.blurb ?? ''} (tools: ${r.tools ?? 'read'}${r.model ? `, model ${r.model}` : ''})`)
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
        ? `4. When everyone is finished, call merge_party. Your working directory is the integration worktree on branch ${this.s.repo.branch}. Resolve any conflicts there (edit, git add, git commit) and call merge_party again until all is merged. Run a cheap build or test if there is one. Then call finish_quest.`
        : `4. When everyone is finished, call finish_quest.`,
      `   The chronicle is the deliverable: a complete markdown answer to the quest for the human, synthesised from the reports (not a list of who did what), crediting agents by name where useful.`,
      ``,
      `Voice: your visible text is shown on the council table, so keep it to one or two lines, in character as a wise old archmage. Write tasks and the chronicle in plain, precise language.`,
      `Messages from "the human" come from the person overseeing the quest; their instructions override yours.`,
    ].join('\n');
  }

  archmageBriefing() {
    return [
      `The quest: ${this.s.goal}`,
      ``,
      `Directory: ${this.s.cwd}${this.s.mode === 'edit' ? ` (you work in the integration worktree ${this.s.archmage.workdir})` : ''}`,
      this.s.repo?.dirty ? `Note: the human's checkout has uncommitted changes; the party works from the last commit (${this.s.repo.base.slice(0, 8)}).` : '',
      ``,
      `Plan the party and call propose_plan.`,
    ].filter((l) => l !== '').join('\n');
  }

  startArchmage(firstMessage, resume) {
    const a = this.s.archmage;
    const mcpConfig = path.join(this.dir, 'mcp', 'archmage.json');
    fs.writeFileSync(mcpConfig, JSON.stringify({
      mcpServers: { council: { command: process.execPath, args: [path.join(LIB, 'council-mcp.js')], env: { GUILD_URL: this.guild.url, GUILD_QUEST_ID: this.id } } },
    }));
    const council = ['propose_plan', 'recruit_agent', 'message_agent', 'answer_agent', 'cancel_agent', 'list_party', 'merge_party', 'finish_quest'].map((t) => `mcp__council__${t}`);
    const sess = new ClaudeSession({
      cwd: a.workdir,
      model: a.model,
      systemPrompt: this.archmageSystemPrompt(),
      allowedTools: [...READ_TOOLS, ...(this.s.mode === 'edit' ? EDIT_TOOLS : []), ...council],
      disallowedTools: NO_NESTING,
      permissionMode: this.s.mode === 'edit' ? 'acceptEdits' : undefined,
      mcpConfig,
      resume,
    });
    const baseCost = a.costUsd;
    this.arch = sess;
    sess.on('init', ({ sessionId }) => { a.sessionId = sessionId; this.save(); });
    sess.on('text', (text) => {
      a.thought = clip(text, 400);
      this.emit('archmage', { archmage: a });
      this.log('archmage', 'say', clip(text, 2000));
    });
    sess.on('tool', (t) => {
      if (t.name.startsWith('mcp__council__')) return; // logged by the tool handlers
      const d = describeTool(t);
      if (d) { a.activity = d; this.emit('archmage', { archmage: a }); }
    });
    sess.on('result', (r) => {
      a.costUsd = baseCost + sess.costUsd;
      this.addCost();
      a.activity = null;
      a.status = ACTIVE.has(this.s.status) ? 'waiting' : 'done';
      this.emit('archmage', { archmage: a });
      if (r.is_error) this.log('guild', 'system', `The Archmage's turn ended in an error: ${clip(r.result ?? r.subtype, 300)}`);
      this.afterArchmageTurn(r);
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
    this.emit('chronicle', { chronicle: this.s.chronicle, diff: this.s.diff });
    store.saveQuest(this.s);
  }

  async cleanupWorktrees(withDiff) {
    const { root, base, branch, integrationDir } = this.s.repo;
    try {
      if (withDiff) this.s.diff = await G.diff(root, base, branch);
    } catch (err) { this.log('guild', 'system', `Could not compute the diff: ${err.message}`); }
    for (const a of this.s.agents) {
      if (!a.worktree) continue;
      // Keep whatever a recalled or unfinished agent left behind: commit it to its branch first.
      try { await G.commitLeftovers(a.worktree, `${a.name} (${a.title}): work in progress (${a.status})`); } catch { /* nothing to keep */ }
      await G.removeWorktree(root, a.worktree);
    }
    if (integrationDir) await G.removeWorktree(root, integrationDir);
    try { await G.git(root, 'worktree', 'prune'); } catch { /* ignore */ }
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
    this.tell(`Message from the human: ${text}`, true);
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
        const race = RACES[h % RACES.length];
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
      merge_party: () => this.mergeParty(),
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
      name: pickName(race, taken, `${this.id}:${this.s.agents.length}`),
      role: roleId, title: role.title, task,
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
    return [
      `You are ${a.name}, the ${role.title} in a guild party of Claude Code agents led by ${this.s.archmage.name} the Archmage.`,
      role.prompt ?? '',
      ``,
      `Reporting: call mcp__guild__report_progress when you start (a low percent and your plan in one sentence), after each meaningful step, and with percent 100 at the end. Its reply may carry messages from the Archmage or the human: follow them.`,
      `If you are blocked on a decision you cannot reasonably make yourself, call mcp__guild__ask; it waits for the answer. Do not ask about things you can find out.`,
      `Your final message is your report to the Archmage: concise but complete and concrete (paths with line numbers, commands, results, open questions).`,
      canEdit
        ? `You work in your own git worktree at ${a.dir} on branch ${a.branch}; other agents work in parallel on their own branches. Stay inside that directory. Commit your work with clear messages before your final report. Do not push and do not switch branches.`
        : `This is a read-only task: do not modify any files.`,
    ].join('\n');
  }

  async startAgent(a, message) {
    const role = this.guild.role(a.role, this);
    const edit = this.s.mode === 'edit';
    const canEdit = edit && role.tools !== 'read';
    let cwd = this.s.cwd;
    if (edit) {
      if (!a.dir) {
        const { root, base } = this.s.repo;
        const slug = `${a.id}-${a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        a.worktree = path.join(store.WORKTREES_DIR, this.id, slug);
        a.branch = `guild/${this.id}/${slug}`;
        await G.addWorktree(root, a.worktree, a.branch, base);
        a.dir = path.join(a.worktree, path.relative(root, this.s.cwd));
      }
      cwd = a.dir;
    }
    const mcpConfig = path.join(this.dir, 'mcp', `${a.id}.json`);
    fs.writeFileSync(mcpConfig, JSON.stringify({
      mcpServers: { guild: { command: process.execPath, args: [path.join(LIB, 'report-mcp.js')], env: { GUILD_URL: this.guild.url, GUILD_QUEST_ID: this.id, GUILD_AGENT_ID: a.id } } },
    }));
    const tools = Array.isArray(role.tools) ? role.tools : [...READ_TOOLS, ...(canEdit ? EDIT_TOOLS : [])];
    const sess = new ClaudeSession({
      cwd,
      model: role.model ?? null,
      systemPrompt: this.agentSystemPrompt(a, role),
      allowedTools: [...tools.filter((t) => canEdit || !EDIT_TOOLS.includes(t)), 'mcp__guild__report_progress', 'mcp__guild__ask'],
      disallowedTools: [...NO_NESTING, ...(canEdit ? [] : EDIT_TOOLS)],
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
      let commits = '';
      if (edit && canEdit && a.worktree) {
        try {
          if (await G.commitLeftovers(a.worktree, `${a.name} (${a.title}): uncommitted work`)) commits = ' (Guild committed uncommitted leftovers.)';
          a.commits = await G.commitCount(this.s.repo.root, this.s.repo.base, a.branch);
        } catch (err) { commits = ` (Commit check failed: ${err.message})`; }
      }
      const result = String(r.result ?? '').trim() || '(no final message)';
      this.updateAgent(a, { status: ok ? 'done' : 'failed', percent: ok ? 100 : a.percent, activity: null, result, finishedAt: now() });
      this.log(a.id, ok ? 'done' : 'failed', clip(result, 4000));
      const branchNote = edit && canEdit ? `\nBranch ${a.branch}: ${a.commits ?? 0} commit(s).${commits}` : '';
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

  partyReport() {
    if (!this.s.agents.length) return 'The party is empty.';
    return this.s.agents.map((a) => [
      `${a.id}: ${a.name} the ${a.title} — ${a.status}, ${a.percent}%${a.phase ? ` (${a.phase})` : ''}`,
      `  task: ${clip(a.task, 300)}`,
      a.question ? `  open question: ${a.question}` : '',
      a.lastReport ? `  last report: ${clip(a.lastReport, 300)}` : '',
      a.result ? `  final report: ${clip(a.result, 1500)}` : '',
      a.branch ? `  branch: ${a.branch} (${a.commits ?? 0} commits)${this.s.merged.includes(a.id) ? ', merged' : ''}` : '',
    ].filter(Boolean).join('\n')).join('\n\n');
  }

  async mergeParty() {
    if (this.s.mode !== 'edit') throw new Error('merge_party is only for edit-mode quests.');
    const dir = this.s.repo.integrationDir;
    if (await G.mergeInProgress(dir)) throw new Error('A merge is still in progress: resolve the conflicts, git add, git commit, then call merge_party again.');
    const lines = [];
    const working = this.s.agents.filter((a) => !FINISHED_AGENT.has(a.status));
    for (const a of this.s.agents) {
      if (!a.branch || this.s.merged.includes(a.id)) continue;
      if (a.status !== 'done') { if (FINISHED_AGENT.has(a.status)) lines.push(`skipped ${a.name}: ${a.status}`); continue; }
      if (!a.commits) { this.s.merged.push(a.id); lines.push(`${a.name}: no commits`); continue; }
      const r = await G.merge(dir, a.branch, `Merge ${a.name} the ${a.title} (${a.branch})`);
      if (!r.ok && !r.conflicts.length) {
        this.save();
        throw new Error(`Merging ${a.name} (${a.branch}) failed without conflicts: ${r.error}. Inspect the working directory and fix it, then call merge_party again.`);
      }
      if (!r.ok) {
        this.log('archmage', 'action', `Merging ${a.name}: conflicts in ${r.conflicts.join(', ')}`);
        this.s.merged.push(a.id); // the Archmage completes this merge by committing the resolution
        this.save();
        return [...lines, `CONFLICT merging ${a.name} (${a.branch}) in ${r.conflicts.join(', ')}.`,
          'Resolve the conflicts in your working directory, git add the files and git commit, then call merge_party again.'].join('\n');
      }
      this.s.merged.push(a.id);
      lines.push(`merged ${a.name} (${a.commits} commits)`);
    }
    this.save();
    this.log('archmage', 'action', `Merged the party into ${this.s.repo.branch}.`);
    if (working.length) lines.push(`Still working (not merged): ${working.map((a) => a.name).join(', ')}`);
    return `${lines.join('\n') || 'Nothing new to merge.'}\nQuest branch: ${this.s.repo.branch}.`;
  }

  async finish(chronicle) {
    if (!chronicle?.trim()) throw new Error('The chronicle is empty.');
    if (this.s.mode === 'edit') {
      if (await G.mergeInProgress(this.s.repo.integrationDir)) throw new Error('Finish the merge in progress first (git add, git commit).');
      await G.commitLeftovers(this.s.repo.integrationDir, 'Archmage: final touches');
      const unmerged = this.s.agents.filter((a) => a.status === 'done' && a.commits && !this.s.merged.includes(a.id));
      if (unmerged.length) throw new Error(`Unmerged work from ${unmerged.map((a) => a.name).join(', ')}: call merge_party first.`);
    }
    this.s.chronicle = chronicle;
    this.log('archmage', 'action', 'Wrote the chronicle.');
    setImmediate(() => this.end('done'));
    return 'The chronicle is written and the quest is complete. End your turn.';
  }
}
