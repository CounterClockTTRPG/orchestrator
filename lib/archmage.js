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
    sess.on('exit', ({ code, stderr }) => this.onArchmageExit(sess, code, stderr));
    a.status = 'thinking';
    this.emit('archmage', { archmage: a });
    sess.start(firstMessage);
  },

  /** A dead Archmage is revived (twice at most) from its session while the quest runs; then the quest fails. */
  onArchmageExit(sess, code, stderr) {
    if (this.arch !== sess) return;
    this.arch = null;
    if (!ACTIVE.has(this.s.status)) return;
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
    this.conversing = false;
    a.replying = false;
    a.activity = null;
    a.status = ACTIVE.has(this.s.status) ? 'waiting' : 'done';
    this.emit('archmage', { archmage: a });
    if (r.is_error) this.log('guild', 'system', `The Archmage's turn ended in an error: ${clip(r.result ?? r.subtype, 300)}`);
    this.afterArchmageTurn(r);
  },

  /** Queue a message for the Archmage. Urgent ones are delivered as soon as it is idle. */
  tell(text, urgent = false) {
    this.inbox.push(text);
    if (urgent) this.urgent = true;
    this.flush();
  },

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
  },

  /** After each Archmage turn: deliver what came in, or nudge it when the quest is stuck on it. */
  afterArchmageTurn() {
    if (!ACTIVE.has(this.s.status)) { this.arch?.close(); return; }
    if (this.inbox.length) return this.flush();
    if (this.s.status === 'planning') {
      if (this.nudges++ < 2) return this.tell('You have not proposed a plan yet. Call propose_plan now.', true);
      return this.fail('The Archmage did not propose a plan.');
    }
    // Nobody at work, yet some wait: their prerequisites failed or were recalled (directly or further up).
    const waiting = this.s.agents.filter((a) => a.status === 'waiting');
    if (this.s.status === 'questing' && waiting.length && !this.queued.size
      && this.s.agents.every((a) => FINISHED_AGENT.has(a.status) || a.status === 'waiting')) {
      if (this.nudges++ < 3) {
        return this.tell(`Nobody is working, but ${waiting.map((a) => `${a.name} (${a.id})`).join(', ')} still wait for work that will not come. For each: start_agent to send it anyway, message_agent then start_agent to change its task, or cancel_agent.`, true);
      }
      this.nudges = 0;
      for (const a of waiting) this.cancelAgent(a.id, 'guild', 'its prerequisites did not finish and the Archmage did not decide');
      return;
    }
    if (this.s.status === 'questing' && this.s.agents.length && this.s.agents.every((a) => FINISHED_AGENT.has(a.status)) && !this.queued.size) {
      if (this.nudges++ < 3) {
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

  /** A council tool call from the Archmage's MCP server. */
  council(tool, args) {
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
