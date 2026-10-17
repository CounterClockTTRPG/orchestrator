// Roles: cleaning roles from the API, inventing the ones a plan asks for, and what each tier may use
// (tools and permission mode).

import { hash, CAST_RACES } from './names.js';
import { clip } from './common.js';

export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite'];
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];
const NO_NESTING = ['Task', 'Agent'];
// Built-ins a headless agent must never use: they reach outside the quest (other sessions, schedules,
// publishing, the human's UI) or would block on a prompt nobody sees.
export const DENIED = [
  ...NO_NESTING, 'Workflow', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup',
  'PushNotification', 'SendMessage', 'ListAgents', 'TaskStop', 'Monitor', 'ShareOnboardingGuide', 'PublishPlugin',
  'Artifact', 'ArtifactComments', 'ArtifactData', 'DesignSync', 'SendFeedback', 'EnterWorktree', 'ExitWorktree',
  'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion',
];
const COUNCIL_TOOLS = ['propose_plan', 'recruit_agent', 'start_agent', 'message_agent', 'answer_agent', 'cancel_agent', 'list_party', 'ask_human', 'attach_file', 'merge_party', 'finish_quest'];
const AGENT_MCP_TOOLS = ['mcp__guild__report_progress', 'mcp__guild__ask', 'mcp__guild__attach_file'];
export const ROLE_ID = /^[a-z][a-z0-9-]{1,30}$/;
const FALLBACK_ORCHESTRATOR = ['archmage', { title: 'Archmage', name: 'Velothar', model: 'opus' }];

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

/** A role the Archmage defined in its plan (newRoles), with only known fields: it ends up in prompts and portraits. */
export function inventRole(roleId, invented) {
  if (!ROLE_ID.test(roleId)) throw new Error(`Role id "${roleId}": use lowercase letters, digits and dashes.`);
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
  return r;
}

/** [id, role] of the catalog's orchestrator, or a built-in Archmage if the catalog has none. */
export function orchestratorRole(roles) {
  return Object.entries(roles).find(([, r]) => r.orchestrator) ?? FALLBACK_ORCHESTRATOR;
}

/** Tools and permissions of the Archmage: read tools, edit tools in edit mode, and the council. */
export function archmageAccess(mode) {
  const edit = mode === 'edit';
  return {
    allowedTools: [...READ_TOOLS, ...(edit ? EDIT_TOOLS : []), ...COUNCIL_TOOLS.map((t) => `mcp__council__${t}`)],
    disallowedTools: DENIED,
    permissionMode: edit ? 'acceptEdits' : undefined,
  };
}

/** Tools and permissions of a party member: its role's list or tier, never edit tools unless it may edit. */
export function agentAccess(role, canEdit) {
  const tools = Array.isArray(role.tools) ? role.tools : [...READ_TOOLS, ...(canEdit ? EDIT_TOOLS : [])];
  return {
    allowedTools: [...tools.filter((t) => canEdit || !EDIT_TOOLS.includes(t)), ...AGENT_MCP_TOOLS],
    disallowedTools: [...DENIED, ...(canEdit ? [] : EDIT_TOOLS)],
    permissionMode: canEdit ? 'acceptEdits' : undefined,
  };
}

// ── Quest methods (mixed into Quest.prototype) ──

export const roleMethods = {
  /** The role for a member: a catalog role, or one the Archmage invented in this plan (kept on the quest). */
  resolveRole(roleId, newRoles = []) {
    const invented = newRoles.find((r) => r.id === roleId);
    if (invented && !this.guild.roles[roleId]) {
      this.s.roles[roleId] = inventRole(roleId, invented);
      this.emit('roles', { roles: this.s.roles });
    }
    const role = this.guild.role(roleId, this);
    if (!role || role.orchestrator) throw new Error(`Unknown role "${roleId}". Use a catalog role or define it in newRoles.`);
    return role;
  },
};
