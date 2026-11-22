'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, getSettings, saveSettings } = require('./db');
const { hashPassword, verifyPassword, newToken } = require('./auth');
const S = require('./slots');

const PORT = Number(process.env.PORT) || 3000;
// One-click / bypass login. On by default for demos; set QUICK_LOGIN=false in production.
const QUICK_LOGIN = process.env.QUICK_LOGIN !== 'false';
const SESSION_DAYS = 30;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* ----------------------------------------------------------------- helpers */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(bad('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, created_at: u.created_at };
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, Date.now());
  return row || null;
}

function startSession(res, userId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    Date.now() + SESSION_DAYS * 864e5
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tiny in-memory rate limiter for auth endpoints.
const attempts = new Map();
function rateLimit(req, key, limit = 10, windowMs = 10 * 60e3) {
  const id = `${key}:${req.socket.remoteAddress}`;
  const now = Date.now();
  const rec = attempts.get(id) || { n: 0, reset: now + windowMs };
  if (now > rec.reset) Object.assign(rec, { n: 0, reset: now + windowMs });
  rec.n += 1;
  attempts.set(id, rec);
  if (rec.n > limit) throw new HttpError(429, 'Too many attempts. Please try again in a few minutes.');
}

const BOOKING_SELECT = `
  SELECT b.*, s.name AS service_name, s.category AS service_category, s.duration_min,
         st.name AS stylist_name, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
  FROM bookings b
  JOIN services s ON s.id = b.service_id
  JOIN stylists st ON st.id = b.stylist_id
  JOIN users u ON u.id = b.user_id`;

function decorate(b) {
  if (!b) return b;
  return { ...b, time: S.fmtMin(b.start_min), end_time: S.fmtMin(b.end_min) };
}

function getBooking(id) {
  return decorate(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(id));
}

function hasStarted(b) {
  const today = S.localDateStr();
  return b.date < today || (b.date === today && b.start_min <= S.nowMinutes());
}

/** Validate the requested slot and pick a stylist. Throws on conflict. */
function resolveSlot({ service_id, stylist_id, date, time, excludeBookingId }) {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(Number(service_id));
  if (!service) throw bad('Please choose a service.');
  if (!S.isValidDate(date)) throw bad('Please choose a valid date.');
  if (!/^\d{2}:\d{2}$/.test(String(time))) throw bad('Please choose a time.');
  const slots = S.availableSlots({
    date,
    serviceId: service.id,
    stylistId: stylist_id || null,
    excludeBookingId,
  });
  const slot = slots.find((s) => s.time === time);
  if (!slot) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another slot.');
  return { service, stylistId: slot.stylist_ids[0], start: slot.start_min, end: slot.start_min + service.duration_min };
}

function icsFor(b, settings) {
  const dt = (date, min) => `${date.replace(/-/g, '')}T${S.fmtMin(min).replace(':', '')}00`;
  const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Salon//Booking//EN',
    'BEGIN:VEVENT',
    `UID:booking-${b.id}@salon`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
    `DTSTART:${dt(b.date, b.start_min)}`,
    `DTEND:${dt(b.date, b.end_min)}`,
    `SUMMARY:${esc(`${b.service_name} at ${settings.salon_name}`)}`,
    `DESCRIPTION:${esc(`With ${b.stylist_name}. Booking #${b.id}.`)}`,
    `LOCATION:${esc(settings.address)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/* ------------------------------------------------------------------ router */

const routes = [];
const route = (method, pattern, opts, handler) => {
  if (typeof opts === 'function') [handler, opts] = [opts, {}];
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
  );
  routes.push({ method, re, keys, handler, ...opts });
};

/* ---------- public */

route('GET', '/api/config', () => {
  const s = getSettings();
  return {
    salon_name: s.salon_name,
    tagline: s.tagline,
    address: s.address,
    phone: s.phone,
    email: s.email,
    currency: s.currency,
    hours: s.hours,
    closed_dates: s.closed_dates,
    max_days_ahead: s.max_days_ahead,
    cancel_cutoff_hours: s.cancel_cutoff_hours,
    quick_login: QUICK_LOGIN,
    today: S.localDateStr(),
  };
});

route('GET', '/api/services', () =>
  db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY category, price').all()
);

route('GET', '/api/stylists', () =>
  db.prepare('SELECT id, name, title, bio, specialties FROM stylists WHERE active = 1 ORDER BY id').all()
);

route('GET', '/api/slots', ({ query, user }) => {
  const exclude = query.get('exclude');
  // Only let a user exclude their own booking (used when rescheduling).
  if (exclude && user) {
    const own = db.prepare('SELECT user_id FROM bookings WHERE id = ?').get(Number(exclude));
    if (!own || (own.user_id !== user.id && user.role !== 'admin')) throw new HttpError(403, 'Forbidden');
  }
  return S.availableSlots({
    date: query.get('date'),
    serviceId: Number(query.get('service_id')),
    stylistId: query.get('stylist_id') || null,
    excludeBookingId: user ? exclude : null,
  });
});

// Day-by-day summary used to grey out full / closed days in the calendar.
route('GET', '/api/availability', ({ query }) => {
  const serviceId = Number(query.get('service_id'));
  const stylistId = query.get('stylist_id') || null;
  const from = S.isValidDate(query.get('from')) ? query.get('from') : S.localDateStr();
  const days = Math.min(Number(query.get('days')) || 42, 62);
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = S.addDays(from, i);
    out.push({ date, slots: S.availableSlots({ date, serviceId, stylistId }).length });
  }
  return out;
});

/* ---------- auth */

route('POST', '/api/auth/register', ({ body, req, res }) => {
  rateLimit(req, 'register', 20);
  const name = str(body.name, 80);
  const email = str(body.email, 120).toLowerCase();
  const phone = str(body.phone, 30);
  const password = String(body.password || '');
  if (name.length < 2) throw bad('Please enter your name.');
  if (!EMAIL_RE.test(email)) throw bad('Please enter a valid email.');
  if (password.length < 6) throw bad('Password must be at least 6 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    throw new HttpError(409, 'An account with this email already exists. Try signing in.');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users(name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
    .run(name, email, phone, hashPassword(password));
  startSession(res, Number(lastInsertRowid));
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) };
});

route('POST', '/api/auth/login', ({ body, req, res }) => {
  rateLimit(req, 'login', 10);
  const email = str(body.email, 120).toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !verifyPassword(String(body.password || ''), u.password_hash))
    throw new HttpError(401, 'Incorrect email or password.');
  startSession(res, u.id);
  return { user: publicUser(u) };
});

// One-click (bypass) login into the demo customer or admin account.
route('POST', '/api/auth/quick', ({ body, res }) => {
  if (!QUICK_LOGIN) throw new HttpError(403, 'One-click sign in is disabled.');
  const role = body.role === 'admin' ? 'admin' : 'customer';
  const email = role === 'admin' ? 'admin@salon.local' : 'demo@salon.local';
  let u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u) {
    const name = role === 'admin' ? 'Salon Admin' : 'Demo Customer';
    const r = db
      .prepare('INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, email, hashPassword(newToken()), role);
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  }
  startSession(res, u.id);
  return { user: publicUser(u) };
});

route('POST', '/api/auth/logout', ({ req, res }) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
});

route('GET', '/api/auth/me', ({ user }) => ({ user: publicUser(user) }));

/* ---------- customer */

route('PUT', '/api/me', { auth: true }, ({ body, user }) => {
  const name = str(body.name, 80);
  const email = str(body.email, 120).toLowerCase();
  const phone = str(body.phone, 30);
  if (name.length < 2) throw bad('Please enter your name.');
  if (!EMAIL_RE.test(email)) throw bad('Please enter a valid email.');
  const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, user.id);
  if (clash) throw new HttpError(409, 'That email is already in use.');
  db.prepare('UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?').run(name, email, phone, user.id);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
});

route('PUT', '/api/me/password', { auth: true }, ({ body, user }) => {
  if (!verifyPassword(String(body.current || ''), user.password_hash))
    throw bad('Your current password is incorrect.');
  if (String(body.next || '').length < 6) throw bad('New password must be at least 6 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.next), user.id);
  return { ok: true };
});

route('GET', '/api/bookings', { auth: true }, ({ user }) =>
  db
    .prepare(`${BOOKING_SELECT} WHERE b.user_id = ? ORDER BY b.date DESC, b.start_min DESC`)
    .all(user.id)
    .map(decorate)
);

route('POST', '/api/bookings', { auth: true }, ({ body, user }) => {
  const open = db
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'confirmed' AND date >= ?`)
    .get(user.id, S.localDateStr()).n;
  if (open >= 10 && user.role !== 'admin') throw bad('You have too many upcoming bookings.');
  const slot = resolveSlot(body);
  const r = db
    .prepare(
      `INSERT INTO bookings(user_id, service_id, stylist_id, date, start_min, end_min, price, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(user.id, slot.service.id, slot.stylistId, body.date, slot.start, slot.end, slot.service.price, str(body.notes, 500));
  return { booking: getBooking(r.lastInsertRowid) };
});

function ownBooking(id, user) {
  const b = getBooking(Number(id));
  if (!b || (b.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Booking not found.');
  return b;
}

function checkCutoff(b, user) {
  if (user.role === 'admin') return;
  const cutoff = Number(getSettings().cancel_cutoff_hours) || 0;
  const start = new Date(`${b.date}T${b.time}:00`).getTime();
  if (start - Date.now() < cutoff * 3600e3)
    throw bad(`Changes are only possible up to ${cutoff} hours before your appointment. Please call us.`);
}

route('PATCH', '/api/bookings/:id/cancel', { auth: true }, ({ params, user }) => {
  const b = ownBooking(params.id, user);
  if (b.status !== 'confirmed') throw bad('This booking can no longer be cancelled.');
  checkCutoff(b, user);
  db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(b.id);
  return { booking: getBooking(b.id) };
});

route('PATCH', '/api/bookings/:id/reschedule', { auth: true }, ({ params, body, user }) => {
  const b = ownBooking(params.id, user);
  if (b.status !== 'confirmed') throw bad('Only upcoming bookings can be rescheduled.');
  checkCutoff(b, user);
  const slot = resolveSlot({
    service_id: b.service_id,
    stylist_id: body.stylist_id || null,
    date: body.date,
    time: body.time,
    excludeBookingId: b.id,
  });
  db.prepare('UPDATE bookings SET date = ?, start_min = ?, end_min = ?, stylist_id = ? WHERE id = ?').run(
    body.date,
    slot.start,
    slot.end,
    slot.stylistId,
    b.id
  );
  return { booking: getBooking(b.id) };
});

route('GET', '/api/bookings/:id/ics', { auth: true, raw: true }, ({ params, user, res }) => {
  const b = ownBooking(params.id, user);
  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="appointment-${b.id}.ics"`,
  });
  res.end(icsFor(b, getSettings()));
});

