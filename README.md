# My Salon Shop

A complete salon website: customer accounts, **one-click sign in**, real-time slot booking, and an admin console. The design is inspired by Apple's style: system fonts, lots of white space, frosted navigation, rounded cards and automatic dark mode.

No framework, no build step and **no dependencies**. It runs on Node.js 22.5+ with its built-in SQLite.

## Quick start

```bash
npm start
```

Open http://localhost:3000. The database (`data/salon.db`) is created and filled with demo data on first run.

| Account  | Email               | Password   |
|----------|---------------------|------------|
| Customer | `demo@salon.local`  | `demo123`  |
| Admin    | `admin@salon.local` | `admin123` |

You don't need either password: the sign-in page has **One-click sign in** (customer) and **Salon staff (admin)** buttons. The last booking step also has an inline one-click button, so a guest can go from choosing a service to a confirmed booking without filling in any form.

## Features

**Customers**
- Home, Services (filter by category), Team and Visit (hours, contact, directions) pages
- Four-step booking: service → stylist (or "any available") → calendar & time → confirm
  - The calendar marks days that have free slots and disables full or closed days
  - Times are grouped into Morning, Afternoon and Evening, with live availability per stylist
  - Your choices are kept while you sign in, and you return to the same step
- Sign up, sign in, one-click sign in, sign out (30-day session)
- My bookings: upcoming and past, **reschedule**, **cancel** (until the cut-off), **Add to Calendar** (.ics), **Book again**
- Profile editing and password change
- Responsive phone layout, dark mode, reduced-motion support, installable web-app manifest

**Admin console** (`#/admin`)
- Overview: today's count, upcoming bookings, revenue this month, customers, cancel rate, a booked-revenue chart (past or next 7 days, with a table view) and top services
- Schedule: a day board with one column per stylist; click an appointment to complete, mark no-show, cancel, re-open or reschedule it
- Bookings: search and filter by date range, status and stylist
- New booking for walk-in and phone customers (creates the customer if they're new)
- Add, edit and archive services (price, duration, category, online visibility)
- Team: stylists with the service categories they cover (used to filter who can be booked)
- Customers: booking count, total spent, last visit, search
- Settings: salon details, weekly opening hours, holidays and closed dates, slot interval, cancellation cut-off, how far ahead customers can book

**Booking rules on the server**
- Slots are worked out from opening hours, service length, the stylist's specialties and existing bookings, so the same stylist can never be double-booked
- Every booking is checked again when it's saved. If two people pick the same slot, the second gets a friendly "just taken" message
- There's a 30-minute minimum lead time for same-day bookings, and changes are blocked inside the cut-off window

## Configuration

| Variable      | Default  | Purpose |
|---------------|----------|---------|
| `PORT`        | `3000`   | HTTP port |
| `DATA_DIR`    | `./data` | Where the SQLite database is stored |
| `QUICK_LOGIN` | enabled  | Set to `false` to turn off one-click / bypass sign in |
| `NODE_ENV`    | –        | Set to `production` to mark session cookies `Secure` (HTTPS) |

> ⚠️ **One-click sign in skips passwords** and signs anyone in as the demo customer or the **admin**. It's useful for demos and testing. Run with `QUICK_LOGIN=false` before going live.

Start again with fresh demo data: delete `data/salon.db` and restart.

## Project layout

```
server/
  index.js   HTTP server, REST API, static files
  db.js      SQLite schema, settings, demo seed data
  slots.js   availability / slot engine
  auth.js    scrypt password hashing, session tokens
public/
  index.html app shell
  styles.css design system (light + dark)
  app.js     single-page app: pages, booking flow, account, admin
```

## Security notes

- Passwords are hashed with scrypt and per-user salts. Sessions use random tokens in `HttpOnly`, `SameSite=Lax` cookies
- API calls that change data must be sent as JSON, which blocks cross-site form posts
- Sign-in and sign-up are rate-limited per IP. Admin endpoints check the user's role on the server
