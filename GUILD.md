# Notes for agents working on Guild

Guild works on itself here, so take care: the live server that runs your quest is built from this code.

- **Never touch the live instance.** Do not stop, restart or send requests to the server on port 7777. Do not
  change `~/.guild` or `systemctl --user … guild`. For an end-to-end check, run `server.js` on another port with a
  scratch home: `GUILD_HOME=$(mktemp -d) GUILD_PORT=7790 GUILD_HOST=127.0.0.1 node server.js`. Add
  `GUILD_CLAUDE_BIN=/bin/false` when no agents should actually run.
- **No dependencies.** Plain Node ≥ 20, ES modules, nothing from npm, including for tests (`node:test`).
  portraitgen stays vendored.
- **Tests.** `npm test` must pass before you report. Behaviour you add or fix gets a test. Prefer real git repos in
  temp directories over mocks.
- **Style.** Match the surrounding code: small functions, comments that say why, plain messages for the human and
  the Archmage.
- **Docs.** User-facing changes update `README.md`, and design decisions update `DESIGN.md`. The decisions already
  taken are in `guild-decisions.md (maintainer's notes, not in this repo)`, and the findings behind them are in
  `guild-self-analysis.md (maintainer's notes, not in this repo)`. Follow them.
- **Security.** The API needs the token from other machines, writes must be same-origin JSON, and `/internal` needs
  the per-quest secret (`lib/auth.js`). New routes go through the same checks. New role fields must pass
  `cleanRole` in `lib/guild.js`.
