"use strict";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");

let currentQuery = "";
let onsiteTimer = null;

// ---------------- helpers ----------------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function londonTodayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB",
    { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtDate(d) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB",
    { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function fmt12h(hm) {
  const [h, m] = String(hm).split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}:${String(m || 0).padStart(2, "0")} ${ampm}`;
}
// "14:00-15:00" -> "2:00 PM – 3:00 PM"
function slotLabel(key) {
  const [a, b] = String(key).split("-");
  if (!a || !b) return key;
  return `${fmt12h(a)} – ${fmt12h(b)}`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (res.status === 401) { showLogin(); throw new Error("unauthorised"); }
  return res;
}
async function apiJSON(path, method, body) {
  const res = await api(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return { res, data: await res.json().catch(() => ({})) };
}

let toastTimer = null;
function toast(msg, isError) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, 2600);
}

// ---------------- auth ----------------
async function boot() {
  try {
    const { authenticated } = await (await fetch("/api/staff/session", { credentials: "same-origin" })).json();
    if (authenticated) showApp(); else showLogin();
  } catch { showLogin(); }
}

function showLogin() {
  appView.classList.add("hide");
  loginView.classList.remove("hide");
  if (onsiteTimer) { clearInterval(onsiteTimer); onsiteTimer = null; }
}

async function showApp() {
  loginView.classList.add("hide");
  appView.classList.remove("hide");

  document.getElementById("today-label").textContent = "Today: " + fmtDate(londonTodayStr());

  const today = londonTodayStr();
  document.getElementById("gate-date").value = today;
  document.getElementById("hist-from").value = today;
  document.getElementById("hist-to").value = today;
  document.getElementById("sched-date").value = today;
  ["gate-date", "hist-from", "hist-to", "sched-date"].forEach((id) => KUI.enhanceDate(document.getElementById(id)));

  // Add-worker form: branch dropdown (once) + default type
  const vbranch = document.getElementById("v_branch");
  if (vbranch && !vbranch._populated) {
    try {
      const cfg = await (await fetch("/api/config", { credentials: "same-origin" })).json();
      for (const b of cfg.branches) { const o = document.createElement("option"); o.value = b; o.textContent = b; vbranch.appendChild(o); }
    } catch {}
    vbranch._populated = true;
    KUI.enhanceSelect(vbranch);
  }
  setVKind("worker");

  loadGateDay();
  loadOnsite();
  if (!onsiteTimer) onsiteTimer = setInterval(loadOnsite, 60000);
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("login-btn");
  const alertEl = document.getElementById("login-alert");
  alertEl.innerHTML = "";
  const passcode = document.getElementById("passcode").value;
  if (!passcode) { alertEl.innerHTML = `<div class="alert alert--error">Please enter the passcode.</div>`; return; }

  btn.disabled = true; btn.textContent = "Logging in…";
  try {
    const { res, data } = await apiJSON("/api/staff/login", "POST", { passcode });
    if (res.ok && data.ok) {
      document.getElementById("passcode").value = "";
      showApp();
    } else {
      alertEl.innerHTML = `<div class="alert alert--error">${esc(data.error || "Incorrect passcode.")}</div>`;
    }
  } catch {
    alertEl.innerHTML = `<div class="alert alert--error">Could not reach the server.</div>`;
  } finally {
    btn.disabled = false; btn.textContent = "Log in";
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  try { await apiJSON("/api/staff/logout", "POST"); } catch {}
  showLogin();
});

// ---------------- tabs ----------------
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const name = tab.dataset.tab;
    ["gate", "onsite", "visitor", "history", "schedule"].forEach(s => {
      document.getElementById("tab-" + s).classList.toggle("hide", s !== name);
    });
    if (name === "onsite") loadOnsite();
    if (name === "gate") loadGateDay();
    if (name === "visitor" && typeof sigPad !== "undefined") sigPad.resize();
    if (name === "schedule") loadSchedule();
  });
});

// ---------------- rendering people ----------------
function bookingRow(b, opts = {}) {
  const showDate = opts.showDate;
  let badge, acts = "";
  const timeInfo = [];
  if (b.checked_in_at) timeInfo.push("In " + fmtTime(b.checked_in_at));
  if (b.checked_out_at) timeInfo.push("Out " + fmtTime(b.checked_out_at));

  if (b.status === "cancelled") {
    badge = `<span class="badge badge--cancel">Cancelled</span>`;
  } else if (b.status === "no_show" || b.is_late) {
    // Missed: 15-min grace blown. Hard cutoff — no sign-in, must rebook.
    badge = `<span class="badge badge--missed">Missed</span> <span class="muted" style="font-size:.78rem;">15-min grace period passed</span>`;
    acts = `<a class="btn btn--ghost btn--sm" href="/" target="_blank" rel="noopener">Rebook</a>`;
  } else if (b.checked_in_at && !b.checked_out_at) {
    badge = `<span class="badge badge--in">On site</span>`;
    acts = `<button class="btn btn--ghost btn--sm" data-act="checkout" data-id="${b.id}">Sign out</button>`;
  } else if (b.checked_out_at) {
    badge = `<span class="badge badge--out">Left</span>`;
    acts = `<button class="btn btn--ghost btn--sm" data-act="checkin" data-id="${b.id}">Sign in again</button>`;
  } else {
    badge = `<span class="badge badge--booked">Booked</span>`;
    acts = `<button class="btn btn--success btn--sm" data-act="checkin" data-id="${b.id}">Verify &amp; sign in</button>
            <button class="btn btn--danger btn--sm" data-act="cancel" data-id="${b.id}">Cancel</button>`;
  }

  const meta = [
    esc(b.branch),
    showDate ? fmtDate(b.visit_date) : null,
    slotLabel(b.slot),
    "Ref " + esc(b.reference),
    esc(b.phone),
    b.vehicle_reg ? "🚗 " + esc(b.vehicle_reg) : null,
    timeInfo.join(" · ") || null
  ].filter(Boolean).join(" &middot; ");

  return `<div class="person">
    <div class="who">
      <div class="nm">${esc(b.full_name)} ${badge}</div>
      <div class="meta">${meta}</div>
      ${b.purpose ? `<div class="meta">Purpose: ${esc(b.purpose)}</div>` : ""}
    </div>
    <div class="acts">${acts}</div>
  </div>`;
}

function visitorRow(v, opts = {}) {
  const timeInfo = [];
  if (v.checked_in_at) timeInfo.push("In " + fmtTime(v.checked_in_at));
  if (v.checked_out_at) timeInfo.push("Out " + fmtTime(v.checked_out_at));
  const acts = v.checked_out_at ? "" :
    `<button class="btn btn--ghost btn--sm" data-act="vcheckout" data-id="${v.id}">Sign out</button>`;
  const isWorker = v.kind === "worker";
  const badge = isWorker
    ? `<span class="badge badge--worker">Worker</span>`
    : `<span class="badge badge--visitor">Contractor</span>`;
  const org = isWorker ? v.branch : v.company;
  const meta = [
    org ? esc(org) : null,
    opts.showDate ? fmtDate(v.visit_date) : null,
    v.vehicle_reg ? "🚗 " + esc(v.vehicle_reg) : null,
    timeInfo.join(" · ") || null
  ].filter(Boolean).join(" &middot; ");
  return `<div class="person">
    <div class="who">
      <div class="nm">${esc(v.full_name)} ${badge}</div>
      <div class="meta">${meta || "&nbsp;"}</div>
      <div class="meta">Purpose: ${esc(v.purpose)}</div>
    </div>
    <div class="acts">${acts}</div>
  </div>`;
}

// ---------------- gate: day view ----------------
async function loadGateDay() {
  const date = document.getElementById("gate-date").value || londonTodayStr();
  const el = document.getElementById("gate-day");
  el.innerHTML = `<div class="spin">Loading…</div>`;
  try {
    const data = await (await api("/api/staff/day?date=" + encodeURIComponent(date))).json();
    renderGateDay(data);
  } catch (e) {
    if (e.message !== "unauthorised") el.innerHTML = `<div class="empty">Could not load bookings.</div>`;
  }
}

function renderGateDay(data) {
  const el = document.getElementById("gate-day");
  const bookings = data.bookings || [];
  const visitors = data.visitors || [];
  if (!bookings.length && !visitors.length) {
    el.innerHTML = `<div class="empty">No bookings or visitors for ${esc(fmtDate(data.date))}.</div>`;
    return;
  }

  // Group by whatever slots this day actually has, ordered by start time.
  const startMin = (key) => { const [h, m] = String(key).split("-")[0].split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const slotKeys = [...new Set(bookings.map(b => b.slot))].sort((a, b) => startMin(a) - startMin(b));
  let html = "";
  for (const key of slotKeys) {
    const inSlot = bookings.filter(b => b.slot === key);
    const active = inSlot.filter(b => b.status !== "cancelled");
    const onsite = inSlot.filter(b => b.checked_in_at && !b.checked_out_at).length;
    html += `<div class="slot-group">
      <h3><span>${esc(slotLabel(key))}</span><span class="muted">${active.length} booked &middot; ${onsite} on site</span></h3>
      ${inSlot.map(b => bookingRow(b)).join("")}
    </div>`;
  }

  if (visitors.length) {
    html += `<div class="slot-group">
      <h3><span>Visitors</span><span class="muted">${visitors.length}</span></h3>
      ${visitors.map(v => visitorRow(v)).join("")}
    </div>`;
  }
  el.innerHTML = html;
}

document.getElementById("gate-date").addEventListener("change", loadGateDay);
document.getElementById("gate-refresh").addEventListener("click", loadGateDay);

// ---------------- gate: search ----------------
let searchTimer = null;
document.getElementById("search-box").addEventListener("input", (e) => {
  currentQuery = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(currentQuery), 250);
});

async function runSearch(q) {
  const el = document.getElementById("search-results");
  if (!q) { el.innerHTML = ""; return; }
  try {
    const data = await (await api("/api/staff/search?q=" + encodeURIComponent(q))).json();
    const list = data.bookings || [];
    if (!list.length) {
      el.innerHTML = `<div class="empty">No booking found for “${esc(q)}”. If they are not in the system, they should not be let in.</div>`;
      return;
    }
    el.innerHTML = list.map(b => bookingRow(b, { showDate: true })).join("");
  } catch (e) {
    if (e.message !== "unauthorised") el.innerHTML = `<div class="empty">Search failed. Please try again.</div>`;
  }
}

// ---------------- on site ----------------
async function loadOnsite() {
  try {
    const data = await (await api("/api/staff/onsite")).json();
    document.getElementById("onsite-count").textContent =
      data.count ? `(${data.count})` : "";
    const el = document.getElementById("onsite-list");
    const bookings = data.bookings || [];
    const visitors = data.visitors || [];
    if (!bookings.length && !visitors.length) {
      el.innerHTML = `<div class="empty">Nobody is currently signed in.</div>`;
      return;
    }
    el.innerHTML =
      bookings.map(b => bookingRow(b, { showDate: true })).join("") +
      visitors.map(v => visitorRow(v, { showDate: true })).join("");
  } catch (e) { /* ignore when not authorised */ }
}
document.getElementById("onsite-refresh").addEventListener("click", loadOnsite);

// ---------------- actions (event delegation) ----------------
document.body.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;

  if (act === "cancel" && !confirm("Cancel this booking? This frees up their slot.")) return;

  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = "…";
  try {
    if (act === "vcheckout") {
      await apiJSON(`/api/staff/visitors/${id}/checkout`, "POST");
      toast("Visitor signed out");
    } else {
      await apiJSON(`/api/staff/bookings/${id}/${act}`, "POST");
      toast(act === "checkin" ? "Signed in" : act === "checkout" ? "Signed out" : "Booking cancelled");
    }
    await afterChange();
  } catch (err) {
    if (err.message !== "unauthorised") toast("Action failed, please try again", true);
    btn.disabled = false; btn.innerHTML = original;
  }
});

async function afterChange() {
  await Promise.all([loadGateDay(), loadOnsite()]);
  if (currentQuery) runSearch(currentQuery);
}

// ---------------- add visitor ----------------
const sigPad = KUI.signaturePad(document.getElementById("sigpad"));

document.getElementById("sig-clear").addEventListener("click", () => sigPad.clear());

// worker vs contractor toggle on the staff add form
let vKind = "worker";
function setVKind(kind) {
  vKind = kind;
  document.querySelectorAll("#v-kind button").forEach(b => b.classList.toggle("active", b.dataset.kind === kind));
  document.getElementById("field-v_branch").classList.toggle("hide", kind !== "worker");
  document.getElementById("field-v_company").classList.toggle("hide", kind !== "contractor");
}
document.querySelectorAll("#v-kind button").forEach(b => b.addEventListener("click", () => setVKind(b.dataset.kind)));

document.getElementById("visitor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById("visitor-alert");
  alertEl.innerHTML = "";
  document.querySelectorAll("#visitor-form .field.invalid").forEach(f => f.classList.remove("invalid"));

  const full_name = document.getElementById("v_full_name").value.trim();
  const purpose = document.getElementById("v_purpose").value.trim();
  const branch = document.getElementById("v_branch").value;
  const company = document.getElementById("v_company").value;
  let ok = true;
  if (!full_name) { document.getElementById("field-v_full_name").classList.add("invalid"); ok = false; }
  if (!purpose) { document.getElementById("field-v_purpose").classList.add("invalid"); ok = false; }
  if (vKind === "worker" && !branch) { document.getElementById("field-v_branch").classList.add("invalid"); ok = false; }
  if (sigPad.isEmpty()) { alertEl.innerHTML = `<div class="alert alert--error">Please ask them to sign.</div>`; ok = false; }
  if (!ok) return;

  const btn = document.getElementById("visitor-btn");
  btn.disabled = true; btn.textContent = "Checking in…";
  try {
    const { res, data } = await apiJSON("/api/staff/visitors", "POST", {
      kind: vKind, full_name, branch, company, purpose,
      vehicle_reg: document.getElementById("v_vehicle_reg").value,
      signature: sigPad.dataURL()
    });
    if (res.ok && data.ok) {
      e.target.reset();
      const bsel = document.getElementById("v_branch");
      if (bsel._kw) bsel._kw.render();
      setVKind("worker");
      sigPad.clear();
      toast("Checked in");
      loadOnsite();
      document.querySelector('.tab[data-tab="onsite"]').click();
    } else {
      if (data.fields) for (const k of Object.keys(data.fields)) { const f = document.getElementById("field-v_" + k); if (f) f.classList.add("invalid"); }
      alertEl.innerHTML = `<div class="alert alert--error">${esc(data.error || "Could not check them in.")}</div>`;
    }
  } catch (err) {
    if (err.message !== "unauthorised") alertEl.innerHTML = `<div class="alert alert--error">Could not reach the server.</div>`;
  } finally {
    btn.disabled = false; btn.textContent = "Check in";
  }
});

// ---------------- history & export ----------------
document.getElementById("hist-load").addEventListener("click", loadHistory);
document.getElementById("hist-export").addEventListener("click", () => {
  const from = document.getElementById("hist-from").value;
  const to = document.getElementById("hist-to").value;
  if (!from || !to) { toast("Please choose a date range", true); return; }
  const url = `/api/staff/export.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const a = document.createElement("a");
  a.href = url; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
});

