/* Salon — single-page app (no framework, no build step). */
'use strict';

/* =============================================================== state */
const state = { config: null, user: null, services: [], stylists: [] };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');

/* ============================================================= helpers */
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const money = (n) =>
  new Intl.NumberFormat(state.config?.currency === 'INR' ? 'en-IN' : undefined, {
    style: 'currency',
    currency: state.config?.currency || 'USD',
    maximumFractionDigits: n % 1 ? 2 : 0,
  }).format(n);
const parseDate = (s) => new Date(s + 'T00:00:00');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return ymd(d); };
const fmtDate = (s, opts = { weekday: 'long', month: 'long', day: 'numeric' }) =>
  parseDate(s).toLocaleDateString(undefined, opts);
const fmtTime = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
const fmtDuration = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} hr${min % 60 ? ` ${min % 60} min` : ''}`);
const today = () => state.config?.today || ymd(new Date());
const initials = (name) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const GRADIENTS = [['#ff7a59', '#d14bff'], ['#3f7bff', '#6a3cff'], ['#00c7be', '#3f7bff'], ['#ffb340', '#ff5f6d'], ['#34c759', '#00a3a3'], ['#ff5f9e', '#ff9f0a']];
const avatar = (name, id = 0, size = '') => {
  const [a1, a2] = GRADIENTS[id % GRADIENTS.length];
  return `<span class="avatar ${size}" style="--a1:${a1};--a2:${a2}" aria-hidden="true">${esc(initials(name))}</span>`;
};
const digits = (v) => String(v || '').replace(/[^\d]/g, '');
const waLink = (text = '') => {
  const n = digits(state.config?.whatsapp || state.config?.phone);
  return n ? `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}` : '';
};
const telLink = () => `tel:+${digits(state.config?.phone)}`;
const mapLink = () => state.config?.map_url || `https://maps.google.com/?q=${encodeURIComponent(state.config?.address || '')}`;
const isStaffUser = () => ['staff', 'admin'].includes(state.user?.role);
const isAdmin = () => state.user?.role === 'admin';
const homeFor = (u) => (!u ? '#/' : u.role === 'admin' ? '#/admin' : u.role === 'staff' ? '#/admin/schedule' : '#/account');
const opts = (list) => state.options?.[list] || [];
async function loadOptions() {
  state.options = isStaffUser() ? await api('/api/options') : null;
}
/** <select> markup. items: [{value,label,group?}] or strings. */
function selectHTML(id, items, { placeholder, value = '', cls = 'input input-sm', required = false } = {}) {
  const norm = items.map((i) => (typeof i === 'string' ? { value: i, label: i } : i));
  const groups = [...new Set(norm.map((i) => i.group || ''))];
  const optHTML = (list) => list.map((i) => `<option value="${esc(i.value)}" ${String(i.value) === String(value) ? 'selected' : ''}>${esc(i.label)}</option>`).join('');
  return `<select class="${cls}" id="${id}" name="${id}" ${required ? 'required' : ''}>
    ${placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : ''}
    ${groups.length > 1 ? groups.map((g) => `<optgroup label="${esc(g)}">${optHTML(norm.filter((i) => (i.group || '') === g))}</optgroup>`).join('') : optHTML(norm)}
  </select>`;
}
const statusLabel = { confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' };
const badge = (s) => `<span class="badge ${s}">${statusLabel[s] || s}</span>`;

const ICON = {
  scissors: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/></svg>',
  clock: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  spark: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/></svg>',
  shield: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  check: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  bolt: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  key: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/></svg>',
  wa: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm4.5 12.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.9-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.2-.2-.5-.3Z"/></svg>',
  ig: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>',
  phone: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
  left: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>',
};

/* =================================================== toast & modal */
let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3200);
}
const toastError = (e) => toast(e.message || String(e), 'error');

function modal(html, { wide = false, onMount } = {}) {
  const root = $('#modalRoot');
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  const prevFocus = document.activeElement;
  const close = () => {
    el.remove();
    document.removeEventListener('keydown', onKey);
    prevFocus?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  el.addEventListener('mousedown', (e) => e.target === el && close());
  document.addEventListener('keydown', onKey);
  root.appendChild(el);
  $$('[data-close]', el).forEach((b) => b.addEventListener('click', close));
  onMount?.(el.firstElementChild, close);
  (el.querySelector('input, select, textarea, button:not([data-close])') || el.firstElementChild).focus?.();
  return close;
}

function confirmDialog({ title, text, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const close = modal(
      `<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
       <div class="foot"><button class="btn gray btn-md" data-close>Not now</button>
       <button class="btn ${danger ? 'danger' : ''} btn-md" id="dlgOk">${esc(ok)}</button></div>`,
      {
        onMount(m, close) {
          $('#dlgOk', m).addEventListener('click', () => { answered = true; close(); resolve(true); });
        },
      }
    );
    const obs = new MutationObserver(() => {
      if (!document.body.contains($('#dlgOk'))) { obs.disconnect(); if (!answered) resolve(false); }
    });
    obs.observe($('#modalRoot'), { childList: true });
    void close;
  });
}

/* ============================================================ session */
async function refreshUser() {
  const { user } = await api('/api/auth/me');
  state.user = user;
  await loadOptions();
  renderNav();
  return user;
}

async function quickLogin(role, next) {
  try {
    const { user } = await api('/api/auth/quick', { method: 'POST', body: { role } });
    state.user = user;
    renderNav();
    await loadOptions();
    toast(`Signed in as ${user.name}`);
    go(next && !isStaffUser() ? next : homeFor(user));
  } catch (e) {
    toastError(e);
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  renderNav();
  toast('Signed out');
  go('#/');
}

/* ================================================================ nav */
function renderNav() {
  const u = state.user;
  const el = $('#navActions');
  document.body.classList.toggle('is-admin', location.hash.startsWith('#/admin'));
  const navAuth = $('#navAuth');
  navAuth.textContent = !u ? 'Sign in' : u.role === 'customer' ? 'My bookings' : 'Dashboard';
  navAuth.setAttribute('href', !u ? '#/login' : homeFor(u));
  if (!u) {
    el.innerHTML = `<a href="#/login" class="plain">Sign in</a><a href="#/book" class="btn btn-sm">Book now</a>`;
    return;
  }
  el.innerHTML = `
    ${u.role === 'customer' ? '<a href="#/book" class="btn btn-sm ghost-hide">Book</a>' : ''}
    <div class="menu-wrap">
      <button class="menu-btn" id="userMenuBtn" aria-haspopup="true" aria-label="Account menu">${avatar(u.name, u.id)}</button>
    </div>`;
  $('#userMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const wrap = e.currentTarget.parentElement;
    const open = $('.menu', wrap);
    if (open) return open.remove();
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = `
      <div class="who"><strong>${esc(u.name)}</strong><div class="small muted">${esc(u.email)}</div></div>
      ${u.role === 'customer' ? `<a href="#/account">My bookings</a>
      <a href="#/account/profile">Profile &amp; security</a>
      <a href="#/book">New booking</a>` : `<a href="${homeFor(u)}">${u.role === 'admin' ? 'Admin dashboard' : 'Staff workspace'}</a>
      <a href="#/account/profile">Profile &amp; password</a>`}
      <button id="logoutBtn">Sign out</button>`;
    wrap.appendChild(m);
    $('#logoutBtn', m).addEventListener('click', logout);
    setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }));
  });
}

$$('#navLinks a').forEach((a) => a.addEventListener('click', () => {
  $('#navLinks').classList.remove('open');
  $('#burger').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('menu-open');
}));
$('#burger').addEventListener('click', (e) => {
  const links = $('#navLinks');
  const open = !links.classList.contains('open');
  links.classList.toggle('open', open);
  e.currentTarget.setAttribute('aria-expanded', open);
  document.body.classList.toggle('menu-open', open);
});

/* ============================================================= router */
const routes = [];
const on = (re, fn, guard) => routes.push({ re, fn, guard });
const go = (hash) => (location.hash === hash ? render() : (location.hash = hash));

