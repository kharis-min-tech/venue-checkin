# Kharis Venue Check-in

A simple booking + gate check-in system for visits to the new building, running on
Cloudflare Workers with a D1 database.

- **Members** book a two-hour time slot in advance on the public form (`/`).
  Slots run 9am–5pm (9–11, 11–1, 1–3, 3–5), **30 people per slot**.
- **Security** use the staff dashboard (`/staff/`) to look people up, verify them,
  sign them in on arrival and out on departure, and add external visitors
  (contractors etc.) with an on-screen signature.
- **Workers & contractors** sign in to the health & safety register at `/workers`.
- **Venue uplift requisitions** at `/requisitions`: the request form is public
  (anyone can file a one-off or recurring spend request); the spend log, totals
  and approve/decline review sit behind an admin passcode.
- **CSV export** of everyone who booked / checked in over any date range, and of
  the requisitions spend log.

---

## 1. Install

```bash
npm install
```

## 2. Run locally

```bash
npm run db:init:local      # create the local database tables (first time only)
npm run dev                # starts http://localhost:8787
```

- Booking form:   http://localhost:8787/
- Staff dashboard: http://localhost:8787/staff/

Local passcodes and the session secret live in `.dev.vars`, which is git-ignored
and so not in this repo. Copy `.dev.vars.example` to `.dev.vars` and set your own
values for local development.

## 3. Deploy to Cloudflare

You only need to do steps a–c once.

**a. Log in** (opens a browser to authorise your Cloudflare account):

```bash
npx wrangler login
```

**b. Create the real database** and copy the `database_id` it prints into
`wrangler.jsonc` (replace `LOCAL_DEV_PLACEHOLDER`):

```bash
npx wrangler d1 create venue-checkin-db
```

**c. Set the production secrets** (you will be prompted to type each value):

```bash
npx wrangler secret put STAFF_PASSCODE                  # passcode for the staff dashboard
npx wrangler secret put SESSION_SECRET                  # any long random string
npx wrangler secret put REQUISITIONS_APPROVER_PASSCODE  # admin passcode for /requisitions review
```

The `/requisitions` request form itself is public (no passcode); only the spend
log and approvals use `REQUISITIONS_APPROVER_PASSCODE`.

**d. Create the tables in the live database, then deploy:**

```bash
npm run db:init:remote
npm run deploy
```

Wrangler prints your live URL (e.g. `https://venue-checkin.<your-subdomain>.workers.dev`).
Share `/` with members and `/staff/` with your security/admin team.

---

## Everyday admin

**Change the staff passcode:** `npx wrangler secret put STAFF_PASSCODE` then `npm run deploy`.

**Add or remove a branch:** edit the list in `src/config.js`, then `npm run deploy`.

**Change slot times or the 30-person limit:** edit `SLOTS` / `CAPACITY` in `src/config.js`, then `npm run deploy`.

**Export today's sign-ins:** staff dashboard → *History & export* → pick the dates → *Download CSV*.

**Back up / inspect the database:**
```bash
npx wrangler d1 execute venue-checkin-db --remote --command "SELECT COUNT(*) FROM bookings"
npx wrangler d1 export venue-checkin-db --remote --output backup.sql
```

---

## How it works (for developers)

| Path | What it is |
|------|-----------|
| `src/index.js` | The Worker: all `/api/*` routes + serves the static pages |
| `src/config.js` | Branches, slots, capacity, timezone |
| `src/util.js` | Time (Europe/London), sessions, CSV, reference codes |
| `public/` | Booking form, staff dashboard, CSS/JS (served as static assets) |
| `schema.sql` | Database tables |

- Capacity is enforced atomically in SQL (a slot can never exceed 30, even under
  simultaneous bookings).
- The staff area is protected by a single shared passcode; a signed, HTTP-only
  session cookie keeps staff logged in for 12 hours.
- All times are handled in UK local time (`Europe/London`).
