import { BRANCHES, DEFAULT_SLOTS, DEFAULT_CAPACITY, GRACE_MINUTES, REQUISITION_CATEGORIES, REQUISITION_FREQUENCIES } from "./config.js";
import {
  json, clean, isValidDate, londonDate, londonMinutesOfDay, formatLondon, nowISO,
  makeReference, createSession, verifySession, getCookie, timingSafeEqual, toCSV,
  hmToMin, slotKey, slotLabel, labelFromKey, poundsToPence, formatPence
} from "./util.js";

// ---- Late / no-show helpers ----
const slotStartMin = (slotKeyStr) => hmToMin(String(slotKeyStr).split("-")[0]);

// A booked seat is "late" (grace blown) when: still 'booked', not checked in,
// and now is past its slot start + grace — on its day (or any past day).
function isLate(b, today, nowMin) {
  if (b.checked_in_at || b.status !== "booked") return false;
  if (b.visit_date < today) return true;            // a past day never attended
  if (b.visit_date > today) return false;           // future booking
  return nowMin > slotStartMin(b.slot) + GRACE_MINUTES;
}

// Single source of truth for how a booking reads: booked | checked_in |
// checked_out | cancelled | no_show.
function effectiveStatus(b, today, nowMin) {
  if (b.status === "cancelled") return "cancelled";
  if (b.status === "no_show") return "no_show";
  if (b.checked_out_at) return "checked_out";
  if (b.checked_in_at) return "checked_in";
  if (isLate(b, today, nowMin)) return "no_show";
  return "booked";
}

function annotate(bookings) {
  const today = londonDate(), nowMin = londonMinutesOfDay();
  return bookings.map(b => ({ ...b, is_late: isLate(b, today, nowMin), state: effectiveStatus(b, today, nowMin) }));
}

// Flip today's past-grace, un-checked-in bookings to 'no_show' (frees capacity).
// Called from the cron and opportunistically.
async function expireNoShows(env) {
  const res = await env.DB.prepare(
    `UPDATE bookings SET status = 'no_show'
     WHERE status = 'booked' AND checked_in_at IS NULL AND visit_date = ?1
       AND (CAST(substr(slot,1,2) AS INTEGER) * 60 + CAST(substr(slot,4,2) AS INTEGER) + ?2) < ?3`
  ).bind(londonDate(), GRACE_MINUTES, londonMinutesOfDay()).run();
  return res.meta.changes || 0;
}

// Shared slot validation for create + reschedule.
async function resolveSlot(env, visit_date, slot) {
  if (!isValidDate(visit_date)) return { ok: false, status: 400, error: "Please choose a valid date.", fields: { visit_date: "Please choose a valid date." } };
  const today = londonDate();
  if (visit_date < today) return { ok: false, status: 400, error: "That date has already passed.", fields: { visit_date: "Please choose today or a later day." } };
  const sched = await getScheduleForDate(env, visit_date);
  if (sched.closed || !sched.slots.length) return { ok: false, status: 400, error: "There are no visits on that day. Please choose another day.", fields: { visit_date: "No visits on this day." } };
  const slotObj = sched.slots.find(s => slotKey(s) === slot);
  if (!slotObj) return { ok: false, status: 400, error: "That time slot isn't available. Please choose one of the listed times.", fields: { slot: "Please choose a time slot." } };
  if (visit_date === today && londonMinutesOfDay() >= hmToMin(slotObj.end)) return { ok: false, status: 400, error: "That time slot has already ended for today.", fields: { slot: "Please choose a later slot or another day." } };
  return { ok: true, capacity: sched.capacity, slotObj };
}

// ---- Per-day schedule (opening times + capacity) ----
// Returns the effective schedule for a date: a staff override if one exists,
// otherwise the default template from config.js.
async function getScheduleForDate(env, date) {
  const row = await env.DB
    .prepare("SELECT slots, capacity, closed FROM schedules WHERE visit_date = ?")
    .bind(date).first();
  if (row) {
    let slots = [];
    try { slots = JSON.parse(row.slots); } catch { slots = []; }
    return { date, slots, capacity: row.capacity, closed: !!row.closed, isOverride: true };
  }
  return { date, slots: DEFAULT_SLOTS, capacity: DEFAULT_CAPACITY, closed: false, isOverride: false };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // --- Public endpoints ---
      if (pathname === "/api/config" && method === "GET") return handleConfig();
      if (pathname === "/api/slots" && method === "GET") return handleSlots(env, url);
      if (pathname === "/api/bookings" && method === "POST") return handleCreateBooking(request, env);

      // --- Public "manage my booking" (look up by reference + phone) ---
      if (pathname === "/api/booking/lookup" && method === "POST") return handleBookingLookup(request, env);
      if (pathname === "/api/booking/cancel" && method === "POST") return handleBookingCancel(request, env);
      if (pathname === "/api/booking/reschedule" && method === "POST") return handleBookingReschedule(request, env);

      // --- Public tour self check-in (door kiosk at /welcome) ---
      if (pathname === "/api/checkin" && method === "POST") return handleCheckin(request, env);

      // --- Public worker/contractor sign-in (health & safety register) ---
      if (pathname === "/api/signin" && method === "POST") return handleSignin(request, env);
      if (pathname === "/api/signin/find" && method === "GET") return handleSigninFind(env, url);
      if (pathname === "/api/signout" && method === "POST") return handleSignout(request, env);

      // --- Staff auth ---
      if (pathname === "/api/staff/login" && method === "POST") return handleLogin(request, env, url);
      if (pathname === "/api/staff/logout" && method === "POST") return handleLogout(url);
      if (pathname === "/api/staff/session" && method === "GET") return handleSessionCheck(request, env);

      // --- Everything else under /api/staff/ requires a valid session ---
      if (pathname.startsWith("/api/staff/")) {
        if (!(await verifySession(env.SESSION_SECRET, getCookie(request, "vc_session")))) {
          return json({ error: "Not authorised. Please log in again." }, 401);
        }
        return handleStaffRoutes(request, env, url, pathname, method);
      }

      // --- Requisitions: public request form (no login — anyone can file one) ---
      if (pathname === "/api/req/config" && method === "GET") return reqConfig();
      if (pathname === "/api/req/create" && method === "POST") return reqCreate(request, env);

      // --- Requisitions admin auth (its own passcode + cookie, separate gate) ---
      if (pathname === "/api/req/login" && method === "POST") return handleReqLogin(request, env, url);
      if (pathname === "/api/req/logout" && method === "POST") return handleReqLogout(url);
      if (pathname === "/api/req/session" && method === "GET") return handleReqSessionCheck(request, env);

      // --- Everything else under /api/req/ is the spend log + review actions.
      //     Admin only: requires a valid "req"-scoped session (vc_req cookie). ---
      if (pathname.startsWith("/api/req/")) {
        if (!(await verifySession(env.SESSION_SECRET, getCookie(request, "vc_req"), "req"))) {
          return json({ error: "Not authorised. Please log in again." }, 401);
        }
        return handleReqAdminRoutes(request, env, url, pathname, method);
      }

      if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

      // --- Static assets (booking form, staff dashboard, css, js) ---
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },

  // Cron (every minute, see wrangler.jsonc): auto-cancel no-shows past their grace.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(expireNoShows(env).then(
      n => { if (n) console.log(`Auto-cancelled ${n} no-show booking(s).`); },
      err => console.error("expireNoShows failed:", err)
    ));
  }
};

