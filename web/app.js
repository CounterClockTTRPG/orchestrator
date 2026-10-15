// Guild web UI: the hall of quests and the live council table.

import { setPortrait, STYLES } from './portraits.js';
import { markdown, esc } from './markdown.js';

const $ = (sel, el = document) => el.querySelector(sel);
const ACTIVE = new Set(['planning', 'awaiting-approval', 'questing']);
const STATUS_WORD = {
  planning: 'Planning', 'awaiting-approval': 'Awaiting your approval', questing: 'On the quest',
  done: 'Complete', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
};
const AGENT_WORD = { queued: 'Waiting', working: 'Questing', blocked: 'Blocked', done: 'Returned', failed: 'Fallen', cancelled: 'Recalled', interrupted: 'Interrupted' };

const G = {
  settings: {}, roles: {}, quests: new Map(),
  q: null, es: null, cards: new Map(), threads: new Map(), logCount: 0, filter: 'all', planDraft: null, planKey: null,
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const money = (n) => (n ? `$${n.toFixed(n < 1 ? 3 : 2)}` : '');
const time = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const when = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const role = (id, q = G.q) => q?.roles?.[id] ?? G.roles[id] ?? { title: id, describe: 'human adventurer' };
const archRole = () => Object.values(G.roles).find((r) => r.orchestrator) ?? { describe: 'old human wizard with a long white beard', name: 'Velothar' };
const style = () => G.settings.style ?? 'painterly';

function toast(msg) {
  const el = Object.assign(document.createElement('div'), { textContent: msg });
  Object.assign(el.style, { position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: '#2a2235', border: '1px solid #8a7430', color: '#ece3d0', padding: '0.6rem 1rem', borderRadius: '8px', zIndex: 99, maxWidth: 'calc(100vw - 32px)' });
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

// ───────────── global stream: quest list, settings, roles ─────────────

function connectGlobal() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    G.settings = s.settings;
    G.roles = s.roles;
    G.quests = new Map(s.quests.map((q) => [q.id, q]));
    renderTabs();
    route();
  });
  es.addEventListener('summary', (e) => {
    const { quest } = JSON.parse(e.data);
    G.quests.set(quest.id, quest);
    renderTabs();
    if (!G.q && !location.hash.startsWith('#/quest/')) renderHall();
  });
  es.addEventListener('settings', (e) => { G.settings = JSON.parse(e.data).settings; });
  es.addEventListener('roles', (e) => { G.roles = JSON.parse(e.data).roles; });
}

