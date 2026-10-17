import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { startGuild } from './helpers/e2e.js';

// The HTTP routes of a running server: the token, the guard (Host, Origin, JSON-only bodies), the per-quest secret
// on /internal, and the public routes, with a review-mode quest driven by fake-claude.

// Requests from another machine are simulated by connecting to one of this machine's own non-loopback addresses.
const LAN = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const noLan = !LAN && 'this machine has no non-loopback address';

const archmage = {
  match: { archmage: true, message: 'GOAL-ONE' },
  steps: [
    { call: 'propose_plan', args: { summary: 'One scout.', agents: [{ role: 'researcher', title: 'Scout it', task: 'Scout the repo.' }] } },
    { result: 'Awaiting approval.' },
    { wait: 'Message from the human: how goes it' },
    { say: 'Aye, the plan awaits you.' },
    { result: 'Answered.' },
    { wait: 'The human approved the plan' },
    { wait: '\\(a1\\) has returned' },
    { call: 'finish_quest', args: { chronicle: 'Scouted.' } },
  ],
};
const idle = { match: { archmage: true, message: 'GOAL-TWO' }, steps: [{ call: 'propose_plan', args: { summary: 'Later.', agents: [{ role: 'researcher', task: 'Wait.' }] } }, { result: 'Proposed.' }] };
const scout = { match: { role: 'Scout' }, steps: [{ call: 'report_progress', args: { percent: 50, message: 'Halfway.' } }, { result: 'Scouted the repo.', cost: 0.01 }] };

let h, repo, one, two;
before(async () => {
  h = await startGuild({ host: LAN ? '0.0.0.0' : '127.0.0.1', token: 'sesame', scenario: { sessions: [archmage, idle, scout] } });
  repo = h.repo('site');
  one = await h.createQuest({ goal: 'GOAL-ONE', cwd: repo, planning: 'review' });
  two = await h.createQuest({ goal: 'GOAL-TWO', cwd: repo, planning: 'review' });
  await h.waitQuest(one.id, 'awaiting-approval');
  await h.waitQuest(two.id, 'awaiting-approval');
});
after(() => h?.stop());

const fromLan = (method, p, opts = {}) => h.request(method, p, { ...opts, address: LAN, headers: { host: `${LAN}:${h.port}`, ...opts.headers } });

test('from another machine the API needs the token; the open routes and the page do not', { skip: noLan }, async () => {
  for (const p of ['/api', '/api/health', '/llms.txt', '/']) assert.equal((await fromLan('GET', p)).status, 200, p);
  for (const p of ['/api/state', '/api/quests', `/api/quests/${one.id}`, '/api/settings']) {
    const r = await fromLan('GET', p);
    assert.equal(r.status, 401, p);
    assert.match(r.body.error, /needs its token/);
  }
  assert.equal((await fromLan('GET', '/api/state', { headers: { 'x-guild-token': 'wrong' } })).status, 401);
  assert.equal((await fromLan('GET', '/api/state', { headers: { 'x-guild-token': 'sesame' } })).status, 200);
  assert.equal((await fromLan('GET', '/api/state', { headers: { authorization: 'Bearer sesame' } })).status, 200);
  assert.equal((await fromLan('GET', '/api/state', { headers: { cookie: 'a=b; guild_token=sesame' } })).status, 200);
  const sse = await fromLan('GET', '/api/events');
  assert.equal(sse.status, 401, 'the event streams too');
});

test('from this machine no token is needed', async () => {
  const s = await h.get('/api/state');
  assert.deepEqual(s.quests.map((q) => q.id).sort(), [one.id, two.id].sort());
});

test('the Host must name this server', async () => {
  const evil = await h.request('GET', '/api/health', { headers: { host: `evil.example:${h.port}` } });
  assert.equal(evil.status, 403);
  assert.match(evil.body.error, /Unknown host evil\.example/);
  assert.equal((await h.request('GET', '/api/state', { headers: { host: `rebound.example` } })).status, 403);
  for (const host of [`localhost:${h.port}`, `[::1]:${h.port}`, `${os.hostname()}:${h.port}`]) {
    assert.equal((await h.request('GET', '/api/health', { headers: { host } })).status, 200, host);
  }
});

test('requests from another origin are refused, the own origin passes', async () => {
  const post = (origin) => h.request('POST', '/api/quests', { body: {}, headers: { origin } });
  assert.equal((await post('https://evil.example')).status, 403);
  assert.equal((await post('null')).status, 403);
  assert.equal((await post(`http://localhost:${h.port}`)).status, 403, 'a different spelling of the host is another origin');
  const same = await post(h.url);
  assert.equal(same.status, 400);
  assert.match(same.body.error, /needs a goal/);
  assert.equal((await h.request('GET', '/api/state', { headers: { origin: 'https://evil.example' } })).status, 403, 'reads too');
  assert.equal((await h.request('POST', `/internal/quests/${one.id}/council/list_party`, { body: {}, headers: { origin: 'https://evil.example', 'x-guild-secret': h.live(one.id).secret } })).status, 403);
});

test('bodies must be JSON', async () => {
  const send = (body, type) => h.request('PUT', '/api/settings', { body, headers: { 'content-type': type } });
  assert.equal((await send('{"maxAgents":5}', 'text/plain')).status, 415);
  assert.equal((await send('maxAgents=5', 'application/x-www-form-urlencoded')).status, 415);
  assert.equal((await send('{"maxAgents":5}', undefined)).status, 415, 'no type at all');
  const bad = await send('{nope', 'application/json');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Invalid JSON/);
  assert.equal((await send('{"maxAgents":5}', 'application/json; charset=utf-8')).status, 200);
  assert.equal((await h.get('/api/settings')).maxAgents, 5);
});

