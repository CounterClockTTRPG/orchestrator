// The Archmage: its session, its inbox (batched dispatches, urgent ones at once), the nudges when a turn ends
// without progress, its revival when the process dies, its talk with the human, and the council tools.

import fs from 'node:fs';
import path from 'node:path';
import { ClaudeSession, describeTool } from './claude.js';
import * as store from './store.js';
import { findApp } from './apps.js';
import { theme, themedRole } from '../web/themes.js';
import { orchestratorRole, archmageAccess } from './roles.js';
import * as P from './prompts.js';
import { ACTIVE, FINISHED_AGENT, now, clip } from './common.js';

// Council tools that move the quest on: a turn that called one resets the nudges (list_party only looks).
const PROGRESS = new Set(['propose_plan', 'recruit_agent', 'start_agent', 'message_agent', 'answer_agent', 'cancel_agent', 'ask_human', 'attach_file', 'merge_party', 'finish_quest']);

/**
 * How a turn that ended in an error (rate limit, credit, overloaded) is retried: after base, 2·base, 4·base… ms,
 * at most max ms apart, `tries` times; then the quest fails. The variables are there to keep tests fast.
 */
const retryPolicy = () => ({
  base: Number(process.env.GUILD_RETRY_MS) || 5000,
  max: Number(process.env.GUILD_RETRY_MAX_MS) || 300_000,
  tries: Number(process.env.GUILD_RETRIES) || 8,
});

// ── Quest methods (mixed into Quest.prototype) ──