async function render() {
  const hash = location.hash || '#/';
  $('#navLinks').classList.remove('open');
  $('#burger').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('menu-open');
  $$('#navLinks a').forEach((a) => a.classList.toggle('active', hash.startsWith(a.getAttribute('href'))));
  document.body.classList.toggle('is-admin', hash.startsWith('#/admin'));
  document.body.classList.toggle('no-fab', /^#\/(login|signup|book|staff)/.test(hash));
  for (const r of routes) {
    const m = hash.match(r.re);
    if (!m) continue;
    if (r.guard === 'auth' && !state.user) return go(`#/login?next=${encodeURIComponent(hash)}`);
    if ((r.guard === 'admin' || r.guard === 'staff') && !state.user) return go('#/staff');
    if (r.guard === 'staff' && !isStaffUser()) return go(homeFor(state.user));
    if (r.guard === 'admin' && !isAdmin()) return go(homeFor(state.user));
    if (isStaffUser() && !state.options) await loadOptions();
    const top = () => window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    top();
    try {
      await r.fn(...m.slice(1));
      top();
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="wrap empty" style="padding:120px 0"><div class="big">⚠️</div><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></div>`;
    }
    return;
  }
  app.innerHTML = `<section class="wrap center" style="padding:140px 0"><h1 class="headline">Page not found.</h1><p class="subhead">The page you’re looking for can’t be found.</p><div class="hero-ctas"><a class="btn" href="#/">Go home</a></div></section>`;
}
window.addEventListener('hashchange', render);
// A link to the page you're already on fires no hashchange: re-render it and jump to the top.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  if (a.getAttribute('href') === (location.hash || '#/')) { e.preventDefault(); render(); }
});
const queryParam = (k) => new URLSearchParams((location.hash.split('?')[1] || '')).get(k);

/* ================================================================ home */
const CATEGORY_ART = {
  Hair: 'linear-gradient(135deg,#ffd1c2,#ff7a59 50%,#d14bff)',
  Colour: 'linear-gradient(135deg,#fff2c7,#ffb340 45%,#ff5f6d)',
  Treatment: 'linear-gradient(135deg,#d9fff6,#00c7be 50%,#3f7bff)',
  Skin: 'linear-gradient(135deg,#ffe0ef,#ff5f9e 50%,#9b5cff)',
  Nails: 'linear-gradient(135deg,#e6f0ff,#3f7bff 50%,#6a3cff)',
  Special: 'linear-gradient(135deg,#fff7d6,#ffcc00 40%,#ff7a59)',
  Bridal: 'linear-gradient(135deg,#ffe3d1,#ff5f6d 45%,#c2185b)',
  'Threading & Wax': 'linear-gradient(135deg,#fff0e0,#ff9f0a 50%,#ff5f9e)',
};

on(/^#\/?$/, async () => {
  const c = state.config;
  const nextOpen = nextOpening();
  const cats = [...new Set(state.services.map((s) => s.category))];
  const tile = (cat, dark) => {
    const list = state.services.filter((s) => s.category === cat);
    const from = Math.min(...list.map((s) => s.price));
    return `<div class="tile ${dark ? 'dark' : ''}">
      <h2 class="title">${esc(cat)}</h2>
      <p class="subhead" style="font-size:19px">${list.length} service${list.length > 1 ? 's' : ''} · from ${money(from)}</p>
      <div class="row"><a class="btn btn-md" href="#/book?category=${encodeURIComponent(cat)}">Book</a><a class="link-arrow" href="#/services?category=${encodeURIComponent(cat)}">Learn more</a></div>
      <div class="tile-art" style="background:${CATEGORY_ART[cat] || CATEGORY_ART.Hair}"></div>
    </div>`;
  };
  app.innerHTML = `
    <section class="hero reveal">
      <p class="eyebrow">New · Online booking</p>
      <h1 class="display" style="margin-top:8px">${esc(c.salon_name.split(' ')[0])}<span class="gradient-text">.</span></h1>
      <p class="subhead">${esc(c.tagline)} Booked in seconds.</p>
      ${c.quote ? `<p class="hero-quote">“${esc(c.quote)}”</p>` : ''}
      <div class="hero-ctas">
        <a class="btn" href="#/book">Book an appointment</a>
        <a class="btn secondary" href="#/services">Explore services</a>
      </div>
      <div class="hero-visual" aria-hidden="true">
        <div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div>
        <div class="glass-card">
          <div class="row" style="gap:12px">
            ${avatar(state.stylists[0]?.name || 'Ava', 0)}
            <div class="grow" style="flex:1"><strong style="font-size:15px">Next available</strong>
              <div class="small muted">${nextOpen}</div></div>
            <a href="#/book" class="btn btn-sm">Book</a>
          </div>
        </div>
      </div>
    </section>

    <section class="section" style="padding-top:40px">
      <div class="wrap-wide tiles">${cats.map((cat, i) => tile(cat, i % 4 === 1 || i % 4 === 2)).join('')}</div>
    </section>

    <section class="section alt">
      <div class="wrap">
        <div class="section-head"><h2 class="headline">Why ${esc(c.salon_name.split(' ')[0])}.</h2>
          <p class="subhead">Everything about your visit, designed to feel effortless.</p></div>
        <div class="features">
          ${[
            ['clock', 'Book in seconds', 'Real-time availability. Pick a time that suits you — no calls, no waiting.'],
            ['scissors', 'Expert stylists', 'A small team of specialists who listen first and cut second.'],
            ['spark', 'Premium products', 'Trusted professional brands and herbal care for Indian hair and skin.'],
            ['shield', 'Flexible changes', `Reschedule or cancel online up to ${c.cancel_cutoff_hours} hours before.`],
          ].map(([i, h, p]) => `<div class="feature"><div class="ico">${ICON[i]}</div><h3>${h}</h3><p class="muted">${p}</p></div>`).join('')}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="section-head"><h2 class="headline">Meet the team.</h2><p class="subhead">Pick a favourite, or let us match you.</p></div>
        <div class="grid grid-4">${state.stylists.map(teamCard).join('')}</div>
        <div class="center" style="margin-top:32px"><a class="link-arrow" href="#/team">See the whole team</a></div>
      </div>
    </section>

    <section class="section alt center">
      <div class="wrap">
        <h2 class="headline">Your chair is waiting.</h2>
        <p class="subhead">${esc(c.address)} · ${esc(c.phone)}</p>
        <div class="hero-ctas"><a class="btn" href="#/book">Book now</a><a class="btn secondary" href="#/visit">Hours &amp; directions</a></div>
      </div>
    </section>`;
});

function nextOpening() {
  const h = state.config.hours;
  for (let i = 0; i < 14; i++) {
    const d = addDays(today(), i);
    const dh = h[parseDate(d).getDay()];
    if (!dh || state.config.closed_dates.includes(d)) continue;
    if (i === 0) {
      const now = state.config.now_min ?? 0;
      const [ch, cm] = dh.close.split(':').map(Number);
      const [oh, om] = dh.open.split(':').map(Number);
      if (now + 60 > ch * 60 + cm) continue;
      return now < oh * 60 + om ? `Today from ${fmtTime(dh.open)}` : `Today until ${fmtTime(dh.close)}`;
    }
    return `${i === 1 ? 'Tomorrow' : fmtDate(d, { weekday: 'long' })} from ${fmtTime(dh.open)}`;
  }
  return 'See opening hours';
}

const teamCard = (s) => `
  <div class="card team-card">
    ${avatar(s.name, s.id, 'xl')}
    <h3>${esc(s.name)}</h3>
    <p class="small muted" style="margin:4px 0 12px">${esc(s.title)}</p>
    <div>${(s.specialties || '').split(',').filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
  </div>`;

/* ============================================================ services */
on(/^#\/services(?:\?.*)?$/, async () => {
  let cat = queryParam('category') || 'All';
  const cats = ['All', ...new Set(state.services.map((s) => s.category))];
  app.innerHTML = `
    <section class="wrap page-head center reveal">
      <h1 class="headline">Services.</h1>
      <p class="subhead">Transparent pricing. No surprises at checkout.</p>
    </section>
    <section class="wrap" style="padding-bottom:96px">
      <div class="chips" id="chips"></div>
      <div class="grid grid-3" id="svcGrid"></div>
    </section>`;
  const draw = () => {
    $('#chips').innerHTML = cats.map((c) => `<button class="chip ${c === cat ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
    $$('#chips .chip').forEach((b) => b.addEventListener('click', () => { cat = b.dataset.c; draw(); }));
    const list = state.services.filter((s) => cat === 'All' || s.category === cat);
    $('#svcGrid').innerHTML = list.map((s) => `
      <div class="card service-card">
        <span class="cat">${esc(s.category)}</span>
        <h3>${esc(s.name)}</h3>
        <p class="muted small">${esc(s.description)}</p>
        <div class="meta">
          <span><span class="price">${money(s.price)}</span> <span class="muted small">· ${fmtDuration(s.duration_min)}</span></span>
          <a class="btn btn-sm" href="#/book?service=${s.id}">Book</a>
        </div>
      </div>`).join('');
  };
  draw();
});

/* ================================================================ team */
on(/^#\/team$/, async () => {
  app.innerHTML = `
    <section class="wrap page-head center reveal"><h1 class="headline">The team.</h1>
      <p class="subhead">Specialists in cut, colour, skin and nails.</p></section>
    <section class="wrap" style="padding-bottom:96px"><div class="grid grid-2">
      ${state.stylists.map((s) => `
        <div class="card row" style="gap:24px;align-items:flex-start;flex-wrap:nowrap">
          ${avatar(s.name, s.id, 'lg')}
          <div style="flex:1"><h3 style="font-size:24px">${esc(s.name)}</h3>
            <p class="small muted">${esc(s.title)}</p>
            <p style="margin:12px 0">${esc(s.bio)}</p>
            <div style="margin-bottom:14px">${(s.specialties || '').split(',').filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
            <a class="btn btn-sm" href="#/book?stylist=${s.id}">Book with ${esc(s.name.split(' ')[0])}</a>
          </div>
        </div>`).join('')}
    </div></section>`;
});

/* =============================================================== visit */
on(/^#\/visit$/, async () => {
  const c = state.config;
  const days = [1, 2, 3, 4, 5, 6, 0];
  const todayDow = parseDate(today()).getDay();
  const dayName = (d) => new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: 'long' });
  app.innerHTML = `
    <section class="wrap page-head center reveal"><h1 class="headline">Visit us.</h1>
      <p class="subhead">${esc(c.address)}</p></section>
    <section class="wrap grid grid-2" style="padding-bottom:96px;gap:24px">
      <div class="visit-map" role="img" aria-label="Map showing the salon location">
        <div class="road" style="left:0;right:0;top:46%;height:18px"></div>
        <div class="road" style="top:0;bottom:0;left:30%;width:14px"></div>
        <div class="road" style="top:0;bottom:0;left:72%;width:10px"></div>
        <div class="pin"></div>
      </div>
      <div class="card">
        <h2 class="title" style="font-size:28px;margin-bottom:20px">Opening hours</h2>
        <div class="hours-list">
          ${days.map((d) => {
            const h = c.hours[d];
            return `<span class="${d === todayDow ? 'today' : ''}">${dayName(d)}</span>
                    <span class="${d === todayDow ? 'today' : 'muted'}">${h ? `${fmtTime(h.open)} – ${fmtTime(h.close)}` : 'Closed'}</span>`;
          }).join('')}
        </div>
        <div class="divider"></div>
        <p><a href="tel:${esc(c.phone.replace(/[^+\d]/g, ''))}">${esc(c.phone)}</a></p>
        <p><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>
        <div class="row" style="margin-top:20px">
          <a class="btn btn-md" target="_blank" rel="noopener" href="${mapLink()}">Get directions</a>
          ${waLink() ? `<a class="btn wa btn-md" target="_blank" rel="noopener" href="${waLink('Hi! I have a question about booking.')}">WhatsApp</a>` : ''}
        </div>
      </div>
    </section>`;
});

/* ======================================================== slot picker */
/**
 * Calendar + time grid. Reused by booking, reschedule and staff booking.
 * opts: { serviceId, stylistId, date, time, exclude, onChange({date,time}) }
 */
function slotPicker(root, opts) {
  const max = addDays(today(), state.config.max_days_ahead);
  let sel = { date: opts.date || null, time: opts.time || null };
  let month = parseDate(sel.date || today());
  month.setDate(1);
  let avail = {};

  root.innerHTML = `<div class="calendar"></div><div class="times-wrap"></div>`;
  const cal = $('.calendar', root);
  const tw = $('.times-wrap', root);

  async function loadMonth() {
    const first = ymd(month);
    const from = first < today() ? today() : first;
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const days = Math.max(1, Math.round((last - parseDate(from)) / 864e5) + 1);
    const q = new URLSearchParams({ service_id: opts.serviceId, from, days });
    if (opts.stylistId) q.set('stylist_id', opts.stylistId);
    const rows = await api(`/api/availability?${q}`);
    avail = Object.fromEntries(rows.map((r) => [r.date, r.slots]));
  }

  async function drawCal() {
    const label = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const canPrev = ymd(month) > today().slice(0, 8) + '01';
    const nextMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    const canNext = ymd(nextMonth) <= max;
    cal.innerHTML = `<div class="cal-head"><h4>${label}</h4><div class="row" style="gap:4px">
        <button class="icon-btn" data-m="-1" ${canPrev ? '' : 'disabled'} aria-label="Previous month">${ICON.left}</button>
        <button class="icon-btn" data-m="1" ${canNext ? '' : 'disabled'} aria-label="Next month">${ICON.right}</button></div></div>
      <div class="cal-grid"><div class="skeleton" style="grid-column:1/-1;height:260px"></div></div>`;
    $$('[data-m]', cal).forEach((b) =>
      b.addEventListener('click', () => { month.setMonth(month.getMonth() + Number(b.dataset.m)); drawCal(); })
    );
    await loadMonth();
    const dows = [...Array(7)].map((_, i) => new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
    const lead = month.getDay();
    const daysIn = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    let cells = dows.map((d) => `<div class="dow">${d}</div>`).join('') + '<div></div>'.repeat(lead);
    for (let d = 1; d <= daysIn; d++) {
      const ds = ymd(new Date(month.getFullYear(), month.getMonth(), d));
      const n = avail[ds] || 0;
      const ok = ds >= today() && ds <= max && n > 0;
      cells += `<button class="day ${ds === today() ? 'today' : ''} ${ds === sel.date ? 'on' : ''}" data-d="${ds}" ${ok ? '' : 'disabled'}
        aria-label="${fmtDate(ds)}${ok ? `, ${n} times available` : ', unavailable'}">${d}${ok ? '<span class="dot"></span>' : ''}</button>`;
    }
    $('.cal-grid', cal).innerHTML = cells;
    $$('.day[data-d]', cal).forEach((b) =>
      b.addEventListener('click', () => {
        sel = { date: b.dataset.d, time: null };
        $$('.day', cal).forEach((x) => x.classList.toggle('on', x === b));
        opts.onChange?.(sel);
        drawTimes();
      })
    );
    // Auto-select first available day so customers see times immediately.
    if (!sel.date) {
      const first = Object.keys(avail).find((k) => avail[k] > 0);
      if (first && first.slice(0, 7) === ymd(month).slice(0, 7)) {
        $(`.day[data-d="${first}"]`, cal)?.click();
        return;
      }
    }
    drawTimes();
  }

  async function drawTimes() {
    if (!sel.date) {
      tw.innerHTML = `<div class="empty small">Select a date to see available times.</div>`;
      return;
    }
    tw.innerHTML = `<div class="skeleton" style="height:120px;margin-top:24px"></div>`;
    const q = new URLSearchParams({ date: sel.date, service_id: opts.serviceId });
    if (opts.stylistId) q.set('stylist_id', opts.stylistId);
    if (opts.exclude) q.set('exclude', opts.exclude);
    const slots = await api(`/api/slots?${q}`);
    if (!slots.length) {
      tw.innerHTML = `<div class="empty"><div class="big">🗓</div>Fully booked on ${fmtDate(sel.date)}. Try another day.</div>`;
      return;
    }
    const groups = [['Morning', 0, 720], ['Afternoon', 720, 1020], ['Evening', 1020, 1440]];
    tw.innerHTML = `<p class="muted small" style="margin-top:24px">${fmtDate(sel.date)}</p>` +
      groups.map(([g, a, b]) => {
        const list = slots.filter((s) => s.start_min >= a && s.start_min < b);
        if (!list.length) return '';
        return `<div class="time-group"><div class="group-title" style="margin-top:0">${g}</div><div class="times">
          ${list.map((s) => `<button class="time ${s.time === sel.time ? 'on' : ''}" data-t="${s.time}">${fmtTime(s.time)}</button>`).join('')}
        </div></div>`;
      }).join('');
    $$('.time', tw).forEach((b) =>
      b.addEventListener('click', () => {
        sel.time = b.dataset.t;
        $$('.time', tw).forEach((x) => x.classList.toggle('on', x === b));
        opts.onChange?.(sel);
      })
    );
  }

  drawCal();
  return { get: () => sel };
}

/* ============================================================ booking */
const DRAFT_KEY = 'salon.bookingDraft';
const loadDraft = () => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY)) || {}; } catch { return {}; } };
const saveDraft = (d) => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch {} };
const clearDraft = () => { try { sessionStorage.removeItem(DRAFT_KEY); } catch {} };

