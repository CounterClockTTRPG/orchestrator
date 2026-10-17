// The party: the plan and its approval, recruiting, `after` dependencies, starting agents through the scheduler,
// their sessions, and what they and the Archmage say to each other (reports, asks, answers, messages, recalls).

import crypto from 'node:crypto';
import { ClaudeSession, describeTool } from './claude.js';
import { raceOf, pickName, presentationFor } from './names.js';
import { theme, themedName, themedRole } from '../web/themes.js';
import { checkPlan, chainLengths } from './plan.js';
import { cleanTitle, titleFromTask, agentTitle } from '../web/titles.js';
import { agentAccess } from './roles.js';
import * as P from './prompts.js';
import { ACTIVE, FINISHED_AGENT, now, clip } from './common.js';

// How long an agent's question stays open before it is told to decide for itself. Long enough for a human who
// stepped away, well under the 24 h the MCP tool call may last, and it bounds how long a blocked agent holds a slot.
export const ASK_DEADLINE_MS = 4 * 3600_000;
// How long a superseded session may take to close before it is killed.
const RETIRE_MS = 30_000;

/** Resolves once a session's process has exited; one that does not close in time is killed. */
function untilExited(sess) {
  return new Promise((resolve) => {
    if (sess.exited) return resolve();
    const t = setTimeout(() => sess.kill(), RETIRE_MS);
    sess.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

/** A duration for a message: "40 min", "4 h". */
const span = (ms) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 360_000) / 10} h`);

// ── Quest methods (mixed into Quest.prototype) ──

export const planMethods = {
  proposePlan({ summary, agents, newRoles = [] }) {
    if (this.s.plan?.status === 'approved') throw new Error('The plan is already approved; use recruit_agent for more members.');
    if (!agents?.length) throw new Error('A plan needs at least one agent.');
    if (agents.length > this.s.maxAgents) throw new Error(`At most ${this.s.maxAgents} agents for this quest; you proposed ${agents.length}.`);
    const members = checkPlan(agents);
    for (const m of members) this.resolveRole(m.role, newRoles);
    this.s.plan = { summary, agents: members, status: 'pending', proposedAt: now() };
    this.log('archmage', 'action', `Proposed a party of ${agents.length}: ${summary}`);
    this.emit('plan', { plan: this.s.plan, roles: this.s.roles });
    if (this.s.planning === 'review') {
      this.setStatus('awaiting-approval');
      return 'Your plan awaits the human\'s approval; they may edit it. End your turn now. You will be told when the party is dispatched.';
    }
    return this.dispatch(this.s.plan.agents, false);
  },

  approvePlan(agents) {
    if (this.s.status !== 'awaiting-approval') throw new Error('No plan is waiting for approval.');
    agents = (agents ?? this.s.plan.agents).filter((m) => m.task?.trim());
    if (!agents.length) throw new Error('The plan has no tasks.');
    if (agents.length > this.s.maxAgents) throw new Error(`At most ${this.s.maxAgents} agents.`);
    // A removed member's key may still be named in another's `after`: drop it rather than refuse the plan.
    const kept = new Set(agents.map((m, i) => String(m.key ?? '').trim() || `t${i + 1}`));
    const members = checkPlan(agents.map((m) => ({ ...m, after: (m.after ?? []).filter((k) => kept.has(k)) })));
    for (const m of members) this.resolveRole(m.role);
    const edited = JSON.stringify(members) !== JSON.stringify(this.s.plan.agents);
    this.s.plan.agents = members;
    this.log('you', 'message', edited ? 'Approved the plan with changes.' : 'Approved the plan.');
    this.setStatus('questing');
    const party = this.dispatch(this.s.plan.agents, true);
    this.tell(`The human approved the plan${edited ? ' with changes' : ''}. The party is on its way:\n${party}\nEnd your turn; dispatches will follow.`, true);
    return party;
  },

  dispatch(members, approved) {
    this.s.plan.status = 'approved';
    if (this.s.status !== 'questing') this.setStatus('questing');
    // The whole party is recruited at once; members with `after` wait until those agents are done.
    const first = this.s.agents.length;
    const idOf = new Map(members.map((m, i) => [m.key, `a${first + i + 1}`]));
    const party = members.map((m) => this.recruit(m.role, m.task, { key: m.key, taskTitle: m.title, after: (m.after ?? []).map((k) => idOf.get(k)) }));
    for (const a of party) this.startOrWait(a);
    const lines = party.map((a) => `- ${a.id}: ${a.name} the ${a.title}${a.after.length ? ` (waits for ${a.after.join(', ')})` : ''}`);
    this.emit('plan', { plan: this.s.plan, roles: this.s.roles });
    return (approved ? '' : 'The party is dispatched:\n') + lines.join('\n');
  },

  recruitByArchmage({ role, task, title, newRole, after = [] }) {
    if (this.s.status !== 'questing') throw new Error('Recruit only after the plan is dispatched; use propose_plan first.');
    const active = this.s.agents.filter((a) => a.status !== 'cancelled').length;
    if (active >= this.s.maxAgents) throw new Error(`The party is at its limit of ${this.s.maxAgents} agents.`);
    after = [...new Set(after)];
    for (const id of after) {
      const d = this.agent(id);
      if (d.status === 'cancelled') throw new Error(`${d.name} (${id}) was recalled; nothing to wait for.`);
    }
    if (newRole) this.resolveRole(newRole.id, [newRole]);
    const a = this.recruit(role, task, { after, taskTitle: title });
    this.startOrWait(a);
    this.log('archmage', 'action', `Recruited ${a.name} the ${a.title}${after.length ? ` (after ${this.names(after)})` : ''}: ${clip(task, 300)}`);
    return `Recruited ${a.id}: ${a.name} the ${a.title}${a.status === 'waiting' ? `; waits for ${after.join(', ')}` : ''}.`;
  },

  recruit(roleId, task, { key, after = [], taskTitle } = {}) {
    const role = this.resolveRole(roleId);
    const race = raceOf(role.describe);
    const taken = new Set(this.s.agents.map((a) => a.name));
    const salt = `${this.id}:${this.s.agents.length}`;
    const look = themedRole(this.s.theme, roleId, role);
    // Presentation first, so the name and the portrait agree.
    const presentation = presentationFor(look.describe, salt, theme(this.s.theme).presentations);
    const a = {
      id: `a${this.s.agents.length + 1}`,
      name: themedName(this.s.theme, taken, salt, presentation) ?? pickName(race, taken, salt, presentation),
      presentation,
      role: roleId, title: look.title, task,
      status: 'queued', percent: 0, phase: null, lastReport: null, activity: null, result: null,
      question: null, ask: null, notes: [], costUsd: 0, sessionId: null, createdAt: now(), key: key ?? null, after,
      taskTitle: cleanTitle(taskTitle) || titleFromTask(task),
    };
    this.s.agents.push(a);
    this.emit('agent', { agent: a });
    return a;
  },

  names(ids) {
    return ids.map((id) => this.s.agents.find((a) => a.id === id)?.name ?? id).join(', ');
  },
};

export const dependencyMethods = {
  /** Start an agent whose prerequisites are done, or leave it waiting for them. */
  startOrWait(a) {
    if (a.after?.length && !a.after.every((id) => this.agent(id).status === 'done')) {
      this.updateAgent(a, { status: 'waiting', activity: `Waiting for ${this.names(a.after)}` });
      return this.releaseWaiting();
    }
    this.schedule(a, null);
  },

  /**
   * Start every waiting agent whose prerequisites are all done. One whose prerequisite failed or was recalled is
   * held, and the Archmage decides (start_agent, message_agent, cancel_agent).
   */
  releaseWaiting() {
    if (this.s.status !== 'questing') return;
    for (const a of this.s.agents) {
      if (a.status !== 'waiting') continue;
      const deps = a.after.map((id) => this.agent(id));
      if (deps.every((d) => d.status === 'done')) {
        a.held = false;
        this.log('guild', 'system', `${a.name} sets out: ${this.names(a.after)} ${deps.length > 1 ? 'are' : 'is'} done.`);
        this.tell(`[started] ${a.name} the ${a.title} (${a.id}) set out; ${a.after.join(', ')} finished, and their reports were handed over.`);
        this.schedule(a, null);
        continue;
      }
      const lost = deps.filter((d) => ['failed', 'cancelled', 'interrupted'].includes(d.status));
      if (lost.length && !a.held) {
        a.held = true;
        const why = lost.map((d) => `${d.name} (${d.id}) ${d.status}`).join(', ');
        this.updateAgent(a, { activity: `Held: ${why}` });
        this.log('guild', 'system', `${a.name} is held: ${why}.`);
        this.tell(`[held] ${a.name} the ${a.title} (${a.id}) waits for work that will not come: ${why}. Decide: start_agent to send it anyway, message_agent to change its task first (then start_agent), or cancel_agent.`, true);
      }
    }
  },

  /** Start a waiting agent now, whatever its prerequisites (council tool start_agent, or the human). */
  startNow(agentId, from = 'archmage') {
    if (this.s.status !== 'questing') throw new Error('The party is not out on the quest.');
    const a = this.agent(agentId);
    if (a.status !== 'waiting') {
      if (from === 'archmage') return `${a.name} is ${a.status}, not waiting.`;
      throw new Error(`${a.name} is not waiting.`);
    }
    this.log(from, 'action', `Sent ${a.name} out without waiting for ${this.names(a.after.filter((id) => this.agent(id).status !== 'done'))}.`, { to: a.id });
    if (from === 'you') this.tell(`The human sent ${a.name} (${a.id}) out without waiting for the rest of its prerequisites.`);
    a.held = false;
    this.schedule(a, null);
    return `${a.name} sets out now, with the reports that are in.`;
  },

  /** What a dependent agent is handed when it sets out: its prerequisites' final reports and files. */
  handoff(a) {
    return P.handoff(this, a);
  },
};

export const sessionMethods = {
  /** Queue an agent for a slot; `message` resumes its session, null starts it afresh. */
  schedule(a, message) {
    // A session still running (an agent woken while its last process is closing) is superseded: its exit and its
    // results no longer speak for the agent, and the new process waits for it to be gone (bug 6).
    const prev = this.sessions.get(a.id);
    if (prev) prev.retired = true;
    const start = () => {
      this.queued.delete(a.id);
      if (this.cannotStart(a)) return this.guild.release();
      this.startAgent(a, message).catch((err) => {
        this.guild.release();
        if (this.cannotStart(a)) return;
        this.updateAgent(a, { status: 'failed', result: `Could not start: ${err.message}`, finishedAt: now() });
        this.log(a.id, 'failed', `Could not start: ${err.message}`);
        this.tell(`[failed] ${a.name} (${a.id}) could not start: ${err.message}`, true);
      });
    };
    this.queued.set(a.id, start);
    this.updateAgent(a, { status: 'queued', activity: this.guild.running >= this.guild.settings.maxConcurrent ? 'Waiting for a free slot' : null });
    this.guild.acquire(start, chainLengths(this.s.agents).get(a.id));
  },

  /**
   * The agent was recalled, or the quest ended or was interrupted, or the server is stopping, while it waited or
   * was being set up (bug 2).
   */
  cannotStart(a) {
    return this.guild.stopping === true || !ACTIVE.has(this.s.status) || a.status === 'cancelled';
  },

  agentSystemPrompt(a, role) {
    return P.agentSystemPrompt(this, a, role, this.standingContext());
  },

  /**
   * Set an agent up and start its session. It holds a slot from the scheduler; if it is recalled or the quest ends
   * during one of the awaits, it gives the slot back and does not start. `startHook` (tests only) is awaited once
   * the workspace is ready, so a test can cancel at exactly that point.
   */
  async startAgent(a, message) {
    const role = this.guild.role(a.role, this);
    const edit = this.s.mode === 'edit';
    const canEdit = edit && role.tools !== 'read';
    let cwd = this.s.cwd;
    let conflicts = [];
    const prev = this.sessions.get(a.id);
    if (prev && !prev.exited) await untilExited(prev);
    if (edit) {
      conflicts = await this.prepareWorkspace(a);
      cwd = a.dir;
    }
    if (this.startHook) await this.startHook(a);
    if (this.cannotStart(a)) {
      this.log('guild', 'system', `${a.name} did not set out: ${this.guild.stopping ? 'the server is stopping' : ACTIVE.has(this.s.status) ? 'recalled' : `the quest is ${this.s.status}`}.`);
      return this.guild.release();
    }
    const mcpConfig = this.writeMcpConfig(a.id, 'guild', 'report-mcp.js', { GUILD_URL: this.guild.url, GUILD_QUEST_ID: this.id, GUILD_AGENT_ID: a.id, GUILD_SECRET: this.secret });
    const sess = new ClaudeSession({
      cwd,
      addDirs: this.extraDirs(cwd),
      model: role.model ?? null,
      systemPrompt: this.agentSystemPrompt(a, role),
      ...agentAccess(role, canEdit),
      mcpConfig,
      resume: message ? a.sessionId : undefined,
    });
    this.sessions.set(a.id, sess);
    const baseCost = a.costUsd ?? 0;
    const first = message || P.agentFirstMessage(this, a, { conflicts, notes: a.notes.splice(0) });

    // Only the agent's current session speaks for it; a superseded one's late events are ignored.
    const current = () => !sess.retired && this.sessions.get(a.id) === sess;
    sess.on('init', ({ sessionId }) => { if (current()) { a.sessionId = sessionId; this.save(); } });
    sess.on('text', (text) => { if (current()) this.updateAgent(a, { activity: `“${clip(text.split('\n')[0], 90)}”` }); });
    sess.on('tool', (t) => {
      const d = current() && describeTool(t);
      if (d) { a.activity = d; this.emit('activity', { agentId: a.id, activity: d }); }
    });
    sess.on('result', (r) => this.guarded(a, sess, 'turn result', () => current() && this.onAgentResult(a, sess, r, { baseCost, edit, canEdit })));
    sess.on('exit', ({ code, stderr }) => this.guarded(a, sess, 'exit', () => this.onAgentExit(a, sess, code, stderr, current())));
    this.updateAgent(a, { status: 'working', activity: 'Setting out…', startedAt: a.startedAt ?? now() });
    if (!message) this.log(a.id, 'action', `${a.name} the ${a.title} sets out: ${clip(a.task, 300)}`);
    sess.start(first);
  },

  /**
   * Run one of an agent's event handlers. An error in it fails only that agent, never the server or the other
   * quests (bug 8). Even the logging may fail (a full disk), so that is guarded too.
   */
  async guarded(a, sess, what, fn) {
    try {
      await fn();
    } catch (err) {
      try {
        console.error(`guild: quest ${this.id}, ${a.id}, ${what}:`, err);
        if (FINISHED_AGENT.has(a.status)) return;
        if (a.ask) this.settleAsk(a, 'Something went wrong in the Guild. Stop now.');
        this.updateAgent(a, { status: 'failed', activity: null, result: a.result ?? `The Guild failed on its ${what}: ${err.message}`, finishedAt: now() });
        this.log(a.id, 'failed', `The Guild failed on ${a.name}'s ${what}: ${err.message}`);
        this.tell(`[failed] ${a.name} (${a.id}) fell: the Guild failed on its ${what} (${err.message}).`, true);
        if (!sess.exited) sess.kill();
      } catch (again) {
        console.error(`guild: quest ${this.id}, ${a.id}: could not record the failure:`, again);
      }
    }
  },

  /** The end of an agent's turn: hand over messages that came meanwhile, or take its final report. */
  async onAgentResult(a, sess, r, { baseCost, edit, canEdit }) {
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
    if (a.status === 'cancelled') return; // recalled while its commits were counted
    const result = String(r.result ?? '').trim() || '(no final message)';
    this.updateAgent(a, { status: ok ? 'done' : 'failed', percent: ok ? 100 : a.percent, activity: null, result, finishedAt: now() });
    this.log(a.id, ok ? 'done' : 'failed', clip(result, 4000));
    const perRepo = this.multi && a.commitsByRepo ? ` (${Object.entries(a.commitsByRepo).map(([r, n]) => `${r} ${n}`).join(', ')})` : '';
    const branchNote = edit && canEdit ? `\nBranch ${a.branch}: ${a.commits ?? 0} commit(s)${perRepo}.${commits}` : '';
    this.tell(`[${ok ? 'done' : 'failed'}] ${a.name} the ${a.title} (${a.id}) has returned. Final report:\n${result}${branchNote}`, true);
    sess.close();
  },

  /**
   * An agent's process ended: give back its slot, and if it was the agent's current session and the agent had not
   * finished, it fell. A superseded session (the agent was woken again meanwhile) only gives back its slot.
   */
  onAgentExit(a, sess, code, stderr, current) {
    if (this.sessions.get(a.id) === sess) this.sessions.delete(a.id);
    this.guild.release();
    if (!current) return;
    // Its question can no longer be answered (bug 3).
    if (a.ask) this.settleAsk(a, 'Your session has ended.');
    if (!FINISHED_AGENT.has(a.status)) {
      const why = clip(stderr.trim().split('\n').pop() || `exit code ${code}`, 300);
      this.updateAgent(a, { status: 'failed', activity: null, result: a.result ?? `The session ended unexpectedly: ${why}`, finishedAt: now() });
      this.log(a.id, 'failed', `Session ended unexpectedly: ${why}`);
      this.tell(`[failed] ${a.name} (${a.id}) fell: the session ended unexpectedly (${why}).`, true);
    }
  },
};

