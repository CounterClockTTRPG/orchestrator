// Guild web UI: the hall of quests and the live council table.

import { setPortrait, setPortraitTheme, setPortraitMotion, motionFor, STYLES } from './portraits.js';
import { markdown, esc } from './markdown.js';
import { theme, themedRole, THEMES, presentationOfName } from './themes.js';
import { agentElapsed, questElapsed, duration, ago } from './elapsed.js';
import { agentTitle, memberTitle, sameAsTitle } from './titles.js';

const $ = (sel, el = document) => el.querySelector(sel);
const ACTIVE = new Set(['planning', 'awaiting-approval', 'questing']);
// The theme only changes wording, colours and looks (web/themes.js).
const T = () => theme(G.settings.theme);
const W = () => T().words;
const questWord = (st) => W().questStatus[st] ?? st;
const agentWord = (st) => W().agentStatus[st] ?? st;

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
// A clock time with how long ago it was ("14:02:11 · 10 minutes ago"); the relative part is kept fresh below.
const stampText = (ts) => (ts ? `${time(ts)} · ${ago(ts)}` : '');
const stamp = (ts) => (ts ? `<time datetime="${esc(ts)}" title="${esc(new Date(ts).toLocaleString())}">${stampText(ts)}</time>` : '');
setInterval(() => { for (const el of document.querySelectorAll('time[datetime]')) el.textContent = stampText(el.getAttribute('datetime')); }, 30_000);
const role = (id, q = G.q) => themedRole(G.settings.theme, id, q?.roles?.[id] ?? G.roles[id] ?? { title: id, describe: 'human adventurer' });
const archRole = () => {
  const [id, r] = Object.entries(G.roles).find(([, x]) => x.orchestrator) ?? ['archmage', { describe: 'old human wizard with a long white beard', name: 'Velothar' }];
  return { ...themedRole(G.settings.theme, id, r), name: G.settings.theme && G.settings.theme !== 'fantasy' ? T().leader.name : r.name };
};
const fullName = (name, title) => T().fullName(name, title);
// Who is talking right now (the Archmage when it speaks, an agent when it reports), and their line.
// The portrait lip-syncs the line for a few seconds, then goes back to its state's animation.
const talking = new Map(); // id ('archmage' or an agent id) -> { text, timer }
function speak(id, text) {
  text = String(text ?? '').replace(/[#*`_>\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  clearTimeout(talking.get(id)?.timer);
  const ms = Math.max(2500, Math.min(9000, 1200 + Math.min(text.length, 140) * 55));
  talking.set(id, { text, timer: setTimeout(() => { talking.delete(id); repaint(id); }, ms) });
  repaint(id);
}
const line = (id) => talking.get(id)?.text;
function repaint(id) {
  if (!G.q) return;
  if (id === 'archmage') return renderArchmage();
  const a = G.q.agents.find((x) => x.id === id), el = G.cards.get(id);
  if (a && el) updateCard(el, a);
}
const leaderState = (a) => (a.status === 'waiting' ? 'listening' : a.status);

// An agent's portrait presentation, matching its name (older agents: read from the name where it tells).
const pres = (a, q = G.q) => a.presentation ?? presentationOfName(q?.theme ?? G.settings.theme, a.name);

/** Dress the page in the current theme: colours and fonts (CSS), portraits, and the static wording. */
function applyTheme() {
  document.documentElement.dataset.theme = THEMES[G.settings.theme] ? G.settings.theme : 'fantasy';
  setPortraitTheme(T().portrait);
  setPortraitMotion(G.settings.animate);
  for (const el of document.querySelectorAll('[data-w]')) el.textContent = W()[el.dataset.w];
  for (const el of document.querySelectorAll('[data-w-placeholder]')) el.placeholder = W()[el.dataset.wPlaceholder];
  $('.sigil').textContent = W().sigil;
}
const style = () => G.settings.style ?? 'painterly';

function toast(msg) {
  const el = Object.assign(document.createElement('div'), { textContent: msg });
  Object.assign(el.style, { position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: 'var(--panel2)', border: '1px solid var(--gold-soft)', color: 'var(--ink)', padding: '0.6rem 1rem', borderRadius: '8px', zIndex: 99, maxWidth: 'calc(100vw - 32px)' });
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
    applyTheme();
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
  es.addEventListener('settings', (e) => {
    const { theme: before, animate } = G.settings;
    G.settings = JSON.parse(e.data).settings;
    if (G.settings.theme !== before || G.settings.animate !== animate) { applyTheme(); rerender(); }
  });
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
  $('#queue-info').textContent = running || waiting ? `${running}/${G.settings.maxConcurrent} ${W().agentsAfield}${waiting ? `, ${waiting} waiting` : ''}` : '';
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
      <h1>${esc(W().hallTitle)}</h1>
      <p>${esc(W().hallLead)}</p>
      <button class="btn gold" data-new>${esc(W().post)}</button>
    </div>
    ${list.length ? `<div class="quest-grid">${list.map((q) => `
      <a class="quest-card" href="#/quest/${q.id}">
        <div class="meta"><span class="dot ${q.status}"></span><span class="status-word">${questWord(q.status)}</span>
          ${q.mode === 'edit' ? '<span class="badge edit">edit</span>' : '<span class="badge">read-only</span>'}
          <span>${when(q.createdAt)}</span><span>${money(q.costUsd)}</span><span>${duration(questElapsed(q))}</span></div>
        <div class="goal">${esc(q.goal)}</div>
        <div class="meta"><code>${esc(q.cwd)}</code></div>
        <div class="mini-party" data-quest="${q.id}"></div>
      </a>`).join('')}</div>`
      : `<div class="empty"><div class="mini" style="width:160px;height:160px;margin:0 auto 1rem;border-radius:50%;overflow:hidden" id="hall-arch"></div>
         <p>${esc(W().hallEmpty)}</p></div>`}`;
  $('[data-new]', $('#view')).onclick = openNewQuest;
  const ha = $('#hall-arch');
  if (ha) setPortrait(ha, { seed: ar.name ?? 'Velothar', role: ar, status: 'waiting', style: style(), size: 200 });
  for (const el of document.querySelectorAll('.mini-party')) {
    const q = G.quests.get(el.dataset.quest);
    for (const a of q.party.slice(0, 10)) {
      const d = document.createElement('div');
      d.className = 'mini';
      d.title = `${a.name}: ${agentTitle(a)} (${a.status})`;
      el.append(d);
      setPortrait(d, { seed: a.name, role: role(a.role, null), status: a.status, style: 'illustrated', size: 64, presentation: pres(a, q) });
    }
  }
}

// ───────────── a quest ─────────────

function openQuest(id) {
  closeQuest();
  $('#view').innerHTML = `<p class="muted">${esc(W().opening)}</p>`;
  const es = new EventSource(`/api/quests/${id}/events`);
  G.es = es;
  es.addEventListener('snapshot', (e) => { G.q = JSON.parse(e.data); buildQuest(); });
  es.addEventListener('quest', (e) => { const d = JSON.parse(e.data); G.q.status = d.status; G.q.finishedAt = d.finishedAt; G.q.pausedMs = d.pausedMs; renderHead(); renderPlan(); renderArchmage(); renderTabs(); });
  es.addEventListener('archmage', (e) => {
    const before = G.q.archmage?.thought;
    G.q.archmage = JSON.parse(e.data).archmage;
    if (G.q.archmage.thought && G.q.archmage.thought !== before) speak('archmage', G.q.archmage.thought);
    else renderArchmage();
  });
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
  es.addEventListener('log', (e) => { G.q.log.push(JSON.parse(e.data).entry); renderLog(); renderThread(); });
  es.addEventListener('attachment', (e) => {
    (G.q.attachments ??= []).push(JSON.parse(e.data).attachment);
    renderParty();
    renderArchmage();
  });
  es.addEventListener('report', (e) => { const d = JSON.parse(e.data); sendOrb(d.agentId, 'up'); if (d.phase !== 'blocked') speak(d.agentId, d.message); });
  es.addEventListener('plan', (e) => { const d = JSON.parse(e.data); G.q.plan = d.plan; G.q.roles = d.roles; renderPlan(); });
  es.addEventListener('roles', (e) => { G.q.roles = JSON.parse(e.data).roles; renderParty(); });
  es.addEventListener('chronicle', (e) => { const d = JSON.parse(e.data); G.q.chronicle = d.chronicle; G.q.diff = d.diff; G.q.delivery = d.delivery; renderChronicle(); });
  es.onerror = () => { if (!G.q) $('#view').innerHTML = `<div class="empty">${esc(W().notFound)}</div>`; };
}

function buildQuest() {
  G.cards.clear();
  G.threads.clear();
  G.logCount = 0;
  G.threadCount = 0;
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
            <div class="bubble"><div class="md bubble-body"></div><button class="more hidden" type="button">Show more</button></div>
            <div class="activity"></div>
            <div class="files"></div>
            <div class="foot"><span class="cost"></span></div>
          </div>
          <div class="converse">
            <h4>${esc(W().council)}</h4>
            <ol id="thread"></ol>
            <form class="composer" id="composer">
              <textarea name="text" rows="2"></textarea>
              <button class="btn small gold">Send</button>
            </form>
          </div>
          <span class="status"></span>
        </div></div>
        <div id="plan-slot"></div>
        <div class="party" id="party"></div>
      </div>
      <div class="lower" id="lower">
        <div class="scroll">
          <h3>${esc(W().scroll)}</h3>
          <div class="filters">
            ${['all', 'reports', 'archmage', 'you'].map((f) => `<button class="btn small ${G.filter === f ? 'gold' : 'ghost'}" data-filter="${f}">${{ all: 'Everything', reports: 'Reports', archmage: role(G.q.archmage?.role ?? 'archmage').title ?? 'Leader', you: 'You' }[f]}</button>`).join('')}
          </div>
          <ol id="log"></ol>
        </div>
        <div class="chronicle" id="chronicle"></div>
      </div>
    </section>`;
  const composer = $('#composer');
  composer.onsubmit = (ev) => {
    ev.preventDefault();
    const text = composer.text.value.trim();
    if (!text) return;
    composer.text.value = '';
    api('POST', `/api/quests/${G.q.id}/message`, { text }).catch((e) => { composer.text.value = text; toast(e.message); });
  };
  composer.text.onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); composer.requestSubmit(); }
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
      <p class="goal ${G.goalOpen ? 'open' : ''}">${esc(q.goal)}</p>
      <button class="goal-more hidden" type="button">${G.goalOpen ? 'Show less' : esc(W().fullGoal)}</button>
      <div class="meta">
        <span class="dot ${q.status}"></span><span class="status-word">${questWord(q.status)}</span>
        ${q.mode === 'edit' ? '<span class="badge edit">edit mode</span>' : '<span class="badge">read-only</span>'}
        <span class="badge">${q.planning === 'review' ? 'reviewed plan' : 'automatic plan'}</span>
        <code>${esc(q.cwd)}</code>
        ${q.repo?.branch ? `<span>branch <code>${esc(q.repo.branch)}</code>${q.repo.target ? ` → <code>${esc(q.repo.target)}</code>` : ''}</span>` : ''}
        ${q.checkIn ? `<span class="badge" title="${esc(q.checkIn)}">check-ins</span>` : ''}
        <span>${q.agents.length} ${esc(W().inParty)}${working ? `, ${working} ${esc(W().afield)}` : ''}</span>
        <span>${money(total)}</span>
        <span class="elapsed" title="Running time">${duration(questElapsed(q))}</span>
        <span>${when(q.createdAt)}</span>
      </div>
    </div>
    <div class="row" style="flex:none">
      ${q.status === 'interrupted' ? '<button class="btn gold" data-resume-quest title="Carry on where the server stopped">Resume</button>' : ''}
      ${active ? `<button class="btn danger" data-cancel-quest>${esc(W().abandon)}</button>` : ''}
    </div>`;
  const goal = $('#q-head .goal'), more = $('#q-head .goal-more');
  more.classList.toggle('hidden', !G.goalOpen && goal.scrollHeight <= goal.clientHeight + 2);
  more.onclick = () => { G.goalOpen = !G.goalOpen; renderHead(); };
  const c = $('[data-cancel-quest]');
  if (c) c.onclick = () => { if (confirm(W().abandonConfirm)) api('POST', `/api/quests/${q.id}/cancel`).catch((e) => toast(e.message)); };
  const r = $('[data-resume-quest]');
  if (r) r.onclick = () => { r.disabled = true; api('POST', `/api/quests/${q.id}/resume`).catch((e) => { r.disabled = false; toast(e.message); }); };
}

// Running times tick once a second while the quest is open.
setInterval(() => {
  const q = G.q;
  if (!q || !ACTIVE.has(q.status)) return;
  const head = $('#q-head .elapsed');
  if (head) head.textContent = duration(questElapsed(q));
  for (const a of q.agents) {
    const el = G.cards.get(a.id);
    if (el) $('.elapsed', el).textContent = duration(agentElapsed(a));
  }
}, 1000);

function renderArchmage() {
  const q = G.q, a = q?.archmage, el = $('#archmage-card');
  if (!a || !el) return;
  const r = role(a.role);
  setPortrait($('.portrait', el), { seed: a.name, role: r, status: a.status, style: style(), size: 220, emotes: motionFor('leader', leaderState(a), line('archmage')), say: line('archmage') });
  el.className = `card archmage ${a.status}`;
  $('.name', el).textContent = fullName(a.name, r.title ?? a.title);
  $('.role', el).innerHTML = `<span>${esc(W().leaderOf)}</span>${a.model ? `<span class="badge">${esc(a.model)}</span>` : ''}`;
  renderBubble($('.bubble', el), a.thought ?? '…');
  $('.activity', el).textContent = a.activity ?? (a.status === 'thinking' ? W().thinking : a.status === 'waiting' ? W().listening : '');
  $('.status', el).textContent = W().leaderStatus[a.status] ?? a.status;
  $('.cost', el).textContent = money(a.costUsd);
  el.classList.toggle('asking', !!a.question);
  renderFiles($('.files', el), 'archmage');
  const composer = $('#composer');
  composer.classList.toggle('hidden', !ACTIVE.has(q.status));
  composer.text.placeholder = a.question ? `Answer ${a.name}'s question…` : W().speak;
  renderThread();
}

