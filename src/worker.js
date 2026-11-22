// Salon — Cloudflare Worker: REST API on D1 + embedded static site.
import { hashPassword, verifyPassword, newToken } from './auth.js';
import * as S from './slots.js';
import STATIC from './static.gen.js';
import { DEFAULT_SETTINGS, SERVICES, STYLISTS } from './seed-data.js';

const SESSION_DAYS = 30;

/* ------------------------------------------------------------------ errors */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalises an Indian mobile number to '+91 XXXXX XXXXX', or returns null if invalid. */
function indianMobile(v) {
  const d = String(v ?? '').replace(/[^\d]/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(d) ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : null;
}
const LISTS = { category: 'Service categories', source: 'Booking sources', payment: 'Payment methods', reason: 'Cancel / no-show reasons' };
const isStaff = (u) => u && (u.role === 'staff' || u.role === 'admin');

/** Active dropdown options grouped by list, in admin-defined order. */
async function getOptions(db, all = false) {
  const { results } = await db.prepare(`SELECT * FROM options ${all ? '' : 'WHERE active = 1'} ORDER BY list, sort, id`).all();
  const out = Object.fromEntries(Object.keys(LISTS).map((k) => [k, []]));
  for (const o of results) (out[o.list] ||= []).push(all ? o : o.label);
  return out;
}
async function sortServices(db, list) {
  const order = (await getOptions(db)).category;
  const rank = (c) => { const i = order.indexOf(c); return i < 0 ? order.length : i; };
  return list.sort((a, b) => b.active - a.active || rank(a.category) - rank(b.category) || a.category.localeCompare(b.category) || a.price - b.price);
}
async function checkOption(db, list, value, required = false) {
  const v = str(value, 80);
  if (!v) { if (required) throw bad(`Please choose a ${LISTS[list].replace(/s$/, '').toLowerCase()}.`); return ''; }
  const ok = await db.prepare('SELECT 1 FROM options WHERE list = ? AND label = ? AND active = 1').bind(list, v).first();
  if (!ok) throw bad(`“${v}” is not in the ${LISTS[list].toLowerCase()} list.`);
  return v;
}

/* ---------------------------------------------------------------- settings */
const LOGO_COLORS = ['rose', 'maroon', 'gold', 'plum', 'teal', 'mono'];
async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of results) out[r.key] = JSON.parse(r.value);
  return out;
}

async function saveSettings(db, patch) {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const batch = Object.entries(patch).filter(([k]) => k in DEFAULT_SETTINGS).map(([k, v]) => stmt.bind(k, JSON.stringify(v)));
  if (batch.length) await db.batch(batch);
  return getSettings(db);
}

