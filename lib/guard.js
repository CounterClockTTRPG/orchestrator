// Cross-site protection for a server without authentication.
//
// Host must name this server, which blocks DNS rebinding (a hostile name re-pointed at 127.0.0.1). A browser's
// Origin, when it sends one, must be this server, so other pages cannot post to it. Clients that are not
// browsers (curl, the MCP servers) send no Origin and are not affected.
// GUILD_ALLOWED_HOSTS adds names, comma-separated (e.g. a reverse proxy's hostname).

import os from 'node:os';

export function allowedHosts(extra = process.env.GUILD_ALLOWED_HOSTS) {
  const name = os.hostname().toLowerCase();
  const names = new Set(['localhost', '127.0.0.1', '::1', name, `${name}.local`]);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) names.add(i.address.toLowerCase());
  for (const h of String(extra ?? '').split(',')) if (h.trim()) names.add(h.trim().toLowerCase());
  return names;
}

/** 'Example.com:7777' → 'example.com', '[::1]:7777' → '::1'. */
export function hostName(host) {
  const h = String(host ?? '').toLowerCase();
  const v6 = h.match(/^\[(.*)\](:\d+)?$/);
  return v6 ? v6[1] : h.replace(/:\d+$/, '');
}

const refuse = (message) => Object.assign(new Error(message), { status: 403 });

/** Throws an error with status 403 when the request may come from another site. */
export function checkOrigin(headers, hosts) {
  const { host, origin } = headers;
  if (!host || !hosts.has(hostName(host))) throw refuse(`Unknown host ${host ?? '(none)'}; set GUILD_ALLOWED_HOSTS to allow it`);
  if (origin === undefined) return;
  let o = null;
  try { o = new URL(origin); } catch { /* "null" and other opaque origins */ }
  if (!o || o.host.toLowerCase() !== host.toLowerCase()) throw refuse(`Cross-origin request refused (${origin})`);
}
