# Guild

A fantasy-themed orchestrator for Claude Code agents. You post a quest (a goal on a directory). A live
orchestrator agent, **the Archmage**, plans a party of subagents (scouts, auditors, smiths, testers…) and
dispatches them. It reads their reports as they arrive and steers them, then writes the **chronicle**, which is the
final result. The browser shows the whole council live, with a procedurally generated portrait for every agent.

- **Headless Claude Code:** every agent is a `claude -p` process using your existing Claude Code login. There is
  nothing to install: no npm dependencies, Node ≥ 20.
- **Read-only or edit quests:** in edit mode each agent works in its own git worktree and branch. The Archmage merges
  them into `guild/<quest>/party` and resolves conflicts. You review that branch; your checkout is never touched.
- **Reviewed or automatic planning:** review the proposed party and its tasks in the browser (edit, add, remove) before
  dispatch, or let it go at once.
- **Live control:** message any agent, answer an agent that is blocked on a question, recall an agent, or abandon the
  quest.
- **Role catalog with looks:** every role has its own race, outfit and colours (auditors are hooded elves, testers are
  orcs, smiths are dwarves…). Each agent has its own face and name. The Archmage may invent new roles; you can save
  them to the catalog. Portraits come from [portraitgen](https://github.com/CounterClockTTRPG/portraitgen), vendored in
  `vendor/portraitgen/`. The art style is configurable (default: painterly).
- **REST + SSE API and an MCP server,** so other projects and Claude Code sessions can start and follow quests.

## Running it

```bash
npm start                 # http://localhost:7777/  (listens on 0.0.0.0:7777, no auth)
```

| Variable | Default | |
|---|---|---|
| `GUILD_PORT` | `7777` | HTTP port |
| `GUILD_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to keep it off the LAN. |
| `GUILD_HOME` | `~/.guild` | Quests, settings, the role catalog, worktrees, server log |
| `GUILD_CLAUDE_BIN` | `claude` | The Claude Code executable |

> **No authentication.** Anyone who can reach the port can start agents, and in edit mode those agents run shell
> commands. Bind to `127.0.0.1` if your network isn't trusted.

To run it as a service, use a systemd user unit:

```ini
# ~/.config/systemd/user/guild.service
[Unit]
Description=Guild agent orchestrator

[Service]
ExecStart=/usr/bin/env node %h/claude/orchestrator/server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now guild
```

## Using it from other projects

### From Claude Code (MCP)

```bash
claude mcp add guild -- node ~/claude/orchestrator/bin/guild-mcp.js
```

Tools: `start_quest(goal, cwd?, mode?, planning?, maxAgents?)`, `quest_status(id)`, `wait_for_quest(id, timeoutSec?)`,
`list_quests()`, `message_quest(id, text, agentId?)` and `cancel_quest(id)`. `cwd` defaults to the session's project,
and MCP quests default to automatic planning. If the server isn't running, the MCP server starts it in the background.
Set `GUILD_URL` to use a server elsewhere; a remote server is never auto-started.

### Over HTTP

```bash
curl -s localhost:7777/api/quests -H 'content-type: application/json' \
  -d '{"goal":"Audit the auth module for security issues","cwd":"/home/me/app","mode":"read","planning":"auto"}'
curl -N localhost:7777/api/quests/<id>/events        # live events (SSE)
curl -s localhost:7777/api/quests/<id>               # full state, including the chronicle when done
```

| Method | Path | |
|---|---|---|
| POST | `/api/quests` | `{ goal, cwd, mode: "read"\|"edit", planning: "review"\|"auto", maxAgents? }` |
| GET | `/api/quests`, `/api/quests/:id` | list / full state |
| GET | `/api/quests/:id/events` | SSE: `snapshot`, then `quest`, `archmage`, `agent`, `activity`, `log`, `report`, `plan`, `roles`, `chronicle` |
| GET | `/api/events` | SSE: `state`, then `summary` (one per quest change), `settings`, `roles` |
| POST | `/api/quests/:id/plan/approve` | `{ agents?: [{ role, task }] }`, the plan, optionally edited |
| POST | `/api/quests/:id/message` | `{ text }` to the Archmage |
| POST | `/api/quests/:id/cancel` | abandon the quest |
| POST | `/api/quests/:id/agents/:aid/message` · `/answer` · `/cancel` | `{ text }` |
| GET/PUT | `/api/roles` · POST `/api/roles/:id` | the role catalog; save an invented role with `{ quest }` |
| GET/PUT | `/api/settings` | `style`, `maxConcurrent`, `maxAgents`, `batchSeconds` |

## How it works

```
browser ─ REST/SSE ─┐                          ┌─ claude -p  the Archmage ─ MCP "council": propose_plan, recruit_agent,
other Claude Code ─ MCP (bin/guild-mcp.js) ────┤                              message_agent, answer_agent, cancel_agent,
                                    server.js ─┤                              list_party, merge_party, finish_quest
                                               └─ claude -p  agents × N  ─── MCP "guild": report_progress, ask
```

- `server.js` and `lib/guild.js` own the quests, the agent processes, the global queue (`maxConcurrent` running agents
  across all quests) and the event log. The two MCP servers (`lib/council-mcp.js`, `lib/report-mcp.js`) are tiny
  stdio processes that forward tool calls to the server's `/internal/…` routes.
- **Reports** reach the UI at once. The Archmage gets routine progress in batches (every `batchSeconds`, default 60);
  `blocked`, `done` and `failed` wake it immediately.
- **Messages to a working agent** come back in the reply to its next `report_progress` call (agents report often).
  A finished agent is resumed with `claude --resume`.
- **`ask`** blocks the agent until you or the Archmage answer. The browser card shows the question with an answer box.
- **Edit mode:** worktrees live in `~/.guild/worktrees/<quest>/`. Agent branches are `guild/<quest>/<agent>`, the
  merged result is `guild/<quest>/party`, and leftover uncommitted work is committed before worktrees are removed.
- **Persistence:** `~/.guild/quests/<id>/quest.json` and `events.jsonl`. Quests that were running when the server
  stopped come back as *interrupted*.

See [DESIGN.md](DESIGN.md) for the decisions behind it.

## Roles

The catalog is `~/.guild/roles.json`, seeded from `roles.default.json` and editable in Settings. Each role has:
`title`, `describe` (a portraitgen description: race and look), `colors`, `tools` (`read`, `edit` or an explicit tool
list), `model` (`opus`, `sonnet`, `haiku` or a model id), `blurb`, and `prompt` (standing instructions). The
orchestrator role has `orchestrator: true` and a fixed `name`.

## Development

```bash
npm test
```

portraitgen is vendored from `raf/portraitgen` (see `vendor/portraitgen/VENDORED.md`). To update it, copy its `src/`
again.
