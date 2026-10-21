// Company settings, branding/logo, users.
import { json, loadSettings, saveSetting, hashPassword } from "./lib.js";
import { ApiError, bad, readJson, cleanStr, cleanEnum, cleanId } from "./register.js";
import { DEFAULT_MAIN, DEFAULT_ACCENT } from "./auth.js";

const COMPANY_FIELDS = ["company_name", "company_address", "company_phone", "company_email", "company_reg"];
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(x => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export async function handleGetSettings(c) {
  const { env } = c;
  const s = await loadSettings(env);
  const out = {
    has_logo: !!s.logo_key, logo_version: s.logo_version || "", setup_complete: s.setup_complete === "1",
    main_color: s.main_color || DEFAULT_MAIN, accent_color: s.accent_color || DEFAULT_ACCENT,
    twofa_enabled: s.twofa_enabled !== "0", resend_configured: !!env.RESEND_API_KEY,
    upload_max_mb: Math.min(25, Number(s.upload_max_mb) || 15),
    upload_rate_per_hour: Number(s.upload_rate_per_hour) || 10,
    audit_reminder_days: Number(s.audit_reminder_days) || 90,
    audit_photo_max_mb: Number(s.audit_photo_max_mb) || 2,
    audit_max_photos: Number(s.audit_max_photos) || 50,
    audit_max_total_mb: Number(s.audit_max_total_mb) || 40,
    label_read_rate_per_hour: Number(s.label_read_rate_per_hour) || 30,
  };
  for (const k of COMPANY_FIELDS) out[k] = s[k] || "";
  return json(out);
}

export async function handleUpdateSettings(c) {
  const b = await readJson(c.request);
  const writes = [];
  for (const k of COMPANY_FIELDS) {
    if (b[k] !== undefined) writes.push([k, cleanStr(b[k], 300, k.replace("company_", "Company ")) || ""]);
  }
  for (const k of ["main_color", "accent_color"]) {
    if (b[k] !== undefined) {
      if (typeof b[k] !== "string" || !/^#[0-9a-fA-F]{6}$/.test(b[k])) throw bad("Colours must look like #1F2A24");
      writes.push([k, b[k].toUpperCase()]);
    }
  }
  if (b.accent_color !== undefined && contrastRatio(b.accent_color, "#FFFFFF") < 4.5) {
    throw bad("That accent colour is too light to read on white. Pick a darker one.");
  }
  if (b.twofa_enabled !== undefined) writes.push(["twofa_enabled", b.twofa_enabled ? "1" : "0"]);
  if (b.setup_complete) writes.push(["setup_complete", "1"]);
  if (b.upload_max_mb !== undefined) {
    const n = Number(b.upload_max_mb);
    if (!Number.isInteger(n) || n < 1 || n > 25) throw bad("The upload size limit must be a whole number from 1 to 25 MB");
    writes.push(["upload_max_mb", String(n)]);
  }
  if (b.upload_rate_per_hour !== undefined) {
    const n = Number(b.upload_rate_per_hour);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw bad("Uploads per hour must be a whole number from 1 to 1000");
    writes.push(["upload_rate_per_hour", String(n)]);
  }
  const range = (key, label, lo, hi, whole) => {
    if (b[key] === undefined) return;
    const n = Number(b[key]);
    if (b[key] === "" || b[key] === null || !Number.isFinite(n) || n < lo || n > hi || (whole && !Number.isInteger(n))) {
      throw bad(`${label} must be ${whole ? "a whole number" : "a number"} from ${lo} to ${hi}`);
    }
    writes.push([key, String(n)]);
  };
  range("audit_reminder_days", "Audit reminder days", 1, 730, true);
  range("audit_photo_max_mb", "Audit photo size (MB)", 0.2, 8, false);
  range("audit_max_photos", "Photos per audit", 1, 200, true);
  range("audit_max_total_mb", "Photo storage per audit (MB)", 5, 200, false);
  range("label_read_rate_per_hour", "Label reads per hour", 1, 200, true);
  if (!writes.length) throw bad("Nothing to update");
  for (const [k, v] of writes) await saveSetting(c.env, k, v);
  return json({ ok: true });
}

export async function handleUploadLogo(c) {
  const { env } = c;
  let form;
  try { form = await c.request.formData(); } catch { throw bad("Expected a multipart form"); }
  const file = form.get("file");
  if (!file || typeof file === "string") throw bad("No file received");
  if (!LOGO_TYPES.includes(file.type)) throw bad("The logo must be a PNG, JPG, WebP, GIF or SVG image");
  if (file.size > LOGO_MAX_BYTES) throw new ApiError(413, "The logo is too large (2 MB max)");
  await env.FILES.put("branding/logo", await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('logo_key', 'branding/logo') ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('logo_type', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(file.type),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('logo_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(Date.now())),
  ]);
  return json({ ok: true });
}

export async function handleDeleteLogo(c) {
  await c.env.FILES.delete("branding/logo");
  await c.env.DB.prepare("DELETE FROM settings WHERE key IN ('logo_key', 'logo_type', 'logo_version')").run();
  return json({ ok: true });
}

export async function handleGetLogo(c) {
  const { env } = c;
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('logo_key', 'logo_type')").all();
  const s = Object.fromEntries(results.map(r => [r.key, r.value]));
  if (!s.logo_key) throw new ApiError(404, "No logo");
  const obj = await env.FILES.get(s.logo_key);
  if (!obj) throw new ApiError(404, "No logo");
  return new Response(obj.body, {
    headers: {
      "Content-Type": LOGO_TYPES.includes(s.logo_type) ? s.logo_type : "image/png",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

// ---------------------------------------------------------------- users

export async function handleListUsers(c) {
  const { results } = await c.env.DB.prepare("SELECT id, name, email, role, color, active, created_at FROM users ORDER BY name COLLATE NOCASE, id").all();
  return json(results);
}

function validEmail(e) { return e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function cleanColor(v) {
  if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) throw bad("Colour must look like #3B6E71");
  return v.toUpperCase();
}
function cleanPassword(v) {
  if (typeof v !== "string" || v.length < 8 || v.length > 200) throw bad("The password must be 8 to 200 characters");
  return v;
}

export async function handleCreateUser(c) {
  const b = await readJson(c.request);
  const name = cleanStr(b.name, 100, "Name", { required: true });
  const email = cleanStr(b.email, 200, "Email", { required: true }).toLowerCase();
  if (!validEmail(email)) throw bad("Enter a valid email address");
  const password = cleanPassword(b.password);
  const role = cleanEnum(b.role, ["admin", "user"], "Role") || "user";
  const color = b.color !== undefined ? cleanColor(b.color) : "#3B6E71";
  try {
    const r = await c.env.DB.prepare("INSERT INTO users (name, email, password_hash, role, color) VALUES (?, ?, ?, ?, ?)")
      .bind(name, email, await hashPassword(password), role, color).run();
    return json({ id: r.meta.last_row_id }, 201);
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw bad("That email is already in use");
    throw e;
  }
}

export async function handleUpdateUser(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "User");
  const b = await readJson(c.request);
  const target = await env.DB.prepare("SELECT id, role, active FROM users WHERE id = ?").bind(id).first();
  if (!target) throw new ApiError(404, "User not found");
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push("name = ?"); vals.push(cleanStr(b.name, 100, "Name", { required: true })); }
  if (b.email !== undefined) {
    const e = cleanStr(b.email, 200, "Email", { required: true }).toLowerCase();
    if (!validEmail(e)) throw bad("Enter a valid email address");
    sets.push("email = ?"); vals.push(e);
  }
  let newRole = target.role, newActive = target.active;
  if (b.role !== undefined) {
    newRole = cleanEnum(b.role, ["admin", "user"], "Role");
    if (!newRole) throw bad("Role is required");
    sets.push("role = ?"); vals.push(newRole);
  }
  if (b.color !== undefined) { sets.push("color = ?"); vals.push(cleanColor(b.color)); }
  if (b.active !== undefined) { newActive = b.active ? 1 : 0; sets.push("active = ?"); vals.push(newActive); }
  if (b.password) { sets.push("password_hash = ?"); vals.push(await hashPassword(cleanPassword(b.password))); }
  if (!sets.length) throw bad("Nothing to update");
  // The last active administrator cannot be demoted or deactivated.
  if (target.role === "admin" && target.active && (newRole !== "admin" || !newActive)) {
    const other = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND id != ? LIMIT 1").bind(id).first();
    if (!other) throw new ApiError(409, "There must be at least one active administrator.");
  }
  try {
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw bad("That email is already in use");
    throw e;
  }
  return json({ ok: true });
}