/* -------------------------------------------------------- one-time seeding */
let seeded = false;
async function ensureSeed(db) {
  if (seeded) return;
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (row.n > 0) return (seeded = true);
  const u = db.prepare('INSERT OR IGNORE INTO users(name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  const sv = db.prepare('INSERT INTO services(name, category, description, duration_min, price) VALUES (?, ?, ?, ?, ?)');
  const st = db.prepare('INSERT INTO stylists(name, title, bio, specialties) VALUES (?, ?, ?, ?)');
  // The batch runs as one transaction. The first statement claims a unique key, so if several
  // cold requests race to seed, only one batch commits and the others roll back.
  try {
    await seedBatch(db, u, sv, st);
  } catch (e) {
    if (!String(e.message).includes('UNIQUE')) throw e;
  }
  seeded = true;
}

async function seedBatch(db, u, sv, st) {
  await db.batch([
    db.prepare(`INSERT INTO settings(key, value) VALUES ('seeded', 'true')`),
    u.bind('Salon Admin', 'admin@salon.local', '+91 90000 00001', await hashPassword('admin123'), 'admin'),
    u.bind('Demo Customer', 'demo@salon.local', '+91 90000 00002', await hashPassword('demo123'), 'customer'),
    u.bind('Front Desk', 'staff@salon.local', '+91 90000 00003', await hashPassword('staff123'), 'staff'),
    ...SERVICES.map((s) => sv.bind(...s)),
    ...STYLISTS.map((s) => st.bind(...s)),
  ]);
}

/* ----------------------------------------------------------------- session */
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const sessionCookie = (token, maxAge, secure) =>
  `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, stylist_id: u.stylist_id ?? null, created_at: u.created_at };

async function currentUser(ctx) {
  const token = parseCookies(ctx.req).sid;
  if (!token) return null;
  return ctx.db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ? AND u.active = 1')
    .bind(token, Date.now())
    .first();
}

async function startSession(ctx, userId) {
  const token = newToken();
  await ctx.db.batch([
    ctx.db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, userId, Date.now() + SESSION_DAYS * 864e5),
    ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
  ]);
  ctx.headers.append('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400, ctx.secure));
}

// Best-effort per-isolate rate limiting for auth endpoints.
const attempts = new Map();
function rateLimit(ctx, key, limit = 10, windowMs = 10 * 60e3) {
  const id = `${key}:${ctx.req.headers.get('cf-connecting-ip') || 'local'}`;
  const now = Date.now();
  const rec = attempts.get(id) || { n: 0, reset: now + windowMs };
  if (now > rec.reset) Object.assign(rec, { n: 0, reset: now + windowMs });
  rec.n += 1;
  attempts.set(id, rec);
  if (attempts.size > 5000) attempts.clear();
  if (rec.n > limit) throw new HttpError(429, 'Too many attempts. Please try again in a few minutes.');
}

/* ----------------------------------------------------------------- helpers */
const BOOKING_SELECT = `
  SELECT b.*, s.name AS service_name, s.category AS service_category, s.duration_min,
         st.name AS stylist_name, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
  FROM bookings b
  JOIN services s ON s.id = b.service_id
  JOIN stylists st ON st.id = b.stylist_id
  JOIN users u ON u.id = b.user_id`;
const decorate = (b) => b && { ...b, time: S.fmtMin(b.start_min), end_time: S.fmtMin(b.end_min) };
const getBooking = async (db, id) => decorate(await db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).bind(id).first());

async function slotsFor(ctx, { date, serviceId, stylistId, excludeBookingId }) {
  if (!S.isValidDate(date)) return [];
  const settings = await ctx.settings();
  const c = await S.loadSlotContext(ctx.db, { serviceId, stylistId, from: date, to: date });
  return S.computeSlots({ date, ...c, settings, now: S.nowLocal(settings.timezone), excludeBookingId });
}

async function resolveSlot(ctx, { service_id, stylist_id, date, time, excludeBookingId }) {
  const service = await ctx.db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').bind(Number(service_id) || 0).first();
  if (!service) throw bad('Please choose a service.');
  if (!S.isValidDate(date)) throw bad('Please choose a valid date.');
  if (!/^\d{2}:\d{2}$/.test(String(time))) throw bad('Please choose a time.');
  const slots = await slotsFor(ctx, { date, serviceId: service.id, stylistId: stylist_id || null, excludeBookingId });
  const slot = slots.find((s) => s.time === time);
  if (!slot) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another slot.');
  return { service, stylistId: slot.stylist_ids[0], start: slot.start_min, end: slot.start_min + service.duration_min };
}

/** Inserts a booking only if the stylist is still free (guards against concurrent requests). */
async function insertBooking(ctx, userId, slot, date, notes, source = 'Online') {
  const r = await ctx.db
    .prepare(
      `INSERT INTO bookings(user_id, service_id, stylist_id, date, start_min, end_min, price, notes, source)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE stylist_id = ? AND date = ?
         AND status IN ('confirmed','completed') AND start_min < ? AND end_min > ?)`
    )
    .bind(userId, slot.service.id, slot.stylistId, date, slot.start, slot.end, slot.service.price, str(notes, 500), source,
      slot.stylistId, date, slot.end, slot.start)
    .run();
  if (!r.meta.changes) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another slot.');
  return getBooking(ctx.db, r.meta.last_row_id);
}

function icsFor(b, settings) {
  const dt = (date, min) => `${date.replace(/-/g, '')}T${S.fmtMin(min).replace(':', '')}00`;
  const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const tz = settings.timezone && settings.timezone !== 'UTC' ? `;TZID=${settings.timezone}` : '';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Salon//Booking//EN', 'BEGIN:VEVENT',
    `UID:booking-${b.id}@salon`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
    `DTSTART${tz}:${dt(b.date, b.start_min)}`,
    `DTEND${tz}:${dt(b.date, b.end_min)}`,
    `SUMMARY:${esc(`${b.service_name} at ${settings.salon_name}`)}`,
    `DESCRIPTION:${esc(`With ${b.stylist_name}. Booking #${b.id}.`)}`,
    `LOCATION:${esc(settings.address)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

/* ------------------------------------------------------------------ router */
const routes = [];
const route = (method, pattern, opts, handler) => {
  if (typeof opts === 'function') [handler, opts] = [opts, {}];
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, ...opts });
};
const A = { auth: true, admin: true };
const ST = { auth: true, staff: true };

/* ---------- public */
route('GET', '/api/config', async (ctx) => {
  const s = await ctx.settings();
  const pick = ['salon_name', 'tagline', 'quote', 'logo', 'logo_color', 'logo_show_name', 'address', 'phone', 'whatsapp', 'instagram', 'map_url', 'email', 'currency', 'timezone', 'hours', 'closed_dates', 'max_days_ahead', 'cancel_cutoff_hours'];
  const now = S.nowLocal(s.timezone);
  return { ...Object.fromEntries(pick.map((k) => [k, s[k]])), category_order: (await getOptions(ctx.db)).category, quick_login: ctx.quickLogin, today: now.date, now_min: now.min };
});

route('GET', '/api/services', async ({ db }) => sortServices(db, (await db.prepare('SELECT * FROM services WHERE active = 1').all()).results));
route('GET', '/api/options', ST, async ({ db }) => getOptions(db));
route('GET', '/api/stylists', async ({ db }) =>
  (await db.prepare('SELECT id, name, title, bio, specialties FROM stylists WHERE active = 1 ORDER BY id').all()).results);