// ── council thread: the conversation between the human and the Archmage ──

const inThread = (e) => (e.who === 'you' && e.to === 'archmage') || (e.who === 'archmage' && e.to === 'you');

function renderThread() {
  const ol = $('#thread'), q = G.q;
  if (!ol || !q) return;
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
  for (; G.threadCount < q.log.length; G.threadCount++) {
    const e = q.log[G.threadCount];
    if (!inThread(e)) continue;
    const li = document.createElement('li');
    li.className = `from-${e.who} kind-${e.kind}`;
    const label = e.who === 'you' ? 'You' : e.kind === 'ask' ? `${whoLabel('archmage')} asks you` : whoLabel('archmage');
    li.innerHTML = `<div class="head"><b>${esc(label)}</b> · ${stamp(e.ts)}</div><div class="md"></div>`;
    $('.md', li).innerHTML = markdown(e.text);
    if (e.attachment) $('.md', li).replaceChildren(fileChip(e.attachment, true));
    ol.append(li);
  }
  let hint = $('.thread-hint', ol);
  const last = q.log.filter(inThread).at(-1);
  const pondering = !!q.archmage?.replying;
  const text = pondering ? `${whoLabel('archmage')} ${W().pondering}` : !last ? W().threadEmpty : '';
  if (text && !hint) { hint = Object.assign(document.createElement('li'), { className: 'thread-hint muted' }); }
  if (hint) { hint.textContent = text; if (text) ol.append(hint); else hint.remove(); }
  if (atBottom || last?.who === 'you') ol.scrollTop = ol.scrollHeight;
}

