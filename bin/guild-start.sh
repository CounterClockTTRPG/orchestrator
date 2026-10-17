#!/usr/bin/env bash
# Start the Guild server so it can be reached from other machines on the network.
#
#   bin/guild-start.sh            # listens on 0.0.0.0:7777
#   GUILD_PORT=8080 bin/guild-start.sh
#
# Checks Node, makes sure the port is free, opens it in ufw if ufw is active (needs sudo),
# then runs server.js in the foreground; it prints the LAN links (with the access token).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export GUILD_PORT="${GUILD_PORT:-7777}"
export GUILD_HOST="${GUILD_HOST:-0.0.0.0}"

die() { echo "guild-start: $*" >&2; exit 1; }

# Node >= 20
command -v node >/dev/null || die "node not found (Node >= 20 required)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 20 )) || die "Node >= 20 required, found $(node -v)"

# Claude Code CLI
command -v "${GUILD_CLAUDE_BIN:-claude}" >/dev/null \
  || die "'${GUILD_CLAUDE_BIN:-claude}' not found; install Claude Code or set GUILD_CLAUDE_BIN"

# Port must be free
if ss -Hltn "sport = :$GUILD_PORT" 2>/dev/null | grep -q .; then
  if curl -fsS -m 2 "http://127.0.0.1:$GUILD_PORT/api/quests" >/dev/null 2>&1; then
    die "Guild already seems to be running on port $GUILD_PORT"
  fi
  die "port $GUILD_PORT is already in use:
$(ss -Hltnp "sport = :$GUILD_PORT" 2>/dev/null)"
fi

# Firewall: open the port in ufw if it is active
if command -v ufw >/dev/null; then
  if sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
    if sudo ufw status | grep -Eq "^$GUILD_PORT(/tcp)?[[:space:]]+ALLOW"; then
      echo "ufw: port $GUILD_PORT/tcp already allowed"
    else
      echo "ufw: allowing $GUILD_PORT/tcp"
      sudo ufw allow "$GUILD_PORT/tcp" comment 'Guild orchestrator' >/dev/null
    fi
  fi
fi

if [[ "$GUILD_HOST" == "127.0.0.1" || "$GUILD_HOST" == "localhost" ]]; then
  echo "warning: GUILD_HOST=$GUILD_HOST, so the server is only reachable from this machine" >&2
else
  echo "Other machines need the access token: the server prints a link with it (…/#token=…) once it listens."
  echo "Open that link once in each browser. The token is in ${GUILD_HOME:-$HOME/.guild}/token."
fi

cd "$ROOT"
exec node server.js