function renderTabs() {
  const list = [...G.quests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const shown = list.filter((q) => ACTIVE.has(q.status)).concat(list.filter((q) => !ACTIVE.has(q.status)).slice(0, 4));
  $('#quest-tabs').innerHTML = shown.map((q) => `
    <a class="tab ${G.q?.id === q.id ? 'active' : ''}" href="#/quest/${q.id}" title="${esc(q.goal)}">
      <span class="dot ${q.status}"></span><span class="goal">${esc(q.goal)}</span>
    </a>`).join('');
  const running = list.reduce((n, q) => n + q.party.filter((a) => a.status === 'working' || a.status === 'blocked').length, 0);
  const waiting = list.reduce((n, q) => n + q.party.filter((a) => a.status === 'queued').length, 0);
  $('#queue-info').textContent = running || waiting ? `${running}/${G.settings.maxConcurrent} agents afield${waiting ? `, ${waiting} waiting` : ''}` : '';
}

// ───────────── routing ─────────────

function route() {
  const m = location.hash.match(/^#\/quest\/([\w-]+)/);
  if (m) { if (G.q?.id !== m[1]) openQuest(m[1]); } else { closeQuest(); renderHall(); }
}
window.addEventListener('hashchange', route);

function closeQuest() {
  G.es?.close();
  G.es = null;
  G.q = null;
  G.cards.clear();
  G.threads.clear();
}

// ───────────── the hall ─────────────

function renderHall() {
  const list = [...G.quests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const ar = archRole();
  $('#view').innerHTML = `
    <div class="hall-head">
      <h1>The Guild Hall</h1>
      <p>Post a quest; the Archmage gathers a party of agents and reports back.</p>
      <button class="btn gold" data-new>Post a quest</button>
    </div>
    ${list.length ? `<div class="quest-grid">${list.map((q) => `
      <a class="quest-card" href="#/quest/${q.id}">
        <div class="meta"><span class="dot ${q.status}"></span><span class="status-word">${STATUS_WORD[q.status] ?? q.status}</span>
          ${q.mode === 'edit' ? '<span class="badge edit">edit</span>' : '<span class="badge">read-only</span>'}
          <span>${when(q.createdAt)}</span><span>${money(q.costUsd)}</span></div>
        <div class="goal">${esc(q.goal)}</div>
        <div class="meta"><code>${esc(q.cwd)}</code></div>
        <div class="mini-party" data-quest="${q.id}"></div>
      </a>`).join('')}</div>`
      : `<div class="empty"><div class="mini" style="width:160px;height:160px;margin:0 auto 1rem;border-radius:50%;overflow:hidden" id="hall-arch"></div>
         <p>No quests yet. The Archmage waits.</p></div>`}`;
  $('[data-new]', $('#view')).onclick = openNewQuest;
  const ha = $('#hall-arch');
  if (ha) setPortrait(ha, { seed: ar.name ?? 'Velothar', role: ar, status: 'waiting', style: style(), size: 200 });
  for (const el of document.querySelectorAll('.mini-party')) {
    const q = G.quests.get(el.dataset.quest);
    for (const a of q.party.slice(0, 10)) {
      const d = document.createElement('div');
      d.className = 'mini';
      d.title = `${a.name} (${a.status})`;
      el.append(d);
      setPortrait(d, { seed: a.name, role: G.roles[a.role] ?? { describe: 'human adventurer' }, status: a.status, style: 'illustrated', size: 64 });
    }
  }
}

// ───────────── a quest ─────────────

function openQuest(id) {
  closeQuest();
  $('#view').innerHTML = '<p class="muted">Opening the quest…</p>';
  const es = new EventSource(`/api/quests/${id}/events`);
  G.es = es;
  es.addEventListener('snapshot', (e) => { G.q = JSON.parse(e.data); buildQuest(); });
  es.addEventListener('quest', (e) => { const d = JSON.parse(e.data); G.q.status = d.status; G.q.finishedAt = d.finishedAt; renderHead(); renderPlan(); renderArchmage(); renderTabs(); });
  es.addEventListener('archmage', (e) => { G.q.archmage = JSON.parse(e.data).archmage; renderArchmage(); });
  es.addEventListener('agent', (e) => {
    const { agent } = JSON.parse(e.data);
    const i = G.q.agents.findIndex((a) => a.id === agent.id);
    if (i >= 0) G.q.agents[i] = agent; else G.q.agents.push(agent);
    renderParty();
    renderHead();
  });
  es.addEventListener('activity', (e) => {
    const { agentId, activity } = JSON.parse(e.data);
    const a = G.q.agents.find((x) => x.id === agentId);
    if (a) { a.activity = activity; const c = G.cards.get(agentId); if (c) $('.activity', c).textContent = activity ?? ''; }
  });
  es.addEventListener('log', (e) => { G.q.log.push(JSON.parse(e.data).entry); renderLog(); });
  es.addEventListener('report', (e) => { const d = JSON.parse(e.data); sendOrb(d.agentId, 'up'); });
  es.addEventListener('plan', (e) => { const d = JSON.parse(e.data); G.q.plan = d.plan; G.q.roles = d.roles; renderPlan(); });
  es.addEventListener('roles', (e) => { G.q.roles = JSON.parse(e.data).roles; renderParty(); });
  es.addEventListener('chronicle', (e) => { const d = JSON.parse(e.data); G.q.chronicle = d.chronicle; G.q.diff = d.diff; renderChronicle(); });
  es.onerror = () => { if (!G.q) $('#view').innerHTML = '<div class="empty">This quest could not be found.</div>'; };
}

function buildQuest() {
  G.cards.clear();
  G.threads.clear();
  G.logCount = 0;
  $('#view').innerHTML = `
    <section class="quest">
      <div class="quest-head" id="q-head"></div>
      <div class="council" id="council">
        <svg class="threads" id="threads"></svg>
        <div class="archmage-wrap"><div class="card archmage" id="archmage-card">
          <div class="portrait"></div>
          <div>
            <div class="name"></div>
            <div class="role"></div>
            <div class="bubble"></div>
            <div class="activity"></div>
            <div class="foot"><span class="cost"></span><button class="btn small" data-msg-arch>Speak to the Archmage</button></div>
          </div>
          <span class="status"></span>
        </div></div>
        <div id="plan-slot"></div>
        <div class="party" id="party"></div>
      </div>
      <div class="lower" id="lower">
        <div class="scroll">
          <h3>Dispatch scroll</h3>
          <div class="filters">
            ${['all', 'reports', 'archmage', 'you'].map((f) => `<button class="btn small ${G.filter === f ? 'gold' : 'ghost'}" data-filter="${f}">${{ all: 'Everything', reports: 'Reports', archmage: 'Archmage', you: 'You' }[f]}</button>`).join('')}
          </div>
          <ol id="log"></ol>
        </div>
        <div class="chronicle" id="chronicle"></div>
      </div>
    </section>`;
  $('[data-msg-arch]').onclick = async () => {
    const text = await askText('Speak to the Archmage', 'Guidance, a correction, or a request for a different plan.');
    if (text) api('POST', `/api/quests/${G.q.id}/message`, { text }).catch((e) => toast(e.message));
  };
  for (const b of document.querySelectorAll('[data-filter]')) b.onclick = () => {
    G.filter = b.dataset.filter;
    for (const x of document.querySelectorAll('[data-filter]')) x.className = `btn small ${x === b ? 'gold' : 'ghost'}`;
    G.logCount = 0;
    $('#log').innerHTML = '';
    renderLog();
  };
  new ResizeObserver(() => drawThreads()).observe($('#council'));
  renderHead();
  renderArchmage();
  renderPlan();
  renderParty();
  renderLog();
  renderChronicle();
  renderTabs();
}

function renderHead() {
  const q = G.q;
  if (!q || !$('#q-head')) return;
  const active = ACTIVE.has(q.status);
  const working = q.agents.filter((a) => a.status === 'working' || a.status === 'blocked').length;
  const total = (q.archmage?.costUsd ?? 0) + q.agents.reduce((n, a) => n + (a.costUsd ?? 0), 0);
  $('#q-head').innerHTML = `
    <div>
      <p class="goal">${esc(q.goal)}</p>
      <div class="meta">
        <span class="dot ${q.status}"></span><span class="status-word">${STATUS_WORD[q.status] ?? q.status}</span>
        ${q.mode === 'edit' ? '<span class="badge edit">edit mode</span>' : '<span class="badge">read-only</span>'}
        <span class="badge">${q.planning === 'review' ? 'reviewed plan' : 'automatic plan'}</span>
        <code>${esc(q.cwd)}</code>
        ${q.repo?.branch ? `<span>branch <code>${esc(q.repo.branch)}</code></span>` : ''}
        <span>${q.agents.length} in the party${working ? `, ${working} afield` : ''}</span>
        <span>${money(total)}</span>
        <span>${when(q.createdAt)}</span>
      </div>
    </div>
    <div class="row" style="flex:none">
      ${active ? '<button class="btn danger" data-cancel-quest>Abandon quest</button>' : ''}
    </div>`;
  const c = $('[data-cancel-quest]');
  if (c) c.onclick = () => { if (confirm('Abandon this quest and recall the whole party?')) api('POST', `/api/quests/${q.id}/cancel`).catch((e) => toast(e.message)); };
}

function renderArchmage() {
  const q = G.q, a = q?.archmage, el = $('#archmage-card');
  if (!a || !el) return;
  const r = role(a.role);
  setPortrait($('.portrait', el), { seed: a.name, role: r, status: a.status, style: style(), size: 220 });
  el.className = `card archmage ${a.status}`;
  $('.name', el).textContent = `${a.name} the ${a.title}`;
  $('.role', el).innerHTML = `<span>Leader of the party</span>${a.model ? `<span class="badge">${esc(a.model)}</span>` : ''}`;
  $('.bubble', el).textContent = a.thought ?? '…';
  $('.activity', el).textContent = a.activity ?? (a.status === 'thinking' ? 'Pondering…' : a.status === 'waiting' ? 'Awaiting dispatches' : '');
  $('.status', el).textContent = { thinking: 'Thinking', waiting: 'Listening', done: 'At rest', idle: 'At rest' }[a.status] ?? a.status;
  $('.cost', el).textContent = money(a.costUsd);
  $('[data-msg-arch]', el).classList.toggle('hidden', !ACTIVE.has(q.status));
}

// ── party cards ──

function renderParty() {
  const q = G.q, party = $('#party');
  if (!q || !party) return;
  party.classList.toggle('hidden', q.status === 'awaiting-approval' && !q.agents.length);
  for (const a of q.agents) {
    let el = G.cards.get(a.id);
    if (!el) {
      el = document.createElement('div');
      el.innerHTML = `
        <div class="portrait"></div><span class="status"></span>
        <div class="name"></div><div class="role"></div>
        <div class="task"></div>
        <div class="question hidden"><div class="q"></div><textarea placeholder="Your answer…"></textarea><button class="btn small gold">Answer</button></div>
        <div class="report"></div>
        <div class="activity"></div>
        <div class="runebar"><div class="fill"></div><div class="ticks"></div><span class="pct"></span></div>
        <div class="foot"><span class="cost"></span><span>
          <button class="icon-btn" data-act="message" title="Send a message">✉</button>
          <button class="icon-btn" data-act="recall" title="Recall this agent">✕</button>
        </span></div>`;
      el.dataset.id = a.id;
      $('.portrait', el).onclick = () => openAgent(a.id);
      $('.task', el).onclick = () => openAgent(a.id);
      $('.name', el).onclick = () => openAgent(a.id);
      $('[data-act=message]', el).onclick = () => messageAgent(a.id);
      $('[data-act=recall]', el).onclick = () => recallAgent(a.id);
      $('.question .btn', el).onclick = () => {
        const text = $('.question textarea', el).value.trim();
        if (text) answerAgent(a.id, text).then(() => { $('.question textarea', el).value = ''; });
      };
      party.append(el);
      G.cards.set(a.id, el);
    }
    updateCard(el, a);
  }
  requestAnimationFrame(drawThreads);
}

function updateCard(el, a) {
  const r = role(a.role);
  el.className = `card ${a.status}`;
  setPortrait($('.portrait', el), { seed: a.name, role: r, status: a.status, style: style(), size: 220 });
  $('.status', el).textContent = AGENT_WORD[a.status] ?? a.status;
  $('.status', el).className = `status ${a.status}`;
  $('.name', el).textContent = a.name;
  const invented = G.q.roles?.[a.role] && !G.roles[a.role];
  $('.role', el).innerHTML = `<span>${esc(a.title)}</span>${invented ? '<span class="badge new">new role</span>' : ''}`;
  $('.task', el).textContent = a.task;
  $('.task', el).title = a.task;
  const qb = $('.question', el);
  qb.classList.toggle('hidden', a.status !== 'blocked' || !a.question);
  $('.q', qb).textContent = a.question ? `“${a.question}”` : '';
  const rep = a.status === 'done' || a.status === 'failed' ? a.result : a.lastReport;
  $('.report', el).innerHTML = rep ? `${a.phase && a.status !== 'done' ? `<span class="phase">${esc(a.phase)}:</span> ` : ''}${esc(firstLines(rep))}` : '';
  $('.activity', el).textContent = a.activity ?? '';
  $('.fill', el).style.width = `${a.status === 'done' ? 100 : a.percent ?? 0}%`;
  $('.pct', el).textContent = `${a.status === 'done' ? 100 : a.percent ?? 0}%`;
  $('.cost', el).textContent = money(a.costUsd);
  const finished = ['done', 'failed', 'cancelled', 'interrupted'].includes(a.status);
  $('[data-act=recall]', el).classList.toggle('hidden', finished || !ACTIVE.has(G.q.status));
  $('[data-act=message]', el).classList.toggle('hidden', ['cancelled', 'interrupted'].includes(a.status) || !ACTIVE.has(G.q.status));
}

const firstLines = (s) => String(s).replace(/[#*`]/g, '').split('\n').filter((l) => l.trim()).slice(0, 4).join(' ');

// ── threads and orbs ──

function centerOf(el, box) {
  const r = el.getBoundingClientRect();
  return { x: r.left - box.left + r.width / 2, top: r.top - box.top, bottom: r.bottom - box.top };
}

function drawThreads() {
  const svg = $('#threads'), council = $('#council'), arch = $('#archmage-card');
  if (!svg || !G.q) return;
  const box = council.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const from = centerOf(arch, box);
  const seen = new Set();
  for (const a of G.q.agents) {
    const card = G.cards.get(a.id);
    if (!card) continue;
    const to = centerOf(card, box);
    const y1 = from.bottom, y2 = to.top, dy = Math.max(30, y2 - y1);
    const d = `M ${from.x} ${y1} C ${from.x} ${y1 + dy * 0.6}, ${to.x} ${y2 - dy * 0.6}, ${to.x} ${y2}`;
    let p = G.threads.get(a.id);
    if (!p) {
      p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      svg.append(p);
      G.threads.set(a.id, p);
    }
    p.setAttribute('d', d);
    p.setAttribute('class', `thread ${a.status}`);
    seen.add(a.id);
  }
  for (const [id, p] of G.threads) if (!seen.has(id)) { p.remove(); G.threads.delete(id); }
}

/** A dispatch orb travelling along an agent's thread: 'up' to the Archmage, 'down' to the agent. */
function sendOrb(agentId, dir) {
  const path = G.threads.get(agentId), svg = $('#threads');
  if (!path || !svg || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const len = path.getTotalLength();
  const orb = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  orb.setAttribute('r', '5');
  orb.setAttribute('class', 'orb');
  svg.append(orb);
  const t0 = performance.now(), dur = 1100;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    const pt = path.getPointAtLength(dir === 'up' ? len * (1 - e) : len * e);
    orb.setAttribute('cx', pt.x);
    orb.setAttribute('cy', pt.y);
    if (k < 1) requestAnimationFrame(step);
    else {
      orb.remove();
      const target = dir === 'up' ? $('#archmage-card') : G.cards.get(agentId);
      target?.classList.add('flash');
      setTimeout(() => target?.classList.remove('flash'), 700);
    }
  };
  requestAnimationFrame(step);
}

// ── plan review ──

function renderPlan() {
  const q = G.q, slot = $('#plan-slot');
  if (!q || !slot) return;
  if (q.status !== 'awaiting-approval' || !q.plan) { slot.innerHTML = ''; G.planKey = null; renderParty(); return; }
  const key = q.plan.proposedAt;
  if (G.planKey !== key) { G.planKey = key; G.planDraft = q.plan.agents.map((m) => ({ ...m })); }
  const roleIds = [...Object.keys(G.roles).filter((id) => !G.roles[id].orchestrator), ...Object.keys(q.roles ?? {}).filter((id) => !G.roles[id])];
  slot.innerHTML = `
    <div class="plan">
      <h3>The Archmage proposes a party</h3>
      <p>${esc(q.plan.summary ?? '')}</p>
      <div class="party" id="contracts"></div>
      <div class="plan-actions">
        <button class="btn gold" data-dispatch>Dispatch the party</button>
        <button class="btn" data-replan>Ask for a different plan</button>
      </div>
    </div>`;
  const box = $('#contracts');
  G.planDraft.forEach((m, i) => {
    const el = document.createElement('div');
    el.className = 'card contract';
    el.innerHTML = `
      <div class="portrait"></div>
      <label>Role <select>${roleIds.map((id) => `<option value="${esc(id)}" ${id === m.role ? 'selected' : ''}>${esc(role(id).title ?? id)}${G.roles[id] ? '' : ' (new)'}</option>`).join('')}</select></label>
      <label>Task <textarea>${esc(m.task)}</textarea></label>
      <div class="foot"><span class="muted small">${esc(role(m.role).blurb ?? role(m.role).prompt?.slice(0, 80) ?? '')}</span><button class="icon-btn" title="Remove">✕</button></div>`;
    const paint = () => setPortrait($('.portrait', el), { seed: `${q.id}-${i}`, role: role(m.role), status: 'queued', style: style(), size: 200 });
    paint();
    $('select', el).onchange = (e) => { m.role = e.target.value; paint(); };
    $('textarea', el).oninput = (e) => { m.task = e.target.value; };
    $('.icon-btn', el).onclick = () => { G.planDraft.splice(i, 1); G.planKey = key; renderPlan(); };
    box.append(el);
  });
  if (G.planDraft.length < q.maxAgents) {
    const add = document.createElement('div');
    add.className = 'card contract add';
    add.textContent = '+ Add a member';
    add.onclick = () => { G.planDraft.push({ role: roleIds[0], task: '' }); renderPlan(); };
    box.append(add);
  }
  $('[data-dispatch]', slot).onclick = async (e) => {
    e.target.disabled = true;
    try { await api('POST', `/api/quests/${q.id}/plan/approve`, { agents: G.planDraft }); } catch (err) { toast(err.message); e.target.disabled = false; }
  };
  $('[data-replan]', slot).onclick = async () => {
    const text = await askText('Ask for a different plan', 'Tell the Archmage what to change; it will propose again.');
    if (text) api('POST', `/api/quests/${q.id}/message`, { text: `Please revise the plan and call propose_plan again: ${text}` }).catch((e) => toast(e.message));
  };
}

// ── the dispatch scroll ──

function whoLabel(who) {
  if (who === 'archmage') return G.q.archmage ? `${G.q.archmage.name}` : 'Archmage';
  if (who === 'you') return 'You';
  if (who === 'guild') return 'The Guild';
  const a = G.q.agents.find((x) => x.id === who);
  return a ? a.name : who;
}

function keep(e) {
  if (G.filter === 'reports') return ['report', 'question', 'done', 'failed'].includes(e.kind);
  if (G.filter === 'archmage') return e.who === 'archmage';
  if (G.filter === 'you') return e.who === 'you';
  return true;
}

function renderLog() {
  const ol = $('#log');
  if (!ol) return;
  const entries = G.q.log;
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
  for (; G.logCount < entries.length; G.logCount++) {
    const e = entries[G.logCount];
    if (!keep(e)) continue;
    const li = document.createElement('li');
    li.className = `kind-${e.kind}`;
    const to = e.to ? ` → ${esc(e.to === 'archmage' ? whoLabel('archmage') : whoLabel(e.to))}` : '';
    const label = { report: `${e.percent ?? ''}%${e.phase ? ` · ${esc(e.phase)}` : ''}`, question: 'asks', answer: 'answers', done: 'returns', failed: 'falls', say: 'says', action: '', message: 'says', system: '' }[e.kind] ?? '';
    li.innerHTML = `<div class="who"></div><div><div class="head"><b>${esc(whoLabel(e.who))}</b>${to} ${label} · ${time(e.ts)}</div><div class="text"></div></div>`;
    $('.text', li).textContent = e.text;
    const w = $('.who', li);
    if (e.who === 'archmage' && G.q.archmage) setPortrait(w, { seed: G.q.archmage.name, role: role(G.q.archmage.role), status: 'waiting', style: 'illustrated', size: 64 });
    else if (e.who === 'you') w.textContent = '✋';
    else if (e.who === 'guild') w.textContent = '✦';
    else {
      const a = G.q.agents.find((x) => x.id === e.who);
      if (a) { setPortrait(w, { seed: a.name, role: role(a.role), status: 'queued', style: 'illustrated', size: 64 }); w.style.cursor = 'pointer'; w.onclick = () => openAgent(a.id); }
    }
    if (e.kind === 'done' || e.kind === 'failed') $('.text', li).onclick = () => openAgent(e.who);
    ol.append(li);
    if (G.logCount === entries.length - 1 && (e.who === 'archmage' || e.who === 'you') && e.to && e.to !== 'archmage') sendOrb(e.to, 'down');
    if (G.logCount === entries.length - 1 && ['done', 'failed', 'question'].includes(e.kind)) sendOrb(e.who, 'up');
  }
  if (atBottom) ol.scrollTop = ol.scrollHeight;
}

// ── chronicle ──

function renderChronicle() {
  const q = G.q, el = $('#chronicle');
  if (!q || !el) return;
  const show = !!q.chronicle;
  $('#lower').classList.toggle('no-chronicle', !show);
  el.classList.toggle('hidden', !show);
  if (!show) return;
  let html = `<h3 class="head">The Chronicle</h3><div class="md">${markdown(q.chronicle)}</div>`;
  if (q.diff) {
    html += `<div class="diff"><h3>Changes on <code>${esc(q.repo.branch)}</code></h3>
      <p class="muted small">Review with <code>git log ${esc(q.repo.base.slice(0, 8))}..${esc(q.repo.branch)}</code> in <code>${esc(q.repo.root)}</code>, then merge it yourself.</p>
      <pre>${esc(q.diff.stat)}</pre>
      <details><summary>Full diff${q.diff.truncated ? ' (truncated)' : ''}</summary><pre>${colourDiff(q.diff.patch)}</pre></details></div>`;
  }
  el.innerHTML = html;
}

function colourDiff(patch) {
  return patch.split('\n').map((l) => {
    const e = esc(l);
    if (l.startsWith('diff --git')) return `<span class="file">${e}</span>`;
    if (l.startsWith('@@')) return `<span class="hunk">${e}</span>`;
    if (l.startsWith('+') && !l.startsWith('+++')) return `<span class="add">${e}</span>`;
    if (l.startsWith('-') && !l.startsWith('---')) return `<span class="del">${e}</span>`;
    return e;
  }).join('\n');
}

// ── agent actions and detail ──

async function messageAgent(id) {
  const a = G.q.agents.find((x) => x.id === id);
  const done = a.status === 'done' || a.status === 'failed';
  const text = await askText(`Message ${a.name}`, done ? `${a.name} has returned; your message wakes them and they report again.` : `${a.name} sees it at their next progress report.`);
  if (text) api('POST', `/api/quests/${G.q.id}/agents/${id}/message`, { text }).then((r) => toast(r.text)).catch((e) => toast(e.message));
}

function answerAgent(id, text) {
  return api('POST', `/api/quests/${G.q.id}/agents/${id}/answer`, { text }).catch((e) => toast(e.message));
}

function recallAgent(id) {
  const a = G.q.agents.find((x) => x.id === id);
  if (confirm(`Recall ${a.name} the ${a.title}?`)) api('POST', `/api/quests/${G.q.id}/agents/${id}/cancel`).catch((e) => toast(e.message));
}

function openAgent(id) {
  const q = G.q, a = q.agents.find((x) => x.id === id);
  if (!a) return;
  const r = role(a.role);
  const invented = q.roles?.[a.role] && !G.roles[a.role];
  const reports = q.log.filter((e) => e.who === a.id || e.to === a.id);
  $('#agent-detail-body').innerHTML = `
    <div class="detail">
      <div><div class="portrait"></div>
        <p class="muted small">${esc(r.describe ?? '')}${r.model ? ` · ${esc(r.model)}` : ''} · tools: ${esc(Array.isArray(r.tools) ? r.tools.join(', ') : r.tools ?? 'read')}</p></div>
      <div>
        <h2>${esc(a.name)}</h2>
        <div class="role" style="color:var(--gold)">${esc(a.title)} · ${AGENT_WORD[a.status] ?? a.status} · ${a.percent ?? 0}% ${money(a.costUsd) ? `· ${money(a.costUsd)}` : ''}</div>
        <div class="section"><h4>Task</h4><div class="md">${markdown(a.task)}</div></div>
        ${a.question ? `<div class="section question"><h4>Asks</h4>${esc(a.question)}</div>` : ''}
        ${a.branch ? `<div class="section"><h4>Branch</h4><code>${esc(a.branch)}</code> · ${a.commits ?? 0} commit(s)</div>` : ''}
        ${a.result ? `<div class="section"><h4>Final report</h4><div class="md">${markdown(a.result)}</div></div>` : ''}
        <div class="section"><h4>Dispatches</h4><div class="reports">${reports.map((e) => `<div><span class="muted small">${time(e.ts)} ${esc(whoLabel(e.who))}${e.to ? ` → ${esc(whoLabel(e.to))}` : ''}${e.percent !== undefined ? ` · ${e.percent}%` : ''}</span><br>${esc(e.text.slice(0, 600))}</div>`).join('') || '<span class="muted">None yet.</span>'}</div></div>
        <div class="detail-actions">
          ${ACTIVE.has(q.status) && !['cancelled', 'interrupted'].includes(a.status) ? '<button class="btn" data-d="message">Send a message</button>' : ''}
          ${a.status === 'blocked' ? '<button class="btn gold" data-d="answer">Answer</button>' : ''}
          ${ACTIVE.has(q.status) && ['queued', 'working', 'blocked'].includes(a.status) ? '<button class="btn danger" data-d="recall">Recall</button>' : ''}
          ${invented ? '<button class="btn" data-d="save-role">Save this role to the catalog</button>' : ''}
        </div>
      </div>
    </div>`;
  const body = $('#agent-detail-body');
  setPortrait($('.portrait', body), { seed: a.name, role: r, status: a.status, style: style(), size: 320 });
  const on = (k, fn) => { const b = $(`[data-d=${k}]`, body); if (b) b.onclick = fn; };
  on('message', () => { $('#agent-detail').close(); messageAgent(a.id); });
  on('answer', async () => {
    $('#agent-detail').close();
    const text = await askText(`Answer ${a.name}`, a.question);
    if (text) answerAgent(a.id, text);
  });
  on('recall', () => { $('#agent-detail').close(); recallAgent(a.id); });
  on('save-role', () => api('POST', `/api/roles/${a.role}`, { quest: q.id }).then(() => { toast(`${a.title} is now in the catalog.`); $('#agent-detail').close(); renderParty(); }).catch((e) => toast(e.message)));
  $('#agent-detail').showModal();
}

// ───────────── dialogs ─────────────

function askText(title, hint = '') {
  const dlg = $('#prompt'), form = $('#prompt-form');
  $('#prompt-title').textContent = title;
  $('#prompt-hint').textContent = hint ?? '';
  form.reset();
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? form.text.value.trim() || null : null);
  });
}

function openNewQuest() {
  const dlg = $('#new-quest'), form = $('#new-quest-form');
  form.cwd.value = form.cwd.value || G.settings.lastCwd || '';
  form.maxAgents.value = G.settings.maxAgents ?? 6;
  $('#new-quest-error').textContent = '';
  dlg.showModal();
  form.goal.focus();
}

$('#new-quest-form').addEventListener('submit', async (e) => {
  const form = e.target;
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const btn = $('#new-quest-submit');
  btn.disabled = true;
  $('#new-quest-error').textContent = '';
  try {
    const q = await api('POST', '/api/quests', {
      goal: form.goal.value, cwd: form.cwd.value.trim(), mode: form.mode.value, planning: form.planning.value, maxAgents: Number(form.maxAgents.value),
    });
    form.goal.value = '';
    $('#new-quest').close();
    location.hash = `#/quest/${q.id}`;
  } catch (err) {
    $('#new-quest-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function openSettings() {
  const form = $('#settings-form');
  $('#style-select').innerHTML = STYLES.map((s) => `<option ${s === style() ? 'selected' : ''}>${s}</option>`).join('');
  for (const k of ['maxConcurrent', 'maxAgents', 'batchSeconds']) form[k].value = G.settings[k];
  $('#roles-json').value = JSON.stringify(G.roles, null, 2);
  $('#roles-error').textContent = '';
  renderGallery(style());
  $('#style-select').onchange = (e) => renderGallery(e.target.value);
  $('#settings').showModal();
}

function renderGallery(st) {
  const g = $('#role-gallery');
  g.innerHTML = '';
  for (const [id, r] of Object.entries(G.roles)) {
    const tile = document.createElement('div');
    tile.className = 'role-tile';
    tile.innerHTML = `<div class="faces"><div></div><div></div></div>
      <div class="t">${esc(r.title ?? id)}</div>
      <div class="muted">${esc(r.blurb ?? '')}</div>
      <div class="small"><code>${esc(id)}</code> · ${esc(r.model ?? 'default model')} · ${r.orchestrator ? 'orchestrator' : esc(Array.isArray(r.tools) ? 'custom tools' : r.tools ?? 'read')}</div>`;
    const [f1, f2] = tile.querySelectorAll('.faces div');
    setPortrait(f1, { seed: r.name ?? `${id}-Aster`, role: r, status: 'waiting', style: st, size: 160 });
    setPortrait(f2, { seed: `${id}-Bryn`, role: r, status: 'done', style: st, size: 160 });
    if (r.orchestrator) f2.parentElement.style.gridTemplateColumns = '1fr', f2.remove();
    g.append(tile);
  }
}

$('#settings-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  const f = e.target;
  try {
    G.settings = await api('PUT', '/api/settings', {
      style: f.style.value, maxConcurrent: Number(f.maxConcurrent.value), maxAgents: Number(f.maxAgents.value), batchSeconds: Number(f.batchSeconds.value),
    });
    if (G.q) { renderArchmage(); renderParty(); renderPlan(); } else renderHall();
  } catch (err) { toast(err.message); }
});

$('#roles-save').onclick = async () => {
  try {
    G.roles = await api('PUT', '/api/roles', JSON.parse($('#roles-json').value));
    $('#roles-error').textContent = 'Saved.';
    renderGallery($('#style-select').value);
  } catch (err) { $('#roles-error').textContent = err.message; }
};

for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => b.closest('dialog').close();
$('#new-quest-btn').onclick = openNewQuest;
$('#settings-btn').onclick = openSettings;
document.addEventListener('keydown', (e) => {
  if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) openNewQuest();
});

connectGlobal();