/* ---------- admin */

const A = { auth: true, admin: true };

route('GET', '/api/admin/stats', A, () => {
  const today = S.localDateStr();
  const monthStart = today.slice(0, 8) + '01';
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const monthEnd = monthStart.slice(0, 8) + '31';
  const dayStats = (from, to) => {
    const out = [];
    for (let i = from; i <= to; i++) {
      const d = S.addDays(today, i);
      const r = one(
        `SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS rev FROM bookings WHERE date = ? AND status IN ('confirmed','completed')`,
        d
      );
      out.push({ date: d, bookings: r.n, revenue: r.rev });
    }
    return out;
  };
  return {
    today,
    today_bookings: one(`SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND status != 'cancelled'`, today).n,
    upcoming: one(`SELECT COUNT(*) AS n FROM bookings WHERE date >= ? AND status = 'confirmed'`, today).n,
    month_revenue: one(
      `SELECT COALESCE(SUM(price),0) AS v FROM bookings WHERE date >= ? AND date <= ? AND status IN ('confirmed','completed')`,
      monthStart,
      monthEnd
    ).v,
    customers: one(`SELECT COUNT(*) AS n FROM users WHERE role = 'customer'`).n,
    cancel_rate: (() => {
      const r = one(
        `SELECT COUNT(*) AS total, SUM(status = 'cancelled') AS c FROM bookings WHERE date >= ?`,
        S.addDays(today, -30)
      );
      return r.total ? Math.round((100 * r.c) / r.total) : 0;
    })(),
    week: dayStats(-6, 0),
    ahead: dayStats(0, 6),
    top_services: db
      .prepare(
        `SELECT s.name, COUNT(*) AS n FROM bookings b JOIN services s ON s.id = b.service_id
         WHERE b.status != 'cancelled' GROUP BY s.id ORDER BY n DESC LIMIT 5`
      )
      .all(),
    schedule: db
      .prepare(`${BOOKING_SELECT} WHERE b.date = ? AND b.status != 'cancelled' ORDER BY b.start_min`)
      .all(today)
      .map(decorate),
  };
});