export const talkMethods = {
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
  },

  /**
   * An agent's question. A check-in (`human`) waits for the human: the Archmage is told but cannot answer it.
   * An agent has at most one open question (bug 9): a new one withdraws the one before, so no long-poll is left
   * waiting. The question itself is kept on the agent as plain data (`a.ask`); this.asks holds the waiters.
   */
  ask(agentId, question, human = false) {
    const a = this.agent(agentId);
    if (FINISHED_AGENT.has(a.status)) throw new Error(`${a.name} is ${a.status}; there is no one to answer.`);
    if (a.ask) this.settleAsk(a, `You asked another question since ("${clip(question, 200)}"), so this one is withdrawn. The answer will come to the new one.`);
    const askedAt = Date.now();
    const rec = { id: crypto.randomBytes(4).toString('hex'), question, human, askedAt: new Date(askedAt).toISOString(), deadline: new Date(askedAt + (this.askDeadlineMs ?? ASK_DEADLINE_MS)).toISOString() };
    this.openAsk(a, rec);
    this.updateAgent(a, { status: 'blocked', activity: human ? 'Waiting for your decision' : 'Waiting for an answer' });
    this.log(a.id, 'question', question, human ? { checkIn: true, to: 'you' } : {});
    this.emit('report', { agentId: a.id, percent: a.percent, phase: 'blocked', message: question });
    this.tell(human
      ? `[check-in] ${a.name} the ${a.title} (${a.id}) asks the human to approve: ${question}\nOnly the human can answer this; do not answer it. The rest of the party carries on.`
      : `[blocked] ${a.name} the ${a.title} (${a.id}) asks: ${question}\nAnswer with answer_agent (the human may answer first).`, true);
    return { askId: rec.id };
  },

  /**
   * Make `rec` ({ id, question, human, askedAt, deadline }) the agent's open question: waiters for its answer and
   * a timer for its deadline. `question`, `askId` and `checkIn` mirror it for the interface.
   */
  openAsk(a, rec) {
    const timer = setTimeout(() => this.expireAsk(a, rec.id), Math.max(0, Date.parse(rec.deadline) - Date.now()));
    timer.unref();
    this.asks.set(rec.id, { id: rec.id, agentId: a.id, question: rec.question, human: rec.human, answer: undefined, waiters: [], timer });
    Object.assign(a, { ask: rec, question: rec.question, askId: rec.id, checkIn: rec.human });
  },

  /** The deadline passed with no answer: the agent decides for itself, and the Archmage hears of it. */
  expireAsk(a, askId) {
    if (a.ask?.id !== askId) return;
    const { question } = a.ask;
    const within = span(Date.parse(a.ask.deadline) - Date.parse(a.ask.askedAt));
    this.settleAsk(a, `No answer came within ${within}. Decide for yourself as best you can, say what you decided and why in your report, and carry on.`);
    if (a.status === 'blocked') this.updateAgent(a, { status: 'working', activity: 'No answer came; carrying on' });
    this.log('guild', 'system', `${a.name}'s question went unanswered for ${within}; told to decide for itself.`, { to: a.id });
    this.tell(`[unanswered] ${a.name} (${a.id}) had no answer within ${within} to: ${question}\nIt was told to decide for itself and carry on.`);
  },

  waitAnswer(askId, seconds, res) {
    const ask = this.asks.get(askId);
    if (!ask) return res({ answer: 'This question is no longer open. Carry on.' });
    if (ask.answer !== undefined) return res({ answer: ask.answer });
    const done = (answer) => { clearTimeout(t); res(answer === undefined ? { pending: true } : { answer }); };
    const t = setTimeout(() => { ask.waiters = ask.waiters.filter((w) => w !== done); done(undefined); }, Math.min(55, seconds) * 1000);
    ask.waiters.push(done);
  },

  /** Answer an open question, and clear it from its agent if it is still the agent's open one. */
  resolveAsk(ask, answer) {
    clearTimeout(ask.timer);
    ask.answer = answer;
    for (const w of ask.waiters.splice(0)) w(answer);
    const a = this.s.agents.find((x) => x.id === ask.agentId);
    if (a?.ask?.id === ask.id) this.updateAgent(a, { ask: null, question: null, askId: null, checkIn: false });
  },

  /** Settle an agent's open question with `answer` (its status is the caller's to change). */
  settleAsk(a, answer) {
    const ask = a.ask && this.asks.get(a.ask.id);
    if (ask && ask.answer === undefined) this.resolveAsk(ask, answer);
    else this.updateAgent(a, { ask: null, question: null, askId: null, checkIn: false });
  },

  /** Only a blocked agent is answered: a dead one's question died with it, and it must not be set working (bug 3). */
  answerAgent(agentId, text, from) {
    const a = this.agent(agentId);
    const ask = a.status === 'blocked' && a.ask && this.asks.get(a.ask.id);
    if (!ask || ask.answer !== undefined) {
      if (from === 'archmage') return `${a.name} has no open question (perhaps the human already answered). Use message_agent to send guidance.`;
      throw new Error(`${a.name} has no open question.`);
    }
    if (ask.human && from !== 'you') return `${a.name}'s question is a check-in: only the human can answer it. Leave it to them; you may add your view with ask_human if it helps them decide.`;
    this.resolveAsk(ask, from === 'you' ? `(from the human) ${text}` : text);
    this.updateAgent(a, { status: 'working', activity: 'Considering the answer' });
    this.log(from, 'answer', text, { to: a.id });
    if (from === 'you') this.tell(`The human answered ${a.name} (${a.id}): ${text}`);
    return `Answered ${a.name}.`;
  },

  messageAgent(agentId, text, from) {
    const a = this.agent(agentId);
    const who = from === 'you' ? 'the human' : 'the Archmage';
    this.log(from, 'message', text, { to: a.id });
    if (from === 'you') this.tell(`The human sent ${a.name} (${a.id}) a message: ${text}`);
    if (a.status === 'cancelled') throw new Error(`${a.name} has left the party (cancelled).`);
    if (a.status === 'interrupted') throw new Error(`${a.name} was interrupted when the server stopped; resume the quest first.`);
    if (a.status === 'done' || a.status === 'failed') {
      if (!a.sessionId) throw new Error(`${a.name} cannot be woken (no session).`);
      this.schedule(a, `A message from ${who}:\n${text}\n\nAct on it (report progress as before), then give your final report again.`);
      return `${a.name} has been woken up with your message and will report again.`;
    }
    a.notes.push(`From ${who}: ${text}`);
    this.save();
    if (a.status === 'waiting') return `${a.name} is waiting for ${this.names(a.after)} and will get the message when it sets out.`;
    return `${a.name} will receive the message at the next progress report.`;
  },

  cancelAgent(agentId, from, reason) {
    const a = this.agent(agentId);
    if (FINISHED_AGENT.has(a.status)) return `${a.name} is already ${a.status}.`;
    const start = this.queued.get(a.id);
    if (start && this.guild.dequeue(start)) this.queued.delete(a.id); // it never held a slot
    this.updateAgent(a, { status: 'cancelled', activity: null, finishedAt: now(), result: a.result ?? `Cancelled${reason ? `: ${reason}` : ''}.` });
    this.sessions.get(a.id)?.kill();
    if (a.ask) this.settleAsk(a, 'You have been recalled. Stop now.');
    this.log(from, 'action', `Recalled ${a.name}${reason ? `: ${reason}` : ''}.`, { to: a.id });
    if (from === 'you') this.tell(`The human recalled ${a.name} (${a.id}).`, true);
    else this.afterAgentChange();
    return `${a.name} has been recalled.`;
  },

  afterAgentChange() {
    if (this.arch && !this.arch.busy) this.afterArchmageTurn();
  },

  async partyReport() {
    if (!this.s.agents.length) return 'The party is empty.';
    const pending = new Map();
    for (const a of this.s.agents) if (a.branch) pending.set(a.id, (await this.unmerged(a)).length);
    return this.s.agents.map((a) => [
      `${a.id}: ${a.name} the ${a.title} — “${agentTitle(a)}” — ${a.status}, ${a.percent}%${a.phase ? ` (${a.phase})` : ''}`,
      `  task: ${clip(a.task, 300)}`,
      a.after?.length ? `  after: ${a.after.map((id) => `${id} (${this.agent(id).status})`).join(', ')}${a.held ? ' — held' : ''}` : '',
      a.question ? `  open question: ${a.question}` : '',
      a.lastReport ? `  last report: ${clip(a.lastReport, 300)}` : '',
      a.result ? `  final report: ${clip(a.result, 1500)}` : '',
      a.branch ? `  branch: ${a.branch} (${a.commits ?? 0} commits)${pending.get(a.id) ? ', not merged yet' : a.commits ? ', merged' : ''}${this.s.leftOut?.includes(a.id) ? ', left out' : ''}` : '',
    ].filter(Boolean).join('\n')).join('\n\n');
  },
};