// ============================ Public ============================

function handleConfig() {
  return json({ branches: BRANCHES });
}

async function handleSlots(env, url) {
  const date = url.searchParams.get("date");
  if (!isValidDate(date)) return json({ error: "Invalid date" }, 400);

  const today = londonDate();
  if (date < today) return json({ date, open: false, reason: "past", slots: [] });

  const sched = await getScheduleForDate(env, date);
  if (sched.closed || !sched.slots.length) {
    return json({ date, open: false, reason: "closed", slots: [] });
  }

  const rows = (await env.DB.prepare(
    "SELECT slot, COUNT(*) AS c FROM bookings WHERE visit_date = ? AND status = 'booked' GROUP BY slot"
  ).bind(date).all()).results;
  const counts = {};
  for (const r of rows) counts[r.slot] = r.c;

  const nowMin = londonMinutesOfDay();
  // IMPORTANT: capacity and remaining counts are NOT exposed to members —
  // only whether each slot can be booked.
  const slots = sched.slots.map(s => {
    const key = slotKey(s);
    let available = (counts[key] || 0) < sched.capacity;
    let reason = available ? "" : "full";
    if (date === today && nowMin >= hmToMin(s.end)) {
      available = false;
      reason = "ended";
    }
    return { key, label: slotLabel(s), available, reason };
  });

  return json({ date, open: true, slots });
}

async function handleCreateBooking(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const full_name   = clean(body.full_name, 100);
  const branch      = clean(body.branch, 60);
  const purpose     = clean(body.purpose, 500);
  const phone       = clean(body.phone, 30);
  const vehicle_reg = clean(body.vehicle_reg, 15).toUpperCase();
  const visit_date  = clean(body.visit_date, 10);
  const slot        = clean(body.slot, 20);

  const fields = {};
  if (!full_name) fields.full_name = "Please enter your full name.";
  if (!BRANCHES.includes(branch)) fields.branch = "Please select your branch.";
  if (!purpose) fields.purpose = "Please tell us the purpose of your visit.";
  if (!phone || phone.replace(/\D/g, "").length < 7) fields.phone = "Please enter a valid phone number.";
  if (!isValidDate(visit_date)) fields.visit_date = "Please choose a valid date.";
  if (!slot) fields.slot = "Please choose a time slot.";

  if (Object.keys(fields).length) return json({ error: "Please check the form.", fields }, 400);

  const r = await resolveSlot(env, visit_date, slot);
  if (!r.ok) return json({ error: r.error, fields: r.fields }, r.status);

  const created_at = nowISO();

  // Atomic capacity-guarded insert: the row is only created if the slot
  // currently has fewer than this day's capacity active bookings.
  for (let attempt = 0; attempt < 6; attempt++) {
    const reference = makeReference(5);
    try {
      const res = await env.DB.prepare(
        `INSERT INTO bookings
           (reference, created_at, visit_date, slot, full_name, branch, purpose, phone, vehicle_reg, status)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked'
         WHERE (SELECT COUNT(*) FROM bookings WHERE visit_date = ? AND slot = ? AND status = 'booked') < ?`
      ).bind(
        reference, created_at, visit_date, slot, full_name, branch, purpose,
        phone, vehicle_reg || null,
        visit_date, slot, r.capacity
      ).run();

      if (res.meta.changes === 1) {
        return json({
          ok: true,
          reference,
          visit_date,
          slot,
          slot_label: slotLabel(r.slotObj),
          full_name,
          branch
        });
      }
      // No row inserted => the slot is now full.
      return json({
        error: "Sorry, that time slot has just become full. Please choose another slot or day.",
        fields: { slot: "This slot is full." }
      }, 409);
    } catch (e) {
      const msg = (e && e.message) || "";
      if (/UNIQUE/i.test(msg) && /reference/i.test(msg)) continue; // rare code clash, retry
      throw e;
    }
  }
  return json({ error: "Could not create the booking. Please try again." }, 500);
}

// ============================ Public "manage my booking" ============================
// Members look up / change / cancel their own booking with reference + phone.

const digitsOnly = (s) => String(s || "").replace(/\D/g, "");

