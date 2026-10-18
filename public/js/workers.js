"use strict";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false });
}
let toastTimer = null;
function toast(msg, isErr) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 2600);
}

const form = document.getElementById("signin-form");
const sigPad = KUI.signaturePad(document.getElementById("sigpad"));
let kind = "worker";

// ---------------- init ----------------
(async function init() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    const sel = document.getElementById("branch");
    for (const b of cfg.branches) { const o = document.createElement("option"); o.value = b; o.textContent = b; sel.appendChild(o); }
    KUI.enhanceSelect(sel);
  } catch { showAlert("Could not load the form. Please refresh the page."); }
  setKind("worker");
  requestAnimationFrame(() => sigPad.resize());
})();

// ---------------- mode toggle (sign in / sign out) ----------------
document.querySelectorAll("#mode button").forEach(b => b.addEventListener("click", () => {
  const mode = b.dataset.mode;
  document.querySelectorAll("#mode button").forEach(x => x.classList.toggle("active", x === b));
  document.getElementById("confirm-view").classList.add("hide");
  document.getElementById("signin-form").classList.toggle("hide", mode !== "in");
  document.getElementById("signout-view").classList.toggle("hide", mode !== "out");
  if (mode === "in") requestAnimationFrame(() => sigPad.resize());
  if (mode === "out") document.getElementById("signout-search").focus();
}));

// ---------------- kind toggle (worker / contractor) ----------------
function setKind(k) {
  kind = k;
  document.querySelectorAll("#kind button").forEach(b => b.classList.toggle("active", b.dataset.kind === k));
  document.getElementById("field-branch").classList.toggle("hide", k !== "worker");
  document.getElementById("field-company").classList.toggle("hide", k !== "contractor");
  requestAnimationFrame(() => sigPad.resize());
}
document.querySelectorAll("#kind button").forEach(b => b.addEventListener("click", () => setKind(b.dataset.kind)));

document.getElementById("sig-clear").addEventListener("click", () => sigPad.clear());

// ---------------- sign in ----------------
function setErr(name, msg) {
  const f = document.getElementById("field-" + name);
  if (!f) return;
  f.classList.add("invalid");
  const e = f.querySelector(".field-error");
  if (e && msg) e.textContent = msg;
}
function clearErrs() { document.querySelectorAll("#signin-form .field.invalid").forEach(f => f.classList.remove("invalid")); }
function showAlert(msg) { document.getElementById("signin-alert").innerHTML = `<div class="alert alert--error">${esc(msg)}</div>`; }

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrs();
  document.getElementById("signin-alert").innerHTML = "";

  const full_name   = document.getElementById("full_name").value.trim();
  const branch      = document.getElementById("branch").value;
  const company     = document.getElementById("company").value.trim();
  const purpose     = document.getElementById("purpose").value.trim();
  const vehicle_reg = document.getElementById("vehicle_reg").value.trim();
  const safety_ack  = document.getElementById("safety_ack").checked;

  let ok = true;
  if (!full_name) { setErr("full_name"); ok = false; }
  if (kind === "worker" && !branch) { setErr("branch"); ok = false; }
  if (!purpose) { setErr("purpose"); ok = false; }
  if (sigPad.isEmpty()) { showAlert("Please sign in the box."); ok = false; }
  if (!safety_ack) { setErr("safety_ack"); ok = false; }
  if (!ok) return;

  const btn = document.getElementById("signin-btn");
  btn.disabled = true; btn.textContent = "Signing in…";
  try {
    const res = await fetch("/api/signin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, full_name, branch, company, purpose, vehicle_reg, safety_ack, signature: sigPad.dataURL() })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      showConfirm(full_name);
    } else {
      if (data.fields) for (const [k, msg] of Object.entries(data.fields)) setErr(k, msg);
      showAlert(data.error || "Could not sign you in. Please try again.");
    }
  } catch {
    showAlert("Could not reach the server. Please check your connection and try again.");
  } finally {
    btn.disabled = false; btn.textContent = "Sign in";
  }
});

function showConfirm(name) {
  document.getElementById("signin-form").classList.add("hide");
  document.getElementById("signout-view").classList.add("hide");
  document.getElementById("confirm-view").classList.remove("hide");
  document.getElementById("confirm-title").textContent = `You're signed in, ${name.split(" ")[0]}`;
  document.getElementById("confirm-detail").textContent = "Please remember to sign out when you leave. Tap 'Sign out' and type your name.";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.getElementById("confirm-done").addEventListener("click", () => {
  form.reset();
  const bsel = document.getElementById("branch");
  if (bsel._kw) bsel._kw.render();
  document.getElementById("safety_ack").checked = false;
  setKind("worker");
  sigPad.clear();
  document.getElementById("confirm-view").classList.add("hide");
  document.querySelector('#mode button[data-mode="in"]').click();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ---------------- sign out (find by name) ----------------
let searchTimer = null;
document.getElementById("signout-search").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => findSignout(q), 250);
});

async function findSignout(q) {
  const el = document.getElementById("signout-results");
  if (q.length < 2) { el.innerHTML = ""; return; }
  try {
    const data = await (await fetch("/api/signin/find?name=" + encodeURIComponent(q))).json();
    const people = data.people || [];
    if (!people.length) {
      el.innerHTML = `<div class="empty">No one still on site is signed in under “${esc(q)}”.</div>`;
      return;
    }
    el.innerHTML = people.map(p => {
      const org = p.kind === "worker" ? (p.branch || "") : (p.company || "");
      const badge = p.kind === "worker" ? "Worker" : "Contractor";
      const meta = [org ? esc(org) : null, "In " + fmtTime(p.checked_in_at)].filter(Boolean).join(" · ");
      return `<div class="person">
        <div class="who"><div class="nm">${esc(p.full_name)} <span class="badge ${p.kind === "worker" ? "badge--worker" : "badge--visitor"}">${badge}</span></div>
          <div class="meta">${meta}</div></div>
        <div class="acts"><button class="btn btn--sm" data-signout="${p.id}" data-name="${esc(p.full_name)}">Sign out</button></div>
      </div>`;
    }).join("");
  } catch {
    el.innerHTML = `<div class="empty">Could not search. Please try again.</div>`;
  }
}

document.getElementById("signout-results").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-signout]");
  if (!btn) return;
  const id = Number(btn.dataset.signout);
  const name = btn.dataset.name;
  btn.disabled = true; btn.textContent = "…";
  try {
    const res = await fetch("/api/signout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      document.getElementById("signout-search").value = "";
      document.getElementById("signout-results").innerHTML = "";
      document.getElementById("signout-view").classList.add("hide");
      document.getElementById("confirm-view").classList.remove("hide");
      document.getElementById("confirm-title").textContent = "You're signed out";
      document.getElementById("confirm-detail").textContent = `Thanks, ${name.split(" ")[0]} stay safe.`;
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      toast(data.error || "Could not sign out", true);
      btn.disabled = false; btn.textContent = "Sign out";
    }
  } catch {
    toast("Could not reach the server", true);
    btn.disabled = false; btn.textContent = "Sign out";
  }
});