async function loadHistory() {
  const from = document.getElementById("hist-from").value;
  const to = document.getElementById("hist-to").value;
  const summary = document.getElementById("hist-summary");
  const results = document.getElementById("hist-results");
  if (!from || !to) { toast("Please choose a date range", true); return; }
  results.innerHTML = `<div class="spin">Loading…</div>`;
  summary.textContent = "";

  try {
    const data = await (await api(
      `/api/staff/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json();
    const bookings = data.bookings || [];
    const visitors = data.visitors || [];
    const total = bookings.length + visitors.length;
    summary.textContent = `${bookings.length} member booking(s) and ${visitors.length} visitor(s) between ${fmtDate(data.from)} and ${fmtDate(data.to)}.`;

    if (!total) { results.innerHTML = `<div class="empty">Nothing in this date range.</div>`; return; }

    const rows = [];
    for (const b of bookings) {
      const status = b.status === "cancelled" ? "Cancelled" : (b.checked_in_at ? "Checked in" : "Booked");
      rows.push([
        "Member", fmtDate(b.visit_date), slotLabel(b.slot), esc(b.reference), esc(b.full_name),
        esc(b.branch), esc(b.purpose), esc(b.phone), b.vehicle_reg ? esc(b.vehicle_reg) : "",
        status, fmtTime(b.checked_in_at), fmtTime(b.checked_out_at)
      ]);
    }
    for (const v of visitors) {
      rows.push([
        "Visitor", fmtDate(v.visit_date), "", "", esc(v.full_name), esc(v.company || ""),
        esc(v.purpose), "", v.vehicle_reg ? esc(v.vehicle_reg) : "",
        v.checked_in_at ? "Checked in" : "", fmtTime(v.checked_in_at), fmtTime(v.checked_out_at)
      ]);
    }

    const head = ["Type", "Date", "Slot", "Ref", "Name", "Branch / Company", "Purpose", "Phone", "Vehicle", "Status", "In", "Out"];
    results.innerHTML = `<table class="data"><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  } catch (e) {
    if (e.message !== "unauthorised") results.innerHTML = `<div class="empty">Could not load history.</div>`;
  }
}

// ---------------- schedule (opening times & capacity) ----------------
const schedDate = () => document.getElementById("sched-date").value || londonTodayStr();
const schedAlert = (html) => { document.getElementById("sched-alert").innerHTML = html || ""; };

function schedToggleOpenBody() {
  const open = document.getElementById("sched-open").checked;
  document.getElementById("sched-open-body").classList.toggle("hide", !open);
}

function addSlotRow(start = "", end = "", bookedCount = 0) {
  const row = document.createElement("div");
  row.className = "slot-row";
  row.innerHTML =
    `<input type="time" class="slot-start" value="${start}" />
     <span class="dash">–</span>
     <input type="time" class="slot-end" value="${end}" />
     ${bookedCount ? `<span class="slot-booked">${bookedCount} already booked</span>` : ""}
     <button type="button" class="slot-del" title="Remove slot" aria-label="Remove slot">×</button>`;
  row.querySelector(".slot-del").addEventListener("click", () => row.remove());
  document.getElementById("sched-slots").appendChild(row);
}

function renderSlotRows(slots, booked) {
  const wrap = document.getElementById("sched-slots");
  wrap.innerHTML = "";
  if (!slots || !slots.length) { addSlotRow(); return; }
  for (const s of slots) addSlotRow(s.start, s.end, booked ? booked[s.key] : 0);
}

function gatherSlots() {
  return Array.from(document.querySelectorAll("#sched-slots .slot-row"))
    .map(r => ({ start: r.querySelector(".slot-start").value, end: r.querySelector(".slot-end").value }))
    .filter(s => s.start || s.end);
}

async function loadSchedule() {
  const date = schedDate();
  const status = document.getElementById("sched-status");
  schedAlert("");
  status.textContent = "Loading…";
  try {
    const data = await (await api("/api/staff/schedule?date=" + encodeURIComponent(date))).json();
    document.getElementById("sched-open").checked = !data.closed;
    document.getElementById("sched-capacity").value = data.capacity;
    renderSlotRows(data.slots || [], data.booked || {});
    schedToggleOpenBody();
    status.innerHTML = data.isOverride
      ? `<strong>${esc(fmtDate(date))}</strong> has a custom schedule.`
      : `<strong>${esc(fmtDate(date))}</strong> uses the standard schedule. Anything you save here applies to this day only.`;
  } catch (e) {
    if (e.message !== "unauthorised") status.textContent = "Could not load this day.";
  }
}

function generateSlots() {
  schedAlert("");
  const start = document.getElementById("gen-start").value;
  const end = document.getElementById("gen-end").value;
  const length = parseInt(document.getElementById("gen-length").value, 10);
  const gap = parseInt(document.getElementById("gen-interval").value, 10);   // break between slots
  const toMin = hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + (m || 0); };
  const toHM = min => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  if (!start || !end || !length || length < 1 || !Number.isFinite(gap) || gap < 0) {
    schedAlert(`<div class="alert alert--error">Fill in the generator fields with valid numbers (break can be 0).</div>`); return;
  }
  const s0 = toMin(start), e0 = toMin(end);
  if (e0 <= s0) { schedAlert(`<div class="alert alert--error">"Last slot ends by" must be after "First slot starts".</div>`); return; }

  const step = length + gap;                 // one group runs, then a break, then the next starts
  const slots = [];
  for (let st = s0; st + length <= e0; st += step) {
    slots.push({ start: toHM(st), end: toHM(st + length) });
    if (slots.length >= 48) break;
  }
  if (!slots.length) { schedAlert(`<div class="alert alert--error">No slots fit that window, check the times and lengths.</div>`); return; }
  document.getElementById("sched-open").checked = true;
  schedToggleOpenBody();
  renderSlotRows(slots, {});
  toast(`Generated ${slots.length} slot${slots.length === 1 ? "" : "s"}`);
}

async function saveSchedule() {
  const date = schedDate();
  const closed = !document.getElementById("sched-open").checked;
  const capacity = parseInt(document.getElementById("sched-capacity").value, 10);
  const slots = closed ? [] : gatherSlots();
  schedAlert("");

  if (!closed) {
    if (!capacity || capacity < 1) { schedAlert(`<div class="alert alert--error">Enter a capacity of at least 1.</div>`); return; }
    if (!slots.length) { schedAlert(`<div class="alert alert--error">Add at least one slot, or switch off "Open this day".</div>`); return; }
    for (const s of slots) {
      if (!s.start || !s.end) { schedAlert(`<div class="alert alert--error">Every slot needs both a start and end time.</div>`); return; }
    }
  }

  const btn = document.getElementById("sched-save");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const { res, data } = await apiJSON("/api/staff/schedule", "POST", { date, closed, capacity: capacity || 1, slots });
    if (res.ok && data.ok) { toast("Saved"); loadSchedule(); }
    else schedAlert(`<div class="alert alert--error">${esc(data.error || "Could not save.")}</div>`);
  } catch (e) {
    if (e.message !== "unauthorised") schedAlert(`<div class="alert alert--error">Could not reach the server.</div>`);
  } finally { btn.disabled = false; btn.textContent = "Save this day"; }
}

async function resetSchedule() {
  if (!confirm("Reset this day to the standard schedule? Any custom times for this day will be removed.")) return;
  const date = schedDate();
  try {
    await api("/api/staff/schedule?date=" + encodeURIComponent(date), { method: "DELETE" });
    toast("Reset to standard");
    loadSchedule();
  } catch (e) {
    if (e.message !== "unauthorised") toast("Could not reset", true);
  }
}

document.getElementById("sched-load").addEventListener("click", loadSchedule);
document.getElementById("sched-date").addEventListener("change", loadSchedule);
document.getElementById("sched-open").addEventListener("change", schedToggleOpenBody);
document.getElementById("gen-run").addEventListener("click", generateSlots);
document.getElementById("sched-add-slot").addEventListener("click", () => addSlotRow());
document.getElementById("sched-save").addEventListener("click", saveSchedule);
document.getElementById("sched-reset").addEventListener("click", resetSchedule);

boot();
