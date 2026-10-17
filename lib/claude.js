// One headless Claude Code session: `claude -p` in stream-json mode on both stdin and stdout.
//
// Events: 'init' {sessionId}, 'text' (string), 'tool' {name, input}, 'result' (the result event),
//         'exit' {code, signal, stderr}.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

const CLAUDE_BIN = process.env.GUILD_CLAUDE_BIN || 'claude';

// Variables that make a nested claude think it runs inside another session.
const STRIP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_JOB_DIR'];

export class ClaudeSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.cwd
   * @param {string[]} [o.addDirs]      more directories the session may work in (--add-dir)
   * @param {string} [o.model]          alias or id; omitted = the CLI default
   * @param {string} [o.systemPrompt]   appended to Claude Code's system prompt
   * @param {string[]} o.allowedTools
   * @param {string[]} [o.disallowedTools]
   * @param {string} o.mcpConfig        path to an MCP config JSON
   * @param {string} [o.permissionMode] e.g. 'acceptEdits' for agents that may change files
   * @param {string} [o.resume]         session id to resume
   * @param {object} [o.env]            extra environment
   */
  constructor(o) {
    super();
    this.opts = o;
    this.sessionId = o.resume ?? null;
    this.costUsd = 0; // cumulative for this process
    this.busy = false;
    this.exited = false;
    this.stderr = '';
  }

  start(firstMessage) {
    const o = this.opts;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', o.mcpConfig, '--strict-mcp-config',
      '--allowedTools', ...o.allowedTools];
    if (o.addDirs?.length) args.push('--add-dir', ...o.addDirs);
    if (o.disallowedTools?.length) args.push('--disallowedTools', ...o.disallowedTools);
    if (o.model) args.push('--model', o.model);
    if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
    if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
    if (o.resume) args.push('--resume', o.resume);

    const env = { ...process.env, MCP_TOOL_TIMEOUT: '86400000', ...o.env };
    for (const k of STRIP_ENV) delete env[k];

    this.proc = spawn(CLAUDE_BIN, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin.on('error', () => {});
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.#onLine(line));
    this.proc.on('error', (err) => { this.stderr += String(err); });
    this.proc.on('close', (code, signal) => {
      this.exited = true;
      this.busy = false;
      this.emit('exit', { code, signal, stderr: this.stderr });
    });
    if (firstMessage) this.send(firstMessage);
    return this;
  }

  /** Start a new turn with a user message. */
  send(text) {
    if (this.exited || !this.proc) return false;
    this.busy = true;
    this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    return true;
  }

  /** Let the session end once its current turn is done. */
  close() {
    if (!this.exited && this.proc) this.proc.stdin.end();
  }

  kill() {
    if (!this.exited && this.proc) {
      this.proc.kill('SIGTERM');
      setTimeout(() => { if (!this.exited) this.proc.kill('SIGKILL'); }, 3000).unref();
    }
  }

  #onLine(line) {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.session_id && !this.sessionId) this.sessionId = e.session_id;
    if (e.type === 'system' && e.subtype === 'init') {
      this.sessionId = e.session_id;
      this.emit('init', { sessionId: e.session_id });
    } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type === 'text' && b.text?.trim()) this.emit('text', b.text.trim());
        else if (b.type === 'tool_use') this.emit('tool', { name: b.name, input: b.input ?? {} });
      }
    } else if (e.type === 'result') {
      if (typeof e.total_cost_usd === 'number') this.costUsd = e.total_cost_usd;
      this.busy = false;
      this.emit('result', e);
    }
  }
}

/** A one-line, human-readable description of a tool call, for the activity line. */
export function describeTool({ name, input }) {
  const short = (s, n = 70) => {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const file = (p) => short(String(p ?? '').split('/').slice(-2).join('/'), 50);
  switch (name) {
    case 'Read': return `Reading ${file(input.file_path)}`;
    case 'Write': return `Writing ${file(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${file(input.file_path)}`;
    case 'NotebookEdit': return `Editing ${file(input.notebook_path)}`;
    case 'Glob': return `Searching for ${short(input.pattern, 40)}`;
    case 'Grep': return `Grepping “${short(input.pattern, 40)}”`;
    case 'Bash': return `Running ${short(input.command, 60)}`;
    case 'WebSearch': return `Searching the web: ${short(input.query, 50)}`;
    case 'WebFetch': return `Reading ${short(input.url, 60)}`;
    case 'ToolSearch': return 'Consulting the spellbook';
    case 'TodoWrite': return 'Updating the task list';
    default: return name.startsWith('mcp__') ? null : `Using ${name}`;
  }
}