on(/^#\/book(?:\?.*)?$/, async () => {
  const draft = { step: 1, service_id: null, stylist_id: 0, date: null, time: null, notes: '', ...loadDraft() };
  if (queryParam('service')) Object.assign(draft, { service_id: Number(queryParam('service')), step: 2, date: null, time: null });
  if (queryParam('stylist')) Object.assign(draft, { stylist_id: Number(queryParam('stylist')), step: draft.service_id ? 3 : 1 });
  const catFilter = queryParam('category');
  if (draft.service_id && !state.services.some((s) => s.id === draft.service_id)) Object.assign(draft, { service_id: null, step: 1 });

  const STEPS = ['Service', 'Stylist', 'Date & time', 'Confirm'];
  app.innerHTML = `
    <section class="wrap page-head reveal" style="padding-bottom:0">
      <p class="eyebrow accent" style="font-size:17px">Book an appointment</p>
      <h1 class="headline" id="stepTitle" style="margin-top:6px"></h1>
      <div class="steps" id="steps"></div>
    </section>
    <section class="wrap book-layout">
      <div id="stepBody"></div>
      <aside class="card summary" id="summary"></aside>
    </section>`;

  const svc = () => state.services.find((s) => s.id === draft.service_id);
  const sty = () => state.stylists.find((s) => s.id === draft.stylist_id);

  function setStep(n) {
    draft.step = n;
    saveDraft(draft);
    draw();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function drawSummary() {
    const s = svc();
    $('#summary').innerHTML = `
      <h3 style="font-size:21px">Summary</h3>
      <dl>
        <dt>Service</dt><dd>${s ? esc(s.name) : '—'}</dd>
        <dt>Duration</dt><dd>${s ? fmtDuration(s.duration_min) : '—'}</dd>
        <dt>Stylist</dt><dd>${draft.stylist_id ? esc(sty()?.name) : 'Any available'}</dd>
        <dt>Date</dt><dd>${draft.date ? fmtDate(draft.date, { weekday: 'short', month: 'short', day: 'numeric' }) : '—'}</dd>
        <dt>Time</dt><dd>${draft.time ? fmtTime(draft.time) : '—'}</dd>
      </dl>
      <div class="total"><span>Total</span><span>${s ? money(s.price) : '—'}</span></div>
      <p class="small muted" style="margin-top:12px">Pay at the salon. Free changes up to ${state.config.cancel_cutoff_hours}h before.</p>`;
  }

  function draw() {
    $('#stepTitle').textContent = ['Choose a service.', 'Choose your stylist.', 'Pick a date and time.', 'Review and confirm.'][draft.step - 1];
    $('#steps').innerHTML = STEPS.map((l, i) => {
      const n = i + 1;
      const cls = n < draft.step ? 'done' : n === draft.step ? 'cur' : '';
      return `<div class="s ${cls}" data-step="${n}"><div class="bar"><i></i></div><div class="lbl">${n}. ${l}</div></div>`;
    }).join('');
    $$('#steps .s.done').forEach((el) => el.addEventListener('click', () => setStep(Number(el.dataset.step))));
    drawSummary();
    const body = $('#stepBody');

    if (draft.step === 1) {
      const cats = [...new Set(state.services.map((s) => s.category))].filter((c) => !catFilter || c === catFilter);
      body.innerHTML = (catFilter ? `<p class="small"><a href="#/book">Show all services</a></p>` : '') +
        cats.map((c) => `<div class="group-title">${esc(c)}</div><div class="select-list">
          ${state.services.filter((s) => s.category === c).map((s) => `
            <button class="option ${s.id === draft.service_id ? 'on' : ''}" data-id="${s.id}">
              <div class="grow"><h4>${esc(s.name)}</h4><p class="small muted">${esc(s.description)}</p></div>
              <div class="right"><div class="price">${money(s.price)}</div><div class="small muted">${fmtDuration(s.duration_min)}</div></div>
            </button>`).join('')}</div>`).join('');
      $$('.option', body).forEach((b) =>
        b.addEventListener('click', () => {
          const id = Number(b.dataset.id);
          if (id !== draft.service_id) Object.assign(draft, { date: null, time: null });
          draft.service_id = id;
          const chosen = sty();
          if (chosen && !canDo(chosen, svc())) draft.stylist_id = 0;
          setStep(2);
        })
      );
    }

    if (draft.step === 2) {
      const s = svc();
      const list = state.stylists.filter((st) => canDo(st, s));
      body.innerHTML = `<div class="select-list">
        <button class="option ${!draft.stylist_id ? 'on' : ''}" data-id="0">
          <span class="avatar" style="--a1:#8e8e93;--a2:#48484a">${ICON.spark.replace('22', '18').replace('22', '18')}</span>
          <div class="grow"><h4>Any available stylist</h4><p class="small muted">Most availability — we’ll match you with a specialist.</p></div>
        </button>
        ${list.map((st) => `
          <button class="option ${st.id === draft.stylist_id ? 'on' : ''}" data-id="${st.id}">
            ${avatar(st.name, st.id)}
            <div class="grow"><h4>${esc(st.name)}</h4><p class="small muted">${esc(st.title)} · ${esc(st.bio)}</p></div>
          </button>`).join('')}
      </div>
      <div class="row" style="margin-top:24px"><button class="btn gray btn-md" id="back">Back</button></div>`;
      $$('.option', body).forEach((b) =>
        b.addEventListener('click', () => {
          const id = Number(b.dataset.id);
          if (id !== draft.stylist_id) Object.assign(draft, { time: null });
          draft.stylist_id = id;
          setStep(3);
        })
      );
      $('#back', body).addEventListener('click', () => setStep(1));
    }

    if (draft.step === 3) {
      body.innerHTML = `<div class="card"><div id="picker"></div></div>
        <div class="row" style="margin-top:24px"><button class="btn gray btn-md" id="back">Back</button><span class="spacer"></span>
        <button class="btn" id="next" ${draft.time ? '' : 'disabled'}>Continue</button></div>`;
      slotPicker($('#picker', body), {
        serviceId: draft.service_id,
        stylistId: draft.stylist_id || null,
        date: draft.date,
        time: draft.time,
        onChange: ({ date, time }) => {
          Object.assign(draft, { date, time });
          saveDraft(draft);
          drawSummary();
          $('#next', body).disabled = !time;
        },
      });
      $('#back', body).addEventListener('click', () => setStep(2));
      $('#next', body).addEventListener('click', () => setStep(4));
    }

    if (draft.step === 4) {
      if (!draft.date || !draft.time) return setStep(3);
      const s = svc();
      const u = state.user;
      body.innerHTML = `
        <div class="card">
          <div class="booking">
            <div class="date-badge"><div class="m">${fmtDate(draft.date, { month: 'short' })}</div><div class="d">${parseDate(draft.date).getDate()}</div></div>
            <div class="grow"><h4>${esc(s.name)}</h4>
              <p class="muted">${fmtDate(draft.date)} at ${fmtTime(draft.time)} · ${fmtDuration(s.duration_min)}</p>
              <p class="muted small">${draft.stylist_id ? `with ${esc(sty().name)}` : 'With the first available stylist'}</p></div>
          </div>
          <label class="field" style="margin-top:20px"><span>Notes for your stylist (optional)</span>
            <textarea class="input" id="notes" maxlength="500" placeholder="E.g. allergies, inspiration, preferences">${esc(draft.notes)}</textarea></label>
        </div>
        <div class="card" style="margin-top:16px" id="whoBox">
          ${u ? `<div class="row">${avatar(u.name, u.id)}<div style="flex:1"><strong>${esc(u.name)}</strong><div class="small muted">${esc(u.email)}${u.phone ? ' · ' + esc(u.phone) : ''}</div></div>
                  <a class="small" href="#/account/profile">Edit</a></div>`
              : `<h3 style="font-size:19px;margin-bottom:6px">Sign in to confirm</h3>
                 <p class="small muted" style="margin-bottom:16px">Your selection is saved — you’ll come right back here.</p>
                 <div class="row">
                   <a class="btn btn-md" href="#/login?next=${encodeURIComponent('#/book')}">Sign in</a>
                   <a class="btn secondary btn-md" href="#/signup?next=${encodeURIComponent('#/book')}">Create account</a>
                   ${state.config.quick_login ? `<button class="btn gray btn-md" id="quickGuest">${ICON.bolt.replace(/22/g, '16')} One-click sign in</button>` : ''}
                 </div>`}
        </div>
        <div class="row" style="margin-top:24px"><button class="btn gray btn-md" id="back">Back</button><span class="spacer"></span>
          <button class="btn" id="confirm" ${u ? '' : 'disabled'}>Confirm booking</button></div>`;
      $('#notes', body).addEventListener('input', (e) => { draft.notes = e.target.value; saveDraft(draft); });
      $('#back', body).addEventListener('click', () => setStep(3));
      $('#quickGuest', body)?.addEventListener('click', async () => {
        await api('/api/auth/quick', { method: 'POST', body: { role: 'customer' } }).then(({ user }) => { state.user = user; renderNav(); toast(`Signed in as ${user.name}`); draw(); }).catch(toastError);
      });
      $('#confirm', body).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Booking…';
        try {
          const { booking } = await api('/api/bookings', {
            method: 'POST',
            body: { service_id: draft.service_id, stylist_id: draft.stylist_id || null, date: draft.date, time: draft.time, notes: draft.notes },
          });
          clearDraft();
          renderSuccess(booking);
        } catch (err) {
          toastError(err);
          btn.disabled = false;
          btn.textContent = 'Confirm booking';
          if (err.status === 409) { draft.time = null; setStep(3); }
        }
      });
    }
  }
  draw();
});

const canDo = (stylist, service) => {
  if (!service) return true;
  const list = (stylist.specialties || '').split(',').map((s) => s.trim()).filter(Boolean);
  return !list.length || list.includes(service.category);
};

function renderSuccess(b) {
  app.innerHTML = `
    <section class="wrap center reveal" style="padding:96px 0 120px;max-width:620px">
      <div class="success-check">${ICON.check}</div>
      <h1 class="headline">You’re booked.</h1>
      <p class="subhead">${esc(b.service_name)} with ${esc(b.stylist_name)}<br>${fmtDate(b.date)} at ${fmtTime(b.time)}</p>
      <div class="card" style="margin-top:36px;text-align:left">
        <div class="summary" style="position:static"><dl style="margin:0">
          <dt>Booking</dt><dd>#${b.id}</dd>
          <dt>Duration</dt><dd>${fmtTime(b.time)} – ${fmtTime(b.end_time)}</dd>
          <dt>Where</dt><dd>${esc(state.config.address)}</dd>
          <dt>Price</dt><dd>${money(b.price)}</dd>
        </dl></div>
      </div>
      <div class="hero-ctas">
        <a class="btn" href="/api/bookings/${b.id}/ics">Add to Calendar</a>
        <a class="btn secondary" href="#/account">View my bookings</a>
      </div>
    </section>`;
}

/* =============================================================== auth */
function authShell(inner) {
  app.innerHTML = `<section class="auth-wrap"><div class="auth-card reveal">${inner}</div></section>`;
}

function quickLoginBlock() {
  if (!state.config.quick_login) return '';
  return `
    <div class="divider">or skip the form</div>
    <button class="quick-btn" data-quick="customer">
      <span class="avatar" style="--a1:#34c759;--a2:#00a3a3">${ICON.bolt.replace(/22/g, '16')}</span>
      <span class="grow"><strong>One-click sign in</strong><span class="small muted">Continue instantly as a guest customer</span></span>${ICON.right}
    </button>`;
}
function bindQuick(next) {
  $$('[data-quick]').forEach((b) => b.addEventListener('click', () => {
    const role = b.dataset.quick;
    quickLogin(role, role === 'admin' ? '#/admin' : next);
  }));
}