// The bubble shows the Archmage's latest words as markdown, clamped with a Show more toggle when long.
function renderBubble(b, text) {
  const body = $('.bubble-body', b), more = $('.more', b);
  if (b.dataset.src !== text) {
    b.dataset.src = text;
    body.innerHTML = markdown(text);
  }
  more.onclick = () => { G.bubbleOpen = !G.bubbleOpen; renderBubble(b, text); };
  b.classList.toggle('open', !!G.bubbleOpen);
  more.textContent = G.bubbleOpen ? 'Show less' : 'Show more';
  more.classList.toggle('hidden', !G.bubbleOpen && body.scrollHeight <= body.clientHeight + 2);
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
        <div class="job"></div>
        <div class="task"></div>
        <div class="after hidden"></div>
        <div class="question hidden"><div class="q"></div><textarea placeholder="Your answer…"></textarea><button class="btn small gold">Answer</button></div>
        <div class="report"></div>
        <div class="activity"></div>
        <div class="files"></div>
        <div class="runebar"><div class="fill"></div><div class="ticks"></div><span class="pct"></span></div>
        <div class="foot"><span class="cost"><span class="money"></span> <span class="elapsed" title="Running time"></span></span><span>
          <button class="icon-btn" data-act="details" title="Show the full task and reports">⤢</button>
          <button class="icon-btn" data-act="message" title="Send a message">✉</button>
          <button class="icon-btn" data-act="recall" title="${esc(W().recallTitle)}">✕</button>
        </span></div>`;
      el.dataset.id = a.id;
      $('.portrait', el).onclick = () => openAgent(a.id);
      $('.task', el).onclick = () => openAgent(a.id);
      $('.job', el).onclick = () => openAgent(a.id);
      $('.report', el).onclick = () => openAgent(a.id);
      $('[data-act=details]', el).onclick = () => openAgent(a.id);
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

// Working cards first, then waiting ones, then the finished: the flex order keeps recruitment order within each group.
const CARD_ORDER = { working: 0, blocked: 0, queued: 1, waiting: 1 };

const LOST = new Set(['failed', 'cancelled', 'interrupted']);

/** "Waits for Hilda, Borin" (or "Built on …" once it set out), each name marked by how that work went. */
function afterLine(a) {
  if (!a.after?.length) return '';
  const names = a.after.map((id) => {
    const d = G.q.agents.find((x) => x.id === id);
    if (!d) return esc(id);
    return `<b class="${LOST.has(d.status) ? 'lost' : ''}" title="${esc(agentWord(d.status))}">${esc(d.name)}${d.status === 'done' ? ' ✓' : ''}</b>`;
  });
  return `${a.status === 'waiting' ? (a.held ? 'Held, waits for' : 'Waits for') : 'Built on'} ${names.join(', ')}`;
}

function updateCard(el, a) {
  const r = role(a.role);
  el.className = `card ${a.status}`;
  el.style.order = CARD_ORDER[a.status] ?? 2;
  setPortrait($('.portrait', el), { seed: a.name, role: r, status: a.status, style: style(), size: 220, presentation: pres(a), emotes: motionFor('agent', a.status, line(a.id)), say: line(a.id) });
  $('.status', el).textContent = agentWord(a.status);
  $('.status', el).className = `status ${a.status}`;
  $('.name', el).textContent = a.name;
  const invented = G.q.roles?.[a.role] && !G.roles[a.role];
  $('.role', el).innerHTML = `<span>${esc(r.title ?? a.title)}</span>${invented ? '<span class="badge new">new role</span>' : ''}`;
  $('.job', el).textContent = agentTitle(a);
  $('.job', el).title = agentTitle(a);
  $('.task', el).textContent = a.task;
  $('.task', el).classList.toggle('hidden', sameAsTitle(a.task, agentTitle(a)));
  $('.task', el).title = a.task;
  const after = afterLine(a);
  $('.after', el).innerHTML = after;
  $('.after', el).classList.toggle('hidden', !after);
  const qb = $('.question', el);
  qb.classList.toggle('hidden', a.status !== 'blocked' || !a.question);
  $('.q', qb).textContent = a.question ? `${a.checkIn ? 'Check-in, needs your decision: ' : ''}“${a.question}”` : '';
  qb.classList.toggle('check-in', !!a.checkIn);
  const rep = a.status === 'done' || a.status === 'failed' ? a.result : a.lastReport;
  $('.report', el).innerHTML = rep ? `${a.phase && a.status !== 'done' ? `<span class="phase">${esc(a.phase)}:</span> ` : ''}${esc(firstLines(rep))}` : '';
  $('.activity', el).textContent = a.activity ?? '';
  $('.fill', el).style.width = `${a.status === 'done' ? 100 : a.percent ?? 0}%`;
  $('.pct', el).textContent = `${a.status === 'done' ? 100 : a.percent ?? 0}%`;
  $('.money', el).textContent = money(a.costUsd);
  $('.elapsed', el).textContent = duration(agentElapsed(a));
  renderFiles($('.files', el), a.id);
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

// The Archmage card spans the party row below it (at least 900px, at most the council's width).
function sizeArchmage() {
  const arch = $('#archmage-card'), cards = [...G.cards.values()].filter((c) => c.isConnected);
  if (!arch) return;
  if (!cards.length) { arch.style.width = ''; return; } // the stylesheet's 900px
  const rects = cards.map((c) => c.getBoundingClientRect());
  const span = Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left));
  arch.style.width = `${Math.max(900, Math.round(span))}px`;
}

function drawThreads() {
  const svg = $('#threads'), council = $('#council'), arch = $('#archmage-card');
  if (!svg || !G.q) return;
  sizeArchmage();
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
  // Dependency links: an arc over the party row from the work waited for to the agent waiting, with an arrowhead.
  for (const a of G.q.agents) {
    const card = G.cards.get(a.id);
    for (const depId of a.after ?? []) {
      const depCard = G.cards.get(depId), dep = G.q.agents.find((x) => x.id === depId);
      if (!card || !depCard || !dep) continue;
      const s = centerOf(depCard, box), t = centerOf(card, box);
      const lift = Math.min(70, 24 + Math.abs(t.x - s.x) * 0.12);
      const d = `M ${s.x} ${s.top} C ${s.x} ${s.top - lift}, ${t.x} ${t.top - lift}, ${t.x} ${t.top - 6}`;
      const id = `dep:${depId}>${a.id}`;
      let p = G.threads.get(id);
      if (!p) {
        p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('marker-end', 'url(#dep-arrow)');
        svg.append(p);
        G.threads.set(id, p);
      }
      p.setAttribute('d', d);
      p.setAttribute('class', `dep ${dep.status === 'done' ? 'met' : LOST.has(dep.status) ? 'lost' : ''}`);
      seen.add(id);
    }
  }
  if (!$('#dep-arrow', svg) && [...seen].some((id) => id.startsWith('dep:'))) {
    svg.insertAdjacentHTML('afterbegin', '<defs><marker id="dep-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="dep-head" d="M0 0 L10 5 L0 10 z"/></marker></defs>');
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
  if (G.planKey !== key) { G.planKey = key; G.planDraft = q.plan.agents.map((m, i) => ({ ...m, key: m.key ?? `t${i + 1}`, after: [...(m.after ?? [])] })); }
  const draft = G.planDraft;
  const freeKey = () => { let n = draft.length + 1; while (draft.some((m) => m.key === `t${n}`)) n++; return `t${n}`; };
  const roleIds = [...Object.keys(G.roles).filter((id) => !G.roles[id].orchestrator), ...Object.keys(q.roles ?? {}).filter((id) => !G.roles[id])];
  slot.innerHTML = `
    <div class="plan">
      <h3>${esc(W().proposes)}</h3>
      <p>${esc(q.plan.summary ?? '')}</p>
      <div class="party" id="contracts"></div>
      <div class="plan-actions">
        <button class="btn gold" data-dispatch>${esc(W().dispatch)}</button>
        <button class="btn" data-replan>${esc(W().replan)}</button>
      </div>
    </div>`;
  const box = $('#contracts');
  G.planDraft.forEach((m, i) => {
    const el = document.createElement('div');
    el.className = 'card contract';
    el.innerHTML = `
      <div class="portrait"></div>
      <label>#${i + 1} · Role <select>${roleIds.map((id) => `<option value="${esc(id)}" ${id === m.role ? 'selected' : ''}>${esc(role(id).title ?? id)}${G.roles[id] ? '' : ' (new)'}</option>`).join('')}</select></label>
      <label>Title <input class="title-in" maxlength="48" value="${esc(m.title ?? '')}" placeholder="${esc(memberTitle({ task: m.task }))}"></label>
      <label>Task <textarea>${esc(m.task)}</textarea></label>
      ${draft.length > 1 ? `<div class="after-pick" title="This member starts once the ticked ones are done, with their reports"><span>After</span>${draft.map((o, j) => (j === i ? '' : `<label><input type="checkbox" value="${esc(o.key)}" ${m.after.includes(o.key) ? 'checked' : ''}>#${j + 1} ${esc(role(o.role).title ?? o.role)}</label>`)).join('')}</div>` : ''}
      <div class="foot"><span class="muted small">${esc(role(m.role).blurb ?? role(m.role).prompt?.slice(0, 80) ?? '')}</span><button class="icon-btn" title="Remove">✕</button></div>`;
    const paint = () => setPortrait($('.portrait', el), { seed: `${q.id}-${i}`, role: role(m.role), status: 'queued', style: style(), size: 200 });
    paint();
    $('select', el).onchange = (e) => { m.role = e.target.value; paint(); };
    $('textarea', el).oninput = (e) => { m.task = e.target.value; $('.title-in', el).placeholder = memberTitle({ task: m.task }); };
    $('.title-in', el).oninput = (e) => { m.title = e.target.value; };
    for (const cb of el.querySelectorAll('.after-pick input')) {
      cb.onchange = () => { m.after = cb.checked ? [...m.after, cb.value] : m.after.filter((k) => k !== cb.value); };
    }
    $('.foot .icon-btn', el).onclick = () => {
      draft.splice(i, 1);
      for (const o of draft) o.after = o.after.filter((k) => k !== m.key);
      G.planKey = key;
      renderPlan();
    };
    box.append(el);
  });
  if (G.planDraft.length < q.maxAgents) {
    const add = document.createElement('div');
    add.className = 'card contract add';
    add.textContent = W().addMember;
    add.onclick = () => { draft.push({ key: freeKey(), role: roleIds[0], title: '', task: '', after: [] }); renderPlan(); };
    box.append(add);
  }
  $('[data-dispatch]', slot).onclick = async (e) => {
    e.target.disabled = true;
    try { await api('POST', `/api/quests/${q.id}/plan/approve`, { agents: G.planDraft }); } catch (err) { toast(err.message); e.target.disabled = false; }
  };
  $('[data-replan]', slot).onclick = async () => {
    const text = await askText(W().replan, W().replanHint);
    if (text) api('POST', `/api/quests/${q.id}/message`, { text: `Please revise the plan and call propose_plan again: ${text}` }).catch((e) => toast(e.message));
  };
}

// ── the dispatch scroll ──

function whoLabel(who) {
  if (who === 'archmage') return G.q.archmage?.name ?? role('archmage').title;
  if (who === 'you') return 'You';
  if (who === 'guild') return W().guildName;
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
    const label = { attach: 'shares a file', ask: 'asks', report: `${e.percent ?? ''}%${e.phase ? ` · ${esc(e.phase)}` : ''}`, question: 'asks', answer: 'answers', done: W().verbs.done, failed: W().verbs.failed, say: 'says', action: '', message: 'says', system: '' }[e.kind] ?? '';
    li.innerHTML = `<div class="who"></div><div><div class="head"><b>${esc(whoLabel(e.who))}</b>${to} ${label} · ${stamp(e.ts)}</div><div class="text"></div></div>`;
    $('.text', li).innerHTML = markdown(e.text);
    if (e.attachment) $('.text', li).replaceChildren(fileChip(e.attachment, true));
    const w = $('.who', li);
    if (e.who === 'archmage' && G.q.archmage) setPortrait(w, { seed: G.q.archmage.name, role: role(G.q.archmage.role), status: 'waiting', style: 'illustrated', size: 64 });
    else if (e.who === 'you') w.textContent = '✋';
    else if (e.who === 'guild') w.textContent = W().sigil;
    else {
      const a = G.q.agents.find((x) => x.id === e.who);
      if (a) { setPortrait(w, { seed: a.name, role: role(a.role), status: 'queued', style: 'illustrated', size: 64, presentation: pres(a) }); w.style.cursor = 'pointer'; w.onclick = () => openAgent(a.id); }
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
  let html = `<h3 class="head">${esc(W().chronicle)}</h3><div class="md">${markdown(q.chronicle)}</div>`;
  if (q.diff) {
    html += `<div class="diff"><h3>Changes on <code>${esc(q.repo.branch)}</code></h3>
      <p class="muted small">Review with <code>git log ${esc(q.repo.base.slice(0, 8))}..${esc(q.repo.branch)}</code> in <code>${esc(q.repo.root)}</code>${q.delivery?.target ? '' : ', then merge it yourself'}.</p>
      <pre>${esc(q.diff.stat)}</pre>
      <details><summary>Full diff${q.diff.truncated ? ' (truncated)' : ''}</summary><pre>${colourDiff(q.diff.patch)}</pre></details></div>`;
  }
  html += deliveryHtml(q);
  el.innerHTML = html;
  const b = $('[data-deliver]', el);
  if (b) b.onclick = () => { b.disabled = true; api('POST', `/api/quests/${q.id}/deliver`).catch((e) => { b.disabled = false; toast(e.message); }); };
}

/** Where the result goes: the final commit, and a button to fast-forward the target branch to it. */
function deliveryHtml(q) {
  const d = q.delivery;
  if (!d?.commit) return '';
  const at = `<code>${esc(q.repo.branch)}</code> at <code>${esc(d.commit.slice(0, 8))}</code>`;
  if (!d.target) return `<div class="delivery"><p>The result is ${at}.</p></div>`;
  const t = `<code>${esc(d.target)}</code>`;
  const body = {
    delivered: `<p class="ok">✓ ${t} was fast-forwarded to ${at}${d.dir ? ` (checked out at <code>${esc(d.dir)}</code>)` : ''}.</p>`,
    moved: `<p>${t} has new commits since the quest last merged it, so it can't simply fast-forward. Merge ${at} into it: <code>git merge ${esc(q.repo.branch)}</code> on ${t}.</p>`,
    ready: `<p>The result is ${at}, ready to fast-forward ${t}.</p><button class="btn gold" data-deliver>Fast-forward ${esc(d.target)}</button>`,
  }[d.status] ?? '';
  return `<div class="delivery"><h3>Delivery</h3>${body}${d.error && d.status !== 'delivered' ? `<p class="error">${esc(d.error)}</p>` : ''}</div>`;
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
  if (confirm(`${W().recall} ${fullName(a.name, role(a.role).title ?? a.title)}?`)) api('POST', `/api/quests/${G.q.id}/agents/${id}/cancel`).catch((e) => toast(e.message));
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
        <p class="job big">${esc(agentTitle(a))}</p>
        <div class="role" style="color:var(--gold)">${esc(r.title ?? a.title)} · ${agentWord(a.status)} · ${a.percent ?? 0}% ${money(a.costUsd) ? `· ${money(a.costUsd)}` : ''}${agentElapsed(a) != null ? ` · ${duration(agentElapsed(a))}` : ''}</div>
        <div class="section"><h4>Task</h4><div class="md">${markdown(a.task)}</div></div>
        ${a.after?.length ? `<div class="section after"><h4>Depends on</h4>${afterLine(a)}</div>` : ''}
        ${a.question ? `<div class="section question"><h4>Asks</h4>${esc(a.question)}</div>` : ''}
        ${a.branch ? `<div class="section"><h4>Branch</h4><code>${esc(a.branch)}</code> · ${a.commits ?? 0} commit(s)</div>` : ''}
        ${a.result ? `<div class="section"><h4>Final report</h4><div class="md">${markdown(a.result)}</div></div>` : ''}
        ${filesOf(a.id).length ? `<div class="section"><h4>Files</h4><div class="files big"></div></div>` : ''}
        <div class="section"><h4>Dispatches</h4><div class="reports">${reports.map((e) => `<div><span class="muted small">${stamp(e.ts)} · ${esc(whoLabel(e.who))}${e.to ? ` → ${esc(whoLabel(e.to))}` : ''}${e.percent !== undefined ? ` · ${e.percent}%` : ''}</span><div class="md">${markdown(e.text)}</div></div>`).join('') || '<span class="muted">None yet.</span>'}</div></div>
        <div class="detail-actions">
          ${ACTIVE.has(q.status) && !['cancelled', 'interrupted'].includes(a.status) ? '<button class="btn" data-d="message">Send a message</button>' : ''}
          ${a.status === 'blocked' ? '<button class="btn gold" data-d="answer">Answer</button>' : ''}
          ${ACTIVE.has(q.status) && a.status === 'waiting' ? '<button class="btn gold" data-d="start" title="Start without waiting for the rest of its prerequisites">Start now</button>' : ''}
          ${ACTIVE.has(q.status) && ['queued', 'waiting', 'working', 'blocked'].includes(a.status) ? `<button class="btn danger" data-d="recall">${esc(W().recall)}</button>` : ''}
          ${invented ? '<button class="btn" data-d="save-role">Save this role to the catalog</button>' : ''}
        </div>
      </div>
    </div>`;
  const body = $('#agent-detail-body');
  setPortrait($('.portrait', body), { seed: a.name, role: r, status: a.status, style: style(), size: 320, presentation: pres(a), emotes: motionFor('agent', a.status) });
  const fl = $('.files.big', body);
  if (fl) fl.replaceChildren(...filesOf(a.id).map((f) => fileChip(f.id, true)));
  const on = (k, fn) => { const b = $(`[data-d=${k}]`, body); if (b) b.onclick = fn; };
  on('message', () => { $('#agent-detail').close(); messageAgent(a.id); });
  on('answer', async () => {
    $('#agent-detail').close();
    const text = await askText(`Answer ${a.name}`, a.question);
    if (text) answerAgent(a.id, text);
  });
  on('recall', () => { $('#agent-detail').close(); recallAgent(a.id); });
  on('start', () => { $('#agent-detail').close(); api('POST', `/api/quests/${q.id}/agents/${a.id}/start`).catch((e) => toast(e.message)); });
  on('save-role', () => api('POST', `/api/roles/${a.role}`, { quest: q.id }).then(() => { toast(`${r.title ?? a.title} is now in the catalog.`); $('#agent-detail').close(); renderParty(); }).catch((e) => toast(e.message)));
  $('#agent-detail').showModal();
}

// ── attached files: screenshots, pages and reports the party shares ──

const filesOf = (who) => (G.q?.attachments ?? []).filter((f) => f.who === who);
const fileUrl = (f, download) => `/api/quests/${G.q.id}/files/${f.id}${download ? '?download=1' : ''}`;
const isImage = (f) => /^image\//.test(f.type);
const fileSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const FILE_ICON = { 'application/pdf': '📄', 'text/html': '🌐', 'text/markdown': '📝', 'video/mp4': '🎞', 'video/webm': '🎞' };

/** A clickable thumbnail (images) or file chip; `withCaption` adds the caption beside it. */
function fileChip(fid, withCaption = false) {
  const f = G.q.attachments?.find((x) => x.id === fid);
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `file-chip${withCaption ? ' wide' : ''}`;
  if (!f) { el.textContent = 'A file (not loaded yet)'; el.disabled = true; return el; }
  const icon = FILE_ICON[f.type.split(';')[0]] ?? '📎';
  el.innerHTML = `${isImage(f) ? `<img src="${fileUrl(f)}" alt="" loading="lazy">` : `<span class="icon">${icon}</span>`}
    <span class="meta"><b>${esc(f.name)}</b>${withCaption && f.caption ? `<span>${esc(f.caption)}</span>` : ''}<span class="muted small">${fileSize(f.size)}</span></span>`;
  el.title = f.caption ?? f.name;
  el.onclick = (ev) => { ev.stopPropagation(); openFile(f); };
  return el;
}

/** The last few files of one agent (or the Archmage) as small thumbnails on its card. */
function renderFiles(box, who) {
  if (!box) return;
  const list = filesOf(who);
  if (box.dataset.n === String(list.length)) return;
  box.dataset.n = list.length;
  box.replaceChildren(...list.slice(-4).map((f) => fileChip(f.id)));
  if (list.length > 4) box.append(Object.assign(document.createElement('span'), { className: 'muted small', textContent: `+${list.length - 4}` }));
}

async function openFile(f) {
  const dlg = $('#file-viewer'), body = $('#file-body');
  $('#file-title').textContent = f.caption ?? f.name;
  $('#file-meta').innerHTML = `${esc(whoLabel(f.who))} · ${esc(f.name)} · ${fileSize(f.size)} · ${stamp(f.ts)} ·
    <a href="${fileUrl(f)}" target="_blank" rel="noopener">Open in a new tab</a> · <a href="${fileUrl(f, true)}">Download</a>`;
  const type = f.type.split(';')[0];
  body.innerHTML = '';
  if (isImage(f)) body.innerHTML = `<img src="${fileUrl(f)}" alt="${esc(f.caption ?? f.name)}">`;
  else if (type === 'application/pdf') body.innerHTML = `<iframe src="${fileUrl(f)}" title="${esc(f.name)}"></iframe>`;
  else if (type === 'text/html') body.innerHTML = `<iframe sandbox="allow-scripts" src="${fileUrl(f)}" title="${esc(f.name)}"></iframe>`;
  else if (type.startsWith('video/')) body.innerHTML = `<video controls src="${fileUrl(f)}"></video>`;
  else if (/^text\/|json/.test(type)) {
    const text = await fetch(fileUrl(f)).then((r) => r.text()).catch(() => 'Could not load the file.');
    body.innerHTML = type === 'text/markdown' ? `<div class="md">${markdown(text)}</div>` : `<pre>${esc(text.slice(0, 500_000))}</pre>`;
  } else body.innerHTML = `<p class="muted">No preview for this kind of file. <a href="${fileUrl(f, true)}">Download it</a>.</p>`;
  if (!dlg.open) dlg.showModal();
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
  if (!form.dataset.touched) form.checkIn.value = G.settings.checkIn ?? '';
  form.checkIn.oninput = () => { form.dataset.touched = '1'; };
  const editOnly = () => $('.edit-only', form).classList.toggle('hidden', form.mode.value !== 'edit');
  for (const r of form.querySelectorAll('[name=mode]')) r.onchange = editOnly;
  editOnly();
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
      checkIn: form.checkIn.value,
      ...(form.mode.value === 'edit' ? { target: form.target.value.trim() || undefined, sync: form.sync.value, deliver: form.deliverAuto.checked ? 'auto' : 'offer' } : {}),
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
  $('#theme-select').innerHTML = Object.entries(THEMES).map(([id, t]) => `<option value="${id}" ${id === (G.settings.theme ?? 'fantasy') ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  for (const k of ['maxConcurrent', 'maxAgents', 'batchSeconds']) form[k].value = G.settings[k];
  form.animate.checked = G.settings.animate !== false;
  form.checkIn.value = G.settings.checkIn ?? '';
  $('#roles-json').value = JSON.stringify(G.roles, null, 2);
  $('#roles-error').textContent = '';
  renderGallery(style());
  $('#style-select').onchange = (e) => renderGallery(e.target.value);
  $('#settings').showModal();
}

function renderGallery(st) {
  const g = $('#role-gallery');
  g.innerHTML = '';
  for (const id of Object.keys(G.roles)) {
    const r = role(id, null);
    const tile = document.createElement('div');
    tile.className = 'role-tile';
    tile.innerHTML = `<div class="faces"><div></div><div></div></div>
      <div class="t">${esc(r.title ?? id)}</div>
      <div class="muted">${esc(r.blurb ?? '')}</div>
      <div class="small"><code>${esc(id)}</code> · ${esc(r.model ?? 'default model')} · ${r.orchestrator ? 'orchestrator' : esc(Array.isArray(r.tools) ? 'custom tools' : r.tools ?? 'read')}</div>`;
    const [f1, f2] = tile.querySelectorAll('.faces div');
    setPortrait(f1, { seed: r.orchestrator ? archRole().name : `${id}-Aster`, role: r, status: 'waiting', style: st, size: 160 });
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
      style: f.style.value, theme: f.theme.value, maxConcurrent: Number(f.maxConcurrent.value), maxAgents: Number(f.maxAgents.value), batchSeconds: Number(f.batchSeconds.value),
      animate: f.animate.checked,
      checkIn: f.checkIn.value,
    });
    applyTheme();
    rerender();
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

/** Redraw the current view, e.g. after the theme changed. */
function rerender() {
  renderTabs();
  if (G.q) buildQuest(); else renderHall();
}

applyTheme();
connectGlobal();