route('GET', '/api/slots', async (ctx) => {
  const { query, user, db } = ctx;
  let exclude = query.get('exclude');
  if (exclude) {
    const own = user && (await db.prepare('SELECT user_id FROM bookings WHERE id = ?').bind(Number(exclude)).first());
    if (!own || (own.user_id !== user.id && !isStaff(user))) throw new HttpError(403, 'Forbidden');
  }
  return slotsFor(ctx, { date: query.get('date'), serviceId: query.get('service_id'), stylistId: query.get('stylist_id') || null, excludeBookingId: exclude });
});

route('GET', '/api/availability', async (ctx) => {
  const { query } = ctx;
  const settings = await ctx.settings();
  const now = S.nowLocal(settings.timezone);
  const from = S.isValidDate(query.get('from')) ? query.get('from') : now.date;
  const days = Math.min(Number(query.get('days')) || 42, 62);
  const to = S.addDays(from, days - 1);
  const c = await S.loadSlotContext(ctx.db, { serviceId: query.get('service_id'), stylistId: query.get('stylist_id') || null, from, to });
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = S.addDays(from, i);
    out.push({ date, slots: S.computeSlots({ date, ...c, settings, now }).length });
  }
  return out;
});

/* ---------- auth */
route('POST', '/api/auth/register', async (ctx) => {
  const { body, db } = ctx;
  rateLimit(ctx, 'register', 20);
  const name = str(body.name, 80);
  const email = str(body.email, 120).toLowerCase();
  const phone = indianMobile(body.phone);
  const password = String(body.password || '');
  if (name.length < 2) throw bad('Please enter your name.');
  if (!EMAIL_RE.test(email)) throw bad('Please enter a valid email.');
  if (!phone) throw bad('Please enter a valid 10-digit mobile number.');
  if (password.length < 6) throw bad('Password must be at least 6 characters.');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())
    throw new HttpError(409, 'An account with this email already exists. Try signing in.');
  const r = await db.prepare('INSERT INTO users(name, email, phone, password_hash) VALUES (?, ?, ?, ?)').bind(name, email, phone, await hashPassword(password)).run();
  await startSession(ctx, r.meta.last_row_id);
  return { user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').bind(r.meta.last_row_id).first()) };
});

async function passwordLogin(ctx, staffPortal) {
  rateLimit(ctx, 'login', 10);
  const u = await ctx.db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').bind(str(ctx.body.email, 120).toLowerCase()).first();
  if (!u || !(await verifyPassword(String(ctx.body.password || ''), u.password_hash))) throw new HttpError(401, 'Incorrect email or password.');
  if (staffPortal && !isStaff(u)) throw new HttpError(403, 'This sign-in is for salon staff. Customers, please use the customer sign-in.');
  if (!staffPortal && isStaff(u)) throw new HttpError(403, 'Staff and admins, please use the Staff sign-in page.');
  await startSession(ctx, u.id);
  return { user: publicUser(u) };
}
route('POST', '/api/auth/login', (ctx) => passwordLogin(ctx, false));
route('POST', '/api/auth/staff-login', (ctx) => passwordLogin(ctx, true));

// One-click (bypass) sign in to the demo customer or admin account.
route('POST', '/api/auth/quick', async (ctx) => {
  if (!ctx.quickLogin) throw new HttpError(403, 'One-click sign in is disabled.');
  const role = ['admin', 'staff'].includes(ctx.body.role) ? ctx.body.role : 'customer';
  const email = { admin: 'admin@salon.local', staff: 'staff@salon.local', customer: 'demo@salon.local' }[role];
  let u = await ctx.db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!u) {
    const r = await ctx.db.prepare('INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .bind({ admin: 'Salon Admin', staff: 'Front Desk', customer: 'Demo Customer' }[role], email, await hashPassword(newToken()), role).run();
    u = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(r.meta.last_row_id).first();
  }
  await startSession(ctx, u.id);
  return { user: publicUser(u) };
});

route('POST', '/api/auth/logout', async (ctx) => {
  const token = parseCookies(ctx.req).sid;
  if (token) await ctx.db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  ctx.headers.append('Set-Cookie', sessionCookie('', 0, ctx.secure));
  return { ok: true };
});

route('GET', '/api/auth/me', async ({ user }) => ({ user: publicUser(user) }));

/* ---------- customer */
route('PUT', '/api/me', { auth: true }, async ({ body, user, db }) => {
  const name = str(body.name, 80);
  const email = str(body.email, 120).toLowerCase();
  if (name.length < 2) throw bad('Please enter your name.');
  if (!EMAIL_RE.test(email)) throw bad('Please enter a valid email.');
  const phone = indianMobile(body.phone);
  if (!phone) throw bad('Please enter a valid 10-digit mobile number.');
  if (await db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(email, user.id).first())
    throw new HttpError(409, 'That email is already in use.');
  await db.prepare('UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?').bind(name, email, phone, user.id).run();
  return { user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first()) };
});