on(/^#\/login(?:\?.*)?$/, async () => {
  const next = queryParam('next') || '';
  if (state.user) return go(next || (state.user.role === 'admin' ? '#/admin' : '#/account'));
  authShell(`
    <div class="center" style="margin-bottom:28px"><h1 class="title">Sign in.</h1><p class="muted" style="margin-top:8px">Manage your appointments in one place.</p></div>
    <div class="card">
      <form id="loginForm" novalidate>
        <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>
        <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
        <a href="#" class="forgot" id="forgotLink">Forgot password?</a>
        <p class="form-error" id="err"></p>
        <button class="btn block" type="submit">Continue</button>
      </form>
      ${quickLoginBlock(next)}
      <p class="center small" style="margin-top:20px">New here? <a href="#/signup${next ? `?next=${encodeURIComponent(next)}` : ''}">Create an account</a></p>
    </div>
    <p class="center small" style="margin-top:18px"><a href="#/staff">Salon staff or admin? Sign in here ›</a></p>
    <p class="center small muted" style="margin-top:8px">Demo: demo@salon.local / demo123</p>`);
  bindQuick(next);
  $('#forgotLink').addEventListener('click', (e) => {
    e.preventDefault();
    const wa = waLink(`Hi, I forgot my password for ${state.config.salon_name}. My registered email is: `);
    modal(`<h2>Forgot your password?</h2>
      <p class="muted">No problem. Message us on WhatsApp or call, and we’ll set a new password for you.</p>
      <div class="foot" style="justify-content:flex-start">
        ${wa ? `<a class="btn wa btn-md" href="${wa}" target="_blank" rel="noopener">WhatsApp us</a>` : ''}
        <a class="btn secondary btn-md" href="${telLink()}">Call ${esc(state.config.phone)}</a>
        <span class="spacer"></span><button class="btn gray btn-md" data-close>Close</button>
      </div>`);
  });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      const { user } = await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      state.user = user;
      renderNav();
      toast(`Welcome back, ${user.name.split(' ')[0]}`);
      go(next || homeFor(user));
    } catch (err) {
      $('#err').textContent = err.message;
      btn.disabled = false;
    }
  });
});

on(/^#\/staff$/, async () => {
  if (isStaffUser()) return go(homeFor(state.user));
  authShell(`
    <div class="center" style="margin-bottom:28px"><span class="tag" style="font-size:13px">Salon team</span>
      <h1 class="title" style="margin-top:10px">Staff sign in.</h1><p class="muted" style="margin-top:8px">For front desk, stylists and admins.</p></div>
    <div class="card">
      <form id="staffForm" novalidate>
        <label class="field"><span>Work email</span><input class="input" name="email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
        <p class="form-error" id="err"></p>
        <button class="btn block dark" type="submit">Sign in to workspace</button>
      </form>
      ${state.config.quick_login ? `
        <div class="divider">or one-click (demo)</div>
        <button class="quick-btn" data-quick="staff">
          <span class="avatar" style="--a1:#ff9f0a;--a2:#ff5f6d">${ICON.scissors.replace(/22/g, '16')}</span>
          <span class="grow"><strong>Staff (front desk)</strong><span class="small muted">Schedule, bookings and customers</span></span>${ICON.right}
        </button>
        <button class="quick-btn" data-quick="admin">
          <span class="avatar" style="--a1:#3f7bff;--a2:#6a3cff">${ICON.key.replace(/22/g, '16')}</span>
          <span class="grow"><strong>Admin</strong><span class="small muted">Everything, including staff and dropdown lists</span></span>${ICON.right}
        </button>` : ''}
      <p class="center small" style="margin-top:20px"><a href="#/login">Customer sign in ›</a></p>
    </div>
    <p class="center small muted" style="margin-top:16px">Demo: staff@salon.local / staff123 · admin@salon.local / admin123</p>`);
  $$('[data-quick]').forEach((b) => b.addEventListener('click', () => quickLogin(b.dataset.quick)));
  $('#staffForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      const { user } = await api('/api/auth/staff-login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      state.user = user;
      await loadOptions();
      renderNav();
      toast(`Welcome, ${user.name.split(' ')[0]}`);
      go(homeFor(user));
    } catch (err) {
      $('#err').textContent = err.message;
      btn.disabled = false;
    }
  });
});

on(/^#\/signup(?:\?.*)?$/, async () => {
  const next = queryParam('next') || '';
  if (state.user) return go(next || '#/account');
  authShell(`
    <div class="center" style="margin-bottom:28px"><h1 class="title">Create your account.</h1><p class="muted" style="margin-top:8px">One account for every visit.</p></div>
    <div class="card">
      <form id="signupForm" novalidate>
        <label class="field"><span>Full name</span><input class="input" name="name" autocomplete="name" required></label>
        <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>
        <label class="field"><span>Mobile number</span><input class="input" name="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="10-digit mobile number" required></label>
        <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="6" required></label>
        <p class="form-error" id="err"></p>
        <button class="btn block" type="submit">Create account</button>
      </form>
      ${quickLoginBlock(next)}
      <p class="center small" style="margin-top:20px">Already have an account? <a href="#/login${next ? `?next=${encodeURIComponent(next)}` : ''}">Sign in</a></p>
    </div>`);
  bindQuick(next);
  $('#signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      const { user } = await api('/api/auth/register', { method: 'POST', body });
      state.user = user;
      renderNav();
      toast(`Welcome, ${user.name.split(' ')[0]}!`);
      go(next || '#/book');
    } catch (err) {
      $('#err').textContent = err.message;
      btn.disabled = false;
    }
  });
});

/* ============================================================ account */
const isUpcoming = (b) =>
  b.status === 'confirmed' && (b.date > today() || (b.date === today() && b.start_min > (state.config.now_min ?? 0)));

on(/^#\/account(?:\/(profile|past))?$/, async (tab = 'upcoming') => {
  const u = state.user;
  app.innerHTML = `
    <section class="wrap page-head reveal">
      <div class="row" style="gap:20px">${avatar(u.name, u.id, 'lg')}
        <div style="flex:1"><h1 class="title">Hi, ${esc(u.name.split(' ')[0])}.</h1><p class="muted">${esc(u.email)}</p></div>
        <a class="btn" href="#/book">New booking</a></div>
      <div class="segmented" style="margin-top:32px" role="tablist">
        <button class="${tab === 'upcoming' ? 'on' : ''}" data-href="#/account">Upcoming</button>
        <button class="${tab === 'past' ? 'on' : ''}" data-href="#/account/past">Past</button>
        <button class="${tab === 'profile' ? 'on' : ''}" data-href="#/account/profile">Profile</button>
      </div>
    </section>
    <section class="wrap" style="padding-bottom:96px" id="acctBody"></section>`;
  $$('.segmented button').forEach((b) => b.addEventListener('click', () => go(b.dataset.href)));
  const body = $('#acctBody');

  if (tab === 'profile') return drawProfile(body);

  const all = await api('/api/bookings');
  const list = tab === 'upcoming'
    ? all.filter(isUpcoming).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    : all.filter((b) => !isUpcoming(b));
  if (!list.length) {
    body.innerHTML = `<div class="card empty"><div class="big">${tab === 'upcoming' ? '✂️' : '🗂'}</div>
      <h3>${tab === 'upcoming' ? 'No upcoming appointments' : 'No past appointments yet'}</h3>
      <p class="muted" style="margin:8px 0 20px">${tab === 'upcoming' ? 'Treat yourself — it only takes a minute.' : 'Your history will show up here.'}</p>
      <a class="btn btn-md" href="#/book">Book now</a></div>`;
    return;
  }
  body.innerHTML = `<div class="grid">${list.map((b) => `
    <div class="card booking" data-id="${b.id}">
      <div class="date-badge"><div class="m">${fmtDate(b.date, { month: 'short' })}</div><div class="d">${parseDate(b.date).getDate()}</div></div>
      <div class="grow">
        <div class="row" style="gap:8px"><h4>${esc(b.service_name)}</h4>${badge(b.status)}</div>
        <p class="muted">${fmtDate(b.date, { weekday: 'long' })} · ${fmtTime(b.time)} – ${fmtTime(b.end_time)} · ${esc(b.stylist_name)}</p>
        <p class="small muted">${money(b.price)} · Booking #${b.id}${b.notes ? ` · “${esc(b.notes)}”` : ''}</p>
      </div>
      <div class="actions">
        ${tab === 'upcoming' ? `
          <a class="btn gray btn-sm" href="/api/bookings/${b.id}/ics">Add to Calendar</a>
          <button class="btn secondary btn-sm" data-act="resched">Reschedule</button>
          <button class="btn danger btn-sm" data-act="cancel">Cancel</button>`
        : `<a class="btn secondary btn-sm" href="#/book?service=${b.service_id}">Book again</a>`}
      </div>
    </div>`).join('')}</div>`;

  $$('[data-act]', body).forEach((btn) => btn.addEventListener('click', async () => {
    const b = list.find((x) => x.id === Number(btn.closest('[data-id]').dataset.id));
    if (btn.dataset.act === 'cancel') {
      const ok = await confirmDialog({ title: 'Cancel this appointment?', text: `${b.service_name} on ${fmtDate(b.date)} at ${fmtTime(b.time)}.`, ok: 'Cancel appointment', danger: true });
      if (!ok) return;
      try { await api(`/api/bookings/${b.id}/cancel`, { method: 'PATCH' }); toast('Appointment cancelled'); render(); } catch (e) { toastError(e); }
    } else {
      rescheduleModal(b, () => render());
    }
  }));
});

function rescheduleModal(b, done, { admin = false } = {}) {
  modal(`
    <h2>Reschedule</h2>
    <p class="muted">${esc(b.service_name)} · currently ${fmtDate(b.date, { weekday: 'short', month: 'short', day: 'numeric' })} at ${fmtTime(b.time)}</p>
    <label class="field" style="margin-top:18px"><span>Stylist</span><select class="input" id="rsSty">
      <option value="">Any available</option>
      ${state.stylists.map((s) => `<option value="${s.id}" ${s.id === b.stylist_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select></label>
    <div id="rsPicker"></div>
    <div class="foot"><button class="btn gray btn-md" data-close>Close</button><button class="btn btn-md" id="rsSave" disabled>Save new time</button></div>`,
  {
    wide: true,
    onMount(m, close) {
      let picker;
      const mount = () => {
        $('#rsSave', m).disabled = true;
        picker = slotPicker($('#rsPicker', m), {
          serviceId: b.service_id,
          stylistId: $('#rsSty', m).value || null,
          exclude: b.id,
          onChange: ({ time }) => ($('#rsSave', m).disabled = !time),
        });
      };
      mount();
      $('#rsSty', m).addEventListener('change', mount);
      $('#rsSave', m).addEventListener('click', async () => {
        const { date, time } = picker.get();
        try {
          await api(`/api/bookings/${b.id}/reschedule`, { method: 'PATCH', body: { date, time, stylist_id: $('#rsSty', m).value || null } });
          toast(`Moved to ${fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric' })} at ${fmtTime(time)}`);
          close();
          done();
        } catch (e) { toastError(e); }
      });
    },
  });
  void admin;
}

function drawProfile(body) {
  const u = state.user;
  body.innerHTML = `
    <div class="grid grid-2" style="gap:24px;align-items:start">
      <form class="card" id="profForm">
        <h3 style="font-size:21px;margin-bottom:18px">Personal information</h3>
        <label class="field"><span>Full name</span><input class="input" name="name" value="${esc(u.name)}" required></label>
        <label class="field"><span>Email</span><input class="input" name="email" type="email" value="${esc(u.email)}" required></label>
        <label class="field"><span>Mobile number</span><input class="input" name="phone" type="tel" inputmode="numeric" value="${esc(u.phone || '')}" placeholder="10-digit mobile number" required></label>
        <button class="btn btn-md" type="submit">Save changes</button>
      </form>
      <form class="card" id="pwForm">
        <h3 style="font-size:21px;margin-bottom:18px">Password &amp; security</h3>
        <label class="field"><span>Current password</span><input class="input" name="current" type="password" autocomplete="current-password" required></label>
        <label class="field"><span>New password</span><input class="input" name="next" type="password" minlength="6" autocomplete="new-password" required></label>
        <button class="btn btn-md" type="submit">Update password</button>
        <div class="divider"></div>
        <button type="button" class="btn danger btn-md" id="signOut">Sign out</button>
      </form>
    </div>`;
  $('#profForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user } = await api('/api/me', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      state.user = user; renderNav(); toast('Profile saved');
    } catch (err) { toastError(err); }
  });
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/me/password', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      e.target.reset(); toast('Password updated');
    } catch (err) { toastError(err); }
  });
  $('#signOut').addEventListener('click', logout);
}

