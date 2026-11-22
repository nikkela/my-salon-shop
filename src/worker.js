// Lumière Salon — Cloudflare Worker: REST API on D1 + embedded static site.
import { hashPassword, verifyPassword, newToken } from './auth.js';
import * as S from './slots.js';
import STATIC from './static.gen.js';

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

/* ---------------------------------------------------------------- settings */
const DEFAULT_SETTINGS = {
  salon_name: 'Lumière Salon',
  tagline: 'Hair. Skin. Calm.',
  address: '24 Park Avenue, Downtown',
  phone: '+1 (555) 010-2040',
  email: 'hello@lumiere.example',
  currency: 'USD',
  timezone: 'UTC',
  slot_interval: 15,
  cancel_cutoff_hours: 2,
  max_days_ahead: 60,
  hours: {
    0: null,
    1: { open: '10:00', close: '19:00' },
    2: { open: '10:00', close: '19:00' },
    3: { open: '10:00', close: '19:00' },
    4: { open: '10:00', close: '20:00' },
    5: { open: '10:00', close: '20:00' },
    6: { open: '09:00', close: '18:00' },
  },
  closed_dates: [],
};

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
    u.bind('Salon Admin', 'admin@salon.local', '+1 555 000 0001', await hashPassword('admin123'), 'admin'),
    u.bind('Demo Customer', 'demo@salon.local', '+1 555 000 0002', await hashPassword('demo123'), 'customer'),
    ...[
      ['Signature Haircut', 'Hair', 'Consultation, wash, precision cut and blow-dry finish.', 45, 55],
      ['Men’s Cut & Style', 'Hair', 'Clean, tailored cut with hot towel finish.', 30, 35],
      ['Blow-dry & Style', 'Hair', 'Smooth, voluminous or waves — your call.', 30, 40],
      ['Full Colour', 'Colour', 'Root-to-tip single process colour with gloss.', 90, 120],
      ['Balayage', 'Colour', 'Hand-painted, sun-kissed dimension.', 150, 210],
      ['Keratin Smoothing', 'Treatment', 'Frizz-free shine that lasts up to 12 weeks.', 120, 180],
      ['Hydrating Facial', 'Skin', 'Deep cleanse, exfoliation and moisture mask.', 60, 85],
      ['Classic Manicure', 'Nails', 'Shape, cuticle care, polish.', 30, 30],
      ['Gel Pedicure', 'Nails', 'Soak, scrub, massage and long-wear gel.', 45, 50],
      ['Bridal Package', 'Special', 'Trial, hair and make-up on the big day.', 180, 350],
    ].map((s) => sv.bind(...s)),
    ...[
      ['Ava Laurent', 'Creative Director', '12 years shaping effortless, lived-in hair.', 'Hair,Colour,Special'],
      ['Noah Kim', 'Senior Stylist', 'Precision cuts and modern men’s grooming.', 'Hair,Treatment'],
      ['Maya Patel', 'Colour Specialist', 'Balayage and dimensional colour expert.', 'Colour,Hair,Treatment'],
      ['Leo Rossi', 'Skin & Nails Artist', 'Calm hands, detailed finishes.', 'Skin,Nails,Special'],
    ].map((s) => st.bind(...s)),
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

const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, created_at: u.created_at };