route('PUT', '/api/me/password', { auth: true }, async ({ body, user, db }) => {
  if (!(await verifyPassword(String(body.current || ''), user.password_hash))) throw bad('Your current password is incorrect.');
  if (String(body.next || '').length < 6) throw bad('New password must be at least 6 characters.');
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(String(body.next)), user.id).run();
  return { ok: true };
});

route('GET', '/api/bookings', { auth: true }, async ({ user, db }) =>
  (await db.prepare(`${BOOKING_SELECT} WHERE b.user_id = ? ORDER BY b.date DESC, b.start_min DESC`).bind(user.id).all()).results.map(decorate));

route('POST', '/api/bookings', { auth: true }, async (ctx) => {
  const { body, user, db } = ctx;
  const settings = await ctx.settings();
  const open = await db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'confirmed' AND date >= ?`)
    .bind(user.id, S.nowLocal(settings.timezone).date).first();
  if (open.n >= 10 && !isStaff(user)) throw bad('You have too many upcoming bookings.');
  const slot = await resolveSlot(ctx, body);
  return { booking: await insertBooking(ctx, user.id, slot, body.date, body.notes) };
});

async function ownBooking(db, id, user) {
  const b = await getBooking(db, Number(id));
  if (!b || (b.user_id !== user.id && !isStaff(user))) throw new HttpError(404, 'Booking not found.');
  return b;
}

async function checkCutoff(ctx, b) {
  if (isStaff(ctx.user)) return;
  const settings = await ctx.settings();
  const cutoff = Number(settings.cancel_cutoff_hours) || 0;
  const now = S.nowLocal(settings.timezone);
  const minutesAway = S.daysBetween(now.date, b.date) * 1440 + b.start_min - now.min;
  if (minutesAway < cutoff * 60) throw bad(`Changes are only possible up to ${cutoff} hours before your appointment. Please call us.`);
}

route('PATCH', '/api/bookings/:id/cancel', { auth: true }, async (ctx) => {
  const b = await ownBooking(ctx.db, ctx.params.id, ctx.user);
  if (b.status !== 'confirmed') throw bad('This booking can no longer be cancelled.');
  await checkCutoff(ctx, b);
  await ctx.db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).bind(b.id).run();
  return { booking: await getBooking(ctx.db, b.id) };
});

route('PATCH', '/api/bookings/:id/reschedule', { auth: true }, async (ctx) => {
  const { db, body } = ctx;
  const b = await ownBooking(db, ctx.params.id, ctx.user);
  if (b.status !== 'confirmed') throw bad('Only upcoming bookings can be rescheduled.');
  await checkCutoff(ctx, b);
  const slot = await resolveSlot(ctx, { service_id: b.service_id, stylist_id: body.stylist_id || null, date: body.date, time: body.time, excludeBookingId: b.id });
  const r = await db
    .prepare(
      `UPDATE bookings SET date = ?, start_min = ?, end_min = ?, stylist_id = ? WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM bookings WHERE stylist_id = ? AND date = ? AND id != ?
         AND status IN ('confirmed','completed') AND start_min < ? AND end_min > ?)`
    )
    .bind(body.date, slot.start, slot.end, slot.stylistId, b.id, slot.stylistId, body.date, b.id, slot.end, slot.start)
    .run();
  if (!r.meta.changes) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another slot.');
  return { booking: await getBooking(db, b.id) };
});

route('GET', '/api/bookings/:id/ics', { auth: true }, async (ctx) => {
  const b = await ownBooking(ctx.db, ctx.params.id, ctx.user);
  return new Response(icsFor(b, await ctx.settings()), {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="appointment-${b.id}.ics"` },
  });
});