/* ============================================================== admin */
const ADMIN_NAV = [
  ['', 'Overview', 'admin'], ['schedule', 'Schedule', 'staff'], ['bookings', 'Bookings', 'staff'], ['customers', 'Customers', 'staff'],
  ['services', 'Services', 'admin'], ['team', 'Stylists', 'admin'], ['staff', 'Staff accounts', 'admin'],
  ['lists', 'Dropdown lists', 'admin'], ['settings', 'Settings', 'admin'],
];

function adminShell(section, title, actions = '') {
  app.innerHTML = `
    <div class="admin">
      <nav class="admin-side"><div class="lbl">${isAdmin() ? 'Admin' : 'Staff'} · ${esc(state.config.salon_name)}</div>
        ${ADMIN_NAV.filter(([, , r]) => isAdmin() || r === 'staff').map(([k, l]) => `<a href="#/admin${k ? '/' + k : ''}" class="${k === section ? 'on' : ''}">${l}</a>`).join('')}
      </nav>
      <div class="admin-main"><div class="head"><h1>${title}</h1>${actions}</div><div id="adminBody"></div></div>
    </div>`;
  return $('#adminBody');
}

on(/^#\/admin\/?$/, async () => {
  const body = adminShell('', 'Overview', `<button class="btn btn-md" id="newBk">New booking</button>`);
  $('#newBk').addEventListener('click', () => staffBookingModal(() => render()));
  const s = await api('/api/admin/stats');
  const myTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzBanner = state.config.timezone === 'UTC' && myTz && myTz !== 'UTC'
    ? `<div class="card flat row" style="margin-bottom:16px;border-color:var(--warn)"><span style="flex:1">The salon’s time zone is set to <strong>UTC</strong>. Use <strong>${esc(myTz)}</strong> so “today” and slot times match your clock?</span>
       <button class="btn btn-sm" id="tzFix">Use ${esc(myTz)}</button></div>` : '';
  body.innerHTML = tzBanner + `
    <div class="grid grid-4">
      ${[['Today', s.today_bookings, 'appointments'], ['Upcoming', s.upcoming, 'confirmed bookings'],
         ['This month', money(s.month_revenue), 'booked revenue'], ['Customers', s.customers, `${s.cancel_rate}% cancel rate (30d)`]]
        .map(([k, v, sub]) => `<div class="card stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('')}
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:16px;margin-top:16px" id="ovRow">
      <div class="card"><div class="chart-head"><h3>Booked revenue</h3>
        <div class="segmented" id="rangeSeg"><button data-r="ahead" class="on">Next 7 days</button><button data-r="week">Past 7 days</button></div>
        <button class="btn gray btn-sm" id="tblToggle">View as table</button></div>
        <div id="chart" style="margin-top:16px"></div></div>
      <div class="card"><h3 style="font-size:19px;margin-bottom:12px">Top services</h3>
        ${s.top_services.length ? s.top_services.map((t) => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line-soft)"><span style="flex:1">${esc(t.name)}</span><span class="muted">${t.n}</span></div>`).join('') : '<p class="muted small">No bookings yet.</p>'}
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="row" style="margin-bottom:16px"><h3 style="font-size:19px;flex:1">Today · ${fmtDate(s.today)}</h3><a href="#/admin/schedule" class="small">Open schedule ›</a></div>
      <div class="schedule">${s.schedule.length ? s.schedule.map((b) => `
        <div class="slot-row"><div class="t">${fmtTime(b.time)}</div>
          <div class="card flat row" data-bid="${b.id}" style="cursor:pointer"><div style="flex:1"><strong>${esc(b.customer_name)}</strong>
          <div class="small muted">${esc(b.service_name)} · ${esc(b.stylist_name)} · until ${fmtTime(b.end_time)}</div></div>${badge(b.status)}</div></div>`).join('')
        : '<p class="muted">No appointments today.</p>'}</div>
    </div>`;
  $('#tzFix')?.addEventListener('click', async () => {
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { timezone: myTz } });
      state.config = await api('/api/config');
      toast(`Time zone set to ${myTz}`);
      render();
    } catch (e) { toastError(e); }
  });
  if (matchMedia('(max-width: 900px)').matches) $('#ovRow').style.gridTemplateColumns = '1fr';
  let asTable = false;
  let range = 'ahead';
  const drawChart = () => {
    const data = s[range];
    if (!data.some((d) => d.bookings)) {
      $('#chart').innerHTML = `<div class="empty small" style="padding:72px 0">No bookings ${range === 'ahead' ? 'in the next 7 days yet' : 'in the past 7 days'}.</div>`;
    } else if (asTable) {
      $('#chart').innerHTML = revenueTable(data);
    } else {
      barChart($('#chart'), data);
    }
    $('#tblToggle').textContent = asTable ? 'View as chart' : 'View as table';
  };
  $('#tblToggle').addEventListener('click', () => { asTable = !asTable; drawChart(); });
  $$('#rangeSeg button').forEach((b) => b.addEventListener('click', () => {
    range = b.dataset.r;
    $$('#rangeSeg button').forEach((x) => x.classList.toggle('on', x === b));
    drawChart();
  }));
  drawChart();
  $$('[data-bid]', body).forEach((el) => el.addEventListener('click', () => bookingDetail(s.schedule.find((b) => b.id === Number(el.dataset.bid)), () => render())));
});

function revenueTable(week) {
  return `<table><thead><tr><th>Day</th><th class="num">Bookings</th><th class="num">Revenue</th></tr></thead><tbody>
    ${week.map((d) => `<tr><td>${fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}</td><td class="num">${d.bookings}</td><td class="num">${money(d.revenue)}</td></tr>`).join('')}
  </tbody></table>`;
}

/** Single-series bar chart: thin rounded bars, recessive grid, hover tooltip, selective labels. */
function barChart(root, week) {
  const W = 600, H = 200, padL = 44, padB = 26, padT = 18;
  const max = Math.max(1, ...week.map((d) => d.revenue));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const bw = (W - padL) / week.length;
  const barW = Math.min(36, bw * 0.5);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const ticks = [0, top / 2, top];
  const maxIdx = week.findIndex((d) => d.revenue === max && max > 0);
  root.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue for the last 7 days">
    ${ticks.map((t) => `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${money(t)}</text>`).join('')}
    ${week.map((d, i) => {
      const x = padL + i * bw + (bw - barW) / 2;
      const h = Math.max(0, y(0) - y(d.revenue));
      const r = Math.min(4, h);
      const path = h > 0 ? `M${x},${y(0)} V${y(d.revenue) + r} Q${x},${y(d.revenue)} ${x + r},${y(d.revenue)} H${x + barW - r} Q${x + barW},${y(d.revenue)} ${x + barW},${y(d.revenue) + r} V${y(0)} Z` : '';
      const label = fmtDate(d.date, { weekday: 'short' });
      return `${path ? `<path class="bar" d="${path}"/>` : ''}
        ${(i === maxIdx || d.date === today()) && d.revenue > 0 ? `<text class="val" x="${x + barW / 2}" y="${y(d.revenue) - 6}" text-anchor="middle">${money(d.revenue)}</text>` : ''}
        <text class="axis" x="${x + barW / 2}" y="${H - 6}" text-anchor="middle">${d.date === today() ? 'Today' : label}</text>
        <rect class="hit" data-i="${i}" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}"/>`;
    }).join('')}
  </svg><div class="chart-tip"></div></div>`;
  const tip = $('.chart-tip', root);
  const svg = $('svg', root);
  $$('.hit', root).forEach((r) => {
    r.addEventListener('mouseenter', () => {
      const d = week[Number(r.dataset.i)];
      const box = svg.getBoundingClientRect();
      const sx = box.width / W;
      tip.innerHTML = `<strong>${fmtDate(d.date, { weekday: 'long', month: 'short', day: 'numeric' })}</strong><br>${money(d.revenue)} · ${d.bookings} booking${d.bookings === 1 ? '' : 's'}`;
      tip.style.left = `${(Number(r.getAttribute('x')) + bw / 2) * sx}px`;
      tip.style.top = `${y(d.revenue) * (box.height / H)}px`;
      tip.style.opacity = 1;
    });
    r.addEventListener('mouseleave', () => (tip.style.opacity = 0));
  });
}

function bookingDetail(b, done) {
  const statusItems = Object.entries(statusLabel).map(([value, label]) => ({ value, label }));
  modal(`
    <div class="row"><h2 style="flex:1">${esc(b.customer_name)}</h2>${badge(b.status)}</div>
    <p class="muted">${b.customer_phone ? `<a href="tel:${esc(b.customer_phone.replace(/\s/g, ''))}">${esc(b.customer_phone)}</a>` : ''}${b.customer_email && !b.customer_email.endsWith('@guest.local') ? ` · ${esc(b.customer_email)}` : ''}</p>
    <div class="summary" style="position:static"><dl>
      <dt>Service</dt><dd>${esc(b.service_name)}</dd>
      <dt>Stylist</dt><dd>${esc(b.stylist_name)}</dd>
      <dt>When</dt><dd>${fmtDate(b.date, { weekday: 'short', month: 'short', day: 'numeric' })}, ${fmtTime(b.time)} – ${fmtTime(b.end_time)}</dd>
      <dt>Price</dt><dd>${money(b.price)}</dd>
      <dt>Source</dt><dd>${esc(b.source || 'Online')}</dd>
      ${b.payment_method ? `<dt>Payment</dt><dd>${esc(b.payment_method)}</dd>` : ''}
      ${b.status_reason ? `<dt>Reason</dt><dd>${esc(b.status_reason)}</dd>` : ''}
      ${b.notes ? `<dt>Notes</dt><dd>${esc(b.notes)}</dd>` : ''}
      <dt>Booking</dt><dd>#${b.id}</dd>
    </dl></div>
    <div class="card flat" style="padding:16px">
      <h3 style="font-size:16px;margin-bottom:12px">Update booking</h3>
      <div class="grid grid-2" style="gap:0 12px">
        <label class="field"><span>Status</span>${selectHTML('bdStatus', statusItems, { value: b.status })}</label>
        <label class="field" id="bdPayWrap"><span>Payment method</span>${selectHTML('bdPay', opts('payment'), { placeholder: 'Choose…', value: b.payment_method })}</label>
        <label class="field" id="bdReasonWrap"><span>Reason</span>${selectHTML('bdReason', opts('reason'), { placeholder: 'Choose…', value: b.status_reason })}</label>
      </div>
    </div>
    <div class="foot">
      ${b.status === 'confirmed' ? '<button class="btn gray btn-md" id="adResched" style="margin-right:auto">Reschedule</button>' : ''}
      <button class="btn gray btn-md" data-close>Close</button><button class="btn btn-md" id="bdSave">Save</button>
    </div>`,
  {
    onMount(m, close) {
      const sync = () => {
        const st = $('#bdStatus', m).value;
        $('#bdPayWrap', m).classList.toggle('hidden', st !== 'completed');
        $('#bdReasonWrap', m).classList.toggle('hidden', !['cancelled', 'no_show'].includes(st));
      };
      sync();
      $('#bdStatus', m).addEventListener('change', sync);
      $('#bdSave', m).addEventListener('click', async () => {
        try {
          await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { status: $('#bdStatus', m).value, payment_method: $('#bdPay', m).value, status_reason: $('#bdReason', m).value } });
          toast('Booking updated');
          close(); done();
        } catch (e) { toastError(e); }
      });
      $('#adResched', m)?.addEventListener('click', () => { close(); rescheduleModal(b, done, { admin: true }); });
    },
  });
}

async function staffBookingModal(done) {
  const customers = await api('/api/admin/customers');
  const svcItems = state.services.map((s) => ({ value: s.id, label: `${s.name} · ${fmtDuration(s.duration_min)} · ${money(s.price)}`, group: s.category }));
  const custItems = [{ value: 'new', label: '+ New customer' }, ...customers.map((c) => ({ value: c.id, label: `${c.name}${c.phone ? ` · ${c.phone}` : ''}` }))];
  const mine = state.user?.stylist_id;
  modal(`
    <h2>New booking</h2><p class="muted">For walk-ins, phone and WhatsApp bookings.</p>
    <div class="grid grid-2" style="margin-top:18px;gap:0 12px">
      <label class="field"><span>Customer</span>${selectHTML('nbCust', custItems, { value: 'new' })}</label>
      <label class="field"><span>Booked via</span>${selectHTML('nbSource', opts('source'), { value: opts('source')[0] })}</label>
    </div>
    <div class="grid grid-3" id="nbNewCust" style="gap:0 12px">
      <label class="field"><span>Name</span><input class="input input-sm" id="nbName" autocomplete="off"></label>
      <label class="field"><span>Mobile</span><input class="input input-sm" id="nbPhone" type="tel" inputmode="numeric" placeholder="10 digits"></label>
      <label class="field"><span>Email (optional)</span><input class="input input-sm" id="nbEmail" type="email"></label>
    </div>
    <div class="grid grid-2" style="gap:0 12px">
      <label class="field"><span>Service</span>${selectHTML('nbSvc', svcItems)}</label>
      <label class="field"><span>Stylist</span>${selectHTML('nbSty', state.stylists.map((s) => ({ value: s.id, label: s.name })), { placeholder: 'Any available', value: mine || '' })}</label>
    </div>
    <div id="nbPicker"></div>
    <label class="field" style="margin-top:16px"><span>Notes</span><input class="input input-sm" id="nbNotes"></label>
    <div class="foot"><button class="btn gray btn-md" data-close>Cancel</button><button class="btn btn-md" id="nbSave" disabled>Create booking</button></div>`,
  {
    wide: true,
    onMount(m, close) {
      const syncCust = () => $('#nbNewCust', m).classList.toggle('hidden', $('#nbCust', m).value !== 'new');
      syncCust();
      $('#nbCust', m).addEventListener('change', syncCust);
      let picker;
      const mount = () => {
        $('#nbSave', m).disabled = true;
        picker = slotPicker($('#nbPicker', m), {
          serviceId: $('#nbSvc', m).value,
          stylistId: $('#nbSty', m).value || null,
          onChange: ({ time }) => ($('#nbSave', m).disabled = !time),
        });
      };
      mount();
      $('#nbSvc', m).addEventListener('change', mount);
      $('#nbSty', m).addEventListener('change', mount);
      $('#nbSave', m).addEventListener('click', async () => {
        const { date, time } = picker.get();
        const cust = $('#nbCust', m).value;
        try {
          await api('/api/admin/bookings', { method: 'POST', body: {
            customer_id: cust === 'new' ? null : Number(cust),
            customer_name: $('#nbName', m).value, customer_phone: $('#nbPhone', m).value, customer_email: $('#nbEmail', m).value,
            source: $('#nbSource', m).value,
            service_id: Number($('#nbSvc', m).value), stylist_id: $('#nbSty', m).value || null, date, time, notes: $('#nbNotes', m).value,
          } });
          toast('Booking created'); close(); done();
        } catch (e) { toastError(e); }
      });
    },
  });
}

/* ---- schedule (day board per stylist) */
on(/^#\/admin\/schedule(?:\?.*)?$/, async () => {
  const date = queryParam('date') || today();
  const body = adminShell('schedule', 'Schedule', `
    <button class="icon-btn" id="prevD" aria-label="Previous day">${ICON.left}</button>
    <input class="input input-sm" type="date" id="pickD" value="${date}" style="width:auto">
    <button class="icon-btn" id="nextD" aria-label="Next day">${ICON.right}</button>
    <button class="btn gray btn-sm" id="todayD">Today</button>
    <button class="btn btn-md" id="newBk">New booking</button>`);
  const goDate = (d) => go(`#/admin/schedule?date=${d}`);
  $('#prevD').addEventListener('click', () => goDate(addDays(date, -1)));
  $('#nextD').addEventListener('click', () => goDate(addDays(date, 1)));
  $('#todayD').addEventListener('click', () => goDate(today()));
  $('#pickD').addEventListener('change', (e) => e.target.value && goDate(e.target.value));
  $('#newBk').addEventListener('click', () => staffBookingModal(() => render()));

  const bookings = await api(`/api/admin/bookings?from=${date}&to=${date}`);
  const settings = state.config;
  const active = state.stylists;
  const h = settings.closed_dates.includes(date) ? null : settings.hours[parseDate(date).getDay()];
  const live = bookings.filter((b) => b.status !== 'cancelled');
  const toMin = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
  const open = h ? toMin(h.open) : 540;
  const close = h ? toMin(h.close) : 1080;
  const startH = Math.floor(Math.min(open, ...live.map((b) => b.start_min)) / 60) * 60;
  const endH = Math.ceil(Math.max(close, ...live.map((b) => b.end_min)) / 60) * 60;
  const PX = 1.4;
  const height = (endH - startH) * PX;

  body.innerHTML = `
    <p class="muted" style="margin-bottom:16px">${fmtDate(date)} · ${h ? `Open ${fmtTime(h.open)} – ${fmtTime(h.close)}` : '<strong>Closed</strong>'} · ${live.length} appointment${live.length === 1 ? '' : 's'}</p>
    <div style="overflow-x:auto"><div class="day-board" style="grid-template-columns:64px repeat(${active.length}, minmax(150px,1fr));min-width:${64 + active.length * 150}px">
      <div class="col-head"></div>
      ${active.map((s) => `<div class="col-head">${esc(s.name)}</div>`).join('')}
      <div class="gutter" style="height:${height}px">
        ${[...Array((endH - startH) / 60 + 1)].map((_, i) => `<div class="hr" style="top:${i * 60 * PX}px;border:0"><span>${fmtTime(`${pad(startH / 60 + i)}:00`)}</span></div>`).join('')}
      </div>
      ${active.map((s) => `<div class="col" style="height:${height}px">
        ${[...Array((endH - startH) / 60)].map((_, i) => `<div class="hr" style="top:${i * 60 * PX}px"></div>`).join('')}
        ${live.filter((b) => b.stylist_id === s.id).map((b) => `
          <div class="appt ${b.status}" data-bid="${b.id}" style="top:${(b.start_min - startH) * PX}px;height:${(b.end_min - b.start_min) * PX - 2}px">
            <strong>${esc(b.customer_name)}</strong>${fmtTime(b.time)} · ${esc(b.service_name)}</div>`).join('')}
      </div>`).join('')}
    </div></div>`;
  $$('[data-bid]', body).forEach((el) => el.addEventListener('click', () => bookingDetail(live.find((b) => b.id === Number(el.dataset.bid)), () => render())));
});