route('GET', '/api/admin/bookings', A, ({ query }) => {
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
  const sql = `${BOOKING_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY b.date DESC, b.start_min ASC LIMIT 500`;
  return db.prepare(sql).all(...args).map(decorate);
});

// Walk-in / phone booking created by staff.
route('POST', '/api/admin/bookings', A, ({ body }) => {
  const email = str(body.customer_email, 120).toLowerCase();
  const name = str(body.customer_name, 80);
  if (!EMAIL_RE.test(email)) throw bad('Customer email is required.');
  let cust = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!cust) {
    if (name.length < 2) throw bad('Customer name is required for new customers.');
    const r = db
      .prepare('INSERT INTO users(name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
      .run(name, email, str(body.customer_phone, 30), hashPassword(newToken()));
    cust = { id: Number(r.lastInsertRowid) };
  }
  const slot = resolveSlot(body);
  const r = db
    .prepare(
      `INSERT INTO bookings(user_id, service_id, stylist_id, date, start_min, end_min, price, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(cust.id, slot.service.id, slot.stylistId, body.date, slot.start, slot.end, slot.service.price, str(body.notes, 500));
  return { booking: getBooking(r.lastInsertRowid) };
});

route('PATCH', '/api/admin/bookings/:id', A, ({ params, body }) => {
  const b = getBooking(Number(params.id));
  if (!b) throw new HttpError(404, 'Booking not found.');
  const statuses = ['confirmed', 'completed', 'cancelled', 'no_show'];
  if (!statuses.includes(body.status)) throw bad('Invalid status.');
  if (body.status === 'confirmed' && b.status === 'cancelled') {
    // Re-opening a cancelled booking: make sure the slot is still free.
    const clash = db
      .prepare(
        `SELECT 1 FROM bookings WHERE stylist_id = ? AND date = ? AND id != ?
         AND status IN ('confirmed','completed') AND start_min < ? AND end_min > ?`
      )
      .get(b.stylist_id, b.date, b.id, b.end_min, b.start_min);
    if (clash) throw new HttpError(409, 'That slot has since been booked by someone else.');
  }
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(body.status, b.id);
  return { booking: getBooking(b.id) };
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

route('GET', '/api/admin/services', A, () => db.prepare('SELECT * FROM services ORDER BY active DESC, category, name').all());
route('POST', '/api/admin/services', A, ({ body }) => {
  const v = serviceInput(body);
  const r = db
    .prepare('INSERT INTO services(name, category, description, duration_min, price, active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(v.name, v.category, v.description, v.duration_min, v.price, v.active);
  return db.prepare('SELECT * FROM services WHERE id = ?').get(r.lastInsertRowid);
});
route('PUT', '/api/admin/services/:id', A, ({ params, body }) => {
  const v = serviceInput(body);
  db.prepare(
    'UPDATE services SET name = ?, category = ?, description = ?, duration_min = ?, price = ?, active = ? WHERE id = ?'
  ).run(v.name, v.category, v.description, v.duration_min, v.price, v.active, Number(params.id));
  return db.prepare('SELECT * FROM services WHERE id = ?').get(Number(params.id));
});
route('DELETE', '/api/admin/services/:id', A, ({ params }) => {
  const id = Number(params.id);
  const used = db.prepare('SELECT 1 FROM bookings WHERE service_id = ? LIMIT 1').get(id);
  if (used) db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(id);
  else db.prepare('DELETE FROM services WHERE id = ?').run(id);
  return { ok: true, archived: !!used };
});

function stylistInput(body) {
  const v = {
    name: str(body.name, 80),
    title: str(body.title, 80),
    bio: str(body.bio, 400),
    specialties: str(body.specialties, 200),
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
  if (v.name.length < 2) throw bad('Stylist name is required.');
  return v;
}

route('GET', '/api/admin/stylists', A, () => db.prepare('SELECT * FROM stylists ORDER BY active DESC, name').all());
route('POST', '/api/admin/stylists', A, ({ body }) => {
  const v = stylistInput(body);
  const r = db
    .prepare('INSERT INTO stylists(name, title, bio, specialties, active) VALUES (?, ?, ?, ?, ?)')
    .run(v.name, v.title, v.bio, v.specialties, v.active);
  return db.prepare('SELECT * FROM stylists WHERE id = ?').get(r.lastInsertRowid);
});
route('PUT', '/api/admin/stylists/:id', A, ({ params, body }) => {
  const v = stylistInput(body);
  db.prepare('UPDATE stylists SET name = ?, title = ?, bio = ?, specialties = ?, active = ? WHERE id = ?').run(
    v.name,
    v.title,
    v.bio,
    v.specialties,
    v.active,
    Number(params.id)
  );
  return db.prepare('SELECT * FROM stylists WHERE id = ?').get(Number(params.id));
});
route('DELETE', '/api/admin/stylists/:id', A, ({ params }) => {
  const id = Number(params.id);
  const used = db.prepare('SELECT 1 FROM bookings WHERE stylist_id = ? LIMIT 1').get(id);
  if (used) db.prepare('UPDATE stylists SET active = 0 WHERE id = ?').run(id);
  else db.prepare('DELETE FROM stylists WHERE id = ?').run(id);
  return { ok: true, archived: !!used };
});

route('GET', '/api/admin/customers', A, ({ query }) => {
  const q = `%${str(query.get('q'), 80)}%`;
  return db
    .prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.created_at,
              COUNT(b.id) AS bookings,
              COALESCE(SUM(CASE WHEN b.status IN ('confirmed','completed') THEN b.price END), 0) AS spent,
              MAX(CASE WHEN b.status != 'cancelled' THEN b.date END) AS last_visit
       FROM users u LEFT JOIN bookings b ON b.user_id = u.id
       WHERE u.role = 'customer' AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)
       GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500`
    )
    .all(q, q, q);
});