async function findBookingByRef(env, reference, phone) {
  const ref = clean(reference, 10).toUpperCase();
  const ph = digitsOnly(phone);
  if (!ref || ph.length < 7) return null;
  const b = await env.DB.prepare(`SELECT ${BOOKING_COLS} FROM bookings WHERE UPPER(reference) = ?`).bind(ref).first();
  if (!b) return null;
  if (digitsOnly(b.phone) !== ph) return null;   // phone must match the booking
  return b;
}

// What the member is allowed to see back (no other people's data; no raw phone).
function publicBooking(b) {
  const today = londonDate(), nowMin = londonMinutesOfDay();
  return {
    reference: b.reference,
    visit_date: b.visit_date,
    slot: b.slot,
    slot_label: labelFromKey(b.slot),
    full_name: b.full_name,
    branch: b.branch,
    purpose: b.purpose,
    vehicle_reg: b.vehicle_reg || "",
    state: effectiveStatus(b, today, nowMin)   // booked | checked_in | checked_out | cancelled | no_show
  };
}

async function handleBookingLookup(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const b = await findBookingByRef(env, body.reference, body.phone);
  if (!b) return json({ error: "We couldn't find a booking with that reference and phone number. Please check and try again." }, 404);
  return json({ ok: true, booking: publicBooking(b) });
}

async function handleBookingCancel(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const b = await findBookingByRef(env, body.reference, body.phone);
  if (!b) return json({ error: "We couldn't find that booking." }, 404);
  if (b.checked_in_at) return json({ error: "You're already checked in, so this booking can't be cancelled here." }, 400);
  if (b.status === "cancelled") return json({ ok: true, booking: publicBooking(b) });
  await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(b.id).run();
  const updated = await env.DB.prepare(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = ?`).bind(b.id).first();
  return json({ ok: true, booking: publicBooking(updated) });
}

async function handleBookingReschedule(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const b = await findBookingByRef(env, body.reference, body.phone);
  if (!b) return json({ error: "We couldn't find that booking." }, 404);
  if (b.checked_in_at) return json({ error: "You're already checked in, so this booking can't be changed here." }, 400);

  const visit_date = clean(body.visit_date, 10);
  const slot = clean(body.slot, 20);
  const r = await resolveSlot(env, visit_date, slot);
  if (!r.ok) return json({ error: r.error, fields: r.fields }, r.status);

  // Atomic move with a capacity guard on the TARGET slot. Also re-activates a
  // previously cancelled / no-show booking (fresh start at the new time).
  const res = await env.DB.prepare(
    `UPDATE bookings SET visit_date = ?, slot = ?, status = 'booked', checked_in_at = NULL, checked_out_at = NULL
     WHERE id = ? AND checked_in_at IS NULL
       AND (SELECT COUNT(*) FROM bookings WHERE visit_date = ? AND slot = ? AND status = 'booked') < ?`
  ).bind(visit_date, slot, b.id, visit_date, slot, r.capacity).run();

  if (res.meta.changes !== 1) {
    return json({ error: "Sorry, that time slot is now full. Please choose another slot or day.", fields: { slot: "This slot is full." } }, 409);
  }
  const updated = await env.DB.prepare(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = ?`).bind(b.id).first();
  return json({ ok: true, booking: publicBooking(updated) });
}

// ============================ Public tour self check-in (door kiosk) ============================
// At the /welcome kiosk, visitors enter their booking reference and the last 4
// digits of the phone on the booking, and check themselves in. Mirrors the staff
// gate's late / no-show guard exactly. Public (no login) and scoped to TODAY.

async function handleCheckin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const ref = clean(body.reference, 10).toUpperCase();
  const last4 = digitsOnly(body.phone_last4).slice(-4);
  if (!ref) return json({ error: "Please choose your booking from the list." }, 400);
  if (last4.length < 4) return json({ error: "Please enter the last 4 digits of your phone number.", fields: { phone_last4: "Enter 4 digits." } }, 400);

  const today = londonDate();
  const b = await env.DB.prepare(`SELECT ${BOOKING_COLS} FROM bookings WHERE UPPER(reference) = ?`).bind(ref).first();
  if (!b || b.visit_date !== today) {
    return json({ error: "We couldn't find a booking for today. Please see a member of staff." }, 404);
  }
  if (digitsOnly(b.phone).slice(-4) !== last4) {
    return json({ error: "That doesn't match the phone number on the booking. Please try again, or see a member of staff.", fields: { phone_last4: "Doesn't match." } }, 400);
  }
  if (b.status === "cancelled") {
    return json({ error: "This booking was cancelled. Please see a member of staff." }, 400);
  }
  if (b.checked_in_at) {
    // Already on site — treat as success so the kiosk stays reassuring.
    return json({ ok: true, already: true, booking: publicBooking(b) });
  }
  if (b.status === "no_show" || isLate(b, today, londonMinutesOfDay())) {
    await env.DB.prepare("UPDATE bookings SET status = 'no_show' WHERE id = ? AND checked_in_at IS NULL").bind(b.id).run();
    return json({ error: "Sorry, this booking has passed its 15-minute arrival window. Please see a member of staff.", late: true }, 400);
  }

  const now = nowISO();
  await env.DB.prepare("UPDATE bookings SET checked_in_at = ?, checked_out_at = NULL WHERE id = ?").bind(now, b.id).run();
  const updated = await env.DB.prepare(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = ?`).bind(b.id).first();
  return json({ ok: true, booking: publicBooking(updated) });
}

// ============================ Public worker/contractor sign-in ============================
// The health & safety register. These endpoints are intentionally public (no
// login) — only the form, not the records behind the dashboard.

async function handleSignin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const kind        = clean(body.kind, 20);
  const full_name   = clean(body.full_name, 100);
  const company     = clean(body.company, 100);
  const branch      = clean(body.branch, 60);
  const purpose     = clean(body.purpose, 500);
  const vehicle_reg = clean(body.vehicle_reg, 15).toUpperCase();
  const safety_ack  = body.safety_ack === true || body.safety_ack === 1 || body.safety_ack === "1";
  let signature = typeof body.signature === "string" ? body.signature : "";
  if (signature && !signature.startsWith("data:image/")) signature = "";
  if (signature.length > 250000) return json({ error: "Signature image is too large." }, 400);

  if (kind !== "worker" && kind !== "contractor") {
    return json({ error: "Please choose whether you're a Kharis worker or an external contractor." }, 400);
  }
  const fields = {};
  if (!full_name) fields.full_name = "Please enter your full name.";
  if (!purpose) fields.purpose = "Please say what work you're here to do.";
  if (kind === "worker" && !BRANCHES.includes(branch)) fields.branch = "Please select your branch.";
  if (!signature) fields.signature = "Please sign in the box.";
  if (!safety_ack) fields.safety_ack = "Please confirm you'll follow the site safety rules.";
  if (Object.keys(fields).length) return json({ error: "Please check the form.", fields }, 400);

  const now = nowISO();
  const res = await env.DB.prepare(
    `INSERT INTO visitors (created_at, visit_date, full_name, kind, company, branch, purpose, vehicle_reg, signature, safety_ack, checked_in_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    now, londonDate(), full_name, kind,
    kind === "contractor" ? (company || null) : null,
    kind === "worker" ? branch : null,
    purpose, vehicle_reg || null, signature || null, safety_ack ? 1 : 0, now
  ).run();

  return json({ ok: true, id: res.meta.last_row_id, full_name, checked_in_at: now });
}

