'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'salon.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT DEFAULT '',
  duration_min INTEGER NOT NULL,
  price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stylists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  title TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  specialties TEXT DEFAULT '',          -- comma separated categories; empty = all
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id),
  stylist_id INTEGER NOT NULL REFERENCES stylists(id),
  date TEXT NOT NULL,                   -- YYYY-MM-DD (salon local time)
  start_min INTEGER NOT NULL,           -- minutes after midnight
  end_min INTEGER NOT NULL,
  price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','completed','cancelled','no_show')),
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(stylist_id, date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  salon_name: 'Lumière Salon',
  tagline: 'Hair. Skin. Calm.',
  address: '24 Park Avenue, Downtown',
  phone: '+1 (555) 010-2040',
  email: 'hello@lumiere.example',
  currency: 'USD',
  slot_interval: 15,
  cancel_cutoff_hours: 2,
  max_days_ahead: 60,
  // 0 = Sunday ... 6 = Saturday. null = closed.
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

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = JSON.parse(r.value);
  return out;
}

function saveSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
  }
  return getSettings();
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  const addUser = db.prepare(
    'INSERT INTO users(name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  );
  addUser.run('Salon Admin', 'admin@salon.local', '+1 555 000 0001', hashPassword('admin123'), 'admin');
  addUser.run('Demo Customer', 'demo@salon.local', '+1 555 000 0002', hashPassword('demo123'), 'customer');

  const addService = db.prepare(
    'INSERT INTO services(name, category, description, duration_min, price) VALUES (?, ?, ?, ?, ?)'
  );
  [
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
  ].forEach((s) => addService.run(...s));

  const addStylist = db.prepare(
    'INSERT INTO stylists(name, title, bio, specialties) VALUES (?, ?, ?, ?)'
  );
  [
    ['Ava Laurent', 'Creative Director', '12 years shaping effortless, lived-in hair.', 'Hair,Colour,Special'],
    ['Noah Kim', 'Senior Stylist', 'Precision cuts and modern men’s grooming.', 'Hair,Treatment'],
    ['Maya Patel', 'Colour Specialist', 'Balayage and dimensional colour expert.', 'Colour,Hair,Treatment'],
    ['Leo Rossi', 'Skin & Nails Artist', 'Calm hands, detailed finishes.', 'Skin,Nails,Special'],
  ].forEach((s) => addStylist.run(...s));

  saveSettings(DEFAULT_SETTINGS);
  console.log('Seeded database with demo data.');
}

seed();

module.exports = { db, getSettings, saveSettings };
