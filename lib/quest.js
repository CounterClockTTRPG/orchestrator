// One quest: its state and events, its lifecycle (interrupt, resume, finish, end), and the method groups from the
// other modules that make up the rest of it (the Archmage, the party, the workspace, roles, attachments).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as G from './git.js';
import * as store from './store.js';
import { findApp, repoNotes, standingContext } from './apps.js';
import { agentTitle } from '../web/titles.js';
import * as P from './prompts.js';
import { roleMethods } from './roles.js';
import { archmageMethods } from './archmage.js';
import { planMethods, dependencyMethods, sessionMethods, talkMethods } from './party.js';
import { workspaceMethods } from './workspace.js';
import { attachmentMethods } from './attachments.js';
import { LIB, ACTIVE, FINISHED_AGENT, now, mixin } from './common.js';

const LOG_LIMIT = 3000;

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
    const { id, goal, app, cwd, mode, planning, status, createdAt, updatedAt, finishedAt, pausedMs, costUsd } = this.s;
    return {
      id, goal, app: app ?? null, cwd, dirs: this.s.dirs.map((d) => d.name), mode, planning, status, createdAt, updatedAt, finishedAt, pausedMs, costUsd,
      theme: this.s.theme,
      party: this.s.agents.map(({ id, name, presentation, role, status, percent, task, taskTitle }) => ({ id, name, presentation, role, status, percent, taskTitle: taskTitle ?? agentTitle({ task }) })),
    };
  }

  // ── events and persistence ──

  emit(type, data) {
    this.s.updatedAt = now();
    const event = { type, quest: this.id, ts: this.s.updatedAt, ...data };
    if (type !== 'activity') {
      // Stored events are numbered, so a client that reconnects can ask for what it missed (?since=).
      event.seq = this.s.seq = (this.s.seq ?? 0) + 1;
      store.appendEvent(this.id, event);
    }
    this.guild.emit('quest', event);
    this.guild.emit('global', { type: 'summary', quest: this.summary() });
    this.save();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  /** Write quest.json at once (dropping a pending debounced save). A failed write is logged; the quest goes on. */
  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      store.saveQuest(this.s);
      return true;
    } catch (err) {
      console.error(`Guild: could not save quest ${this.id}: ${err.message}`);
      return false;
    }
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
    this.emit('quest', { status, finishedAt: this.s.finishedAt, pausedMs: this.s.pausedMs });
  }

  agent(id) {
    const a = this.s.agents.find((x) => x.id === id);
    if (!a) throw new Error(`No agent ${id} in this quest. Use list_party.`);
    return a;
  }

  updateAgent(a, patch) {
    Object.assign(a, patch);
    this.emit('agent', { agent: a });
    // A finished agent may be what others wait for (after the caller's own bookkeeping).
    if (FINISHED_AGENT.has(patch.status) && this.s.agents.some((x) => x.status === 'waiting')) queueMicrotask(() => this.releaseWaiting());
  }

  addCost() {
    let total = this.s.archmage?.costUsd ?? 0;
    for (const a of this.s.agents) total += a.costUsd ?? 0;
    this.s.costUsd = total;
  }

  /** The application's standing context and the GUILD.md of each directory, for every prompt. */
  standingContext() {
    return standingContext(findApp(this.guild.apps, this.s.app), repoNotes(this.s.dirs));
  }

  /** Write the MCP config of one session (only its own server, with the quest's secret). Returns its path. */
  writeMcpConfig(file, server, script, env) {
    const mcpConfig = path.join(this.dir, 'mcp', `${file}.json`);
    fs.writeFileSync(mcpConfig, JSON.stringify({
      mcpServers: { [server]: { command: process.execPath, args: [path.join(LIB, script)], env } },
    }), { mode: 0o600 });
    return mcpConfig;
  }

  // ── lifecycle ──

  markInterrupted() {
    let changed = false;
    const at = this.s.updatedAt ?? now(); // the last sign of life before the server stopped
    if (ACTIVE.has(this.s.status)) {
      this.s.resumeStatus = this.s.status;
      this.s.status = 'interrupted'; this.s.finishedAt = at; this.s.interruptedAt = at; changed = true;
    }
    for (const a of this.s.agents) {
      // Waiting agents never set out: they keep waiting, and are released again on resume.
      if (!FINISHED_AGENT.has(a.status) && a.status !== 'waiting') {
        Object.assign(a, { status: 'interrupted', activity: null, question: null, askId: null, checkIn: false, interruptedAt: at });
        changed = true;
      }
    }
    if (this.s.archmage && !['done', 'idle'].includes(this.s.archmage.status)) this.s.archmage.status = 'idle';
    if (changed) this.saveNow();
  }

  /**
   * The server is stopping: record the quest and its running agents as interrupted (so resume picks them up) and
   * save that at once, then stop every session. The exit handlers find the quest no longer active, so they neither
   * revive the Archmage nor record the agents as failed. Resolves when the sessions have exited (or after `ms`).
   */
  interrupt(ms = 5000) {
    const sessions = [this.arch, ...this.sessions.values()].filter(Boolean);
    if (!ACTIVE.has(this.s.status) && !sessions.length) {
      if (this.saveTimer) this.saveNow();
      return Promise.resolve();
    }
    clearInterval(this.timer);
    for (const [id, start] of this.queued) { this.guild.dequeue(start); this.queued.delete(id); }
    if (ACTIVE.has(this.s.status)) this.log('guild', 'system', 'The Guild server is stopping; the quest is interrupted. Resume it once the server is back.');
    this.s.updatedAt = now();
    this.markInterrupted();
    this.saveNow();
    for (const s of sessions) s.kill();
    return Promise.all(sessions.map((s) => s.waitExit(ms)));
  }

  /**
   * Carry on with a quest the server stopped in the middle of: the Archmage and every interrupted agent are
   * resumed from their Claude sessions (claude --resume), in the same worktrees.
   */
  async resume() {
    if (this.s.status !== 'interrupted') throw new Error('Only an interrupted quest can be resumed.');
    const arch = this.s.archmage;
    if (!arch?.sessionId) throw new Error('The Archmage never got a session going; post the quest again.');
    const status = this.s.resumeStatus ?? (this.s.plan?.status === 'approved' ? 'questing' : this.s.plan ? 'awaiting-approval' : 'planning');
    const stopped = this.s.agents.filter((a) => a.status === 'interrupted');
    if (this.s.mode === 'edit') {
      // Worktrees normally survive a stop, but may have been removed by hand since.
      for (const r of this.s.repos) await G.restoreWorktree(r.root, r.integrationDir, r.branch);
      for (const a of stopped) for (const w of this.worktreesOf(a)) await G.restoreWorktree(w.root, w.dir, a.branch);
    }
    this.addPause(stopped);
    delete this.s.resumeStatus;
    delete this.s.interruptedAt;
    this.s.finishedAt = null;
    Object.assign(this, { inbox: [], urgent: false, humanWaiting: false, conversing: false, nudges: 0, archRestarts: 0, lastFlush: Date.now() });
    this.setStatus(status);
    this.log('you', 'message', 'Resumed the quest.');
    this.resumeAgents(stopped);
    const resumed = stopped.map((a) => `${a.name} (${a.id})`).join(', ');
    this.startArchmage(P.resumeBriefing({ resumed, party: this.partyReport(), status }), arch.sessionId);
    this.timer = setInterval(() => this.flush(), 5000);
    this.timer.unref();
    return this.s;
  }

  /** The time a quest and its stopped agents spent interrupted does not count as time spent. */
  addPause(stopped) {
    const t = Date.now();
    const since = (ts) => Math.max(0, t - (Date.parse(ts) || t));
    this.s.pausedMs = (this.s.pausedMs ?? 0) + since(this.s.interruptedAt);
    for (const a of stopped) if (a.startedAt) a.pausedMs = (a.pausedMs ?? 0) + since(a.interruptedAt);
  }

  /** Requeue the interrupted agents (resumed from their sessions), and release the waiting ones again. */
  resumeAgents(stopped) {
    for (const a of stopped) {
      delete a.interruptedAt;
      if (a.sessionId) {
        this.schedule(a, 'The Guild server stopped while you were working, so your session was interrupted. It has been resumed. ' +
          'Carry on with your task from where you left off (check what you had already done), report progress as before, then give your final report. ' +
          'If you were waiting on a question, ask it again.');
      } else {
        this.schedule(a, null); // it never set out: start it afresh
      }
    }
    for (const a of this.s.agents) if (a.status === 'waiting') a.held = false; // tell the Archmage again if still stuck
    this.releaseWaiting();
  }

  async finish(chronicle) {
    if (!chronicle?.trim()) throw new Error('The chronicle is empty.');
    if (this.s.mode === 'edit') await this.checkFinish();
    this.s.chronicle = chronicle;
    this.log('archmage', 'action', 'Wrote the chronicle.');
    setImmediate(() => this.end('done'));
    return 'The chronicle is written and the quest is complete. End your turn.';
  }

  cancel(reason = 'Cancelled by the human.') {
    if (!ACTIVE.has(this.s.status)) throw new Error('The quest is not running.');
    this.s.chronicle = `**Cancelled.** ${reason}`;
    this.log('you', 'message', 'Cancelled the quest.');
    return this.end('cancelled');
  }

  fail(reason) {
    if (!ACTIVE.has(this.s.status)) return;
    this.s.chronicle = this.s.chronicle ?? `**The quest failed.** ${reason}`;
    this.end('failed');
  }

  /** End the quest once: a second call (a cancel during a finish, a fail during a cancel) gets the same promise. */
  end(status) {
    if (this.guild.stopping) return Promise.resolve(); // the quest is interrupted instead, to be resumed
    this.ending ??= this.settle(status);
    return this.ending;
  }

  async settle(status) {
    clearInterval(this.timer);
    for (const [id, start] of this.queued) { this.guild.dequeue(start); this.queued.delete(id); }
    const sessions = [...this.sessions.values()]; // an exited one leaves the map, but its group may still be dying
    for (const a of this.s.agents) {
      if (!FINISHED_AGENT.has(a.status)) this.updateAgent(a, { status: 'cancelled', activity: null, finishedAt: now() });
      this.sessions.get(a.id)?.kill();
    }
    for (const ask of this.asks.values()) if (ask.answer === undefined) this.resolveAsk(ask, 'The quest has ended. Stop now.');
    if (this.s.archmage) this.s.archmage.status = status === 'done' ? 'done' : 'idle';
    const arch = this.arch;
    if (status !== 'done') arch?.kill(); else arch?.close();
    this.setStatus(status);
    // Nothing may still run in a worktree when it goes away. The Archmage may finish its last turn; one that is
    // still going after a minute is killed (and its group with it). Killed agents get SIGKILL after 3 s.
    if (arch && !(await arch.waitExit(60_000))) { arch.kill(); await arch.waitExit(5000); }
    await Promise.all(sessions.map((s) => s.waitExit(10_000)));
    if (this.s.mode === 'edit') await this.cleanupWorktrees(status === 'done');
    if (this.s.mode === 'edit' && status === 'done') await this.prepareDelivery();
    this.log('guild', 'system', status === 'done' ? 'The quest is complete.' : `The quest ended: ${status}.`);
    this.emit('chronicle', { chronicle: this.s.chronicle, diffs: this.s.diffs, delivery: this.s.delivery });
    this.saveNow();
    try { store.chronicleFile(this.s); } catch { /* the briefing of a later quest tries again */ }
  }
}

mixin(Quest.prototype, roleMethods, archmageMethods, planMethods, dependencyMethods, sessionMethods, talkMethods, workspaceMethods, attachmentMethods);