async function handleSigninFind(env, url) {
  const name = clean(url.searchParams.get("name"), 100);
  if (name.length < 2) return json({ people: [] });
  const like = "%" + name.replace(/[\\%_]/g, m => "\\" + m) + "%";
  const people = (await env.DB.prepare(
    `SELECT id, full_name, kind, company, branch, checked_in_at
     FROM visitors
     WHERE visit_date = ? AND checked_out_at IS NULL AND full_name LIKE ? ESCAPE '\\'
     ORDER BY checked_in_at DESC LIMIT 15`
  ).bind(londonDate(), like).all()).results;
  return json({ people });
}

async function handleSignout(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const id = parseInt(body.id, 10);
  const name = clean(body.name, 100);
  if (!id || !name) return json({ error: "Invalid request" }, 400);

  const rec = await env.DB.prepare(
    "SELECT id, full_name, visit_date, checked_out_at FROM visitors WHERE id = ?"
  ).bind(id).first();
  if (!rec || rec.visit_date !== londonDate()) return json({ error: "We couldn't find that sign-in for today." }, 404);
  if (rec.full_name.toLowerCase() !== name.toLowerCase()) return json({ error: "That name doesn't match this sign-in." }, 400);
  if (rec.checked_out_at) return json({ ok: true, alreadyOut: true });

  await env.DB.prepare("UPDATE visitors SET checked_out_at = ? WHERE id = ?").bind(nowISO(), id).run();
  return json({ ok: true });
}

// ============================ Staff auth ============================

async function handleLogin(request, env, url) {
  if (!env.STAFF_PASSCODE || !env.SESSION_SECRET) {
    return json({ error: "The system is not fully set up (missing passcode configuration)." }, 500);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const passcode = clean(body.passcode, 100);
  if (!passcode || !timingSafeEqual(passcode, env.STAFF_PASSCODE)) {
    return json({ error: "Incorrect passcode." }, 401);
  }

  const token = await createSession(env.SESSION_SECRET);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, url, 12 * 60 * 60) });
}

function handleLogout(url) {
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", url, 0) });
}

async function handleSessionCheck(request, env) {
  const ok = await verifySession(env.SESSION_SECRET, getCookie(request, "vc_session"));
  return json({ authenticated: !!ok });
}