/* ---- bookings table */
on(/^#\/admin\/bookings$/, async () => {
  const body = adminShell('bookings', 'Bookings', `<button class="btn btn-md" id="newBk">New booking</button>`);
  $('#newBk').addEventListener('click', () => staffBookingModal(() => load()));
  body.innerHTML = `
    <div class="filters">
      <input class="input input-sm" id="fQ" placeholder="Search customer or service" style="min-width:220px">
      <select class="input input-sm" id="fRange">
        <option value="upcoming">Upcoming</option><option value="today">Today</option><option value="week">Next 7 days</option>
        <option value="past">Past 30 days</option><option value="all">All</option></select>
      <select class="input input-sm" id="fStatus"><option value="">Any status</option>
        ${Object.entries(statusLabel).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <select class="input input-sm" id="fSty"><option value="">All stylists</option>${state.stylists.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <span class="spacer"></span><span class="small muted" id="fCount"></span>
    </div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th class="num">Status</th><th>Customer</th><th>Service · Stylist</th><th>Price</th></tr></thead>
    <tbody id="bkRows"></tbody></table></div>`;
  let rows = [];
  async function load() {
    const q = new URLSearchParams();
    const r = $('#fRange').value;
    const t = today();
    if (r === 'upcoming') q.set('from', t);
    if (r === 'today') { q.set('from', t); q.set('to', t); }
    if (r === 'week') { q.set('from', t); q.set('to', addDays(t, 7)); }
    if (r === 'past') { q.set('from', addDays(t, -30)); q.set('to', addDays(t, -1)); }
    if ($('#fStatus').value) q.set('status', $('#fStatus').value);
    if ($('#fSty').value) q.set('stylist_id', $('#fSty').value);
    if ($('#fQ').value.trim()) q.set('q', $('#fQ').value.trim());
    rows = await api(`/api/admin/bookings?${q}`);
    if (r === 'upcoming' || r === 'week' || r === 'today') rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    $('#fCount').textContent = `${rows.length} booking${rows.length === 1 ? '' : 's'}`;
    $('#bkRows').innerHTML = rows.length ? rows.map((b) => `
      <tr data-bid="${b.id}" style="cursor:pointer">
        <td><strong>${fmtDate(b.date, { weekday: 'short', month: 'short', day: 'numeric' })}</strong><div class="sub">${fmtTime(b.time)} – ${fmtTime(b.end_time)}</div></td>
        <td class="num">${badge(b.status)}</td>
        <td class="span">${esc(b.customer_name)}<div class="sub">${esc(b.customer_phone || b.customer_email)}</div></td>
        <td class="span" data-label="Service">${esc(b.service_name)} · ${esc(b.stylist_name)}</td>
        <td class="span" data-label="Price">${money(b.price)}<div class="sub">${esc(b.source || 'Online')}${b.payment_method ? ' · ' + esc(b.payment_method) : ''}</div></td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">No bookings match these filters.</td></tr>`;
    $$('[data-bid]', body).forEach((tr) => tr.addEventListener('click', () => bookingDetail(rows.find((b) => b.id === Number(tr.dataset.bid)), load)));
  }
  let t;
  $('#fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  ['fRange', 'fStatus', 'fSty'].forEach((id) => $('#' + id).addEventListener('change', load));
  load();
});

/* ---- generic CRUD for services & team */
function crudPage({ section, title, endpoint, columns, fields, blank, after }) {
  return async () => {
    const body = adminShell(section, title, `<button class="btn btn-md" id="addBtn">Add</button>`);
    const load = async () => {
      const items = await api(endpoint);
      body.innerHTML = `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th class="${c.cls || ''}">${c.label}</th>`).join('')}<th></th></tr></thead>
        <tbody>${items.map((it) => `<tr style="${it.active ? '' : 'opacity:.5'}">${columns.map((c, i) => `<td class="${c.cls || ''} ${i === 0 ? 'span' : ''}" ${i ? `data-label="${c.label}"` : ''}>${c.render(it)}</td>`).join('')}
          <td class="num span"><button class="btn gray btn-sm" data-edit="${it.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>`;
      $$('[data-edit]', body).forEach((b) => b.addEventListener('click', () => edit(items.find((i) => i.id === Number(b.dataset.edit)))));
    };
    const edit = (item) => {
      const isNew = !item;
      item = item || blank;
      modal(`<h2>${isNew ? 'Add' : 'Edit'} ${title.toLowerCase().replace(/s$/, '')}</h2>
        <form id="crudForm" style="margin-top:16px">
          ${fields.map((f) => f.type === 'select'
            ? `<label class="field"><span>${f.label}</span>${selectHTML(f.name, f.options(), { cls: 'input', value: item[f.name] ?? '', placeholder: f.placeholder })}</label>`
            : f.type === 'checks'
            ? `<div class="field"><span>${f.label}</span><div class="checks">${f.options().map((o) => `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(o)}" ${(item[f.name] || '').split(',').map((x) => x.trim()).includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div>${f.hint ? `<span class="small muted" style="margin:6px 4px 0;display:block">${f.hint}</span>` : ''}</div>`
            : f.type === 'switch'
            ? `<label class="row field" style="justify-content:space-between"><span style="margin:0">${f.label}</span><span class="switch"><input type="checkbox" name="${f.name}" ${item[f.name] ? 'checked' : ''}><i></i></span></label>`
            : f.type === 'textarea'
              ? `<label class="field"><span>${f.label}</span><textarea class="input" name="${f.name}">${esc(item[f.name])}</textarea></label>`
              : `<label class="field"><span>${f.label}</span><input class="input" name="${f.name}" type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''} value="${esc(item[f.name])}" ${f.list ? `list="${f.name}List"` : ''}>${f.list ? `<datalist id="${f.name}List">${f.list().map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : ''}${f.hint ? `<span class="small muted" style="margin:6px 4px 0;display:block">${f.hint}</span>` : ''}</label>`).join('')}
          <div class="foot">${isNew ? '' : '<button type="button" class="btn danger btn-md" id="delBtn" style="margin-right:auto">Remove</button>'}
            <button type="button" class="btn gray btn-md" data-close>Cancel</button><button class="btn btn-md" type="submit">Save</button></div>
        </form>`, {
        onMount(m, close) {
          $('#crudForm', m).addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.target));
            fields.filter((f) => f.type === 'switch').forEach((f) => (data[f.name] = e.target[f.name].checked));
            fields.filter((f) => f.type === 'checks').forEach((f) => (data[f.name] = $$(`input[name="${f.name}"]:checked`, e.target).map((i) => i.value).join(',')));
            try {
              await api(isNew ? endpoint : `${endpoint}/${item.id}`, { method: isNew ? 'POST' : 'PUT', body: data });
              toast('Saved'); close(); await after(); load();
            } catch (err) { toastError(err); }
          });
          $('#delBtn', m)?.addEventListener('click', async () => {
            try {
              const r = await api(`${endpoint}/${item.id}`, { method: 'DELETE' });
              toast(r.archived ? 'Has past bookings — archived instead' : 'Removed'); close(); await after(); load();
            } catch (err) { toastError(err); }
          });
        },
      });
    };
    $('#addBtn').addEventListener('click', () => edit(null));
    load();
  };
}