/* ---------- admin */
route('GET', '/api/admin/stats', A, async (ctx) => {
  const { db } = ctx;
  const settings = await ctx.settings();
  const today = S.nowLocal(settings.timezone).date;
  const monthStart = today.slice(0, 8) + '01';
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const { results: daily } = await db
    .prepare(`SELECT date, COUNT(*) AS n, COALESCE(SUM(price),0) AS rev FROM bookings
              WHERE date >= ? AND date <= ? AND status IN ('confirmed','completed') GROUP BY date`)
    .bind(S.addDays(today, -6), S.addDays(today, 6))
    .all();
  const byDate = Object.fromEntries(daily.map((d) => [d.date, d]));
  const range = (a, b) => {
    const out = [];
    for (let i = a; i <= b; i++) {
      const d = S.addDays(today, i);
      out.push({ date: d, bookings: byDate[d]?.n || 0, revenue: byDate[d]?.rev || 0 });
    }
    return out;
  };
  const [todayN, upcoming, month, customers, cancel, top, schedule] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND status != 'cancelled'`, today),
    one(`SELECT COUNT(*) AS n FROM bookings WHERE date >= ? AND status = 'confirmed'`, today),
    one(`SELECT COALESCE(SUM(price),0) AS v FROM bookings WHERE date >= ? AND date <= ? AND status IN ('confirmed','completed')`, monthStart, monthStart.slice(0, 8) + '31'),
    one(`SELECT COUNT(*) AS n FROM users WHERE role = 'customer'`),
    one(`SELECT COUNT(*) AS total, SUM(status = 'cancelled') AS c FROM bookings WHERE date >= ?`, S.addDays(today, -30)),
    db.prepare(`SELECT s.name, COUNT(*) AS n FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.status != 'cancelled' GROUP BY s.id ORDER BY n DESC LIMIT 5`).all(),
    db.prepare(`${BOOKING_SELECT} WHERE b.date = ? AND b.status != 'cancelled' ORDER BY b.start_min`).bind(today).all(),
  ]);
  return {
    today,
    today_bookings: todayN.n,
    upcoming: upcoming.n,
    month_revenue: month.v,
    customers: customers.n,
    cancel_rate: cancel.total ? Math.round((100 * (cancel.c || 0)) / cancel.total) : 0,
    week: range(-6, 0),
    ahead: range(0, 6),
    top_services: top.results,
    schedule: schedule.results.map(decorate),
  };
});

route('GET', '/api/admin/bookings', ST, async ({ query, db }) => {
  const where = [];
  const args = [];
  if (S.isValidDate(query.get('from'))) where.push('b.date >= ?'), args.push(query.get('from'));
  if (S.isValidDate(query.get('to'))) where.push('b.date <= ?'), args.push(query.get('to'));
  if (query.get('status')) where.push('b.status = ?'), args.push(query.get('status'));
  if (query.get('stylist_id')) where.push('b.stylist_id = ?'), args.push(Number(query.get('stylist_id')));
  if (query.get('q')) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR s.name LIKE ?)');
    const q = `%${str(query.get('q'), 80)}%`;
    args.push(q, q, q, q);
  }
  const sql = `${BOOKING_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.date DESC, b.start_min ASC LIMIT 500`;
  return (await db.prepare(sql).bind(...args).all()).results.map(decorate);
});

// Walk-in / phone booking by staff: pick an existing customer, or add a new one by name + mobile.
route('POST', '/api/admin/bookings', ST, async (ctx) => {
  const { body, db } = ctx;
  const source = await checkOption(db, 'source', body.source, true);
  let cust = null;
  if (body.customer_id) {
    cust = await db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'customer'`).bind(Number(body.customer_id)).first();
    if (!cust) throw bad('Please choose a customer.');
  }
  const slot = await resolveSlot(ctx, body);
  if (!cust) {
    const name = str(body.customer_name, 80);
    const phone = indianMobile(body.customer_phone);
    if (name.length < 2) throw bad('Please enter the customer’s name.');
    if (!phone) throw bad('Please enter a valid 10-digit mobile number.');
    cust = await db.prepare(`SELECT id FROM users WHERE phone = ? AND role = 'customer'`).bind(phone).first();
    if (!cust) {
      let email = str(body.customer_email, 120).toLowerCase();
      if (email && !EMAIL_RE.test(email)) throw bad('Please enter a valid email or leave it empty.');
      if (!email) email = `walkin-${phone.replace(/\D/g, '')}@guest.local`;
      if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw new HttpError(409, 'That email already belongs to an account.');
      const r = await db.prepare('INSERT INTO users(name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
        .bind(name, email, phone, await hashPassword(newToken())).run();
      cust = { id: r.meta.last_row_id };
    }
  }
  return { booking: await insertBooking(ctx, cust.id, slot, body.date, body.notes, source) };
});

route('PATCH', '/api/admin/bookings/:id', ST, async ({ params, body, db }) => {
  const b = await getBooking(db, Number(params.id));
  if (!b) throw new HttpError(404, 'Booking not found.');
  if (!['confirmed', 'completed', 'cancelled', 'no_show'].includes(body.status)) throw bad('Invalid status.');
  const payment = body.status === 'completed' ? await checkOption(db, 'payment', body.payment_method, true) : '';
  const reason = ['cancelled', 'no_show'].includes(body.status) ? await checkOption(db, 'reason', body.status_reason, true) : '';
  if (body.status === 'confirmed' && b.status === 'cancelled') {
    const clash = await db
      .prepare(`SELECT 1 FROM bookings WHERE stylist_id = ? AND date = ? AND id != ? AND status IN ('confirmed','completed') AND start_min < ? AND end_min > ?`)
      .bind(b.stylist_id, b.date, b.id, b.end_min, b.start_min).first();
    if (clash) throw new HttpError(409, 'That slot has since been booked by someone else.');
  }
  await db.prepare('UPDATE bookings SET status = ?, payment_method = ?, status_reason = ? WHERE id = ?').bind(body.status, payment, reason, b.id).run();
  return { booking: await getBooking(db, b.id) };
});