function sessionCookie(token, url, maxAgeSeconds, name = "vc_session") {
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `${name}=${token}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

// ============================ Staff (authenticated) ============================

function handleStaffRoutes(request, env, url, pathname, method) {
  if (pathname === "/api/staff/day" && method === "GET") return staffDay(env, url);
  if (pathname === "/api/staff/search" && method === "GET") return staffSearch(env, url);
  if (pathname === "/api/staff/onsite" && method === "GET") return staffOnsite(env);
  if (pathname === "/api/staff/history" && method === "GET") return staffHistory(env, url);
  if (pathname === "/api/staff/export.csv" && method === "GET") return staffExport(env, url);
  if (pathname === "/api/staff/visitors" && method === "POST") return staffCreateVisitor(request, env);
  if (pathname === "/api/staff/schedule" && method === "GET") return staffGetSchedule(env, url);
  if (pathname === "/api/staff/schedule" && method === "POST") return staffSetSchedule(request, env);
  if (pathname === "/api/staff/schedule" && method === "DELETE") return staffDeleteSchedule(env, url);

  let m;
  if ((m = pathname.match(/^\/api\/staff\/bookings\/(\d+)\/(checkin|checkout|cancel)$/)) && method === "POST") {
    return staffBookingAction(env, parseInt(m[1], 10), m[2]);
  }
  if ((m = pathname.match(/^\/api\/staff\/visitors\/(\d+)\/checkout$/)) && method === "POST") {
    return staffVisitorCheckout(env, parseInt(m[1], 10));
  }
  if ((m = pathname.match(/^\/api\/staff\/visitors\/(\d+)$/)) && method === "GET") {
    return staffGetVisitor(env, parseInt(m[1], 10));
  }

  return json({ error: "Not found" }, 404);
}

const BOOKING_COLS =
  "id, reference, visit_date, slot, full_name, branch, purpose, phone, vehicle_reg, status, checked_in_at, checked_out_at";

async function staffDay(env, url) {
  const date = url.searchParams.get("date") || londonDate();
  if (!isValidDate(date)) return json({ error: "Invalid date" }, 400);

  const bookings = annotate((await env.DB.prepare(
    `SELECT ${BOOKING_COLS} FROM bookings WHERE visit_date = ? ORDER BY slot, full_name COLLATE NOCASE`
  ).bind(date).all()).results);

  const visitors = (await env.DB.prepare(
    `SELECT id, visit_date, full_name, kind, company, branch, purpose, vehicle_reg, checked_in_at, checked_out_at,
            CASE WHEN signature IS NOT NULL AND signature <> '' THEN 1 ELSE 0 END AS has_signature
     FROM visitors WHERE visit_date = ? ORDER BY checked_in_at`
  ).bind(date).all()).results;

  return json({ date, bookings, visitors });
}

async function staffSearch(env, url) {
  const q = clean(url.searchParams.get("q"), 60);
  if (!q) return json({ bookings: [] });

  const like = "%" + q.replace(/[\\%_]/g, m => "\\" + m) + "%";
  const bookings = annotate((await env.DB.prepare(
    `SELECT ${BOOKING_COLS} FROM bookings
     WHERE full_name LIKE ? ESCAPE '\\'
        OR branch    LIKE ? ESCAPE '\\'
        OR UPPER(reference) = UPPER(?)
     ORDER BY visit_date DESC, slot LIMIT 50`
  ).bind(like, like, q).all()).results);

  return json({ bookings });
}

async function staffOnsite(env) {
  const bookings = (await env.DB.prepare(
    `SELECT id, reference, visit_date, slot, full_name, branch, phone, vehicle_reg, checked_in_at
     FROM bookings WHERE checked_in_at IS NOT NULL AND checked_out_at IS NULL
     ORDER BY checked_in_at`
  ).all()).results;

  const visitors = (await env.DB.prepare(
    `SELECT id, visit_date, full_name, kind, company, branch, purpose, vehicle_reg, checked_in_at
     FROM visitors WHERE checked_in_at IS NOT NULL AND checked_out_at IS NULL
     ORDER BY checked_in_at`
  ).all()).results;

  return json({ bookings, visitors, count: bookings.length + visitors.length });
}

async function staffBookingAction(env, id, action) {
  const existing = await env.DB.prepare(
    "SELECT id, status, slot, visit_date, checked_in_at FROM bookings WHERE id = ?"
  ).bind(id).first();
  if (!existing) return json({ error: "Booking not found." }, 404);

  const now = nowISO();
  if (action === "checkin") {
    if (existing.status === "cancelled") return json({ error: "This booking was cancelled." }, 400);
    if (existing.status === "no_show") return json({ error: "This booking was auto-cancelled because they arrived more than 15 minutes late. They need to rebook." }, 400);
    if (!existing.checked_in_at && isLate(existing, londonDate(), londonMinutesOfDay())) {
      await env.DB.prepare("UPDATE bookings SET status = 'no_show' WHERE id = ? AND checked_in_at IS NULL").bind(id).run();
      return json({ error: "Too late. This booking passed its 15-minute grace and is now cancelled. They need to rebook." }, 400);
    }
    await env.DB.prepare("UPDATE bookings SET checked_in_at = ?, checked_out_at = NULL WHERE id = ?").bind(now, id).run();
  } else if (action === "checkout") {
    await env.DB.prepare("UPDATE bookings SET checked_out_at = ? WHERE id = ?").bind(now, id).run();
  } else if (action === "cancel") {
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(id).run();
  }

  const booking = await env.DB.prepare(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = ?`).bind(id).first();
  return json({ ok: true, booking });
}

