// Access control for the HTTP server, on top of lib/guard.js (Host and Origin checks, against DNS rebinding and
// cross-site requests):
//   - a token for the API (GUILD_TOKEN, or GUILD_HOME/token, made on first start); requests from the
//     server's own machine need none,
//   - a per-quest secret for the internal routes, which only the agents' MCP servers call.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadToken(home) {
  if (process.env.GUILD_TOKEN) return process.env.GUILD_TOKEN;
  const file = path.join(home, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch { /* first start */ }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

export const isLoopback = (addr) => /^(127\.|::1$|::ffff:127\.)/.test(String(addr ?? ''));

export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** The token a request carries: the x-guild-token header, a bearer token, or the guild_token cookie. */
export function tokenOf(req) {
  const h = req.headers;
  if (h['x-guild-token']) return String(h['x-guild-token']);
  const bearer = /^Bearer\s+(\S+)/i.exec(h.authorization ?? '');
  if (bearer) return bearer[1];
  const cookie = /(?:^|;\s*)guild_token=([^;]+)/.exec(h.cookie ?? '');
  return cookie ? decodeURIComponent(cookie[1]) : null;
}

/** Why a request to the public API must be refused (no valid token from another machine), or null. */
export function refuseApi(req, { token }) {
  if (!isLoopback(req.socket.remoteAddress) && !sameSecret(tokenOf(req), token)) {
    return [401, 'This Guild needs its token: open the link the server printed at start (…/#token=…), or send the x-guild-token header. The token is in GUILD_HOME/token on the server.'];
  }
  return null;
}
