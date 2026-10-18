"use strict";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer = null;
function toast(msg, isErr) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 2600);
}
function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
function niceDate(d) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

const lookupForm = document.getElementById("lookup-form");
const bookingView = document.getElementById("booking-view");
let creds = { reference: "", phone: "" };
let current = null;
let rSlot = "";
let rDateReady = false;

// Prefill reference from ?ref= (set by the booking confirmation link).
const qsRef = new URLSearchParams(location.search).get("ref");
if (qsRef) document.getElementById("reference").value = qsRef;

// ---------------- lookup ----------------
lookupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrs(lookupForm);
  document.getElementById("lookup-alert").innerHTML = "";
  const reference = document.getElementById("reference").value.trim();
  const phone = document.getElementById("phone").value.trim();
  let ok = true;
  if (!reference) { markInvalid("field-reference"); ok = false; }
  if (!phone) { markInvalid("field-phone"); ok = false; }
  if (!ok) return;

  const btn = document.getElementById("lookup-btn");
  btn.disabled = true; btn.textContent = "Finding…";
  try {
    const res = await fetch("/api/booking/lookup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference, phone })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      creds = { reference, phone };
      current = data.booking;
      lookupForm.classList.add("hide");
      bookingView.classList.remove("hide");
      renderBooking();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      document.getElementById("lookup-alert").innerHTML = `<div class="alert alert--error">${esc(data.error || "Couldn't find that booking.")}</div>`;
    }
  } catch {
    document.getElementById("lookup-alert").innerHTML = `<div class="alert alert--error">Could not reach the server. Please try again.</div>`;
  } finally {
    btn.disabled = false; btn.textContent = "Find my booking";
  }
});

// ---------------- render ----------------
const STATE = {
  booked:      { badge: "badge--booked", label: "Booked",     bad: false, msg: "Your booking is confirmed. Please arrive 15 minutes before your session." },
  checked_in:  { badge: "badge--in",     label: "Checked in",  bad: false, msg: "You're checked in. Enjoy your visit." },
  checked_out: { badge: "badge--out",    label: "Visited",     bad: false, msg: "You've completed your visit. Thank you for coming." },
  cancelled:   { badge: "badge--cancel", label: "Cancelled",   bad: true,  msg: "This booking has been cancelled." },
  no_show:     { badge: "badge--missed", label: "Missed",      bad: true,  msg: "This booking was cancelled because you didn't arrive within 15 minutes of your slot. You can rebook a new time below." }
};

function renderBooking() {
  const b = current;
  document.getElementById("b-ref").textContent = b.reference;
  document.getElementById("b-when").textContent = `${niceDate(b.visit_date)} · ${b.slot_label}`;
  document.getElementById("b-who").textContent = `${b.full_name} · ${b.branch}`;

  const st = STATE[b.state] || STATE.booked;
  document.getElementById("booking-status").innerHTML =
    `<div class="alert ${st.bad ? "alert--error" : "alert--info"}"><span class="badge ${st.badge}">${st.label}</span> &nbsp; ${esc(st.msg)}</div>`;

  const actions = document.getElementById("booking-actions");
  document.getElementById("action-alert").innerHTML = "";
  document.getElementById("reschedule-panel").classList.add("hide");

  if (b.state === "booked") {
    actions.innerHTML = `<button class="btn" id="btn-change">Change date/time</button>
      <button class="btn btn--danger" id="btn-cancel">Cancel booking</button>`;
    document.getElementById("btn-change").addEventListener("click", openReschedule);
    document.getElementById("btn-cancel").addEventListener("click", doCancel);
  } else if (b.state === "cancelled" || b.state === "no_show") {
    actions.innerHTML = `<button class="btn" id="btn-rebook">Rebook a new time</button>`;
    document.getElementById("btn-rebook").addEventListener("click", openReschedule);
  } else {
    actions.innerHTML = "";
  }
}