async function staffCreateVisitor(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const kind        = (clean(body.kind, 20) === "worker") ? "worker" : "contractor";
  const full_name   = clean(body.full_name, 100);
  const company     = clean(body.company, 100);
  const branch      = clean(body.branch, 60);
  const purpose     = clean(body.purpose, 500);
  const vehicle_reg = clean(body.vehicle_reg, 15).toUpperCase();
  let signature = typeof body.signature === "string" ? body.signature : "";
  if (signature && !signature.startsWith("data:image/")) signature = "";
  if (signature.length > 250000) return json({ error: "Signature image is too large." }, 400);

  const fields = {};
  if (!full_name) fields.full_name = "Please enter the name.";
  if (!purpose) fields.purpose = "Please enter the purpose of the visit.";
  if (kind === "worker" && !BRANCHES.includes(branch)) fields.branch = "Please select the branch.";
  if (Object.keys(fields).length) return json({ error: "Please check the form.", fields }, 400);

  const now = nowISO();
  const res = await env.DB.prepare(
    `INSERT INTO visitors (created_at, visit_date, full_name, kind, company, branch, purpose, vehicle_reg, signature, safety_ack, checked_in_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    now, londonDate(), full_name, kind,
    kind === "contractor" ? (company || null) : null,
    kind === "worker" ? branch : null,
    purpose, vehicle_reg || null, signature || null, 1, now
  ).run();

  return json({ ok: true, id: res.meta.last_row_id });
}

async function staffVisitorCheckout(env, id) {
  const v = await env.DB.prepare("SELECT id FROM visitors WHERE id = ?").bind(id).first();
  if (!v) return json({ error: "Visitor not found." }, 404);
  await env.DB.prepare("UPDATE visitors SET checked_out_at = ? WHERE id = ?").bind(nowISO(), id).run();
  return json({ ok: true });
}

async function staffGetVisitor(env, id) {
  const v = await env.DB.prepare("SELECT * FROM visitors WHERE id = ?").bind(id).first();
  if (!v) return json({ error: "Not found." }, 404);
  return json({ visitor: v });
}

// ---- Schedule management ----

const enrich = (s) => ({ start: s.start, end: s.end, key: slotKey(s), label: slotLabel(s) });

async function staffGetSchedule(env, url) {
  const date = url.searchParams.get("date") || londonDate();
  if (!isValidDate(date)) return json({ error: "Invalid date" }, 400);
  const sched = await getScheduleForDate(env, date);

  const rows = (await env.DB.prepare(
    "SELECT slot, COUNT(*) AS c FROM bookings WHERE visit_date = ? AND status = 'booked' GROUP BY slot"
  ).bind(date).all()).results;
  const booked = {};
  for (const r of rows) booked[r.slot] = r.c;

  return json({
    date,
    slots: sched.slots.map(enrich),
    capacity: sched.capacity,
    closed: sched.closed,
    isOverride: sched.isOverride,
    booked,
    default: { slots: DEFAULT_SLOTS.map(enrich), capacity: DEFAULT_CAPACITY }
  });
}

async function staffSetSchedule(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const date = clean(body.date, 10);
  if (!isValidDate(date)) return json({ error: "Please choose a valid date." }, 400);

  const closed = !!body.closed;
  const capacity = Math.floor(Number(body.capacity));
  if (!Number.isFinite(capacity) || capacity < 1 || capacity > 100000) {
    return json({ error: "Capacity must be a whole number of at least 1." }, 400);
  }

  const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const input = Array.isArray(body.slots) ? body.slots : [];
  const cleaned = [];
  for (const s of input) {
    const start = clean(s && s.start, 5);
    const end = clean(s && s.end, 5);
    if (!timeRe.test(start) || !timeRe.test(end)) {
      return json({ error: `Each slot needs a valid start and end time (check "${start}"–"${end}").` }, 400);
    }
    if (hmToMin(end) <= hmToMin(start)) {
      return json({ error: `A slot's end must be after its start (${start}–${end}).` }, 400);
    }
    cleaned.push({ start, end });
  }
  if (!closed && cleaned.length === 0) {
    return json({ error: "Add at least one time slot, or mark the day closed." }, 400);
  }
  if (cleaned.length > 48) return json({ error: "That's too many slots (maximum 48)." }, 400);

  cleaned.sort((a, b) => hmToMin(a.start) - hmToMin(b.start) || hmToMin(a.end) - hmToMin(b.end));
  const seen = new Set();
  const final = [];
  for (const s of cleaned) {
    const k = slotKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    final.push(s);
  }

  await env.DB.prepare(
    `INSERT INTO schedules (visit_date, slots, capacity, closed, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(visit_date) DO UPDATE SET
       slots = excluded.slots, capacity = excluded.capacity,
       closed = excluded.closed, updated_at = excluded.updated_at`
  ).bind(date, JSON.stringify(final), capacity, closed ? 1 : 0, nowISO()).run();

  return json({ ok: true, date, slots: final.map(enrich), capacity, closed });
}

async function staffDeleteSchedule(env, url) {
  const date = url.searchParams.get("date");
  if (!isValidDate(date)) return json({ error: "Invalid date" }, 400);
  await env.DB.prepare("DELETE FROM schedules WHERE visit_date = ?").bind(date).run();
  return json({ ok: true });
}

async function staffHistory(env, url) {
  const from = url.searchParams.get("from") || londonDate();
  const to   = url.searchParams.get("to") || from;
  if (!isValidDate(from) || !isValidDate(to)) return json({ error: "Invalid date range" }, 400);
  const [lo, hi] = from <= to ? [from, to] : [to, from];

  const bookings = annotate((await env.DB.prepare(
    `SELECT ${BOOKING_COLS} FROM bookings WHERE visit_date BETWEEN ? AND ?
     ORDER BY visit_date DESC, slot, full_name COLLATE NOCASE`
  ).bind(lo, hi).all()).results);

  const visitors = (await env.DB.prepare(
    `SELECT id, visit_date, full_name, kind, company, branch, purpose, vehicle_reg, checked_in_at, checked_out_at
     FROM visitors WHERE visit_date BETWEEN ? AND ?
     ORDER BY visit_date DESC, checked_in_at`
  ).bind(lo, hi).all()).results;

  return json({ from: lo, to: hi, bookings, visitors });
}

