// Shared helpers for the SDS EZY Worker: JSON responses, crypto, sessions, cookies, settings, dates.
// Exports (stable, other modules rely on them):
//   json(data, status, headers), b64url(bytes), b64urlToBytes(str), hashPassword(pw), verifyPassword(pw, stored),
//   hmacKey(secret), makeSession(payload, secret), readSession(token, secret), getCookie(request, name),
//   setCookieHeader(name, value, maxAgeSeconds), sessionSecret(env), loadSettings(env), saveSetting(env, key, value),
//   todayIso(), addYearsIso(iso, n), daysBetweenIso(a, b), escapeHtml(s), sameString(a, b), READ_ONLY_MESSAGE,
//   encryptSecret(env, plain), decryptSecret(env, blob)

export const READ_ONLY_MESSAGE = "This is a read-only demo. Changes are not saved.";

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export function b64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(str) {
  str = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- password hashing (PBKDF2 via Web Crypto, no dependencies) ----------

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return `${iterations}:${b64url(salt)}:${b64url(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [iterStr, saltB64, hashB64] = String(stored || "").split(":");
  const iterations = parseInt(iterStr, 10);
  if (!iterations || !saltB64 || !hashB64) return false;
  const salt = b64urlToBytes(saltB64);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return sameString(b64url(bits), hashB64);
}

// ---------- signed session cookie (HMAC-SHA256) ----------

export async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function makeSession(payload, secret) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function readSession(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), new TextEncoder().encode(body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

export function setCookieHeader(name, value, maxAgeSeconds) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join("; ");
}

// The key that signs sessions and login codes. SESSION_SECRET if set; otherwise a random key generated on first
// use and kept in the settings table (one row read). Never returned by any endpoint.
let generatedSecret = null;
export async function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (generatedSecret) return generatedSecret;
  let row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'session_secret'").first();
  if (!row) {
    const fresh = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?)").bind(fresh).run();
    row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'session_secret'").first();
  }
  generatedSecret = row.value;
  return generatedSecret;
}

// ---------- settings ----------

export async function loadSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const r of results) out[r.key] = r.value;
  return out;
}

export async function saveSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

// ---------- AES-GCM for the stored AI key (key derived from the session secret with HKDF/SHA-256) ----------

async function aesKey(env) {
  const secret = await sessionSecret(env);
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("sds-ezy-settings-v1"), info: new TextEncoder().encode("ai-key") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

export async function encryptSecret(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(String(plain))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64url(out);
}

// Returns the plain text, or null if the blob is missing or cannot be decrypted (for example the session secret changed).
export async function decryptSecret(env, blob) {
  if (!blob) return null;
  try {
    const bytes = b64urlToBytes(blob);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await aesKey(env), bytes.slice(12));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// ---------- small helpers ----------

export function sameString(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ---------- dates (YYYY-MM-DD text) ----------

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Same month and day n years later; 29 Feb becomes 28 Feb when the target year is not a leap year.
export function addYearsIso(iso, n) {
  const y = parseInt(iso.slice(0, 4), 10) + n;
  const m = iso.slice(5, 7);
  let d = iso.slice(8, 10);
  if (m === "02" && d === "29") {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (!leap) d = "28";
  }
  return `${String(y).padStart(4, "0")}-${m}-${d}`;
}

// Whole days from a to b (positive when b is later).
export function daysBetweenIso(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