function serviceInput(body) {
  const v = {
    name: str(body.name, 80),
    category: str(body.category, 40) || 'Hair',
    description: str(body.description, 400),
    duration_min: Math.round(Number(body.duration_min)),
    price: Math.round(Number(body.price) * 100) / 100,
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
  if (v.name.length < 2) throw bad('Service name is required.');
  if (!(v.duration_min >= 5 && v.duration_min <= 600)) throw bad('Duration must be 5–600 minutes.');
  if (!(v.price >= 0)) throw bad('Price must be a positive number.');
  return v;
}
function stylistInput(body) {
  const v = {
    name: str(body.name, 80), title: str(body.title, 80), bio: str(body.bio, 400), specialties: str(body.specialties, 200),
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
  if (v.name.length < 2) throw bad('Stylist name is required.');
  return v;
}

function crud(path, table, cols, input, order, sort = (db, x) => x, validate = async () => {}) {
  route('GET', path, A, async ({ db }) => sort(db, (await db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()).results));
  route('POST', path, A, async ({ body, db }) => {
    const v = input(body);
    await validate(db, v);
    const r = await db.prepare(`INSERT INTO ${table}(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => v[c])).run();
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(r.meta.last_row_id).first();
  });
  route('PUT', `${path}/:id`, A, async ({ params, body, db }) => {
    const v = input(body);
    await validate(db, v);
    await db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).bind(...cols.map((c) => v[c]), Number(params.id)).run();
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(Number(params.id)).first();
  });
  route('DELETE', `${path}/:id`, A, async ({ params, db }) => {
    const id = Number(params.id);
    const fk = table === 'services' ? 'service_id' : 'stylist_id';
    const used = await db.prepare(`SELECT 1 FROM bookings WHERE ${fk} = ? LIMIT 1`).bind(id).first();
    await db.prepare(used ? `UPDATE ${table} SET active = 0 WHERE id = ?` : `DELETE FROM ${table} WHERE id = ?`).bind(id).run();
    return { ok: true, archived: !!used };
  });
}
crud('/api/admin/services', 'services', ['name', 'category', 'description', 'duration_min', 'price', 'active'], serviceInput, 'active DESC, category, name', sortServices, async (db, v) => { v.category = await checkOption(db, 'category', v.category, true); });
crud('/api/admin/stylists', 'stylists', ['name', 'title', 'bio', 'specialties', 'active'], stylistInput, 'active DESC, name');

route('PUT', '/api/admin/customers/:id/password', A, async ({ params, body, db }) => {
  const pw = String(body.password || '');
  if (pw.length < 6) throw bad('Password must be at least 6 characters.');
  const u = await db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'customer'`).bind(Number(params.id)).first();
  if (!u) throw new HttpError(404, 'Customer not found.');
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(pw), u.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
  ]);
  return { ok: true };
});

route('GET', '/api/admin/customers', ST, async ({ query, db }) => {
  const q = `%${str(query.get('q'), 80)}%`;
  return (await db
    .prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.created_at, COUNT(b.id) AS bookings,
              COALESCE(SUM(CASE WHEN b.status IN ('confirmed','completed') THEN b.price END), 0) AS spent,
              MAX(CASE WHEN b.status != 'cancelled' THEN b.date END) AS last_visit
       FROM users u LEFT JOIN bookings b ON b.user_id = u.id
       WHERE u.role = 'customer' AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)
       GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500`
    )
    .bind(q, q, q).all()).results;
});

/* ---------- admin: dropdown lists */
route('GET', '/api/admin/options', A, async ({ db }) => ({ lists: LISTS, options: await getOptions(db, true) }));
route('POST', '/api/admin/options', A, async ({ body, db }) => {
  const list = String(body.list || '');
  const label = str(body.label, 60);
  if (!LISTS[list]) throw bad('Unknown list.');
  if (label.length < 1) throw bad('Please enter a name.');
  if (await db.prepare('SELECT 1 FROM options WHERE list = ? AND label = ? COLLATE NOCASE').bind(list, label).first())
    throw new HttpError(409, `“${label}” is already in this list.`);
  const max = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM options WHERE list = ?').bind(list).first();
  await db.prepare('INSERT INTO options(list, label, sort) VALUES (?, ?, ?)').bind(list, label, max.m + 1).run();
  return { ok: true };
});
route('PUT', '/api/admin/options/:id', A, async ({ params, body, db }) => {
  const o = await db.prepare('SELECT * FROM options WHERE id = ?').bind(Number(params.id)).first();
  if (!o) throw new HttpError(404, 'Option not found.');
  const label = 'label' in body ? str(body.label, 60) : o.label;
  const active = 'active' in body ? (body.active ? 1 : 0) : o.active;
  if (!label) throw bad('Please enter a name.');
  if (label !== o.label && (await db.prepare('SELECT 1 FROM options WHERE list = ? AND label = ? COLLATE NOCASE AND id != ?').bind(o.list, label, o.id).first()))
    throw new HttpError(409, `“${label}” is already in this list.`);
  const batch = [db.prepare('UPDATE options SET label = ?, active = ? WHERE id = ?').bind(label, active, o.id)];
  if (o.list === 'category' && label !== o.label) {
    batch.push(db.prepare('UPDATE services SET category = ? WHERE category = ?').bind(label, o.label));
    const { results } = await db.prepare('SELECT id, specialties FROM stylists').all();
    for (const st of results) {
      const parts = (st.specialties || '').split(',').map((x) => x.trim());
      if (parts.includes(o.label)) batch.push(db.prepare('UPDATE stylists SET specialties = ? WHERE id = ?').bind(parts.map((x) => (x === o.label ? label : x)).join(','), st.id));
    }
  }
  await db.batch(batch);
  return { ok: true };
});
route('POST', '/api/admin/options/:id/move', A, async ({ params, body, db }) => {
  const o = await db.prepare('SELECT * FROM options WHERE id = ?').bind(Number(params.id)).first();
  if (!o) throw new HttpError(404, 'Option not found.');
  const { results } = await db.prepare('SELECT id FROM options WHERE list = ? ORDER BY sort, id').bind(o.list).all();
  const ids = results.map((r) => r.id);
  const i = ids.indexOf(o.id);
  const j = i + (body.dir === 'up' ? -1 : 1);
  if (j < 0 || j >= ids.length) return { ok: true };
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await db.batch(ids.map((id, n) => db.prepare('UPDATE options SET sort = ? WHERE id = ?').bind(n + 1, id)));
  return { ok: true };
});
route('DELETE', '/api/admin/options/:id', A, async ({ params, db }) => {
  const o = await db.prepare('SELECT * FROM options WHERE id = ?').bind(Number(params.id)).first();
  if (!o) throw new HttpError(404, 'Option not found.');
  if (o.list === 'category' && (await db.prepare('SELECT 1 FROM services WHERE category = ? AND active = 1').bind(o.label).first()))
    throw bad(`Some live services still use “${o.label}”. Move them to another category first, or hide this option instead.`);
  await db.prepare('DELETE FROM options WHERE id = ?').bind(o.id).run();
  return { ok: true };
});

/* ---------- admin: staff accounts */
route('GET', '/api/admin/staff', A, async ({ db }) =>
  (await db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.role, u.stylist_id, u.active, u.created_at, st.name AS stylist_name
     FROM users u LEFT JOIN stylists st ON st.id = u.stylist_id WHERE u.role IN ('staff','admin') ORDER BY u.role, u.name`).all()).results);