async function staffExport(env, url) {
  const from = url.searchParams.get("from") || londonDate();
  const to   = url.searchParams.get("to") || from;
  if (!isValidDate(from) || !isValidDate(to)) return json({ error: "Invalid date range" }, 400);
  const [lo, hi] = from <= to ? [from, to] : [to, from];

  const bookings = (await env.DB.prepare(
    `SELECT reference, visit_date, slot, full_name, branch, purpose, phone, vehicle_reg, status, checked_in_at, checked_out_at
     FROM bookings WHERE visit_date BETWEEN ? AND ? ORDER BY visit_date, slot, full_name COLLATE NOCASE`
  ).bind(lo, hi).all()).results;

  const visitors = (await env.DB.prepare(
    `SELECT visit_date, full_name, kind, company, branch, purpose, vehicle_reg, checked_in_at, checked_out_at
     FROM visitors WHERE visit_date BETWEEN ? AND ? ORDER BY visit_date, checked_in_at`
  ).bind(lo, hi).all()).results;

  const rows = [[
    "Type", "Date", "Time Slot", "Reference", "Full Name", "Branch / Company",
    "Purpose", "Phone", "Vehicle Reg", "Status", "Time In", "Time Out"
  ]];

  const today = londonDate(), nowMin = londonMinutesOfDay();
  const STATE_LABEL = { booked: "Booked", checked_in: "Checked in", checked_out: "Checked in", cancelled: "Cancelled", no_show: "No-show (late)" };
  for (const b of bookings) {
    const status = STATE_LABEL[effectiveStatus(b, today, nowMin)] || "Booked";
    rows.push([
      "Member", b.visit_date, labelFromKey(b.slot), b.reference, b.full_name, b.branch,
      b.purpose, b.phone, b.vehicle_reg || "", status,
      formatLondon(b.checked_in_at), formatLondon(b.checked_out_at)
    ]);
  }
  for (const v of visitors) {
    const type = v.kind === "worker" ? "Worker" : "Contractor";
    const org = v.kind === "worker" ? (v.branch || "") : (v.company || "");
    rows.push([
      type, v.visit_date, "", "", v.full_name, org,
      v.purpose, "", v.vehicle_reg || "", v.checked_in_at ? "Checked in" : "",
      formatLondon(v.checked_in_at), formatLondon(v.checked_out_at)
    ]);
  }

  const csv = "﻿" + toCSV(rows); // BOM so Excel reads UTF-8 correctly
  const filename = lo === hi ? `venue-checkin-${lo}.csv` : `venue-checkin-${lo}_to_${hi}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

// ============================ Requisitions auth ============================
// The /requisitions request form is PUBLIC (see the router: /api/req/config and
// /api/req/create need no login) so anyone can file a request. The spend log and
// the approve/decline review are admin only, behind this passcode. It is its own
// gate from the staff portal: its own cookie (vc_req) and a "req"-scoped session
// (signed with SESSION_SECRET), so a staff login can't be reused here.
// The admin passcode is REQUISITIONS_APPROVER_PASSCODE (falls back to the older
// REQUISITIONS_PASSCODE if only that is set).

function reqAdminPasscode(env) {
  return env.REQUISITIONS_APPROVER_PASSCODE || env.REQUISITIONS_PASSCODE || "";
}

async function handleReqLogin(request, env, url) {
  const adminPass = reqAdminPasscode(env);
  if (!adminPass || !env.SESSION_SECRET) {
    return json({ error: "The requisitions admin area is not fully set up (missing passcode configuration)." }, 500);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const passcode = clean(body.passcode, 100);
  if (!passcode || !timingSafeEqual(passcode, adminPass)) {
    return json({ error: "Incorrect passcode." }, 401);
  }

  const token = await createSession(env.SESSION_SECRET, { scope: "req" });
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, url, 12 * 60 * 60, "vc_req") });
}

function handleReqLogout(url) {
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", url, 0, "vc_req") });
}

async function handleReqSessionCheck(request, env) {
  const ok = await verifySession(env.SESSION_SECRET, getCookie(request, "vc_req"), "req");
  return json({ authenticated: !!ok });
}

// ============================ Requisitions (authenticated) ============================

// The spend log + review actions. Reached only after the admin guard in the
// router has verified a "req"-scoped session, so everything here is admin only.
function handleReqAdminRoutes(request, env, url, pathname, method) {
  if (pathname === "/api/req/list" && method === "GET") return reqList(env, url);
  if (pathname === "/api/req/export.csv" && method === "GET") return reqExport(env);

  let m;
  if ((m = pathname.match(/^\/api\/req\/(\d+)\/decision$/)) && method === "POST") {
    return reqDecision(request, env, parseInt(m[1], 10));
  }
  if ((m = pathname.match(/^\/api\/req\/(\d+)$/)) && method === "DELETE") {
    return reqDelete(env, parseInt(m[1], 10));
  }

  return json({ error: "Not found" }, 404);
}

const REQ_COLS =
  "id, reference, created_at, requestor, item, item_url, category, cost_pence, kind, frequency, approver, notes, status, decided_at, decided_by";

const REQ_STATUSES = ["pending", "approved", "declined"];
const REQ_MAX_PENCE = 100000000; // £1,000,000 sanity cap per requisition

// Frequency lookup: value -> { value, label, perYear }. Used to validate a
// recurring frequency and to annualise recurring amounts for the totals / CSV.
const FREQ_BY_VALUE = new Map(REQUISITION_FREQUENCIES.map(f => [f.value, f]));

function reqConfig() {
  return json({
    categories: REQUISITION_CATEGORIES,
    frequencies: REQUISITION_FREQUENCIES.map(f => ({ value: f.value, label: f.label }))
  });
}

async function reqCreate(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const requestor  = clean(body.requestor, 100);
  const item       = clean(body.item, 200);
  const category   = clean(body.category, 60);
  const approver   = clean(body.approver, 100);
  const notes      = clean(body.notes, 1000);
  const cost_pence = poundsToPence(body.cost);
  const kind       = clean(body.kind, 20) === "recurring" ? "recurring" : "one_off";
  let frequency    = null;

  // Optional link to the item. Normalise a bare host to https:// and sanity-check
  // it parses as an http(s) URL with a dotted host; blank is fine.
  let item_url = clean(body.item_url, 500);

  const fields = {};
  if (!requestor) fields.requestor = "Please enter who is requesting this.";
  if (!item) fields.item = "Please enter the item.";
  if (item_url) {
    if (!/^https?:\/\//i.test(item_url)) item_url = "https://" + item_url;
    try {
      const u = new URL(item_url);
      if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname.includes(".")) throw 0;
    } catch { fields.item_url = "Please enter a valid web link, or leave it blank."; }
  }
  if (!REQUISITION_CATEGORIES.includes(category)) fields.category = "Please choose what it's for.";
  if (cost_pence === null || cost_pence <= 0) fields.cost = "Please enter a valid cost in pounds.";
  else if (cost_pence > REQ_MAX_PENCE) fields.cost = "That cost looks too large.";
  if (kind === "recurring") {
    frequency = clean(body.frequency, 20);
    if (!FREQ_BY_VALUE.has(frequency)) fields.frequency = "Please choose how often this recurs.";
  }
  if (!approver) fields.approver = "Please enter who approves this.";
  if (Object.keys(fields).length) return json({ error: "Please check the form.", fields }, 400);

  const created_at = nowISO();
  for (let attempt = 0; attempt < 6; attempt++) {
    const reference = "R" + makeReference(5);
    try {
      const res = await env.DB.prepare(
        `INSERT INTO requisitions (reference, created_at, requestor, item, item_url, category, cost_pence, kind, frequency, approver, notes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      ).bind(reference, created_at, requestor, item, item_url || null, category, cost_pence, kind, frequency, approver, notes || null).run();

      if (res.meta.changes === 1) {
        const row = await env.DB.prepare(`SELECT ${REQ_COLS} FROM requisitions WHERE id = ?`).bind(res.meta.last_row_id).first();
        return json({ ok: true, requisition: row });
      }
    } catch (e) {
      const msg = (e && e.message) || "";
      if (/UNIQUE/i.test(msg) && /reference/i.test(msg)) continue; // rare code clash, retry
      throw e;
    }
  }
  return json({ error: "Could not save the requisition. Please try again." }, 500);
}

