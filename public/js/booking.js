"use strict";

const form = document.getElementById("booking-form");
const slotsEl = document.getElementById("slots");
const dateEl = document.getElementById("visit_date");
const branchEl = document.getElementById("branch");
const alertEl = document.getElementById("form-alert");
const submitBtn = document.getElementById("submit-btn");
const confirmationEl = document.getElementById("confirmation");

let selectedSlot = "";

// Today's date in YYYY-MM-DD (local device time is fine for the picker min).
function todayStr() {
  const n = new Date();
  const m = String(n.getMonth() + 1).padStart(2, "0");
  const d = String(n.getDate()).padStart(2, "0");
  return `${n.getFullYear()}-${m}-${d}`;
}

async function init() {
  dateEl.min = todayStr();
  dateEl.value = todayStr();
  KUI.enhanceDate(dateEl);

  try {
    const cfg = await (await fetch("/api/config")).json();
    for (const b of cfg.branches) {
      const o = document.createElement("option");
      o.value = b; o.textContent = b;
      branchEl.appendChild(o);
    }
  } catch {
    showAlert("Could not load the form. Please refresh the page.");
  }
  KUI.enhanceSelect(branchEl);

  loadSlots();
  dateEl.addEventListener("change", loadSlots);
}

async function loadSlots() {
  selectedSlot = "";
  clearFieldError("slot");
  const date = dateEl.value;
  if (!date) { slotsEl.innerHTML = '<div class="spin">Choose a date first.</div>'; return; }
  slotsEl.innerHTML = '<div class="spin">Checking availability…</div>';

  try {
    const res = await fetch("/api/slots?date=" + encodeURIComponent(date));
    const data = await res.json();
    if (!res.ok) { slotsEl.innerHTML = `<div class="spin">${data.error || "Could not load times."}</div>`; return; }
    if (!data.open || !data.slots || !data.slots.length) {
      const msg = data.reason === "past"
        ? "That day has already passed, please choose another date."
        : "There are no visits on this day. Please choose another date.";
      slotsEl.innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    renderSlots(data.slots);
  } catch {
    slotsEl.innerHTML = '<div class="spin">Could not check availability. Please try again.</div>';
  }
}

function renderSlots(slots) {
  slotsEl.innerHTML = "";
  for (const s of slots) {
    const el = document.createElement("label");
    el.className = "slot";
    // Capacity is deliberately hidden — members only see whether a slot is open.
    let note;
    if (s.available) { note = "Available"; }
    else if (s.reason === "ended") { el.classList.add("closed"); note = "Already ended"; }
    else { el.classList.add("full"); note = "Fully booked"; }

    el.innerHTML =
      `<input type="radio" name="slot" value="${s.key}" ${s.available ? "" : "disabled"} />
       <div class="slot-time">${s.label}</div>
       <div class="slot-left">${note}</div>`;

    if (s.available) {
      el.addEventListener("click", () => {
        document.querySelectorAll(".slot").forEach(x => x.classList.remove("selected"));
        el.classList.add("selected");
        el.querySelector("input").checked = true;
        selectedSlot = s.key;
        clearFieldError("slot");
      });
    }
    slotsEl.appendChild(el);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAllErrors();
  alertEl.innerHTML = "";

  const payload = {
    visit_date: dateEl.value,
    slot: selectedSlot,
    full_name: form.full_name.value,
    branch: form.branch.value,
    purpose: form.purpose.value,
    phone: form.phone.value,
    vehicle_reg: form.vehicle_reg.value
  };

  if (!selectedSlot) { setFieldError("slot", "Please choose a time slot."); scrollToTop(); return; }

  submitBtn.disabled = true;
  submitBtn.textContent = "Booking…";

  try {
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      showConfirmation(data);
      return;
    }

    if (data.fields) for (const [k, msg] of Object.entries(data.fields)) setFieldError(k, msg);
    showAlert(data.error || "Please check the form and try again.");
    if (data.fields && data.fields.slot) loadSlots(); // refresh availability if slot filled up
  } catch {
    showAlert("Could not reach the server. Please check your connection and try again.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Book my visit";
  }
});

function showConfirmation(data) {
  form.classList.add("hide");
  confirmationEl.classList.remove("hide");
  document.getElementById("confirm-ref").textContent = data.reference;
  const niceDate = new Date(data.visit_date + "T00:00:00").toLocaleDateString("en-GB",
    { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  document.getElementById("confirm-when").textContent = `${niceDate} · ${data.slot_label}`;
  document.getElementById("confirm-who").textContent = `${data.full_name} · ${data.branch}`;
  const manageLink = document.getElementById("manage-link");
  if (manageLink) manageLink.href = "/manage?ref=" + encodeURIComponent(data.reference);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.getElementById("book-another").addEventListener("click", () => {
  form.reset();
  selectedSlot = "";
  confirmationEl.classList.add("hide");
  form.classList.remove("hide");
  dateEl.min = todayStr();
  dateEl.value = todayStr();
  if (dateEl._kw) dateEl._kw.render();
  if (branchEl._kw) branchEl._kw.render();
  clearAllErrors();
  alertEl.innerHTML = "";
  loadSlots();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ---- helpers ----
function setFieldError(name, msg) {
  const field = document.getElementById("field-" + name);
  if (!field) return;
  field.classList.add("invalid");
  const err = field.querySelector(".field-error");
  if (err && msg) err.textContent = msg;
}
function clearFieldError(name) {
  const field = document.getElementById("field-" + name);
  if (field) field.classList.remove("invalid");
}
function clearAllErrors() {
  document.querySelectorAll(".field.invalid").forEach(f => f.classList.remove("invalid"));
}
function showAlert(msg) {
  alertEl.innerHTML = `<div class="alert alert--error">${msg}</div>`;
  scrollToTop();
}
function scrollToTop() { window.scrollTo({ top: 0, behavior: "smooth" }); }

init();
