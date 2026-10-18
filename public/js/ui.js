"use strict";
/*
 * Lightweight custom <select> and date-picker that match the Kairos
 * "Modern Sanctuary" design. Each progressively enhances a real form
 * control (a hidden <select> / <input type="date">) which stays the value
 * store, so existing code keeps reading `el.value` and listening for "change".
 *
 *   KUI.enhanceSelect(selectEl)  -> instance
 *   KUI.enhanceDate(inputEl)     -> instance
 *   instance.render()            -> re-sync the trigger from the native value
 *
 * Both are idempotent (calling again just re-renders).
 */
(function () {
  const SVG = {
    chevDown: '<svg class="k-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    chevLeft: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    chevRight: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    calendar: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>'
  };

  // Only one popover open at a time.
  let openInstance = null;
  document.addEventListener("mousedown", (e) => {
    if (openInstance && !openInstance.contains(e.target)) openInstance.close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openInstance) openInstance.close(true);
  });

  function positionPanel(trigger, panel, opts) {
    const pad = 12, gap = opts.gap || 6;
    const vw = window.innerWidth, vh = window.innerHeight;
    const r = trigger.getBoundingClientRect();
    const prevScroll = panel.scrollTop;               // preserve the user's scroll position
    const width = opts.prefWidth
      ? Math.min(opts.prefWidth, vw - pad * 2)
      : Math.min(Math.max(r.width, 120), vw - pad * 2);
    panel.style.width = width + "px";
    panel.style.maxHeight = "none";
    panel.style.visibility = "hidden";
    const ph = panel.offsetHeight;
    const spaceBelow = vh - r.bottom - gap - pad;
    const spaceAbove = r.top - gap - pad;
    const up = ph > spaceBelow && spaceAbove > spaceBelow;
    const top = up
      ? Math.max(pad, r.top - Math.min(ph, spaceAbove) - gap)
      : Math.min(r.bottom + gap, vh - pad);
    const maxH = up ? Math.max(150, spaceAbove) : Math.max(150, vh - top - pad);
    const left = Math.min(Math.max(r.left, pad), Math.max(pad, vw - width - pad));
    panel.style.top = top + "px";
    panel.style.left = left + "px";
    panel.style.maxHeight = maxH + "px";
    panel.style.visibility = "visible";
    panel.scrollTop = prevScroll;                     // restore scroll after reflow
  }

  // A scroll anywhere on the page should keep the panel glued to its trigger,
  // but scrolling *inside* the panel must not trigger a reposition (that would
  // fight the user's scroll).
  function makeOnScroll(panel, reposition) {
    return (e) => {
      if (e.target === panel || (e.target && e.target.nodeType === 1 && panel.contains(e.target))) return;
      reposition();
    };
  }

  function makeWrap(nativeEl) {
    nativeEl.classList.add("k-native");
    nativeEl.setAttribute("tabindex", "-1");
    nativeEl.setAttribute("aria-hidden", "true");
    const wrap = document.createElement("div");
    wrap.className = "k-wrap";
    nativeEl.parentNode.insertBefore(wrap, nativeEl);
    wrap.appendChild(nativeEl);
    return wrap;
  }

  function relabel(nativeEl, triggerId) {
    if (!nativeEl.id) return;
    const lbl = document.querySelector('label[for="' + nativeEl.id + '"]');
    if (lbl) lbl.setAttribute("for", triggerId);
  }

  // ---------------------------------------------------------------- SELECT
  function enhanceSelect(sel) {
    if (sel._kw) { sel._kw.render(); return sel._kw; }
    const wrap = makeWrap(sel);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "k-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    if (sel.id) { trigger.id = sel.id + "-trigger"; relabel(sel, trigger.id); }
    trigger.innerHTML = '<span class="k-trigger-label"></span><span class="k-ic">' + SVG.chevDown + "</span>";
    wrap.appendChild(trigger);

    const panel = document.createElement("div");
    panel.className = "k-panel k-panel--select";
    panel.setAttribute("role", "listbox");

    const inst = { open: false };
    let activeIdx = -1, typeBuf = "", typeTimer = null;

    const placeholderText = () => {
      const ph = Array.from(sel.options).find((o) => o.value === "");
      return ph ? ph.textContent : "Select…";
    };
    const labelEl = () => trigger.querySelector(".k-trigger-label");
    function renderLabel() {
      const opt = sel.options[sel.selectedIndex];
      const has = opt && opt.value !== "";
      labelEl().textContent = has ? opt.textContent : placeholderText();
      trigger.classList.toggle("placeholder", !has);
    }
    function buildOptions() {
      panel.innerHTML = "";
      Array.from(sel.options).forEach((o) => {
        if (o.value === "") return;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "k-opt" + (o.value === sel.value ? " selected" : "");
        b.setAttribute("role", "option");
        b.dataset.value = o.value;
        b.textContent = o.textContent;
        if (o.disabled) b.disabled = true;
        b.addEventListener("click", () => select(o.value));
        panel.appendChild(b);
      });
    }
    const opts = () => Array.from(panel.querySelectorAll(".k-opt:not(:disabled)"));
    function setActive(i) {
      const list = opts();
      if (!list.length) return;
      if (i < 0) i = list.length - 1;
      if (i >= list.length) i = 0;
      list.forEach((x) => x.classList.remove("active"));
      activeIdx = i;
      list[i].classList.add("active");
      list[i].scrollIntoView({ block: "nearest" });
    }
    function select(value) {
      if (sel.value !== value) {
        sel.value = value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      renderLabel();
      close(true);
    }
    function reposition() { positionPanel(trigger, panel, {}); }
    const onScroll = makeOnScroll(panel, reposition);
    function open() {
      if (inst.open) return;
      if (openInstance && openInstance !== inst) openInstance.close();
      buildOptions();
      document.body.appendChild(panel);
      inst.open = true;
      trigger.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      openInstance = inst;
      reposition();
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", reposition);
      const list = opts();
      const i = list.findIndex((x) => x.dataset.value === sel.value);
      setActive(i >= 0 ? i : 0);
    }
    function close(returnFocus) {
      if (!inst.open) return;
      inst.open = false;
      trigger.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", reposition);
      if (openInstance === inst) openInstance = null;
      if (returnFocus) trigger.focus();
    }
    function typeahead(ch) {
      typeBuf += ch.toLowerCase();
      clearTimeout(typeTimer);
      typeTimer = setTimeout(() => (typeBuf = ""), 600);
      const i = opts().findIndex((x) => x.textContent.toLowerCase().startsWith(typeBuf));
      if (i >= 0) setActive(i);
    }

    trigger.addEventListener("click", () => (inst.open ? close() : open()));
    trigger.addEventListener("keydown", (e) => {
      if (!inst.open) {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
        return;
      }
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); setActive(activeIdx + 1); break;
        case "ArrowUp": e.preventDefault(); setActive(activeIdx - 1); break;
        case "Home": e.preventDefault(); setActive(0); break;
        case "End": e.preventDefault(); setActive(opts().length - 1); break;
        case "Enter": case " ": { e.preventDefault(); const a = opts()[activeIdx]; if (a) select(a.dataset.value); break; }
        case "Tab": close(); break;
        default: if (e.key.length === 1 && /\S/.test(e.key)) typeahead(e.key);
      }
    });

    inst.contains = (n) => wrap.contains(n) || panel.contains(n);
    inst.close = close;
    inst.render = () => { renderLabel(); if (inst.open) buildOptions(); };
    sel._kw = inst;
    renderLabel();
    return inst;
  }

  // ------------------------------------------------------------------ DATE
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WD = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  function parseIso(iso) {
    if (!iso) return null;
    const p = iso.split("-").map(Number);
    if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return null;
    const dt = new Date(p[0], p[1] - 1, p[2]);
    return isNaN(dt.getTime()) ? null : dt;
  }
  const strip = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const toIso = (dt) => dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
  const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const fmtDisplay = (dt) => dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  function enhanceDate(input) {
    if (input._kw) { input._kw.render(); return input._kw; }
    const wrap = makeWrap(input);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "k-trigger";
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    if (input.id) { trigger.id = input.id + "-trigger"; relabel(input, trigger.id); }
    trigger.innerHTML = '<span class="k-trigger-label"></span><span class="k-ic">' + SVG.calendar + "</span>";
    wrap.appendChild(trigger);

    const panel = document.createElement("div");
    panel.className = "k-panel k-panel--cal";
    panel.setAttribute("role", "dialog");

    const inst = { open: false };
    let viewMonth = strip(new Date());
    let viewMode = "day";

    const minD = () => parseIso(input.min);
    const maxD = () => parseIso(input.max);
    const dayDisabled = (dt) => {
      const mn = minD(), mx = maxD();
      if (mn && dt < strip(mn)) return true;
      if (mx && dt > strip(mx)) return true;
      return false;
    };

    function renderLabel() {
      const sel = parseIso(input.value);
      const l = trigger.querySelector(".k-trigger-label");
      l.textContent = sel ? fmtDisplay(sel) : (input.dataset.placeholder || "Select date");
      trigger.classList.toggle("placeholder", !sel);
    }
    function selectDate(dt) {
      input.value = toIso(dt);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      renderLabel();
      close(true);
    }
    function head(title) {
      return '<div class="k-cal-head">' +
        '<button type="button" class="k-cal-nav" data-nav="prev" aria-label="Previous month">' + SVG.chevLeft + "</button>" +
        '<button type="button" class="k-cal-title" data-title>' + title + "</button>" +
        '<button type="button" class="k-cal-nav" data-nav="next" aria-label="Next month">' + SVG.chevRight + "</button>" +
        "</div>";
    }
    const foot = () =>
      '<div class="k-cal-foot"><button type="button" class="k-clear" data-clear>Clear</button>' +
      '<button type="button" class="k-today" data-today>Today</button></div>';

    function buildDay() {
      const sel = parseIso(input.value), today = strip(new Date());
      const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
      const gridStart = new Date(first);
      gridStart.setDate(1 - first.getDay());
      let html = head(MONTHS[viewMonth.getMonth()] + " " + viewMonth.getFullYear());
      html += '<div class="k-cal-grid">' + WD.map((w) => '<div class="k-wd">' + w + "</div>").join("") + "</div>";
      html += '<div class="k-cal-grid">';
      for (let i = 0; i < 42; i++) {
        const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
        const cls = ["k-day"];
        if (d.getMonth() !== viewMonth.getMonth()) cls.push("out");
        const dis = dayDisabled(d);
        if (dis) cls.push("disabled");
        else if (sel && sameDay(d, sel)) cls.push("selected");
        else if (sameDay(d, today)) cls.push("today");
        html += '<button type="button" class="' + cls.join(" ") + '"' + (dis ? " disabled" : "") + ' data-iso="' + toIso(d) + '">' + d.getDate() + "</button>";
      }
      html += "</div>" + foot();
      panel.innerHTML = html;
    }
    function buildMonth() {
      const sel = parseIso(input.value);
      let html = head(String(viewMonth.getFullYear())) + '<div class="k-cal-grid3">';
      MONTHS_SHORT.forEach((m, idx) => {
        const cls = ["k-cell"];
        if (sel && sel.getFullYear() === viewMonth.getFullYear() && sel.getMonth() === idx) cls.push("selected");
        else if (viewMonth.getMonth() === idx) cls.push("current");
        html += '<button type="button" class="' + cls.join(" ") + '" data-month="' + idx + '">' + m + "</button>";
      });
      panel.innerHTML = html + "</div>" + foot();
    }
    function buildYear() {
      const sel = parseIso(input.value);
      const start = Math.floor(viewMonth.getFullYear() / 12) * 12;
      let html = head(start + " – " + (start + 11)) + '<div class="k-cal-grid3">';
      for (let y = start; y < start + 12; y++) {
        const cls = ["k-cell"];
        if (sel && sel.getFullYear() === y) cls.push("selected");
        else if (viewMonth.getFullYear() === y) cls.push("current");
        html += '<button type="button" class="' + cls.join(" ") + '" data-year="' + y + '">' + y + "</button>";
      }
      panel.innerHTML = html + "</div>" + foot();
    }
    function build() {
      if (viewMode === "day") buildDay();
      else if (viewMode === "month") buildMonth();
      else buildYear();
      if (inst.open) reposition();
    }

    panel.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.nav) {
        const dir = t.dataset.nav === "prev" ? -1 : 1;
        if (viewMode === "day") viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + dir, 1);
        else if (viewMode === "month") viewMonth = new Date(viewMonth.getFullYear() + dir, viewMonth.getMonth(), 1);
        else viewMonth = new Date(viewMonth.getFullYear() + dir * 12, viewMonth.getMonth(), 1);
        build();
      } else if (t.hasAttribute("data-title")) {
        viewMode = viewMode === "day" ? "month" : viewMode === "month" ? "year" : "day";
        build();
      } else if (t.hasAttribute("data-iso")) {
        if (!t.disabled) selectDate(parseIso(t.dataset.iso));
      } else if (t.hasAttribute("data-month")) {
        viewMonth = new Date(viewMonth.getFullYear(), Number(t.dataset.month), 1);
        viewMode = "day"; build();
      } else if (t.hasAttribute("data-year")) {
        viewMonth = new Date(Number(t.dataset.year), viewMonth.getMonth(), 1);
        viewMode = "month"; build();
      } else if (t.hasAttribute("data-clear")) {
        input.value = "";
        input.dispatchEvent(new Event("change", { bubbles: true }));
        renderLabel(); close(true);
      } else if (t.hasAttribute("data-today")) {
        const td = strip(new Date());
        if (!dayDisabled(td)) { viewMonth = new Date(td.getFullYear(), td.getMonth(), 1); selectDate(td); }
      }
    });

    function reposition() { positionPanel(trigger, panel, { prefWidth: 288 }); }
    const onScroll = makeOnScroll(panel, reposition);
    function open() {
      if (inst.open) return;
      if (openInstance && openInstance !== inst) openInstance.close();
      const sel = parseIso(input.value) || strip(new Date());
      viewMonth = new Date(sel.getFullYear(), sel.getMonth(), 1);
      viewMode = "day";
      document.body.appendChild(panel);
      inst.open = true;
      trigger.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      openInstance = inst;
      build();
      reposition();
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", reposition);
    }
    function close(returnFocus) {
      if (!inst.open) return;
      inst.open = false;
      trigger.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", reposition);
      if (openInstance === inst) openInstance = null;
      if (returnFocus) trigger.focus();
    }

    trigger.addEventListener("click", () => (inst.open ? close() : open()));
    trigger.addEventListener("keydown", (e) => {
      if (!inst.open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) { e.preventDefault(); open(); }
    });

    inst.contains = (n) => wrap.contains(n) || panel.contains(n);
    inst.close = close;
    inst.render = renderLabel;
    input._kw = inst;
    renderLabel();
    return inst;
  }

  // ---------------------------------------------------------- SIGNATURE PAD
  // Finger/stylus/mouse signature on a <canvas>. Returns {resize, clear,
  // isEmpty, dataURL}. The buffer is (re)sized lazily so it works even when
  // the canvas starts hidden (e.g. inside a hidden tab).
  function signaturePad(canvas) {
    const ctx = canvas.getContext("2d");
    let drawing = false, hasInk = false, last = null, ratio = 1;

    function setup() {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      ratio = window.devicePixelRatio || 1;
      const w = Math.round(rect.width * ratio);
      const h = Math.round(rect.height * ratio);
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1b2440";
      hasInk = false;
    }
    function pos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    canvas.addEventListener("pointerdown", (e) => {
      setup();
      drawing = true; last = pos(e);
      try { canvas.setPointerCapture(e.pointerId); } catch {}
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; hasInk = true;
    });
    const stop = () => { drawing = false; };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    canvas.addEventListener("pointerleave", stop);

    function clear() {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore(); hasInk = false;
    }

    requestAnimationFrame(setup);
    window.addEventListener("resize", setup);

    return { resize: setup, clear, isEmpty: () => !hasInk, dataURL: () => canvas.toDataURL("image/png") };
  }

  window.KUI = { enhanceSelect, enhanceDate, signaturePad };
})();