async function reqList(env, url) {
  const status = clean(url.searchParams.get("status"), 20);
  const category = clean(url.searchParams.get("category"), 60);

  const where = [], binds = [];
  if (REQ_STATUSES.includes(status)) { where.push("status = ?"); binds.push(status); }
  if (category) { where.push("category = ?"); binds.push(category); }
  const whereSql = where.length ? ("WHERE " + where.join(" AND ")) : "";

  const requisitions = (await env.DB.prepare(
    `SELECT ${REQ_COLS} FROM requisitions ${whereSql}
     ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC`
  ).bind(...binds).all()).results;

  // Totals are computed across ALL requisitions (never the filter), so the
  // headline "how much have we spent" figures stay stable as you filter.
  const totalsRows = (await env.DB.prepare(
    `SELECT status, category, kind, frequency, COUNT(*) AS n, COALESCE(SUM(cost_pence), 0) AS pence
     FROM requisitions GROUP BY status, category, kind, frequency`
  ).all()).results;

  return json({ requisitions, totals: buildReqTotals(totalsRows) });
}

// Annualise an amount: a recurring amount is cost-per-occurrence x occurrences
// per year; a one-off is just itself.
function annualisePence(pence, kind, frequency) {
  if (kind !== "recurring") return pence;
  const f = FREQ_BY_VALUE.get(frequency);
  return f ? pence * f.perYear : 0;
}

// Approved one-off requisitions are the money spent (and the per-category
// breakdown). Approved RECURRING requisitions are an ongoing commitment, shown
// separately annualised to a £/year figure. Pending is awaiting a decision
// (recurring annualised so the queue total is comparable); declined is excluded.
function buildReqTotals(rows) {
  const t = {
    approvedPence: 0, approvedCount: 0,         // one-off approved (money spent)
    recurringAnnualPence: 0, recurringCount: 0, // recurring approved, annualised to £/yr
    pendingPence: 0, pendingCount: 0,           // all pending, recurring annualised
    declinedCount: 0,
    byCategory: []                              // one-off approved, by category
  };
  const cat = {};
  for (const r of rows) {
    if (r.status === "approved") {
      if (r.kind === "recurring") {
        t.recurringAnnualPence += annualisePence(r.pence, r.kind, r.frequency);
        t.recurringCount += r.n;
      } else {
        t.approvedPence += r.pence; t.approvedCount += r.n;
        cat[r.category] = (cat[r.category] || 0) + r.pence;
      }
    } else if (r.status === "pending") {
      t.pendingPence += annualisePence(r.pence, r.kind, r.frequency);
      t.pendingCount += r.n;
    } else if (r.status === "declined") {
      t.declinedCount += r.n;
    }
  }
  t.byCategory = Object.entries(cat)
    .map(([category, pence]) => ({ category, pence }))
    .sort((a, b) => b.pence - a.pence);
  return t;
}

async function reqDecision(request, env, id) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const decision = clean(body.decision, 20);
  if (!REQ_STATUSES.includes(decision)) return json({ error: "Invalid decision." }, 400);
  const by = clean(body.by, 100);

  const existing = await env.DB.prepare("SELECT id FROM requisitions WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Requisition not found." }, 404);

  const decided_at = decision === "pending" ? null : nowISO();
  await env.DB.prepare("UPDATE requisitions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?")
    .bind(decision, decided_at, by || null, id).run();

  const row = await env.DB.prepare(`SELECT ${REQ_COLS} FROM requisitions WHERE id = ?`).bind(id).first();
  return json({ ok: true, requisition: row });
}

async function reqDelete(env, id) {
  const existing = await env.DB.prepare("SELECT id FROM requisitions WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Requisition not found." }, 404);
  await env.DB.prepare("DELETE FROM requisitions WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function reqExport(env) {
  const rows = (await env.DB.prepare(
    `SELECT reference, created_at, requestor, item, item_url, category, cost_pence, kind, frequency, approver, status, decided_at, decided_by, notes
     FROM requisitions ORDER BY created_at`
  ).all()).results;

  const out = [[
    "Reference", "Submitted", "Requestor", "Item", "Link", "Category", "Type", "Frequency",
    "Amount (GBP)", "Annualised (GBP)", "Approver", "Status", "Decided", "Reviewed by", "Notes"
  ]];
  const STATUS_LABEL = { pending: "Pending", approved: "Approved", declined: "Declined" };
  for (const r of rows) {
    const recurring = r.kind === "recurring";
    const freq = recurring ? (FREQ_BY_VALUE.get(r.frequency)?.label || r.frequency || "") : "";
    out.push([
      r.reference, formatLondon(r.created_at), r.requestor, r.item, r.item_url || "", r.category,
      recurring ? "Recurring" : "One-off", freq,
      formatPence(r.cost_pence),
      recurring ? formatPence(annualisePence(r.cost_pence, r.kind, r.frequency)) : "",
      r.approver, STATUS_LABEL[r.status] || r.status,
      formatLondon(r.decided_at), r.decided_by || "", r.notes || ""
    ]);
  }

  const csv = "﻿" + toCSV(out); // BOM so Excel reads UTF-8 correctly
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="requisitions-${londonDate()}.csv"`,
      "Cache-Control": "no-store"
    }
  });
}