test('/internal needs the quest\'s own secret, from this machine', async () => {
  const p = `/internal/quests/${one.id}/council/list_party`;
  const call = (secret, opts) => h.request('POST', p, { body: {}, headers: secret === undefined ? {} : { 'x-guild-secret': secret }, ...opts });
  assert.equal((await call(undefined)).status, 403);
  assert.equal((await call('wrong')).status, 403);
  assert.equal((await call(h.live(two.id).secret)).status, 403, 'another quest\'s secret');
  assert.equal((await h.request('POST', '/internal/quests/nope/council/list_party', { body: {}, headers: { 'x-guild-secret': h.live(one.id).secret } })).status, 403);
  const ok = await call(h.live(one.id).secret);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.text, 'The party is empty.');
  // The token does not stand in for the secret.
  assert.equal((await h.request('POST', p, { body: {}, headers: { 'x-guild-token': 'sesame' } })).status, 403);
  // Agents' routes too.
  const report = await h.request('POST', `/internal/quests/${one.id}/agents/a1/report`, { body: { percent: 1, message: 'x' } });
  assert.equal(report.status, 403);
});

test('/internal refuses other machines even with the secret', { skip: noLan }, async () => {
  const r = await fromLan('POST', `/internal/quests/${one.id}/council/list_party`, { body: {}, headers: { 'x-guild-secret': h.live(one.id).secret, 'x-guild-token': 'sesame' } });
  assert.equal(r.status, 403);
});

test('static files, and no way out of their directories', async () => {
  const page = await h.request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal((await h.request('GET', '/web/..%2fserver.js')).status, 403, 'an encoded slash survives URL parsing');
  assert.equal((await h.request('GET', '/web/nope.js')).status, 404);
  assert.equal((await h.request('GET', '/api/nope')).status, 404);
  assert.equal((await h.request('GET', '/api/quests/nope')).status, 404);
  const api = await h.get('/api');
  assert.ok(api.endpoints.some((e) => e.path === '/api/quests/:id/resume'));
  assert.match((await h.request('GET', '/llms.txt')).text, /^# Guild/);
});

test('settings, roles and applications', async () => {
  assert.equal((await h.put('/api/settings', { maxConcurrent: 99 })).maxConcurrent, 32, 'clamped');
  assert.equal((await h.request('PUT', '/api/settings', { body: { theme: 'nope' } })).status, 400);
  await h.put('/api/settings', { maxConcurrent: 4 });

  const roles = await h.post('/api/roles/cartographer', { role: { title: 'Cartographer', tools: 'read', prompt: 'Map.', colors: { cloak: '#123456', evil: 'url(x)' } } });
  assert.deepEqual(roles.cartographer, { title: 'Cartographer', prompt: 'Map.', tools: 'read', colors: { cloak: '#123456' } });
  assert.equal((await h.request('POST', '/api/roles/Bad_Id', { body: { role: { title: 'x' } } })).status, 400);
  assert.equal((await h.request('POST', '/api/roles/x2', { body: {} })).status, 400);
  assert.ok((await h.get('/api/roles')).cartographer);

  const app = await h.post('/api/applications', { name: 'Site', repos: [repo], context: 'A small site.' });
  assert.equal(app.repos[0].path, repo);
  assert.equal((await h.get(`/api/applications/${app.id}`)).quests.length, 0);
  await h.put(`/api/quests/${two.id}/app`, { app: app.id });
  assert.deepEqual((await h.get(`/api/applications/${app.id}`)).quests.map((q) => q.id), [two.id]);
  assert.equal((await h.put(`/api/applications/${app.id}`, { name: 'Site', repos: [repo], context: 'Changed.' })).context, 'Changed.');
  await h.del(`/api/applications/${app.id}`);
  assert.equal((await h.request('GET', `/api/applications/${app.id}`)).status, 404);
  assert.equal((await h.quest(two.id)).app, null, 'its quests stay, ungrouped');
});

test('a review quest over HTTP: event stream, a message, approval, the party, the chronicle; and a cancel', async () => {
  const [snap] = await h.sse(`/api/quests/${one.id}/events`);
  assert.equal(snap.event, 'snapshot');
  assert.equal(snap.data.status, 'awaiting-approval');
  const replay = await h.sse(`/api/quests/${one.id}/events?since=0`, { until: (ev) => ev.some((e) => e.event === 'plan') });
  assert.equal(replay[0].id, '1');

  assert.equal((await h.request('POST', `/api/quests/${one.id}/message`, { body: { text: '  ' } })).status, 400);
  await h.post(`/api/quests/${one.id}/message`, { text: 'how goes it?' });
  await h.waitQuest(one.id, (s) => s.log.some((e) => e.who === 'archmage' && e.kind === 'say' && e.to === 'you' && /Aye/.test(e.text)));

  assert.equal((await h.request('POST', `/api/quests/${one.id}/plan/approve`, { body: { agents: [] } })).status, 400, 'an empty plan');
  const { party } = await h.post(`/api/quests/${one.id}/plan/approve`, {});
  assert.match(party, /a1: .+ the Scout/);
  const done = await h.waitQuest(one.id, 'done');
  assert.equal(done.chronicle, 'Scouted.');
  assert.equal(done.agents[0].result, 'Scouted the repo.');
  assert.equal((await h.request('POST', `/api/quests/${one.id}/cancel`)).status, 400, 'not running any more');
  assert.equal((await h.request('POST', `/api/quests/${one.id}/deliver`)).status, 400, 'a read quest has nothing to deliver');

  await h.post(`/api/quests/${two.id}/cancel`);
  const cancelled = await h.waitQuest(two.id, 'cancelled');
  assert.match(cancelled.chronicle, /Cancelled/);
});