const reloadCatalog = async () => {
  [state.services, state.stylists] = await Promise.all([api('/api/services'), api('/api/stylists')]);
};
const categories = () => [...new Set([...(state.config?.category_order || []), ...state.services.map((s) => s.category)])];

on(/^#\/admin\/services$/, crudPage({
  section: 'services', title: 'Services', endpoint: '/api/admin/services', after: reloadCatalog,
  blank: { name: '', category: 'Hair', description: '', duration_min: 30, price: 0, active: 1 },
  columns: [
    { label: 'Service', render: (s) => `<strong>${esc(s.name)}</strong><div class="sub">${esc(s.description)}</div>` },
    { label: 'Category', render: (s) => `<span class="tag">${esc(s.category)}</span>` },
    { label: 'Duration', render: (s) => fmtDuration(s.duration_min) },
    { label: 'Price', cls: 'num', render: (s) => money(s.price) },
    { label: 'Status', render: (s) => (s.active ? 'Live' : 'Hidden') },
  ],
  fields: [
    { name: 'name', label: 'Name' },
    { name: 'category', label: 'Category', type: 'select', options: () => opts('category') },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'duration_min', label: 'Duration (minutes)', type: 'number' },
    { name: 'price', label: 'Price', type: 'number', step: '0.01' },
    { name: 'active', label: 'Bookable online', type: 'switch' },
  ],
}), 'admin');

on(/^#\/admin\/team$/, crudPage({
  section: 'team', title: 'Stylists', endpoint: '/api/admin/stylists', after: reloadCatalog,
  blank: { name: '', title: '', bio: '', specialties: '', active: 1 },
  columns: [
    { label: 'Stylist', render: (s) => `<div class="row" style="flex-wrap:nowrap">${avatar(s.name, s.id)}<div><strong>${esc(s.name)}</strong><div class="sub">${esc(s.title)}</div></div></div>` },
    { label: 'Specialties', render: (s) => (s.specialties || 'All services').split(',').map((t) => `<span class="tag">${esc(t)}</span>`).join('') },
    { label: 'Status', render: (s) => (s.active ? 'Active' : 'Inactive') },
  ],
  fields: [
    { name: 'name', label: 'Name' },
    { name: 'title', label: 'Title' },
    { name: 'bio', label: 'Short bio', type: 'textarea' },
    { name: 'specialties', label: 'Can do these categories', type: 'checks', options: () => opts('category'), hint: 'Tick none to allow all services.' },
    { name: 'active', label: 'Taking bookings', type: 'switch' },
  ],
}), 'admin');

/* ---- customers */
on(/^#\/admin\/customers$/, async () => {
  const body = adminShell('customers', 'Customers');
  body.innerHTML = `<div class="filters"><input class="input input-sm" id="cQ" placeholder="Search name, email or phone" style="min-width:260px"><span class="spacer"></span><span class="small muted" id="cCount"></span></div>
    <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Mobile</th><th class="num">Bookings</th><th class="num">Spent</th><th>Last visit</th><th></th></tr></thead><tbody id="cRows"></tbody></table></div>`;
  const load = async () => {
    const list = await api(`/api/admin/customers?q=${encodeURIComponent($('#cQ').value.trim())}`);
    $('#cCount').textContent = `${list.length} customer${list.length === 1 ? '' : 's'}`;
    $('#cRows').innerHTML = list.map((c) => `<tr>
      <td><div class="row" style="flex-wrap:nowrap">${avatar(c.name, c.id)}<div><strong>${esc(c.name)}</strong><div class="sub">${esc(c.email)}</div></div></div></td>
      <td data-label="Mobile">${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s/g, ''))}">${esc(c.phone)}</a>` : '—'}</td>
      <td class="num" data-label="Bookings">${c.bookings}</td><td class="num" data-label="Spent">${money(c.spent)}</td>
      <td data-label="Last visit">${c.last_visit ? fmtDate(c.last_visit, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
      <td class="num">${isAdmin() ? `<button class="btn gray btn-sm" data-reset="${c.id}" data-name="${esc(c.name)}">Reset password</button>` : ''}</td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">No customers found.</td></tr>';
    $$('[data-reset]', body).forEach((b) => b.addEventListener('click', () => modal(`
      <h2>Reset password</h2><p class="muted">Set a new password for ${b.dataset.name}. They’ll be signed out everywhere.</p>
      <form id="rpForm" style="margin-top:16px"><label class="field"><span>New password</span>
        <input class="input" name="password" type="text" minlength="6" required autocomplete="off"></label>
        <div class="foot"><button type="button" class="btn gray btn-md" data-close>Cancel</button><button class="btn btn-md">Save password</button></div></form>`, {
      onMount(m, close) {
        $('#rpForm', m).addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            await api(`/api/admin/customers/${b.dataset.reset}/password`, { method: 'PUT', body: { password: e.target.password.value } });
            toast('Password updated — share it with the customer'); close();
          } catch (err) { toastError(err); }
        });
      },
    })));
  };
  let t;
  $('#cQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  load();
}, 'admin');

/* ---- settings */
on(/^#\/admin\/settings$/, async () => {
  const body = adminShell('settings', 'Settings');
  const s = await api('/api/admin/settings');
  const dayName = (d) => new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: 'long' });
  let closed = [...s.closed_dates];
  body.innerHTML = `
    <form id="setForm" class="grid" style="gap:16px;max-width:820px">
      <div class="card"><h3 style="font-size:19px;margin-bottom:16px">Salon</h3>
        <div class="grid grid-2" style="gap:0 16px">
          ${[['salon_name', 'Name'], ['tagline', 'Tagline'], ['quote', 'Home page quote'], ['address', 'Address'], ['phone', 'Phone'], ['whatsapp', 'WhatsApp number'], ['email', 'Email'], ['instagram', 'Instagram handle (optional)'], ['map_url', 'Google Maps link (optional)'], ['currency', 'Currency (ISO code, e.g. USD, INR, EUR)']]
            .map(([k, l]) => `<label class="field"><span>${l}</span><input class="input input-sm" name="${k}" value="${esc(s[k])}"></label>`).join('')}
          <label class="field"><span>Time zone (used for “today” and slot times)</span>
            <span class="row" style="flex-wrap:nowrap;gap:8px"><input class="input input-sm" name="timezone" id="tzIn" value="${esc(s.timezone)}" list="tzList">
            <button type="button" class="btn gray btn-sm" id="tzMine">Use mine</button></span></label>
          <datalist id="tzList">${(Intl.supportedValuesOf?.('timeZone') || []).map((z) => `<option value="${z}">`).join('')}</datalist>
        </div></div>
      <div class="card"><h3 style="font-size:19px;margin-bottom:8px">Opening hours</h3>
        ${[1, 2, 3, 4, 5, 6, 0].map((d) => {
          const h = s.hours[d];
          return `<div class="hours-row" data-d="${d}"><strong>${dayName(d)}</strong>
            <span class="switch"><input type="checkbox" class="hOpen" ${h ? 'checked' : ''} aria-label="Open on ${dayName(d)}"><i></i></span>
            <input class="input input-sm hFrom" type="time" value="${h?.open || '10:00'}" ${h ? '' : 'disabled'}>
            <input class="input input-sm hTo" type="time" value="${h?.close || '18:00'}" ${h ? '' : 'disabled'}></div>`;
        }).join('')}</div>
      <div class="card"><h3 style="font-size:19px;margin-bottom:8px">Holidays &amp; closed dates</h3>
        <div class="row" style="margin-bottom:12px"><input class="input input-sm" type="date" id="cdNew" style="width:auto"><button type="button" class="btn gray btn-sm" id="cdAdd">Add date</button></div>
        <div id="cdList"></div></div>
      <div class="card"><h3 style="font-size:19px;margin-bottom:16px">Booking rules</h3>
        <div class="grid grid-3" style="gap:0 16px">
          <label class="field"><span>Slot interval (min)</span><input class="input input-sm" type="number" name="slot_interval" value="${s.slot_interval}"></label>
          <label class="field"><span>Change cut-off (hours)</span><input class="input input-sm" type="number" name="cancel_cutoff_hours" value="${s.cancel_cutoff_hours}"></label>
          <label class="field"><span>Book up to (days ahead)</span><input class="input input-sm" type="number" name="max_days_ahead" value="${s.max_days_ahead}"></label>
        </div></div>
      <div><button class="btn" type="submit">Save settings</button></div>
    </form>`;
  const drawClosed = () => {
    $('#cdList').innerHTML = closed.length
      ? closed.map((d) => `<span class="tag" style="font-size:14px;padding:6px 6px 6px 12px">${fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} <button type="button" class="icon-btn" data-rm="${d}" aria-label="Remove" style="padding:0 6px">×</button></span>`).join('')
      : '<p class="small muted">No closures scheduled.</p>';
    $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { closed = closed.filter((x) => x !== b.dataset.rm); drawClosed(); }));
  };
  drawClosed();
  $('#tzMine').addEventListener('click', () => ($('#tzIn').value = Intl.DateTimeFormat().resolvedOptions().timeZone));
  $('#cdAdd').addEventListener('click', () => {
    const v = $('#cdNew').value;
    if (v && !closed.includes(v)) { closed.push(v); closed.sort(); drawClosed(); }
  });
  $$('.hOpen').forEach((c) => c.addEventListener('change', () => {
    const row = c.closest('.hours-row');
    $$('input[type=time]', row).forEach((i) => (i.disabled = !c.checked));
  }));
  $('#setForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    data.hours = {};
    $$('.hours-row').forEach((r) => {
      data.hours[r.dataset.d] = $('.hOpen', r).checked ? { open: $('.hFrom', r).value, close: $('.hTo', r).value } : null;
    });
    data.closed_dates = closed;
    try {
      await api('/api/admin/settings', { method: 'PUT', body: data });
      state.config = await api('/api/config');
      applyBranding();
      toast('Settings saved');
    } catch (err) { toastError(err); }
  });
}, 'admin');

