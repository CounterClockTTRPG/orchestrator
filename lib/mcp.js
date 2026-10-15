// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No dependencies.
//
//   serveMcp({ name: 'guild', tools: [{ name, description, inputSchema, handler }] });
//
// A handler returns a string or a JSON-able value (sent as text content), or throws (sent as an error result).

import { createInterface } from 'node:readline';

export function serveMcp({ name, version = '1.0.0', instructions, tools }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

  const methods = {
    initialize: (params) => ({
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name, version },
      ...(instructions ? { instructions } : {}),
    }),
    ping: () => ({}),
    'tools/list': () => ({
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }),
    'tools/call': async ({ name: tool, arguments: args }) => {
      const t = byName.get(tool);
      if (!t) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${tool}` }] };
      try {
        const out = await t.handler(args ?? {});
        return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
      }
    },
  };

  // Exit when stdin closes, but only after the calls still in flight have answered.
  let pending = 0, closed = false;
  const maybeExit = () => { if (closed && !pending) process.exit(0); };

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || msg.id === null) return; // notifications need no reply
    const fn = methods[msg.method];
    if (!fn) return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    pending++;
    try {
      send({ id: msg.id, result: await fn(msg.params) });
    } catch (err) {
      send({ id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } });
    } finally {
      pending--;
      maybeExit();
    }
  });
  rl.on('close', () => { closed = true; maybeExit(); });
}

/** Call the guild server's JSON API. Throws with the server's error message on failure. */
export async function api(baseUrl, method, path, body, { timeoutMs } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
