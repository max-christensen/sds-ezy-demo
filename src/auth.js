// Setup, login, two-factor code, logout, current session user, public settings.
import {
  json, b64url, hashPassword, verifyPassword, hmacKey, makeSession, readSession, getCookie, setCookieHeader,
  sessionSecret, loadSettings, sameString, escapeHtml,
} from "./lib.js";
import { ApiError, bad, readJson, cleanStr } from "./register.js";

export const COOKIE_NAME = "session";
const SESSION_HOURS = 24 * 30;
const CODE_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_MAX_PER_WINDOW = 5;
export const DEFAULT_MAIN = "#1F2A24";
export const DEFAULT_ACCENT = "#3B6E71";
// A real-looking hash so a login for an unknown email costs the same time as a wrong password.
const DUMMY_HASH = "100000:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export async function authenticate(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;
  const payload = await readSession(token, await sessionSecret(env));
  if (!payload || payload.kind || !payload.uid) return null;
  const user = await env.DB.prepare("SELECT id, name, email, role, color, active FROM users WHERE id = ? AND active = 1").bind(payload.uid).first();
  return user || null;
}

function validEmail(e) {
  return typeof e === "string" && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export async function handleSetup(c) {
  const { env } = c;
  const body = await readJson(c.request);
  if (env.SETUP_KEY && !(typeof body.setup_key === "string" && sameString(body.setup_key, env.SETUP_KEY))) {
    throw new ApiError(403, "Invalid setup key");
  }
  const name = cleanStr(body.name, 100, "Name", { required: true });
  const email = cleanStr(body.email, 200, "Email", { required: true }).toLowerCase();
  if (!validEmail(email)) throw bad("Enter a valid email address");
  if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 200) throw bad("The password must be 8 to 200 characters");
  const existing = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first();
  if (existing) throw new ApiError(403, "An administrator already exists. Setup is one-time only.");
  const hash = await hashPassword(body.password);
  const r = await env.DB.prepare(
    `INSERT INTO users (name, email, password_hash, role, color)
     SELECT ?, ?, ?, 'admin', '#1F2A24' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`
  ).bind(name, email, hash).run().catch(e => {
    if (/UNIQUE/i.test(String(e.message))) throw bad("That email is already in use");
    throw e;
  });
  if (!r.meta.changes) throw new ApiError(403, "An administrator already exists. Setup is one-time only.");
  return json({ ok: true }, 201);
}

function twoFactorOn(env, settings) {
  return !!env.RESEND_API_KEY && settings.twofa_enabled !== "0";
}

async function hashCode(env, userId, code) {
  const key = await hmacKey(await sessionSecret(env));
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`login-code:${userId}:${code}`)));
}

function randomCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
}

async function sendLoginCode(env, toEmail, code, company) {
  const res = await fetch(env.RESEND_API_URL || "https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM || "SDS EZY <onboarding@resend.dev>",
      to: [toEmail],
      subject: `Your ${company} login code: ${code}`,
      text: `Your ${company} login code is ${code}. It is valid for ${CODE_MINUTES} minutes. If you did not try to log in, you can ignore this email.`,
      html: `<p>Your <strong>${escapeHtml(company)}</strong> login code is:</p>` +
        `<p style="font-size:28px; letter-spacing:6px; font-weight:bold;">${code}</p>` +
        `<p>It is valid for ${CODE_MINUTES} minutes. If you did not try to log in, you can ignore this email.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}`);
}

async function startSession(user, env) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const token = await makeSession({ uid: user.id, exp }, await sessionSecret(env));
  return json(
    { id: user.id, name: user.name, email: user.email, role: user.role, color: user.color },
    200,
    { "Set-Cookie": setCookieHeader(COOKIE_NAME, token, SESSION_HOURS * 3600) }
  );
}

function isDemoEmail(env, email) {
  const e = String(email || "").toLowerCase();
  return !!e && [env.DEMO_ADMIN_EMAIL, env.DEMO_USER_EMAIL].some(d => d && d.toLowerCase() === e);
}

