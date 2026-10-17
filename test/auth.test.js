import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostName, isLoopback, tokenOf, refuseApi, sameSecret, loadToken } from '../lib/auth.js';

// Access control: the API token, the Host allowlist, same-origin JSON writes and the per-quest
// secret of the internal routes. The second half runs the real server on a spare port.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const req = ({ method = 'GET', headers = {}, addr = '192.168.1.9' } = {}) => ({ method, headers, socket: { remoteAddress: addr } });

test('host names, loopback addresses and tokens are read the way browsers and curl send them', () => {
  assert.equal(hostName('Example.local:7777'), 'example.local');
  assert.equal(hostName('[::1]:7777'), '::1');
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'));
  assert.ok(!isLoopback('192.168.1.9'));
  assert.equal(tokenOf(req({ headers: { 'x-guild-token': 'a' } })), 'a');
  assert.equal(tokenOf(req({ headers: { authorization: 'Bearer b' } })), 'b');
  assert.equal(tokenOf(req({ headers: { cookie: 'x=1; guild_token=c%2B' } })), 'c+');
  assert.ok(sameSecret('s3', 's3') && !sameSecret('s3', 's4') && !sameSecret('', ''));
});

test('the API wants the token from other machines, and writes from this server\'s own origin only', () => {
  const token = 't0ken';
  assert.equal(refuseApi(req(), { token })[0], 401);
  assert.equal(refuseApi(req({ headers: { 'x-guild-token': token } }), { token }), null);
  assert.equal(refuseApi(req({ addr: '127.0.0.1' }), { token }), null);
  const evil = { host: 'localhost:7777', origin: 'https://evil.example' };
  assert.equal(refuseApi(req({ method: 'POST', addr: '127.0.0.1', headers: evil }), { token })[0], 403);
  const own = { host: 'localhost:7777', origin: 'http://localhost:7777' };
  assert.equal(refuseApi(req({ method: 'POST', addr: '127.0.0.1', headers: own }), { token }), null);
});

test('the token is made once and kept private', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-token-'));
  const t = loadToken(home);
  assert.ok(t.length >= 30);
  assert.equal(loadToken(home), t);
  assert.equal(fs.statSync(path.join(home, 'token')).mode & 0o777, 0o600);
});

// ── the running server ──

const PORT = 17000 + Math.floor(Math.random() * 2000);
let server;
before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-srv-'));
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, GUILD_HOME: home, GUILD_PORT: String(PORT), GUILD_HOST: '127.0.0.1', GUILD_CLAUDE_BIN: '/bin/false' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/api/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
after(() => server?.kill());

const http = (p, { method = 'GET', headers = {}, body } = {}) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body }).then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));

test('the server refuses unknown hosts, cross-site text posts and internal calls without the secret', async () => {
  assert.equal((await http('/api/health')).status, 200);
  // fetch() won't send a Host of our choosing; a DNS-rebinding page would.
  const rebound = await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: PORT, path: '/api/quests', headers: { host: 'rebind.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject).end();
  });
  assert.equal(rebound, 421);
  // A web page can send text/plain without a preflight; it must not start a quest.
  const forged = await http('/api/quests', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ goal: 'x', cwd: ROOT }) });
  assert.equal(forged.status, 415);
  const crossSite = await http('/api/quests', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(crossSite.status, 403);
  const internal = await http('/internal/quests/nope/agents/archmage/attach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"path":"/etc/passwd"}' });
  assert.equal(internal.status, 403);
  const page = await http('/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});

test('a quest on the whole disk or the whole home directory is refused', async () => {
  for (const cwd of ['/', os.homedir()]) {
    const r = await http('/api/quests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'x', cwd }) });
    assert.equal(r.status, 400);
    assert.match(r.text, /too broad/);
  }
});

test('saved roles keep only known fields, and colours must be colours', async () => {
  process.env.GUILD_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'guild-test-'));
  const { cleanRole } = await import('../lib/guild.js');
  const r = cleanRole({ title: '<img src=x onerror=alert(1)>', tools: 'read', colors: { clothing: '#334455', accent: 'red;}</style>' }, evil: 1 });
  assert.deepEqual(Object.keys(r).sort(), ['colors', 'title', 'tools']);
  assert.deepEqual(r.colors, { clothing: '#334455' });
  assert.throws(() => cleanRole({ tools: 'root' }), /tools/);
});