async function staffInput(db, body, isNew) {
  const v = {
    name: str(body.name, 80),
    email: str(body.email, 120).toLowerCase(),
    phone: body.phone ? indianMobile(body.phone) : '',
    role: body.role === 'admin' ? 'admin' : 'staff',
    stylist_id: body.stylist_id ? Number(body.stylist_id) : null,
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
  if (v.name.length < 2) throw bad('Please enter a name.');
  if (isNew && !EMAIL_RE.test(v.email)) throw bad('Please enter a valid email (used to sign in).');
  if (v.phone === null) throw bad('Please enter a valid 10-digit mobile number.');
  if (v.stylist_id && !(await db.prepare('SELECT 1 FROM stylists WHERE id = ?').bind(v.stylist_id).first())) throw bad('Unknown stylist.');
  return v;
}
async function adminsLeft(db, exceptId) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`).bind(exceptId).first()).n;
}
route('POST', '/api/admin/staff', A, async ({ body, db }) => {
  const v = await staffInput(db, body, true);
  if (String(body.password || '').length < 6) throw bad('Password must be at least 6 characters.');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(v.email).first()) throw new HttpError(409, 'An account with this email already exists.');
  await db.prepare('INSERT INTO users(name, email, phone, password_hash, role, stylist_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(v.name, v.email, v.phone, await hashPassword(String(body.password)), v.role, v.stylist_id).run();
  return { ok: true };
});
route('PUT', '/api/admin/staff/:id', A, async ({ params, body, db, user }) => {
  const id = Number(params.id);
  const u = await db.prepare(`SELECT * FROM users WHERE id = ? AND role IN ('staff','admin')`).bind(id).first();
  if (!u) throw new HttpError(404, 'Staff member not found.');
  const v = await staffInput(db, { ...body, email: u.email }, false);
  if (u.role === 'admin' && (v.role !== 'admin' || !v.active) && (await adminsLeft(db, id)) === 0) throw bad('You need at least one active admin.');
  if (id === user.id && !v.active) throw bad('You can’t deactivate your own account.');
  const batch = [db.prepare('UPDATE users SET name = ?, phone = ?, role = ?, stylist_id = ?, active = ? WHERE id = ?').bind(v.name, v.phone, v.role, v.stylist_id, v.active, id)];
  if (!v.active) batch.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  if (body.password) {
    if (String(body.password).length < 6) throw bad('Password must be at least 6 characters.');
    batch.push(db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(String(body.password)), id));
  }
  await db.batch(batch);
  return { ok: true };
});
route('DELETE', '/api/admin/staff/:id', A, async ({ params, db, user }) => {
  const id = Number(params.id);
  const u = await db.prepare(`SELECT * FROM users WHERE id = ? AND role IN ('staff','admin')`).bind(id).first();
  if (!u) throw new HttpError(404, 'Staff member not found.');
  if (id === user.id) throw bad('You can’t remove your own account.');
  if (u.role === 'admin' && (await adminsLeft(db, id)) === 0) throw bad('You need at least one active admin.');
  await db.batch([db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id), db.prepare('DELETE FROM users WHERE id = ?').bind(id)]);
  return { ok: true };
});

route('GET', '/api/admin/settings', A, (ctx) => ctx.settings());
route('PUT', '/api/admin/settings', A, async ({ body, db }) => {
  const patch = {};
  for (const k of ['salon_name', 'tagline', 'quote', 'address', 'phone', 'email', 'currency', 'instagram', 'map_url']) if (k in body) patch[k] = str(body[k], 200);
  if ('logo' in body) {
    const v = String(body.logo || '');
    if (v && !/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v)) throw bad('Logo must be a PNG, JPG, WebP or SVG image.');
    if (v.length > 280000) throw bad('Logo is too large. Please use an image under 200 KB.');
    patch.logo = v;
  }
  if ('logo_color' in body) {
    if (!LOGO_COLORS.includes(body.logo_color)) throw bad('Unknown logo colour.');
    patch.logo_color = body.logo_color;
  }
  if ('logo_show_name' in body) patch.logo_show_name = !!body.logo_show_name && body.logo_show_name !== 'false';
  if ('whatsapp' in body) {
    if (body.whatsapp && !indianMobile(body.whatsapp)) throw bad('WhatsApp must be a valid 10-digit mobile number.');
    patch.whatsapp = body.whatsapp ? indianMobile(body.whatsapp) : '';
  }
  if ('timezone' in body) {
    const tz = str(body.timezone, 64);
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw bad('Unknown time zone.'); }
    patch.timezone = tz;
  }
  for (const k of ['slot_interval', 'cancel_cutoff_hours', 'max_days_ahead']) {
    if (k in body) {
      const n = Math.round(Number(body[k]));
      if (!(n >= 0 && n <= 365)) throw bad(`Invalid ${k.replace(/_/g, ' ')}.`);
      patch[k] = n;
    }
  }
  if (patch.slot_interval !== undefined && patch.slot_interval < 5) throw bad('Slot interval must be at least 5 minutes.');
  if (body.hours) {
    const hours = {};
    for (let d = 0; d < 7; d++) {
      const h = body.hours[d];
      if (!h) { hours[d] = null; continue; }
      if (!/^\d{2}:\d{2}$/.test(h.open) || !/^\d{2}:\d{2}$/.test(h.close) || S.toMin(h.open) >= S.toMin(h.close))
        throw bad('Opening hours must have a valid open time before the close time.');
      hours[d] = { open: h.open, close: h.close };
    }
    patch.hours = hours;
  }
  if (Array.isArray(body.closed_dates)) patch.closed_dates = body.closed_dates.filter(S.isValidDate).sort();
  return saveSettings(db, patch);
});

/* ------------------------------------------------------------ static files */
function serveStatic(pathname) {
  const file = STATIC[pathname] || STATIC['/index.html'];
  return new Response(file.body, {
    headers: {
      'Content-Type': file.type,
      'Cache-Control': pathname === '/' || !STATIC[pathname] || pathname.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}

function withHeaders(res, headers) {
  for (const [k, v] of headers) res.headers.append(k, v);
  return res;
}

/* ------------------------------------------------------------------- fetch */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname === '/' ? '/index.html' : url.pathname);

    const headers = new Headers();
    try {
      if (!env.DB) throw new HttpError(500, 'Database binding "DB" is not configured.');
      await ensureSeed(env.DB);
      if (req.method !== 'GET' && !(req.headers.get('content-type') || '').includes('application/json'))
        throw new HttpError(415, 'Expected application/json');

      let match;
      const r = routes.find((r) => r.method === req.method && (match = url.pathname.match(r.re)));
      if (!r) throw new HttpError(404, 'Not found');

      let settingsCache;
      const ctx = {
        req, env, headers, db: env.DB, query: url.searchParams,
        secure: url.protocol === 'https:',
        quickLogin: env.QUICK_LOGIN !== 'false',
        params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])])),
        settings: () => (settingsCache ||= getSettings(env.DB)),
      };
      ctx.user = await currentUser(ctx);
      if (r.auth && !ctx.user) throw new HttpError(401, 'Please sign in.');
      if (r.admin && ctx.user.role !== 'admin') throw new HttpError(403, 'Admins only.');
      if (r.staff && !isStaff(ctx.user)) throw new HttpError(403, 'Staff only.');
      const raw = req.method === 'GET' ? '' : await req.text();
      try { ctx.body = raw ? JSON.parse(raw) : {}; } catch { throw bad('Invalid JSON'); }

      const result = await r.handler(ctx);
      return withHeaders(result instanceof Response ? result : json(result ?? { ok: true }), headers);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      return withHeaders(json({ error: err.status ? err.message : 'Something went wrong.' }, err.status || 500), headers);
    }
  },
};