export async function handleLogin(c) {
  const { env } = c;
  const body = await readJson(c.request);
  if (typeof body.email !== "string" || typeof body.password !== "string" || !body.email || !body.password) throw bad("Email and password are required");
  if (body.password.length > 200 || body.email.length > 200) throw new ApiError(401, "Invalid email or password");
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND active = 1").bind(body.email.trim().toLowerCase()).first();
  if (!user) {
    await verifyPassword(body.password, DUMMY_HASH);
    throw new ApiError(401, "Invalid email or password");
  }
  if (!(await verifyPassword(body.password, user.password_hash))) throw new ApiError(401, "Invalid email or password");

  if (isDemoEmail(env, user.email)) return startSession(user, env);
  const settings = await loadSettings(env);
  if (!twoFactorOn(env, settings)) return startSession(user, env);

  await env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(new Date().toISOString()).run();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ? AND created_at > ?")
    .bind(user.id, new Date(Date.now() - CODE_MINUTES * 60000).toISOString()).first();
  if (recent.n >= CODE_MAX_PER_WINDOW) throw new ApiError(429, "Too many codes requested. Wait a few minutes and try again.");
  const code = randomCode();
  const created = new Date();
  const ins = await env.DB.prepare("INSERT INTO login_codes (user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, await hashCode(env, user.id, code), new Date(created.getTime() + CODE_MINUTES * 60000).toISOString(), created.toISOString()).run();
  try {
    await sendLoginCode(env, user.email, code, settings.company_name || "SDS EZY");
  } catch {
    await env.DB.prepare("DELETE FROM login_codes WHERE id = ?").bind(ins.meta.last_row_id).run();
    throw new ApiError(502, "Could not send the login code email. Ask your administrator to check the Resend setup.");
  }
  const challenge = await makeSession({ uid: user.id, kind: "2fa", exp: Date.now() + CODE_MINUTES * 60000 }, await sessionSecret(env));
  const [local, domain] = user.email.split("@");
  return json({ needs_code: true, challenge, sent_to: `${local.slice(0, 2)}***@${domain}` });
}

export async function handleVerifyCode(c) {
  const { env } = c;
  const body = await readJson(c.request);
  const payload = await readSession(body.challenge, await sessionSecret(env));
  if (!payload || payload.kind !== "2fa") throw new ApiError(401, "That login attempt has expired. Please log in again.");
  const row = await env.DB.prepare("SELECT * FROM login_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(payload.uid).first();
  if (!row || row.expires_at < new Date().toISOString()) throw new ApiError(401, "That code has expired. Please log in again to get a new one.");
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await env.DB.prepare("DELETE FROM login_codes WHERE user_id = ?").bind(payload.uid).run();
    throw new ApiError(429, "Too many wrong codes. Please log in again to get a new one.");
  }
  const given = String(body.code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given) || !sameString(await hashCode(env, payload.uid, given), row.code_hash)) {
    await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    throw new ApiError(401, "That code isn't right.");
  }
  await env.DB.prepare("DELETE FROM login_codes WHERE user_id = ?").bind(payload.uid).run();
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND active = 1").bind(payload.uid).first();
  if (!user) throw new ApiError(401, "Account not available");
  return startSession(user, env);
}

export function handleLogout() {
  return json({ ok: true }, 200, { "Set-Cookie": setCookieHeader(COOKIE_NAME, "", 0) });
}

export function handleMe(c) {
  const u = c.user;
  return json({ id: u.id, name: u.name, email: u.email, role: u.role, color: u.color });
}

export async function handlePublicSettings(c) {
  const { env } = c;
  const [s, admin] = await Promise.all([
    loadSettings(env),
    env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first(),
  ]);
  const out = {
    company_name: s.company_name || "",
    has_logo: !!s.logo_key,
    logo_version: s.logo_version || "",
    main_color: s.main_color || DEFAULT_MAIN,
    accent_color: s.accent_color || DEFAULT_ACCENT,
    needs_setup: !admin,
    setup_key_required: !!env.SETUP_KEY,
  };
  if (env.DEMO_MODE === "1") {
    out.demo = true;
    out.demo_logins = [
      env.DEMO_ADMIN_EMAIL ? { email: env.DEMO_ADMIN_EMAIL.toLowerCase(), role: "admin", label: "Administrator" } : null,
      env.DEMO_USER_EMAIL ? { email: env.DEMO_USER_EMAIL.toLowerCase(), role: "user", label: "User" } : null,
    ].filter(Boolean);
  }
  return json(out);
}
