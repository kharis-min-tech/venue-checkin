"use strict";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");

let currentStatus = "";   // "" | pending | approved | declined
let currentKind = "one_off";   // "one_off" | "recurring" (new-request form)
let configLoaded = false;
let isApprover = false;   // false = public (form only) | true = admin (form + log + review)

// Recurring frequencies: how to show them, and how many times a year they recur
// (to annualise the amount). Must mirror REQUISITION_FREQUENCIES in config.js.
const FREQ = {
  weekly:    { suffix: "/ week",    perYear: 52 },
  monthly:   { suffix: "/ month",   perYear: 12 },
  quarterly: { suffix: "/ quarter", perYear: 4 },
  yearly:    { suffix: "/ year",    perYear: 1 }
};

// ---------------- helpers ----------------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtMoney(pence) {
  const n = Math.round(Number(pence) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const pounds = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}£${pounds}.${String(abs % 100).padStart(2, "0")}`;
}
function fmtWhen(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB",
    { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" });
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (res.status === 401) { onUnauthorised(); throw new Error("unauthorised"); }
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

// An admin session dropped out (expired / logged out elsewhere): fall back to
// the public form rather than trapping the person on a dead screen.
function onUnauthorised() {
  isApprover = false;
  showApp();
  toast("Your admin session has ended. Please log in again.", true);
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
// The admin portal is intentionally unadvertised: there is NO button on the
// public form. Admins reach the login by visiting /requisitions/#admin (or
// ?admin). An already logged-in admin lands straight in the review view.
function wantsAdmin() {
  if ((location.hash || "").toLowerCase() === "#admin") return true;
  try { return new URLSearchParams(location.search).has("admin"); } catch { return false; }
}

// Strip the #admin / ?admin marker from the address bar so it doesn't linger
// (e.g. a reload after cancelling would otherwise reopen the login).
function clearAdminUrl() {
  try {
    if (location.hash || new URLSearchParams(location.search).has("admin")) {
      history.replaceState(null, "", location.pathname);
    }
  } catch {}
}

async function boot() {
  try {
    const { authenticated } = await (await fetch("/api/req/session", { credentials: "same-origin" })).json();
    isApprover = !!authenticated;
  } catch { isApprover = false; }
  if (!isApprover && wantsAdmin()) showAdminLogin();
  else showApp();
}

function showAdminLogin() {
  appView.classList.add("hide");
  loginView.classList.remove("hide");
  const pc = document.getElementById("passcode");
  if (pc) { pc.value = ""; pc.focus(); }
}

// Approvers get the full app (totals, log, review, and the form). The public
// gets only the "New request" form: no totals, no log, no other requests.
function applyRole() {
  document.querySelector(".totals").classList.toggle("hide", !isApprover);
  document.querySelector(".tabs").classList.toggle("hide", !isApprover);
  document.getElementById("logout-btn").classList.toggle("hide", !isApprover);

  if (isApprover) {
    document.getElementById("tab-new").classList.add("hide");
    document.getElementById("tab-log").classList.remove("hide");
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "log"));
  } else {
    document.getElementById("tab-log").classList.add("hide");
    document.getElementById("tab-new").classList.remove("hide");
  }
  const sub = document.getElementById("topbar-sub");
  if (sub) sub.textContent = isApprover ? "Spurgeon's Centre spend log" : "Request funds for improving the venue";
}

async function showApp() {
  loginView.classList.add("hide");
  appView.classList.remove("hide");
  applyRole();
  await loadConfigOnce();          // categories + frequencies for the form
  if (isApprover) loadReq();
}

// Category + frequency dropdowns, from the server so they always match config.js.
// Public endpoint, so this works whether or not an admin is logged in.
async function loadConfigOnce() {
  if (configLoaded) return;
  const cat = document.getElementById("category");
  const freq = document.getElementById("frequency");
  try {
    const cfg = await (await fetch("/api/req/config", { credentials: "same-origin" })).json();
    for (const c of (cfg.categories || [])) {
      const o = document.createElement("option");
      o.value = c; o.textContent = c; cat.appendChild(o);
    }
    for (const f of (cfg.frequencies || [])) {
      const o = document.createElement("option");
      o.value = f.value; o.textContent = f.label; freq.appendChild(o);
    }
  } catch { return; }
  configLoaded = true;
  if (cat) KUI.enhanceSelect(cat);
  if (freq) KUI.enhanceSelect(freq);
}

document.getElementById("login-cancel").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("login-alert").innerHTML = "";
  clearAdminUrl();
  showApp();
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("login-btn");
  const alertEl = document.getElementById("login-alert");
  alertEl.innerHTML = "";
  const passcode = document.getElementById("passcode").value;
  if (!passcode) { alertEl.innerHTML = `<div class="alert alert--error">Please enter the passcode.</div>`; return; }

  btn.disabled = true; btn.textContent = "Logging in…";
  try {
    const { res, data } = await apiJSON("/api/req/login", "POST", { passcode });
    if (res.ok && data.ok) {
      document.getElementById("passcode").value = "";
      isApprover = true;
      clearAdminUrl();
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
  try { await apiJSON("/api/req/logout", "POST"); } catch {}
  isApprover = false;
  showApp();
});

// ---------------- tabs ----------------
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const name = tab.dataset.tab;
    ["log", "new"].forEach(s => {
      document.getElementById("tab-" + s).classList.toggle("hide", s !== name);
    });
    if (name === "log") loadReq();
  });
});

// ---------------- recurring / one-off toggle ----------------
document.querySelectorAll("#kind-toggle button").forEach(b => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#kind-toggle button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    setKind(b.dataset.kind);
  });
});

function setKind(kind) {
  currentKind = kind === "recurring" ? "recurring" : "one_off";
  const recurring = currentKind === "recurring";
  document.getElementById("field-frequency").classList.toggle("hide", !recurring);
  const costLabel = document.getElementById("cost-label");
  if (costLabel) costLabel.innerHTML = recurring ? "Amount each time (&pound;)" : "Cost (&pound;)";
}

// ---------------- status filter ----------------
document.querySelectorAll("#status-filter button").forEach(b => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#status-filter button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    currentStatus = b.dataset.status || "";
    loadReq();
  });
});

// ---------------- totals + list ----------------
async function loadReq() {
  const list = document.getElementById("req-list");
  list.innerHTML = `<div class="spin">Loading…</div>`;
  const q = currentStatus ? ("?status=" + encodeURIComponent(currentStatus)) : "";
  try {
    const data = await (await api("/api/req/list" + q)).json();
    renderTotals(data.totals || {});
    renderList(data.requisitions || []);
  } catch (e) {
    if (e.message !== "unauthorised") list.innerHTML = `<div class="empty">Could not load requisitions.</div>`;
  }
}

function renderTotals(t) {
  document.getElementById("stat-approved").textContent = fmtMoney(t.approvedPence || 0);
  document.getElementById("stat-approved-sub").textContent = `${t.approvedCount || 0} one-off approved`;

  document.getElementById("stat-recurring").innerHTML =
    `${fmtMoney(t.recurringAnnualPence || 0)} <span class="stat-unit">/ yr</span>`;
  document.getElementById("stat-recurring-sub").textContent = `${t.recurringCount || 0} recurring approved`;

  document.getElementById("stat-pending").textContent = fmtMoney(t.pendingPence || 0);
  document.getElementById("stat-pending-sub").textContent = `${t.pendingCount || 0} pending`;

  const cats = t.byCategory || [];
  const el = document.getElementById("stat-cats");
  if (!cats.length) {
    el.innerHTML = `<span class="muted">No approved spend yet.</span>`;
    return;
  }
  el.innerHTML = cats.map(c =>
    `<div class="cat-row"><span>${esc(c.category)}</span><strong>${fmtMoney(c.pence)}</strong></div>`
  ).join("");
}

const STATUS_BADGE = {
  pending:  `<span class="badge badge--pending">Pending</span>`,
  approved: `<span class="badge badge--approved">Approved</span>`,
  declined: `<span class="badge badge--declined">Declined</span>`
};

function reqRow(r) {
  let acts = "";
  if (r.status === "pending") {
    acts = `<button class="btn btn--success btn--sm" data-act="approved" data-id="${r.id}">Approve</button>
            <button class="btn btn--danger btn--sm" data-act="declined" data-id="${r.id}">Decline</button>`;
  } else {
    acts = `<button class="btn btn--ghost btn--sm" data-act="pending" data-id="${r.id}">Reopen</button>`;
  }
  acts += `<button class="btn btn--ghost btn--sm" data-act="delete" data-id="${r.id}" title="Delete">Delete</button>`;

  const recurring = r.kind === "recurring";
  const f = FREQ[r.frequency];
  const cost = recurring && f
    ? `${fmtMoney(r.cost_pence)} <span class="req-per">${esc(f.suffix)}</span>`
    : fmtMoney(r.cost_pence);
  const recurTag = recurring
    ? `<span class="badge badge--recurring">Recurring</span>`
    : "";

  const meta = [
    esc(r.category),
    recurring && f ? "Recurring &middot; " + fmtMoney(r.cost_pence * f.perYear) + " / yr" : null,
    "Requested by " + esc(r.requestor),
    "Approver: " + esc(r.approver),
    "Ref " + esc(r.reference),
    "Submitted " + esc(fmtWhen(r.created_at)),
    r.decided_at ? "Decided " + esc(fmtWhen(r.decided_at)) : null
  ].filter(Boolean).join(" &middot; ");

  return `<div class="person">
    <div class="who">
      <div class="nm"><span class="req-cost">${cost}</span> ${esc(r.item)} ${STATUS_BADGE[r.status] || ""} ${recurTag}</div>
      <div class="meta">${meta}</div>
      ${r.notes ? `<div class="meta">Notes: ${esc(r.notes)}</div>` : ""}
    </div>
    <div class="acts">${acts}</div>
  </div>`;
}

function renderList(rows) {
  const el = document.getElementById("req-list");
  if (!rows.length) {
    el.innerHTML = `<div class="empty">No requisitions${currentStatus ? " with this status" : " yet"}.</div>`;
    return;
  }
  el.innerHTML = rows.map(reqRow).join("");
}

// ---------------- actions (event delegation) ----------------
document.body.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (!id) return;

  if (act === "delete" && !confirm("Delete this requisition? This cannot be undone.")) return;

  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = "…";
  try {
    if (act === "delete") {
      await api(`/api/req/${id}`, { method: "DELETE" });
      toast("Requisition deleted");
    } else {
      await apiJSON(`/api/req/${id}/decision`, "POST", { decision: act });
      toast(act === "approved" ? "Approved" : act === "declined" ? "Declined" : "Reopened");
    }
    await loadReq();
  } catch (err) {
    if (err.message !== "unauthorised") { toast("Action failed, please try again", true); btn.disabled = false; btn.innerHTML = original; }
  }
});

// ---------------- new requisition ----------------
function resetReqForm() {
  document.getElementById("req-form").reset();
  document.querySelectorAll("#kind-toggle button").forEach(x => x.classList.toggle("active", x.dataset.kind === "one_off"));
  setKind("one_off");
  const cat = document.getElementById("category");
  const freq = document.getElementById("frequency");
  if (cat && cat._kw) cat._kw.render();
  if (freq && freq._kw) freq._kw.render();
}

document.getElementById("req-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById("req-alert");
  alertEl.innerHTML = "";
  document.querySelectorAll("#req-form .field.invalid").forEach(f => f.classList.remove("invalid"));

  const payload = {
    requestor: document.getElementById("requestor").value.trim(),
    item: document.getElementById("item").value.trim(),
    category: document.getElementById("category").value,
    cost: document.getElementById("cost").value.trim(),
    kind: currentKind,
    frequency: document.getElementById("frequency").value,
    approver: document.getElementById("approver").value.trim(),
    notes: document.getElementById("notes").value.trim()
  };

  const btn = document.getElementById("req-submit");
  btn.disabled = true; btn.textContent = "Submitting…";
  try {
    const { res, data } = await apiJSON("/api/req/create", "POST", payload);
    if (res.ok && data.ok) {
      resetReqForm();
      toast("Requisition submitted");
      if (isApprover) {
        currentStatus = "pending";
        document.querySelectorAll("#status-filter button").forEach(x => x.classList.toggle("active", x.dataset.status === "pending"));
        document.querySelector('.tab[data-tab="log"]').click();
      } else {
        alertEl.innerHTML = `<div class="alert alert--info">Thanks, your requisition has been submitted for approval.</div>`;
      }
    } else {
      if (data.fields) for (const k of Object.keys(data.fields)) {
        const f = document.getElementById("field-" + k);
        if (f) f.classList.add("invalid");
      }
      alertEl.innerHTML = `<div class="alert alert--error">${esc(data.error || "Could not save the requisition.")}</div>`;
    }
  } catch (err) {
    if (err.message !== "unauthorised") alertEl.innerHTML = `<div class="alert alert--error">Could not reach the server.</div>`;
  } finally {
    btn.disabled = false; btn.textContent = "Submit requisition";
  }
});

// ---------------- export ----------------
document.getElementById("req-export").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = "/api/req/export.csv"; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
});

document.getElementById("req-refresh").addEventListener("click", loadReq);

boot();