// ---------------- cancel ----------------
async function doCancel() {
  if (!confirm("Cancel this booking? This frees your space for someone else.")) return;
  const btn = document.getElementById("btn-cancel");
  btn.disabled = true; btn.textContent = "Cancelling…";
  try {
    const res = await fetch("/api/booking/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creds)
    });
    const data = await res.json();
    if (res.ok && data.ok) { current = data.booking; toast("Booking cancelled"); renderBooking(); }
    else {
      document.getElementById("action-alert").innerHTML = `<div class="alert alert--error">${esc(data.error || "Could not cancel.")}</div>`;
      btn.disabled = false; btn.textContent = "Cancel booking";
    }
  } catch {
    document.getElementById("action-alert").innerHTML = `<div class="alert alert--error">Could not reach the server.</div>`;
    btn.disabled = false; btn.textContent = "Cancel booking";
  }
}

// ---------------- reschedule ----------------
function openReschedule() {
  const panel = document.getElementById("reschedule-panel");
  panel.classList.remove("hide");
  const d = document.getElementById("r_date");
  d.min = todayStr();
  if (!d.value) d.value = todayStr();
  if (!rDateReady) {
    KUI.enhanceDate(d);
    d.addEventListener("change", loadRSlots);
    rDateReady = true;
  } else if (d._kw) {
    d._kw.render();
  }
  loadRSlots();
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
document.getElementById("r_back").addEventListener("click", () => document.getElementById("reschedule-panel").classList.add("hide"));

async function loadRSlots() {
  rSlot = "";
  const el = document.getElementById("r_slots");
  const date = document.getElementById("r_date").value;
  if (!date) { el.innerHTML = '<div class="spin">Pick a date.</div>'; return; }
  el.innerHTML = '<div class="spin">Checking available times…</div>';
  try {
    const res = await fetch("/api/slots?date=" + encodeURIComponent(date));
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<div class="spin">${esc(data.error || "Could not load times.")}</div>`; return; }
    if (!data.open || !data.slots || !data.slots.length) {
      el.innerHTML = `<div class="empty">${data.reason === "past" ? "That day has already passed." : "There are no visits on this day."} Please pick another date.</div>`;
      return;
    }
    el.innerHTML = "";
    for (const s of data.slots) {
      const lab = document.createElement("label");
      lab.className = "slot";
      let note;
      if (s.available) { note = "Available"; }
      else if (s.reason === "ended") { lab.classList.add("closed"); note = "Already ended"; }
      else { lab.classList.add("full"); note = "Fully booked"; }
      lab.innerHTML = `<div class="slot-time">${esc(s.label)}</div><div class="slot-left">${note}</div>`;
      if (s.available) {
        lab.addEventListener("click", () => {
          document.querySelectorAll("#r_slots .slot").forEach(x => x.classList.remove("selected"));
          lab.classList.add("selected");
          rSlot = s.key;
        });
      }
      el.appendChild(lab);
    }
  } catch {
    el.innerHTML = '<div class="spin">Could not check availability. Please try again.</div>';
  }
}

document.getElementById("r_confirm").addEventListener("click", async () => {
  const date = document.getElementById("r_date").value;
  document.getElementById("r_alert").innerHTML = "";
  if (!date) { rAlert("Please choose a date."); return; }
  if (!rSlot) { rAlert("Please choose a time slot."); return; }
  const btn = document.getElementById("r_confirm");
  btn.disabled = true; btn.textContent = "Changing…";
  try {
    const res = await fetch("/api/booking/reschedule", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...creds, visit_date: date, slot: rSlot })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      current = data.booking;
      toast("Booking updated");
      document.getElementById("reschedule-panel").classList.add("hide");
      renderBooking();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      rAlert(data.error || "Could not change your booking.");
      btn.disabled = false; btn.textContent = "Confirm change";
    }
  } catch {
    rAlert("Could not reach the server.");
    btn.disabled = false; btn.textContent = "Confirm change";
  }
});
function rAlert(msg) { document.getElementById("r_alert").innerHTML = `<div class="alert alert--error">${esc(msg)}</div>`; }

// ---------------- lookup again ----------------
document.getElementById("lookup-again").addEventListener("click", (e) => {
  e.preventDefault();
  bookingView.classList.add("hide");
  lookupForm.classList.remove("hide");
  current = null; creds = { reference: "", phone: "" };
  document.getElementById("phone").value = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ---------------- helpers ----------------
function markInvalid(id) { document.getElementById(id).classList.add("invalid"); }
function clearErrs(form) { form.querySelectorAll(".field.invalid").forEach(f => f.classList.remove("invalid")); }
