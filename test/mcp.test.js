import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

// Run the subagents' MCP server against a stub guild server and talk JSON-RPC to it.
test('report-mcp forwards reports and long-polls answers', async () => {
  const seen = [];
  let polls = 0;
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/report')) return res.end('{"notes":["be brief"]}');
      if (req.url.endsWith('/attach')) return res.end('{"text":"Attached shot.png"}');
      if (req.method === 'POST') return res.end('{"askId":"k1"}');
      res.end(++polls < 2 ? '{"pending":true}' : '{"answer":"Hail"}');
    });
  }).listen(0);
  await new Promise((r) => stub.once('listening', r));

  const child = spawn(process.execPath, [path.join(LIB, 'report-mcp.js')], {
    env: { ...process.env, GUILD_URL: `http://127.0.0.1:${stub.address().port}`, GUILD_QUEST_ID: 'q', GUILD_AGENT_ID: 'a1' },
  });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      replies.get(m.id)?.(m);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'guild');
  const list = await rpc(2, 'tools/list');
  assert.deepEqual(list.result.tools.map((t) => t.name), ['report_progress', 'attach_file', 'ask']);
  const rep = await rpc(3, 'tools/call', { name: 'report_progress', arguments: { percent: 10, message: 'hi' } });
  assert.match(rep.result.content[0].text, /be brief/);
  const ask = await rpc(4, 'tools/call', { name: 'ask', arguments: { question: 'Hello or Hail?' } });
  assert.equal(ask.result.content[0].text, 'Answer: Hail');
  const att = await rpc(6, 'tools/call', { name: 'attach_file', arguments: { path: 'shot.png', caption: 'Title' } });
  assert.equal(att.result.content[0].text, 'Attached shot.png');
  const bad = await rpc(5, 'tools/call', { name: 'nope', arguments: {} });
  assert.equal(bad.result.isError, true);

  assert.ok(seen.some((s) => s.startsWith('POST /internal/quests/q/agents/a1/report')));
  assert.ok(seen.some((s) => s.startsWith('GET /internal/quests/q/agents/a1/ask/k1?wait=50')));
  assert.ok(seen.includes('POST /internal/quests/q/agents/a1/attach {"path":"shot.png","caption":"Title"}'));
  child.stdin.end();
  await new Promise((r) => child.once('exit', r));
  stub.close();
});
