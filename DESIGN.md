# Guild — a fantasy-themed Claude agent orchestrator

Guild runs a *quest* (a goal on a directory) with a live orchestrator agent, the **Archmage**, who recruits a
party of Claude Code subagents. Every subagent reports back to the Archmage, and the browser shows the whole
council live, with portraitgen portraits.

## Decisions

| Topic | Decision |
|---|---|
| Agent runtime | Headless Claude Code: each agent is a `claude -p` process with `--input-format stream-json --output-format stream-json`. It uses your existing Claude Code login. |
| Work type | Per quest: **read-only** (research/analysis) or **edit** (code changes in per-agent git worktrees). |
| Planning | Per quest toggle: **review** (Archmage proposes the party and tasks, you edit and approve in the browser) or **auto** (dispatch at once). |
| Orchestrator | A **live** Claude session that receives reports, steers (messages, recruits, cancels) and finally synthesizes. |
| Wake-ups | Routine progress reports are batched and delivered about every 60 s. `blocked`, `done` and `failed` wake the Archmage at once. |
| Party shape | **Flat**: only the Archmage recruits. Subagents have the built-in Task/Agent tool disabled. |
| Edit output | Agents commit on `guild/<quest>/<agent>`. The Archmage merges them into `guild/<quest>/party` and resolves conflicts. The quest then **stops for your review**; nothing touches your main branch. |
| Non-git dir | Edit mode is refused. Read-only works anywhere. |
| Browser controls | Cancel an agent or the quest, message a running agent, answer a blocked agent (your answer wins over the Archmage's). |
| Roles | `roles.json` catalog (look, prompt, tools, model). The planner may **invent** a role; it gets a derived look and the UI offers *Save to catalog*. |
| Look | Same race, outfit, colours and props per role; **distinct face and name** per agent (seeded by agent name). |
| Art | portraitgen vendored in `vendor/portraitgen/` (no dependency). Render style is configurable; the default is **painterly**. |
| Interfaces | **REST + SSE** (the core; the UI uses it) and an **MCP server** for Claude Code sessions in other projects. |
| Persistence | Several quests at once, all saved to disk and browsable after a restart. |
| Guardrails | Max agents per quest (default 6), a model per role, a global concurrency cap (default 4 running agents; the rest queue). No cost budget, but cost is shown. |
| Access | Binds `0.0.0.0` on the LAN, **no auth** (by choice; anyone on the network can start agents that edit files). Requests must name the server in `Host` (against DNS rebinding), a browser `Origin` must be the server itself, and bodies must be `application/json`, so other web pages cannot drive it. |
| Hosting | Long-running service (`npm start` / systemd user unit). The MCP server auto-starts it when it isn't running. |
| Layout | **Council table**: the Archmage at the top centre, the party in an arc below, glowing threads with a dispatch orb flying up on each report, the Dispatch scroll (all reports), and the Chronicle (final result). |

## Processes

```
browser ──REST/SSE──┐                      ┌── claude -p  (Archmage)  ◄─ stdin: reports, your notes
other Claude Code ──MCP (guild-mcp)──REST──┤        └─ MCP "council": recruit / message / cancel / propose_plan / merge_party / finish_quest
                                   server.js ┤
                                           └── claude -p  (agent ×N)  ◄─ stdin: messages, answers
                                                    └─ MCP "guild": report_progress / ask
```

- **server.js** (plain Node, no dependencies) owns quests, the agent processes, the queue, the event log and
  the SSE fan-out. It serves the UI and the vendored portraitgen as static files.
- **Archmage**: one long-lived stream-json session per quest. Its MCP tools (served by `lib/council-mcp.js`, which
  forwards them to server.js over HTTP):
  - `propose_plan(agents[])` stores the plan. In review mode the quest waits for your approval and edits; in auto
    mode it dispatches at once.
  - `recruit_agent(role, task, name?)`, `message_agent(id, text)`, `cancel_agent(id)`, `list_party()`
  - `answer_agent(id, text)` replies to a blocked agent.
  - `merge_party()` (edit mode) merges the agent branches into `guild/<quest>/party` in an integration worktree and
    returns the conflicts. The Archmage resolves them with Bash/Edit in that worktree.
  - `finish_quest(chronicle)` writes the final markdown result and ends the quest.
- **Subagents**: MCP tools from `lib/report-mcp.js`:
  - `report_progress(percent, phase, message)`, at start, after each step, and at 100 at the end.
  - `ask(question)` marks the agent *blocked* and **waits** for an answer from you or the Archmage. The answer is
    the tool result.
  - Their final message (the stream's `result` event) is their report; the server forwards it to the Archmage as `done`.
- **Live messages** to a running agent are written to its stdin as a stream-json user message and are seen at its
  next turn. If it has already finished, the session is resumed (`--resume <session_id>`) with the message.
- **Activity** (tool calls, text) is parsed from each agent's stream-json output and shown in the UI as the agent's
  current action, separate from its explicit reports.

## Edit mode and git

- Quest start: verify the target is a git repo; record `base = HEAD`.
- Each agent: `git worktree add ~/.guild/worktrees/<quest>/<agent> -b guild/<quest>/<agent> <base>`. The agent runs
  there with Edit/Write/Bash allowed and is told to commit its work.
- `merge_party`: integration worktree on `guild/<quest>/party` from `base`, merging each agent branch in order.
- End: the UI shows the combined diff (`base..guild/<quest>/party`) and the branch name. Agent worktrees are removed and
  their branches kept. Your checkout is never modified.

## Roles and looks (`roles.json`)

```jsonc
{
  "style": "painterly",
  "roles": {
    "archmage":    { "title": "Archmage",  "describe": "ancient human wizard with a long white beard, robe, circlet", "model": "opus",   "orchestrator": true },
    "researcher":  { "title": "Scout",     "describe": "tabaxi rogue with a hood",        "colors": { "clothing": "#3b4a3a" }, "tools": "read",  "model": "sonnet" },
    "auditor":     { "title": "Auditor",   "describe": "elf with a hood and a monocle",   "colors": { "clothing": "#2f3b5c" }, "tools": "read",  "model": "opus" },
    "tester":      { "title": "Tester",    "describe": "orc warrior with war paint",      "colors": { "clothing": "#5a3a2a" }, "tools": "edit",  "model": "sonnet" },
    "implementer": { "title": "Smith",     "describe": "stout dwarf with a braided beard","colors": { "clothing": "#6b4b2b" }, "tools": "edit",  "model": "opus" },
    "reviewer":    { "title": "Inquisitor","describe": "tiefling warlock with horns",     "colors": { "clothing": "#4a2a4a" }, "tools": "read",  "model": "opus" },
    "scribe":      { "title": "Bard",      "describe": "satyr bard, smiling",             "colors": { "clothing": "#7a5a2a" }, "tools": "edit",  "model": "sonnet" }
  }
}
```

- Each role also has a `prompt` (its standing instructions). `tools` is `read`, `edit` or an explicit list; in a
  read-only quest, edit tools are removed whatever the role says.
- Portrait = `generate({ theme: 'fantasy', seed: agentName, describe: role.describe, colors: role.colors, style })`, so
  the race, outfit and colours come from the role and the face from the name. Names come from per-race syllable tables.
- Expression follows state (only brows and mouth change, so the face stays recognisable): queued *neutral*,
  working *stern*, blocked *surprised*, done *smile*, failed *sad*, cancelled *tired*.
- Invented role: the archetype and palette are hashed from the role name, so the same name always looks the same.

## REST + SSE (port 7777)

| Method | Path | |
|---|---|---|
| POST | `/api/quests` | `{ goal, cwd, mode: "read"\|"edit", planning: "review"\|"auto", maxAgents? }` returns the quest |
| GET | `/api/quests` / `/api/quests/:id` | list / full state |
| GET | `/api/quests/:id/events` | SSE: `snapshot`, then `agent`, `report`, `activity`, `plan`, `chronicle`, `quest` events. Stored events carry an id (`seq`); `?since=<seq>` or `Last-Event-ID` replays the ones after it instead of the snapshot |
| GET | `/api/events` | SSE for all quests (the list view) |
| POST | `/api/quests/:id/plan/approve` | `{ agents[] }` (edited plan) dispatches |
| POST | `/api/quests/:id/cancel` · `/agents/:aid/cancel` | cancel |
| POST | `/api/quests/:id/resume` | resume an *interrupted* quest |
| POST | `/api/quests/:id/agents/:aid/message` · `/answer` | `{ text }` |
| POST | `/api/quests/:id/message` | a note to the Archmage |
| GET/PUT | `/api/roles` | role catalog; `POST /api/roles/:id` saves an invented role |
| GET/PUT | `/api/settings` | concurrency cap, default style, default models |

Internal (MCP tools to server, the same HTTP): `/internal/quests/:id/...`.

## MCP server for other projects (`bin/guild-mcp.js`)

Add it once with `claude mcp add guild -- node ~/claude/orchestrator/bin/guild-mcp.js`. Tools:
`start_quest(goal, cwd?, mode?, planning?, maxAgents?)` (cwd defaults to the caller's directory) returns the id and
the browser URL; also `quest_status(id)`, `wait_for_quest(id, timeoutSec?)` (returns the chronicle when done),
`list_quests()`, `message_quest(id, text)`, `resume_quest(id)` and `cancel_quest(id)`. If the server isn't reachable, it starts it
detached and retries.

## Storage

`~/.guild/quests/<id>/quest.json` (state, written on change) and `events.jsonl` (append-only; the SSE replay source),
plus `~/.guild/worktrees/`. On restart, quests that were running are marked **interrupted**; their session ids are
kept, and *Resume* (`POST /api/quests/:id/resume`) carries on: the Archmage and every interrupted agent are restarted
with `claude --resume` in their worktrees (re-created from their branches if removed), told what happened, and the
Archmage gets the party's state. Agents that never set out start afresh; a question that was open must be asked again.
The downtime is kept in `pausedMs` and left out of running times.

## UI

- Header: the quest list (status pills and portraits of the party) and *New quest* (goal, directory, mode, planning,
  party size).
- Council table: the Archmage card (portrait, current thought, cost) at the top; the party arc below. Each card shows
  the portrait, name, role, task, progress rune-bar, phase, current tool activity and controls (message, cancel,
  answer when blocked). SVG threads link the cards to the Archmage; an orb travels up on each report.
- Review mode: before dispatch, the cards appear as *unsigned contracts* with editable tasks and roles, add/remove,
  and **Dispatch**.
- Dispatch scroll: a timeline of every report and Archmage action. Chronicle: the final markdown, plus the diff and
  branch name in edit mode.
- Settings: render style (default painterly), concurrency cap, the role catalog with portrait previews.

## Refinements made while building v1

- **The quest branch is `guild/<quest>/party`,** not `guild/<quest>`: git cannot hold both a branch `guild/<quest>` and
  branches under `guild/<quest>/…`.
- **Live messages to a working agent** arrive in the reply to its next `report_progress` call. A stream-json message
  written to a busy session is only read after the whole turn, and for a subagent that is the entire task. Messages
  still undelivered when its turn ends start a new turn; a finished agent is resumed with `--resume`.
- **Edit-mode agents and the Archmage run with `--permission-mode acceptEdits`,** with Edit, Write and Bash in their
  allowed tools.
- **Invented roles are sanitised:** only title, describe, tools and prompt are kept. The id must be a slug, and the
  colours are generated as hex.

## Out of scope for v1

Auth, cost budgets, nested recruiting, pushing or opening PRs. (Resuming interrupted quests was added after v1.)