async function currentUser(ctx) {
  const token = parseCookies(ctx.req).sid;
  if (!token) return null;
  return ctx.db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?')
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
async function insertBooking(ctx, userId, slot, date, notes) {
  const r = await ctx.db
    .prepare(
      `INSERT INTO bookings(user_id, service_id, stylist_id, date, start_min, end_min, price, notes)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE stylist_id = ? AND date = ?
         AND status IN ('confirmed','completed') AND start_min < ? AND end_min > ?)`
    )
    .bind(userId, slot.service.id, slot.stylistId, date, slot.start, slot.end, slot.service.price, str(notes, 500),
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

/* ---------- public */
route('GET', '/api/config', async (ctx) => {
  const s = await ctx.settings();
  const pick = ['salon_name', 'tagline', 'address', 'phone', 'email', 'currency', 'timezone', 'hours', 'closed_dates', 'max_days_ahead', 'cancel_cutoff_hours'];
  const now = S.nowLocal(s.timezone);
  return { ...Object.fromEntries(pick.map((k) => [k, s[k]])), quick_login: ctx.quickLogin, today: now.date, now_min: now.min };
});

route('GET', '/api/services', async ({ db }) => (await db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY category, price').all()).results);
route('GET', '/api/stylists', async ({ db }) =>
  (await db.prepare('SELECT id, name, title, bio, specialties FROM stylists WHERE active = 1 ORDER BY id').all()).results);

route('GET', '/api/slots', async (ctx) => {
  const { query, user, db } = ctx;
  let exclude = query.get('exclude');
  if (exclude) {
    const own = user && (await db.prepare('SELECT user_id FROM bookings WHERE id = ?').bind(Number(exclude)).first());
    if (!own || (own.user_id !== user.id && user.role !== 'admin')) throw new HttpError(403, 'Forbidden');
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
  const phone = str(body.phone, 30);
  const password = String(body.password || '');
  if (name.length < 2) throw bad('Please enter your name.');
  if (!EMAIL_RE.test(email)) throw bad('Please enter a valid email.');
  if (password.length < 6) throw bad('Password must be at least 6 characters.');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())
    throw new HttpError(409, 'An account with this email already exists. Try signing in.');
  const r = await db.prepare('INSERT INTO users(name, email, phone, password_hash) VALUES (?, ?, ?, ?)').bind(name, email, phone, await hashPassword(password)).run();
  await startSession(ctx, r.meta.last_row_id);
  return { user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').bind(r.meta.last_row_id).first()) };
});

route('POST', '/api/auth/login', async (ctx) => {
  rateLimit(ctx, 'login', 10);
  const u = await ctx.db.prepare('SELECT * FROM users WHERE email = ?').bind(str(ctx.body.email, 120).toLowerCase()).first();
  if (!u || !(await verifyPassword(String(ctx.body.password || ''), u.password_hash))) throw new HttpError(401, 'Incorrect email or password.');
  await startSession(ctx, u.id);
  return { user: publicUser(u) };
});

// One-click (bypass) sign in to the demo customer or admin account.
route('POST', '/api/auth/quick', async (ctx) => {
  if (!ctx.quickLogin) throw new HttpError(403, 'One-click sign in is disabled.');
  const role = ctx.body.role === 'admin' ? 'admin' : 'customer';
  const email = role === 'admin' ? 'admin@salon.local' : 'demo@salon.local';
  let u = await ctx.db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!u) {
    const r = await ctx.db.prepare('INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .bind(role === 'admin' ? 'Salon Admin' : 'Demo Customer', email, await hashPassword(newToken()), role).run();
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
  if (await db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(email, user.id).first())
    throw new HttpError(409, 'That email is already in use.');
  await db.prepare('UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?').bind(name, email, str(body.phone, 30), user.id).run();
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
  if (open.n >= 10 && user.role !== 'admin') throw bad('You have too many upcoming bookings.');
  const slot = await resolveSlot(ctx, body);
  return { booking: await insertBooking(ctx, user.id, slot, body.date, body.notes) };
});

async function ownBooking(db, id, user) {
  const b = await getBooking(db, Number(id));
  if (!b || (b.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Booking not found.');
  return b;
}

async function checkCutoff(ctx, b) {
  if (ctx.user.role === 'admin') return;
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

route('GET', '/api/admin/bookings', A, async ({ query, db }) => {
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

route('POST', '/api/admin/bookings', A, async (ctx) => {
  const { body, db } = ctx;
  const email = str(body.customer_email, 120).toLowerCase();
  const name = str(body.customer_name, 80);
  if (!EMAIL_RE.test(email)) throw bad('Customer email is required.');
  let cust = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  const slot = await resolveSlot(ctx, body);
  if (!cust) {
    if (name.length < 2) throw bad('Customer name is required for new customers.');
    const r = await db.prepare('INSERT INTO users(name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
      .bind(name, email, str(body.customer_phone, 30), await hashPassword(newToken())).run();
    cust = { id: r.meta.last_row_id };
  }
  return { booking: await insertBooking(ctx, cust.id, slot, body.date, body.notes) };
});

route('PATCH', '/api/admin/bookings/:id', A, async ({ params, body, db }) => {
  const b = await getBooking(db, Number(params.id));
  if (!b) throw new HttpError(404, 'Booking not found.');
  if (!['confirmed', 'completed', 'cancelled', 'no_show'].includes(body.status)) throw bad('Invalid status.');
  if (body.status === 'confirmed' && b.status === 'cancelled') {
    const clash = await db
      .prepare(`SELECT 1 FROM bookings WHERE stylist_id = ? AND date = ? AND id != ? AND status IN ('confirmed','completed') AND start_min < ? AND end_min > ?`)
      .bind(b.stylist_id, b.date, b.id, b.end_min, b.start_min).first();
    if (clash) throw new HttpError(409, 'That slot has since been booked by someone else.');
  }
  await db.prepare('UPDATE bookings SET status = ? WHERE id = ?').bind(body.status, b.id).run();
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

function crud(path, table, cols, input, order) {
  route('GET', path, A, async ({ db }) => (await db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()).results);
  route('POST', path, A, async ({ body, db }) => {
    const v = input(body);
    const r = await db.prepare(`INSERT INTO ${table}(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => v[c])).run();
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(r.meta.last_row_id).first();
  });
  route('PUT', `${path}/:id`, A, async ({ params, body, db }) => {
    const v = input(body);
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
crud('/api/admin/services', 'services', ['name', 'category', 'description', 'duration_min', 'price', 'active'], serviceInput, 'active DESC, category, name');
crud('/api/admin/stylists', 'stylists', ['name', 'title', 'bio', 'specialties', 'active'], stylistInput, 'active DESC, name');

route('GET', '/api/admin/customers', A, async ({ query, db }) => {
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

route('GET', '/api/admin/settings', A, (ctx) => ctx.settings());
route('PUT', '/api/admin/settings', A, async ({ body, db }) => {
  const patch = {};
  for (const k of ['salon_name', 'tagline', 'address', 'phone', 'email', 'currency']) if (k in body) patch[k] = str(body[k], 120);
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
      ctx.body = req.method === 'GET' ? {} : await req.json().catch(() => { throw bad('Invalid JSON'); });

      const result = await r.handler(ctx);
      return withHeaders(result instanceof Response ? result : json(result ?? { ok: true }), headers);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      return withHeaders(json({ error: err.status ? err.message : 'Something went wrong.' }, err.status || 500), headers);
    }
  },
};
