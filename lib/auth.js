// Access control for the HTTP server:
//   - a token for the API (GUILD_TOKEN, or GUILD_HOME/token, made on first start); requests from the
//     server's own machine need none,
//   - a Host allowlist against DNS rebinding,
//   - same-origin and JSON-only checks on writes, against cross-site requests from web pages,
//   - a per-quest secret for the internal routes, which only the agents' MCP servers call.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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

/** Host names this server answers to: loopback, the machine's names and addresses, and GUILD_ALLOWED_HOSTS. */
export function allowedHosts() {
  const hosts = new Set(['localhost', '127.0.0.1', '::1', os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`]);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) hosts.add(i.address.toLowerCase());
  for (const h of String(process.env.GUILD_ALLOWED_HOSTS ?? '').split(',')) if (h.trim()) hosts.add(h.trim().toLowerCase());
  return hosts;
}

/** The host name of a Host header or URL authority: no port, no IPv6 brackets. */
export function hostName(authority) {
  const a = String(authority ?? '').trim().toLowerCase();
  if (a.startsWith('[')) return a.slice(1, a.indexOf(']'));
  return a.replace(/:\d+$/, '');
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

/**
 * Why a request to the public API must be refused, or null if it may go ahead.
 * Writes must come from this server's own pages (or from a client that sends no Origin, like curl).
 */
export function refuseApi(req, { token }) {
  const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (writes && req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin).host; } catch { origin = null; }
    if (origin !== String(req.headers.host ?? '').toLowerCase()) return [403, 'Cross-origin requests are not allowed'];
  }
  if (!isLoopback(req.socket.remoteAddress) && !sameSecret(tokenOf(req), token)) {
    return [401, 'This Guild needs its token: open the link the server printed at start (…/#token=…), or send the x-guild-token header. The token is in GUILD_HOME/token on the server.'];
  }
  return null;
}