export const archmageMethods = {
  async begin() {
    fs.mkdirSync(path.join(this.dir, 'mcp'), { recursive: true });
    const [roleId, role] = orchestratorRole(this.guild.roles);
    const workdir = this.s.mode === 'edit' ? await this.openIntegration() : this.s.cwd;
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
  },

  archmageSystemPrompt() {
    return P.archmageSystemPrompt(this);
  },

  async archmageBriefing() {
    const app = findApp(this.guild.apps, this.s.app);
    const context = this.standingContext();
    const history = app ? await this.guild.appHistory(app.id, this.id) : null;
    return P.archmageBriefing(this, { app, history, context });
  },

  startArchmage(firstMessage, resume) {
    const a = this.s.archmage;
    const mcpConfig = this.writeMcpConfig('archmage', 'council', 'council-mcp.js', { GUILD_URL: this.guild.url, GUILD_QUEST_ID: this.id, GUILD_SECRET: this.secret });
    const sess = new ClaudeSession({
      cwd: a.workdir,
      addDirs: this.extraDirs(a.workdir),
      model: a.model,
      systemPrompt: this.archmageSystemPrompt(),
      ...archmageAccess(this.s.mode),
      mcpConfig,
      resume,
    });
    const baseCost = a.costUsd;
    this.arch = sess;
    this.inFlight = { batch: [firstMessage], first: true };
    sess.on('init', ({ sessionId }) => { a.sessionId = sessionId; this.save(); });
    sess.on('text', (text) => this.onArchmageText(text));
    sess.on('tool', (t) => {
      if (t.name.startsWith('mcp__council__')) return; // logged by the tool handlers
      const d = describeTool(t);
      if (d) { a.activity = d; this.emit('archmage', { archmage: a }); }
    });
    sess.on('result', (r) => this.guarded('the end of the Archmage\'s turn', () => {
      a.costUsd = baseCost + sess.costUsd;
      this.addCost();
      this.onArchmageResult(r);
    }));
    sess.on('exit', ({ code, stderr }) => this.guarded('the end of the Archmage\'s session', () => this.onArchmageExit(sess, code, stderr)));
    a.status = 'thinking';
    this.emit('archmage', { archmage: a });
    sess.start(firstMessage);
  },

  /** A dead Archmage is revived (twice at most) from its session while the quest runs; then the quest fails. */
  onArchmageExit(sess, code, stderr) {
    if (this.arch !== sess) return;
    this.arch = null;
    if (!ACTIVE.has(this.s.status)) return;
    // What it was given in its last turn goes back in the inbox for the revived one (its first message is sent anew).
    const lost = this.inFlight;
    this.inFlight = null;
    if (lost && !lost.first) this.requeue(lost);
    const a = this.s.archmage;
    if (this.archRestarts++ < 2 && a.sessionId) {
      this.log('guild', 'system', `The Archmage's session ended unexpectedly (exit ${code}); reviving.`);
      this.startArchmage('Your session was restarted. Continue the quest from where you were (list_party shows the party).', a.sessionId);
    } else {
      this.log('guild', 'system', `The Archmage is gone (exit ${code}). ${clip(stderr, 400)}`);
      this.fail('The Archmage session ended before the quest was finished.');
    }
  },

  onArchmageText(text) {
    const a = this.s.archmage;
    a.thought = clip(text, 4000);
    this.emit('archmage', { archmage: a });
    this.log('archmage', 'say', clip(text, this.conversing ? 8000 : 2000));
  },

  onArchmageResult(r) {
    const a = this.s.archmage;
    const sent = this.inFlight, answered = this.conversing;
    this.inFlight = null;
    this.conversing = false;
    a.replying = false;
    a.activity = null;
    a.status = ACTIVE.has(this.s.status) ? 'waiting' : 'done';
    this.emit('archmage', { archmage: a });
    if (r.is_error && ACTIVE.has(this.s.status)) return this.retryArchmage(r, sent);
    this.archErrors = 0;
    // A turn that moved the quest on, or answered the human, starts the nudges afresh.
    if (this.archProgress || answered) this.nudges = {};
    this.archProgress = false;
    this.afterArchmageTurn(r);
  },

  /** A turn that failed on the API side is not the Archmage stalling: wait, then send it the same messages again. */
  retryArchmage(r, sent) {
    const { base, max, tries } = retryPolicy();
    const reason = clip(r.result || r.subtype || 'an error', 300);
    this.archErrors = (this.archErrors ?? 0) + 1;
    if (this.archErrors > tries) {
      this.log('guild', 'system', `The Archmage's turn ended in an error again: ${reason}. Giving up after ${tries} retries.`);
      return this.fail(`The Archmage's turns kept failing (${reason}), ${tries} retries in a row.`);
    }
    const delay = Math.min(max, base * 2 ** (this.archErrors - 1));
    this.log('guild', 'system', `The Archmage's turn ended in an error: ${reason}. Trying again in ${delay < 1000 ? `${delay} ms` : `${Math.round(delay / 1000)} s`} (retry ${this.archErrors} of ${tries}).`);
    const again = 'Your last turn ended in an error, so what it was given comes again.';
    if (sent) this.requeue(sent.batch[0] === again ? sent : { ...sent, batch: [again, ...sent.batch] });
    else this.inbox.unshift('Your last turn ended in an error. Carry on with the quest.');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.urgent = true;
      this.guarded('a retry of the Archmage\'s turn', () => this.flush());
    }, delay);
    this.retryTimer.unref();
  },

  /** Put a batch that did not get through back at the front of the inbox, to go out as soon as it can. */
  requeue({ batch, conversing }) {
    this.inbox.unshift(...batch);
    this.urgent = true;
    if (conversing) this.humanWaiting = true;
  },

  /** Run an event handler; an error is logged to the quest instead of taking the server (and every quest) down. */
  guarded(what, fn) {
    try {
      return fn();
    } catch (err) {
      console.error(`quest ${this.id}: ${what}:`, err);
      try { this.log('guild', 'system', `Guild hit an error in ${what}: ${clip(err?.message ?? err, 400)}`); } catch { /* logged above */ }
    }
  },

  /** One more nudge of a kind ('plan', 'waiting', 'finish'); false once `limit` of them have been sent. */
  nudge(kind, limit) {
    this.nudges[kind] = (this.nudges[kind] ?? 0) + 1;
    return this.nudges[kind] <= limit;
  },

  /** Queue a message for the Archmage. Urgent ones are delivered as soon as it is idle. */
  tell(text, urgent = false) {
    this.inbox.push(text);
    if (urgent) this.urgent = true;
    this.save(); // the inbox is kept in quest.json, so a stop loses none of it
    this.flush();
  },

  /**
   * What the Archmage has not taken in yet, for quest.json: the batch of a turn that has not ended (its process
   * may die before it does; the first message is already in its session), then the inbox. Restored on load.
   */
  pendingForArchmage() {
    const open = this.inFlight && !this.inFlight.first ? this.inFlight : null;
    return {
      messages: [...(open?.batch ?? []), ...this.inbox],
      humanWaiting: this.humanWaiting || Boolean(open?.conversing),
      nudges: this.nudges,
    };
  },

  flush() {
    if (!ACTIVE.has(this.s.status) || !this.arch || this.arch.busy || this.retryTimer || !this.inbox.length) return;
    if (this.s.status === 'awaiting-approval' && !this.urgent) return;
    const due = this.urgent || Date.now() - this.lastFlush >= this.guild.settings.batchSeconds * 1000;
    if (!due) return;
    const batch = this.inbox.splice(0);
    this.urgent = false;
    this.lastFlush = Date.now();
    if (!this.arch.send(batch.join('\n\n'))) {
      this.requeue({ batch }); // the session is gone; the revived one gets them
      return;
    }
    this.conversing = this.humanWaiting;
    this.humanWaiting = false;
    this.inFlight = { batch, conversing: this.conversing }; // until its turn ends: a process that dies gives it back
    this.s.archmage.replying = this.conversing;
    this.s.archmage.status = 'thinking';
    this.emit('archmage', { archmage: this.s.archmage });
  },

  /** After each Archmage turn: deliver what came in, or nudge it when the quest is stuck on it. */
  afterArchmageTurn() {
    this.guarded('the check after the Archmage\'s turn', () => this.nudgeArchmage());
  },

  nudgeArchmage() {
    if (!ACTIVE.has(this.s.status)) { this.arch?.close(); return; }
    if (this.retryTimer) return; // a failed turn is sent again shortly
    if (this.inbox.length) return this.flush();
    if (this.s.status === 'planning') {
      if (this.nudge('plan', 2)) return this.tell('You have not proposed a plan yet. Call propose_plan now.', true);
      return this.fail('The Archmage did not propose a plan.');
    }
    // Nobody at work, yet some wait: their prerequisites failed or were recalled (directly or further up).
    const waiting = this.s.agents.filter((a) => a.status === 'waiting');
    if (this.s.status === 'questing' && waiting.length && !this.queued.size
      && this.s.agents.every((a) => FINISHED_AGENT.has(a.status) || a.status === 'waiting')) {
      if (this.nudge('waiting', 3)) {
        return this.tell(`Nobody is working, but ${waiting.map((a) => `${a.name} (${a.id})`).join(', ')} still wait for work that will not come. For each: start_agent to send it anyway, message_agent then start_agent to change its task, or cancel_agent.`, true);
      }
      this.nudges.waiting = 0;
      for (const a of waiting) this.cancelAgent(a.id, 'guild', 'its prerequisites did not finish and the Archmage did not decide');
      return;
    }
    if (this.s.status === 'questing' && this.s.agents.length && this.s.agents.every((a) => FINISHED_AGENT.has(a.status)) && !this.queued.size) {
      if (this.nudge('finish', 3)) {
        const edit = this.s.mode === 'edit';
        return this.tell(`The whole party has finished. ${edit ? 'Call merge_party, then finish_quest' : 'Call finish_quest'} with the chronicle, or recruit more agents if the quest is not answered yet.`, true);
      }
      return this.fail('The Archmage did not finish the quest.');
    }
  },

  messageArchmage(text) {
    if (!ACTIVE.has(this.s.status)) throw new Error('The quest is not running.');
    this.log('you', 'message', text, { to: 'archmage' });
    const a = this.s.archmage, asked = a?.question;
    if (asked) { a.question = null; this.emit('archmage', { archmage: a }); }
    this.humanWaiting = true;
    this.tell(asked ? `The human answers your question ("${asked}"): ${text}` : `Message from the human: ${text}`, true);
  },

  askHuman(question) {
    if (!question?.trim()) throw new Error('Ask a question.');
    this.s.archmage.question = question.trim();
    this.emit('archmage', { archmage: this.s.archmage });
    this.log('archmage', 'ask', question.trim(), { to: 'you' });
    return 'Your question is shown to the human. The party keeps working. End your turn now; their answer arrives as a message.';
  },

  /**
   * A council tool call from the Archmage's MCP server. An error goes back to the Archmage as the tool's answer
   * (through the route) and is logged to the quest. Synchronous tools answer synchronously.
   */
  council(tool, args) {
    const failed = (err) => {
      this.log('guild', 'system', `The Archmage's ${tool} failed: ${clip(err?.message ?? err, 400)}`);
      throw err;
    };
    const done = (out) => {
      if (PROGRESS.has(tool)) this.archProgress = true;
      return out;
    };
    let out;
    try { out = this.councilTool(tool, args); } catch (err) { failed(err); }
    return out instanceof Promise ? out.then(done, failed) : done(out);
  },

  councilTool(tool, args) {
    if (!ACTIVE.has(this.s.status)) return 'The quest has ended. End your turn.';
    const fn = {
      propose_plan: () => this.proposePlan(args),
      recruit_agent: () => this.recruitByArchmage(args),
      start_agent: () => this.startNow(args.agentId),
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
  },
};
