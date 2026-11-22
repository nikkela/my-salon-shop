-- Adds the 'staff' role, staff↔stylist link, admin-managed dropdown lists and extra booking fields.
PRAGMA defer_foreign_keys = true;

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','staff','admin')),
  stylist_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO users_new (id, name, email, phone, password_hash, role, created_at)
  SELECT id, name, email, phone, password_hash, role, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE TABLE IF NOT EXISTS options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list TEXT NOT NULL,
  label TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_options_list ON options(list, active, sort);

INSERT INTO options (list, label, sort) VALUES
  ('category', 'Hair', 1), ('category', 'Threading & Wax', 2), ('category', 'Colour', 3), ('category', 'Bridal', 4),
  ('category', 'Treatment', 5), ('category', 'Skin', 6), ('category', 'Nails', 7),
  ('source', 'Walk-in', 1), ('source', 'Phone call', 2), ('source', 'WhatsApp', 3), ('source', 'Instagram', 4), ('source', 'Online', 5),
  ('payment', 'Cash', 1), ('payment', 'UPI', 2), ('payment', 'Card', 3), ('payment', 'Pending', 4),
  ('reason', 'Customer cancelled', 1), ('reason', 'Did not show up', 2), ('reason', 'Stylist unavailable', 3), ('reason', 'Rescheduled by phone', 4);

ALTER TABLE bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'Online';
ALTER TABLE bookings ADD COLUMN payment_method TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN status_reason TEXT NOT NULL DEFAULT '';
