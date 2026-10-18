import { TIMEZONE } from "./config.js";

const encoder = new TextEncoder();

// ---------- HTTP helpers ----------

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

export function clean(value, maxLength) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, maxLength);
}

export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) return false;
  // Reject impossible dates like 2026-02-31 (which Date would roll over).
  return d.toISOString().slice(0, 10) === s;
}

// ---------- Time (UK local) ----------

function londonParts(d) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const out = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

export function londonDate(d = new Date()) {
  const p = londonParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

export function londonHour(d = new Date()) {
  return parseInt(londonParts(d).hour, 10);
}

// Minutes since midnight, UK local time (e.g. 14:30 -> 870).
export function londonMinutesOfDay(d = new Date()) {
  const p = londonParts(d);
  return parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
}

// ---------- Time slots ----------

// "HH:MM" -> minutes since midnight.
export function hmToMin(hm) {
  const [h, m] = String(hm).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// "14:00" -> "2:00 PM"
export function fmt12h(hm) {
  const [h, m] = String(hm).split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  let hh = h % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${String(m || 0).padStart(2, "0")} ${ampm}`;
}

export const slotKey = (s) => `${s.start}-${s.end}`;
export const slotLabel = (s) => `${fmt12h(s.start)} – ${fmt12h(s.end)}`;

// "14:00-15:00" -> "2:00 PM – 3:00 PM"
export function labelFromKey(key) {
  const [a, b] = String(key).split("-");
  if (!a || !b) return key;
  return `${fmt12h(a)} – ${fmt12h(b)}`;
}

// ISO (UTC) timestamp -> "11/10/2026 22:15" in UK local time.
export function formatLondon(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = londonParts(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

export function nowISO() {
  return new Date().toISOString();
}

// ---------- Reference codes ----------

// Unambiguous alphabet (no 0/O/1/I/L).
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeReference(length = 5) {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < length; i++) s += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return s;
}

// ---------- Sessions (signed cookie) ----------

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// opts: { ttlMs, scope }. A `scope` (e.g. "req") is baked into the token so a
// session minted for one area can't be replayed as another. Back-compat: called
// with no opts it behaves exactly as before (12h, no scope) — the staff portal.
export async function createSession(secret, opts = {}) {
  const ttlMs = typeof opts === "number" ? opts : (opts.ttlMs ?? 12 * 60 * 60 * 1000);
  const scope = (opts && typeof opts === "object") ? opts.scope : undefined;
  const role  = (opts && typeof opts === "object") ? opts.role : undefined;
  const claims = { exp: Date.now() + ttlMs };
  if (scope) claims.scope = scope;
  if (role) claims.role = role;
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  const sig = b64url(await hmac(secret, payload));
  return `${payload}.${sig}`;
}

// expectedScope: pass the scope a token MUST carry (e.g. "req"). Omit it for the
// staff portal, where valid tokens carry no scope — so a scoped token (finance,
// requisitions) is rejected here, and vice versa. The two gates don't overlap.
export async function verifySession(secret, token, expectedScope) {
  if (!secret || !token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = b64url(await hmac(secret, payload));
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
    if (typeof data.exp !== "number" || data.exp <= Date.now()) return false;
    if (expectedScope) return data.scope === expectedScope;
    return data.scope === undefined;
  } catch {
    return false;
  }
}

// Like verifySession, but returns the decoded claims ({ exp, scope, role }) when
// the signature and expiry are valid, else null. Used where the handler needs to
// read the session's role (e.g. requisitions submit vs approver).
export async function readSession(secret, token) {
  if (!secret || !token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = b64url(await hmac(secret, payload));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
    if (typeof data.exp !== "number" || data.exp <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

// ---------- CSV ----------

function csvCell(v) {
  if (v === null || v === undefined) v = "";
  v = String(v);
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

export function toCSV(rows) {
  return rows.map(r => r.map(csvCell).join(",")).join("\r\n");
}

// ---------- Money (GBP) ----------
// Store money as whole pence (integers) so sums never drift the way floats do.

// Parse a user-entered amount ("1,234.50", "£99", 42) to integer pence.
// Returns null if it isn't a valid non-negative amount with at most 2 decimals.
export function poundsToPence(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/[£,\s]/g, "");
  if (s === "" || !/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const pence = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(pence) || pence < 0) return null;
  return pence;
}

// 1234550 pence -> "12,345.50". No currency symbol; the UI adds the £.
export function formatPence(pence) {
  const n = Math.round(Number(pence) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const pounds = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${pounds}.${String(abs % 100).padStart(2, "0")}`;
}