route('GET', '/api/admin/settings', A, () => getSettings());
route('PUT', '/api/admin/settings', A, ({ body }) => {
  const patch = {};
  for (const k of ['salon_name', 'tagline', 'address', 'phone', 'email', 'currency']) {
    if (k in body) patch[k] = str(body[k], 120);
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
      if (!h) {
        hours[d] = null;
        continue;
      }
      if (!/^\d{2}:\d{2}$/.test(h.open) || !/^\d{2}:\d{2}$/.test(h.close) || S.toMin(h.open) >= S.toMin(h.close))
        throw bad('Opening hours must have a valid open time before the close time.');
      hours[d] = { open: h.open, close: h.close };
    }
    patch.hours = hours;
  }
  if (Array.isArray(body.closed_dates)) patch.closed_dates = body.closed_dates.filter(S.isValidDate).sort();
  return saveSettings(patch);
});

/* ------------------------------------------------------------ static files */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  let file;
  try {
    file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  try {
    // Basic CSRF defence: state-changing API calls must be JSON (cannot be sent by a plain HTML form).
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json'))
      throw new HttpError(415, 'Expected application/json');

    let match;
    const r = routes.find((r) => r.method === req.method && (match = url.pathname.match(r.re)));
    if (!r) throw new HttpError(404, 'Not found');

    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
    const user = currentUser(req);
    if (r.auth && !user) throw new HttpError(401, 'Please sign in.');
    if (r.admin && user.role !== 'admin') throw new HttpError(403, 'Admins only.');
    const body = req.method === 'GET' ? {} : await readBody(req);

    const result = await r.handler({ req, res, params, query: url.searchParams, body, user });
    if (!r.raw) send(res, 200, result ?? { ok: true });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.' });
  }
});

server.listen(PORT, () => {
  console.log(`Salon running at http://localhost:${PORT}`);
  console.log(`One-click sign in: ${QUICK_LOGIN ? 'ENABLED (set QUICK_LOGIN=false to disable)' : 'disabled'}`);
});
