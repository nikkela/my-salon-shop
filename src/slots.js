// Availability engine. Dates are salon-local 'YYYY-MM-DD' strings; times are minutes after midnight.
const pad = (n) => String(n).padStart(2, '0');

export const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export const fmtMin = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

const utc = (s) => new Date(s + 'T00:00:00Z');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = utc(s);
  return !isNaN(d) && ymd(d) === s;
}
export const addDays = (s, n) => {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
export const dayOfWeek = (s) => utc(s).getUTCDay();

/** Current date and minute in the salon's time zone. */
export function nowLocal(tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
  } catch {
    return nowLocal('UTC');
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

export function hoursFor(date, settings) {
  if ((settings.closed_dates || []).includes(date)) return null;
  const h = settings.hours[dayOfWeek(date)];
  return h ? { open: toMin(h.open), close: toMin(h.close) } : null;
}

export function stylistDoesCategory(stylist, category) {
  const list = (stylist.specialties || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(category);
}

const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

/** Pure slot computation for one date. `bookings` = live bookings on that date. */
export function computeSlots({ date, service, stylists, bookings, settings, now, excludeBookingId }) {
  if (!service || !isValidDate(date)) return [];
  if (date < now.date || date > addDays(now.date, settings.max_days_ahead)) return [];
  const hours = hoursFor(date, settings);
  if (!hours) return [];
  const step = Number(settings.slot_interval) || 15;
  const earliest = date === now.date ? now.min + 30 : 0; // 30 min lead time
  const busy = new Map(stylists.map((s) => [s.id, []]));
  for (const b of bookings) {
    if (b.date !== date || (excludeBookingId && b.id === Number(excludeBookingId))) continue;
    busy.get(b.stylist_id)?.push(b);
  }
  const slots = [];
  for (let start = hours.open; start + service.duration_min <= hours.close; start += step) {
    if (start < earliest) continue;
    const end = start + service.duration_min;
    const free = stylists.filter((s) => !busy.get(s.id).some((b) => overlaps(start, end, b.start_min, b.end_min))).map((s) => s.id);
    if (free.length) slots.push({ time: fmtMin(start), start_min: start, stylist_ids: free });
  }
  return slots;
}

/** Loads what computeSlots needs for a date range from D1. */
export async function loadSlotContext(db, { serviceId, stylistId, from, to }) {
  const service = await db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').bind(Number(serviceId) || 0).first();
  if (!service) return { service: null, stylists: [], bookings: [] };
  const { results: all } = await db.prepare('SELECT * FROM stylists WHERE active = 1 ORDER BY id').all();
  const stylists = all.filter((s) => stylistDoesCategory(s, service.category) && (!stylistId || s.id === Number(stylistId)));
  const { results: bookings } = await db
    .prepare(`SELECT id, stylist_id, date, start_min, end_min FROM bookings WHERE date >= ? AND date <= ? AND status IN ('confirmed','completed')`)
    .bind(from, to)
    .all();
  return { service, stylists, bookings };
}
