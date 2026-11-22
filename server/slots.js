'use strict';
const { db, getSettings } = require('./db');

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const pad = (n) => String(n).padStart(2, '0');
const fmtMin = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function nowMinutes(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !isNaN(d) && localDateStr(d) === s;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

/** Opening hours for a date, or null if the salon is closed. */
function hoursFor(dateStr, settings = getSettings()) {
  if ((settings.closed_dates || []).includes(dateStr)) return null;
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const h = settings.hours[dow];
  if (!h) return null;
  return { open: toMin(h.open), close: toMin(h.close) };
}

function stylistDoesCategory(stylist, category) {
  const list = (stylist.specialties || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(category);
}

function eligibleStylists(service, stylistId) {
  const all = db.prepare('SELECT * FROM stylists WHERE active = 1 ORDER BY id').all();
  return all.filter(
    (s) => stylistDoesCategory(s, service.category) && (!stylistId || s.id === Number(stylistId))
  );
}

function busyMap(dateStr, stylistIds, excludeBookingId) {
  const map = new Map(stylistIds.map((id) => [id, []]));
  if (!stylistIds.length) return map;
  const rows = db
    .prepare(
      `SELECT id, stylist_id, start_min, end_min FROM bookings
       WHERE date = ? AND status IN ('confirmed','completed')`
    )
    .all(dateStr);
  for (const r of rows) {
    if (excludeBookingId && r.id === Number(excludeBookingId)) continue;
    if (map.has(r.stylist_id)) map.get(r.stylist_id).push(r);
  }
  return map;
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * Available start times for a service on a date.
 * Returns [{ time:'HH:MM', start_min, stylist_ids:[...] }]
 */
function availableSlots({ date, serviceId, stylistId, excludeBookingId }) {
  const settings = getSettings();
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
  if (!service || !isValidDate(date)) return [];

  const today = localDateStr();
  if (date < today || date > addDays(today, settings.max_days_ahead)) return [];

  const hours = hoursFor(date, settings);
  if (!hours) return [];

  const stylists = eligibleStylists(service, stylistId);
  const busy = busyMap(date, stylists.map((s) => s.id), excludeBookingId);
  const step = Number(settings.slot_interval) || 15;
  const earliest = date === today ? nowMinutes() + 30 : 0; // 30 min lead time

  const slots = [];
  for (let start = hours.open; start + service.duration_min <= hours.close; start += step) {
    if (start < earliest) continue;
    const end = start + service.duration_min;
    const free = stylists
      .filter((s) => !busy.get(s.id).some((b) => overlaps(start, end, b.start_min, b.end_min)))
      .map((s) => s.id);
    if (free.length) slots.push({ time: fmtMin(start), start_min: start, stylist_ids: free });
  }
  return slots;
}

module.exports = {
  availableSlots,
  hoursFor,
  eligibleStylists,
  localDateStr,
  nowMinutes,
  isValidDate,
  addDays,
  toMin,
  fmtMin,
};