/* ---- staff accounts (admin) */
on(/^#\/admin\/staff$/, async () => {
  const body = adminShell('staff', 'Staff accounts', `<button class="btn btn-md" id="addStaff">Add staff</button>`);
  const roleItems = [{ value: 'staff', label: 'Staff — schedule, bookings, customers' }, { value: 'admin', label: 'Admin — full access' }];
  const styItems = state.stylists.map((s) => ({ value: s.id, label: s.name }));
  const load = async () => {
    const list = await api('/api/admin/staff');
    body.innerHTML = `<p class="muted" style="margin-bottom:16px">Staff sign in at <a href="#/staff">${esc(location.host)}/#/staff</a>. Staff can manage the schedule, bookings and customers; only admins can change services, stylists, staff, dropdown lists and settings.</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Linked stylist</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((u) => `<tr style="${u.active ? '' : 'opacity:.5'}">
        <td class="span"><div class="row" style="flex-wrap:nowrap">${avatar(u.name, u.id)}<div><strong>${esc(u.name)}</strong>${u.id === state.user.id ? ' <span class="tag">You</span>' : ''}<div class="sub">${esc(u.email)}${u.phone ? ' · ' + esc(u.phone) : ''}</div></div></div></td>
        <td data-label="Role"><span class="tag">${u.role === 'admin' ? 'Admin' : 'Staff'}</span></td>
        <td data-label="Stylist">${esc(u.stylist_name || '—')}</td>
        <td data-label="Status">${u.active ? 'Active' : 'Disabled'}</td>
        <td class="num span"><button class="btn gray btn-sm" data-edit="${u.id}">Edit</button></td></tr>`).join('')}
      </tbody></table></div>`;
    $$('[data-edit]', body).forEach((b) => b.addEventListener('click', () => edit(list.find((u) => u.id === Number(b.dataset.edit)))));
  };
  const edit = (u) => {
    const isNew = !u;
    u = u || { name: '', email: '', phone: '', role: 'staff', stylist_id: '', active: 1 };
    modal(`<h2>${isNew ? 'Add staff member' : 'Edit ' + esc(u.name)}</h2>
      <form id="stForm" style="margin-top:16px">
        <label class="field"><span>Full name</span><input class="input" name="name" value="${esc(u.name)}" required></label>
        <label class="field"><span>Work email (used to sign in)</span><input class="input" name="email" type="email" value="${esc(u.email)}" ${isNew ? 'required' : 'disabled'}></label>
        <label class="field"><span>Mobile (optional)</span><input class="input" name="phone" type="tel" inputmode="numeric" value="${esc(u.phone || '')}"></label>
        <label class="field"><span>Role</span>${selectHTML('role', roleItems, { cls: 'input', value: u.role })}</label>
        <label class="field"><span>Linked stylist (optional)</span>${selectHTML('stylist_id', styItems, { cls: 'input', placeholder: 'Not a stylist', value: u.stylist_id || '' })}</label>
        <label class="field"><span>${isNew ? 'Password' : 'New password (leave empty to keep)'}</span><input class="input" name="password" type="text" autocomplete="off" ${isNew ? 'required minlength="6"' : ''}></label>
        ${isNew ? '' : `<label class="row field" style="justify-content:space-between"><span style="margin:0">Account active</span><span class="switch"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}><i></i></span></label>`}
        <div class="foot">${isNew ? '' : '<button type="button" class="btn danger btn-md" id="stDel" style="margin-right:auto">Remove</button>'}
          <button type="button" class="btn gray btn-md" data-close>Cancel</button><button class="btn btn-md">Save</button></div>
      </form>`, {
      onMount(m, close) {
        $('#stForm', m).addEventListener('submit', async (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.target));
          if (!isNew) data.active = e.target.active.checked;
          try {
            await api(isNew ? '/api/admin/staff' : `/api/admin/staff/${u.id}`, { method: isNew ? 'POST' : 'PUT', body: data });
            toast(isNew ? 'Staff member added' : 'Saved'); close(); load();
          } catch (err) { toastError(err); }
        });
        $('#stDel', m)?.addEventListener('click', async () => {
          if (!(await confirmDialog({ title: `Remove ${u.name}?`, text: 'They will no longer be able to sign in.', ok: 'Remove', danger: true }))) return;
          try { await api(`/api/admin/staff/${u.id}`, { method: 'DELETE' }); toast('Removed'); load(); } catch (err) { toastError(err); }
        });
      },
    });
  };
  $('#addStaff').addEventListener('click', () => edit(null));
  load();
});

/* ---- dropdown lists (admin) */
on(/^#\/admin\/lists$/, async () => {
  const body = adminShell('lists', 'Dropdown lists');
  const hints = {
    category: 'Used to group services on the website and in the service editor. Order here = order on the site.',
    source: 'Shown to staff when creating a booking (“Booked via”).',
    payment: 'Staff choose one when marking a booking completed.',
    reason: 'Staff choose one when cancelling or marking a no-show.',
  };
  const load = async () => {
    const { lists, options } = await api('/api/admin/options');
    body.innerHTML = `<p class="muted" style="margin-bottom:16px">Everything staff pick from a dropdown comes from these lists. Add, rename, reorder, hide or remove options at any time.</p>
      <div class="grid grid-2" style="gap:16px;align-items:start">
      ${Object.entries(lists).map(([key, title]) => `
        <div class="card">
          <h3 style="font-size:19px">${esc(title)}</h3>
          <p class="small muted" style="margin:4px 0 14px">${hints[key] || ''}</p>
          <div class="opt-list">
            ${(options[key] || []).map((o, i, arr) => `
              <div class="opt ${o.active ? '' : 'off'}" data-id="${o.id}">
                <span class="opt-label">${esc(o.label)}</span>${o.active ? '' : '<span class="tag">Hidden</span>'}
                <button class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
                <button class="icon-btn" data-act="down" ${i === arr.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
                <button class="icon-btn" data-act="edit" aria-label="Edit">Edit</button>
              </div>`).join('') || '<p class="small muted">No options yet.</p>'}
          </div>
          <form class="row opt-add" data-list="${key}" style="margin-top:12px;flex-wrap:nowrap">
            <input class="input input-sm" name="label" placeholder="Add new option" required maxlength="60">
            <button class="btn btn-sm">Add</button>
          </form>
        </div>`).join('')}
      </div>`;
    const all = Object.values(options).flat();
    $$('.opt-add', body).forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/admin/options', { method: 'POST', body: { list: f.dataset.list, label: f.label.value } }); toast('Added'); await refresh(); } catch (err) { toastError(err); }
    }));
    $$('.opt [data-act]', body).forEach((btn) => btn.addEventListener('click', async () => {
      const o = all.find((x) => x.id === Number(btn.closest('.opt').dataset.id));
      if (btn.dataset.act !== 'edit') {
        try { await api(`/api/admin/options/${o.id}/move`, { method: 'POST', body: { dir: btn.dataset.act } }); await refresh(); } catch (err) { toastError(err); }
        return;
      }
      modal(`<h2>Edit option</h2><p class="muted">${esc(lists[o.list])}${o.list === 'category' ? ' — renaming also updates services and stylists using it.' : ''}</p>
        <form id="opForm" style="margin-top:16px">
          <label class="field"><span>Name</span><input class="input" name="label" value="${esc(o.label)}" required maxlength="60"></label>
          <label class="row field" style="justify-content:space-between"><span style="margin:0">Show in dropdowns</span><span class="switch"><input type="checkbox" name="active" ${o.active ? 'checked' : ''}><i></i></span></label>
          <div class="foot"><button type="button" class="btn danger btn-md" id="opDel" style="margin-right:auto">Remove</button>
            <button type="button" class="btn gray btn-md" data-close>Cancel</button><button class="btn btn-md">Save</button></div>
        </form>`, {
        onMount(m, close) {
          $('#opForm', m).addEventListener('submit', async (e) => {
            e.preventDefault();
            try { await api(`/api/admin/options/${o.id}`, { method: 'PUT', body: { label: e.target.label.value, active: e.target.active.checked } }); toast('Saved'); close(); await refresh(); } catch (err) { toastError(err); }
          });
          $('#opDel', m).addEventListener('click', async () => {
            try { await api(`/api/admin/options/${o.id}`, { method: 'DELETE' }); toast('Removed'); close(); await refresh(); } catch (err) { toastError(err); }
          });
        },
      });
    }));
  };
  const refresh = async () => {
    await Promise.all([loadOptions(), reloadCatalog(), api('/api/config').then((c) => (state.config = c))]);
    await load();
  };
  load();
});

/* ======================================== guards for remaining routes */
// Apply guards to routes registered above without one.
for (const r of routes) {
  const src = r.re.source;
  if (src.includes('account')) r.guard = 'auth';
  if (src.includes('admin')) r.guard = /admin\\\/(schedule|bookings|customers)/.test(src) ? 'staff' : 'admin';
}

/* =============================================================== boot */
function applyBranding() {
  const c = state.config;
  document.title = c.salon_name;
  $$('[data-salon-name]').forEach((el, i) => (el.textContent = i === 0 ? c.salon_name.split(' ')[0] : c.salon_name));
  renderFooter();
  const wa = waLink(`Hi ${c.salon_name}! I’d like to book an appointment.`);
  $('#waFab').classList.toggle('hidden', !wa);
  if (wa) $('#waFab').href = wa;
}

function openStatus() {
  const c = state.config;
  const h = c.closed_dates.includes(today()) ? null : c.hours[parseDate(today()).getDay()];
  const now = c.now_min ?? 0;
  const toM = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
  if (h && now >= toM(h.open) && now < toM(h.close)) return { open: true, text: `Open now · until ${fmtTime(h.close)}` };
  return { open: false, text: `Closed now · Opens ${nextOpening().replace(/^Today from/, 'today at').replace(/^Tomorrow/, 'tomorrow').replace(/ from /, ' at ')}` };
}

function renderFooter() {
  const c = state.config;
  const st = openStatus();
  const wa = waLink(`Hi ${c.salon_name}! I’d like to book an appointment.`);
  const ig = (c.instagram || '').replace(/^@/, '');
  const days = [1, 2, 3, 4, 5, 6, 0];
  const dayShort = (d) => new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: 'short' });
  const closedDays = days.filter((d) => !c.hours[d]).map(dayShort);
  const todayHours = c.closed_dates.includes(today()) ? null : c.hours[parseDate(today()).getDay()];
  $('#footer').innerHTML = `
    <div class="wrap">
      <div class="footer-top">
        <div>
          <a href="#/" class="footer-brand">${esc(c.salon_name)}</a>
          <p>${esc(c.tagline)}</p>
          <p style="margin-top:10px">${esc(c.address)}</p>
          <span class="open-now ${st.open ? 'open' : 'closed'}">${esc(st.text)}</span>
          <div class="footer-cta">
            <a class="btn btn-md" href="#/book">Book now</a>
            ${wa ? `<a class="btn wa btn-md" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          </div>
        </div>
        <div><h4>Explore</h4><ul>
          <li><a href="#/services">Services &amp; prices</a></li><li><a href="#/team">Our team</a></li>
          <li><a href="#/visit">Hours &amp; location</a></li><li><a href="#/book">Book an appointment</a></li></ul></div>
        <div><h4>Your account</h4><ul>
          <li><a href="#/account">My bookings</a></li><li><a href="#/account/profile">Profile</a></li>
          <li><a href="#/login">Sign in</a></li><li><a href="#/signup">Create account</a></li></ul></div>
        <div><h4>Contact</h4><ul>
          <li><a href="${telLink()}">${esc(c.phone)}</a></li>
          <li><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></li>
          <li><a href="${mapLink()}" target="_blank" rel="noopener">Get directions</a></li>
          <li>Today: ${todayHours ? `${fmtTime(todayHours.open)} – ${fmtTime(todayHours.close)}` : 'Closed'}${closedDays.length ? `<br>Weekly off: ${esc(closedDays.join(', '))}` : ''}<br><a href="#/visit">All opening hours ›</a></li>
        </ul></div>
      </div>
      <div class="footer-bottom">
        <span>© ${new Date().getFullYear()} ${esc(c.salon_name)}. All rights reserved.</span>
        <div class="footer-social">
          ${wa ? `<a href="${wa}" target="_blank" rel="noopener" aria-label="WhatsApp">${ICON.wa}</a>` : ''}
          ${ig ? `<a href="https://instagram.com/${encodeURIComponent(ig)}" target="_blank" rel="noopener" aria-label="Instagram">${ICON.ig}</a>` : ''}
          <a href="${telLink()}" aria-label="Call">${ICON.phone}</a>
        </div>
      </div>
    </div>`;
}

(async function boot() {
  try {
    [state.config] = await Promise.all([api('/api/config'), reloadCatalog(), refreshUser()]);
    applyBranding();
    render();
  } catch (e) {
    app.innerHTML = `<div class="wrap empty" style="padding:120px 0"><h2>Can’t reach the salon server.</h2><p class="muted">${esc(e.message)}</p></div>`;
  }
})();
