// SDS EZY API worker. /api/* is handled here; everything else is served from /public via the ASSETS binding.
//
// ONE role table (ROUTES below). Deny by default:
//   * a GET needs a logged-in user unless the entry says "public" or "admin";
//   * any non-GET is admin-only unless it is on USER_WRITES (the two upload endpoints) or PUBLIC_WRITES (login, setup, logout).
// DEMO_MODE=1 blocks every non-GET except login / login/verify / logout, for everyone.

import { json, READ_ONLY_MESSAGE } from "./lib.js";
import { ApiError } from "./register.js";
import * as Auth from "./auth.js";
import * as Settings from "./settings.js";
import * as Reg from "./register.js";
import * as Sds from "./sds.js";
import * as Assess from "./assessments.js";
import * as Places from "./places.js";
import * as Audits from "./audits.js";
import { handleImport } from "./import.js";
import { handlePrecheck, handleUpload } from "./upload.js";
import { handleGetAiSettings, handlePutAiSettings, handleTestAi } from "./ai.js";
import { handleTestVision } from "./label.js";
import { ensureSchema } from "./schema.js";

const ID = "(\\d+)";
const USER_WRITES = new Set([
  "POST /api/uploads", "POST /api/uploads/precheck",
  // Audit records and photos: a user acts on audits they started (checked in audits.js), an admin on any.
  "POST /api/audits", `PUT /api/audits/${ID}/items/${ID}`, `POST /api/audits/${ID}/finish`, `POST /api/audits/${ID}/found/read-label`,
  `POST /api/audits/${ID}/found/match`, `POST /api/audits/${ID}/found`, `POST /api/audits/${ID}/disposals`, `POST /api/audits/${ID}/photos`,
]);
const PUBLIC_WRITES = new Set(["POST /api/setup", "POST /api/login", "POST /api/login/verify", "POST /api/logout"]);
const DEMO_ALLOWED_WRITES = new Set(["POST /api/login", "POST /api/login/verify", "POST /api/logout"]);

// [method, path regex, access, handler(ctx)]   access: "public" | "user" | "admin" (writes default to admin)
const ROUTES = [
  ["POST", "/api/setup", "public", Auth.handleSetup],
  ["POST", "/api/login", "public", Auth.handleLogin],
  ["POST", "/api/login/verify", "public", Auth.handleVerifyCode],
  ["POST", "/api/logout", "public", () => Auth.handleLogout()],
  ["GET", "/api/public-settings", "public", Auth.handlePublicSettings],
  ["GET", "/api/logo", "public", Settings.handleGetLogo],
  ["GET", "/api/me", "user", Auth.handleMe],

  ["GET", "/api/settings", "user", Settings.handleGetSettings],
  ["PUT", "/api/settings", "admin", Settings.handleUpdateSettings],
  ["POST", "/api/settings/logo", "admin", Settings.handleUploadLogo],
  ["DELETE", "/api/settings/logo", "admin", Settings.handleDeleteLogo],
  ["GET", "/api/settings/ai", "admin", (c) => handleGetAiSettings(c.env)],
  ["PUT", "/api/settings/ai", "admin", (c) => handlePutAiSettings(c.request, c.env)],
  ["POST", "/api/settings/ai/test", "admin", (c) => handleTestAi(c.env)],
  ["POST", "/api/settings/ai/test-vision", "admin", (c) => handleTestVision(c.env)],

  ["GET", "/api/users", "admin", Settings.handleListUsers],
  ["POST", "/api/users", "admin", Settings.handleCreateUser],
  ["PUT", `/api/users/${ID}`, "admin", Settings.handleUpdateUser],

  ["GET", "/api/review", "user", Reg.handleReview],
  ["GET", "/api/chemicals", "user", Reg.handleListChemicals],
  ["POST", "/api/chemicals", "admin", Reg.handleCreateChemical],
  ["GET", `/api/chemicals/${ID}`, "user", Reg.handleGetChemical],
  ["PUT", `/api/chemicals/${ID}`, "admin", Reg.handleUpdateChemical],
  ["DELETE", `/api/chemicals/${ID}`, "admin", Reg.handleDeleteChemical],
  ["GET", `/api/chemicals/${ID}/history`, "user", Reg.handleHistory],
  ["POST", `/api/chemicals/${ID}/link-sds`, "admin", Sds.handleLinkSds],
  ["POST", `/api/chemicals/${ID}/unlink-sds`, "admin", Sds.handleUnlinkSds],
  ["POST", `/api/chemicals/${ID}/assessments`, "admin", Assess.handleCreateAssessment],
  ["GET", "/api/manifest", "user", Places.handleManifest],
  ["POST", "/api/audits", "user", Audits.handleStartAudit],
  ["GET", "/api/audits", "user", Audits.handleListAudits],
  ["GET", `/api/audits/${ID}`, "user", Audits.handleGetAudit],
  ["PUT", `/api/audits/${ID}/items/${ID}`, "user", Audits.handleMarkItem],
  ["POST", `/api/audits/${ID}/finish`, "user", Audits.handleFinishAudit],
  ["POST", `/api/audits/${ID}/found/read-label`, "user", Audits.handleReadLabelRoute],
  ["POST", `/api/audits/${ID}/found/match`, "user", Audits.handleFoundMatch],
  ["POST", `/api/audits/${ID}/found`, "user", Audits.handleAddFound],
  ["POST", `/api/audits/${ID}/disposals`, "user", Audits.handleAddDisposal],
  ["POST", `/api/audits/${ID}/photos`, "user", Audits.handleUploadPhoto],
  ["GET", `/api/audit-photos/${ID}`, "user", Audits.handleGetPhoto],
  ["GET", "/api/disposals", "admin", Audits.handleListDisposals],
  ["PUT", `/api/disposals/${ID}/close`, "admin", Audits.handleCloseDisposal],
  ["GET", "/api/findings", "admin", Audits.handleListFindings],
  ["POST", `/api/findings/${ID}/accept`, "admin", Audits.handleAcceptFinding],
  ["POST", `/api/findings/${ID}/dismiss`, "admin", Audits.handleDismissFinding],
  ["GET", "/api/pack", "user", Places.handlePack],
  ["GET", "/api/places", "user", Places.handleListPlaces],
  ["POST", "/api/places", "admin", Places.handleCreatePlace],
  ["GET", `/api/places/${ID}`, "user", Places.handleGetPlace],
  ["PUT", `/api/places/${ID}`, "admin", Places.handleUpdatePlace],
  ["POST", `/api/places/${ID}/chemicals`, "admin", Places.handleAddChemicalToPlace],
  ["POST", `/api/chemicals/${ID}/places`, "admin", Places.handleAddPlaceToChemical],
  ["PUT", `/api/chemical-places/${ID}`, "admin", Places.handleUpdateLink],
  ["DELETE", `/api/chemical-places/${ID}`, "admin", Places.handleDeleteLink],
  ["GET", "/api/export/all", "user", Reg.handleExportAll],

  ["GET", "/api/options", "user", Reg.handleListOptions],
  ["POST", "/api/options", "admin", Reg.handleCreateOption],
  ["PUT", `/api/options/${ID}`, "admin", Reg.handleUpdateOption],
  ["DELETE", `/api/options/${ID}`, "admin", Reg.handleDeleteOption],

  ["GET", `/api/sds/${ID}`, "user", Sds.handleGetSds],
  ["GET", `/api/sds/${ID}/file`, "user", Sds.handleSdsFile],
  ["GET", `/api/sds/${ID}/chemicals`, "user", Sds.handleSdsChemicals],
  ["POST", "/api/sds", "admin", Sds.handleCreateSds],
  ["PUT", `/api/sds/${ID}`, "admin", Sds.handleUpdateSds],
  ["POST", `/api/sds/${ID}/replace`, "admin", Sds.handleReplaceSds],
  ["DELETE", `/api/sds/${ID}`, "admin", Sds.handleDeleteSds],

  ["GET", `/api/assessments/${ID}`, "user", Assess.handleGetAssessment],
  ["PUT", `/api/assessments/${ID}`, "admin", Assess.handleUpdateAssessment],
  ["DELETE", `/api/assessments/${ID}`, "admin", Assess.handleDeleteAssessment],

  ["POST", "/api/import", "admin", handleImport],

  ["POST", "/api/uploads/precheck", "user", (c) => handlePrecheck(c.request, c.env, c.user)],
  ["POST", "/api/uploads", "user", (c) => handleUpload(c.request, c.env, c.user)],
].map(([m, p, access, h]) => ({ m, re: new RegExp(`^${p}$`), access, h, key: `${m} ${p}` }));

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Debug only (DEBUG_ROWS=1): sums meta.rows_read for every D1 call in a request and reports it in X-Rows-Read.
function instrumentDb(db, counter) {
  const wrap = (stmt) => ({
    __raw: stmt,
    bind: (...a) => wrap(stmt.bind(...a)),
    all: async () => { const r = await stmt.all(); counter.n += (r.meta && r.meta.rows_read) || 0; return r; },
    run: async () => { const r = await stmt.run(); counter.n += (r.meta && r.meta.rows_read) || 0; return r; },
    first: async (col) => {
      const r = await stmt.all(); counter.n += (r.meta && r.meta.rows_read) || 0;
      const row = r.results[0] ?? null;
      return col && row ? row[col] : row;
    },
    raw: (o) => stmt.raw(o),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    batch: async (list) => {
      const res = await db.batch(list.map(s => s.__raw || s));
      for (const r of res) counter.n += (r.meta && r.meta.rows_read) || 0;
      return res;
    },
    exec: (sql) => db.exec(sql),
  };
}

function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try { return new URL(origin).host === url.host; } catch { return false; }
}

export default {
  async fetch(request, rawEnv) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return rawEnv.ASSETS.fetch(request);

    try { await ensureSchema(rawEnv); }
    catch (e) { console.error("schema setup failed", e); return json({ error: "The database could not be set up. Check that the D1 database is attached to this Worker, then reload." }, 500); }

    const counter = { n: 0 };
    const debug = rawEnv.DEBUG_ROWS === "1";
    const env = debug ? { ...rawEnv, DB: instrumentDb(rawEnv.DB, counter) } : rawEnv;
    const res = await handle(request, env, url);
    if (debug) {
      const h = new Headers(res.headers);
      h.set("X-Rows-Read", String(counter.n));
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },
};

async function handle(request, env, url) {
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    const isWrite = WRITE_METHODS.has(method);
    if (!isWrite && method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST, PUT, DELETE" });

    // Demo mode: read-only for everyone, before anything else.
    if (isWrite && env.DEMO_MODE === "1" && !DEMO_ALLOWED_WRITES.has(`${method} ${path}`)) {
      return json({ error: READ_ONLY_MESSAGE, demo: true }, 403);
    }
    if (isWrite && !sameOrigin(request, url)) return json({ error: "Cross-site request refused" }, 403);

    let route = null, params = null;
    for (const r of ROUTES) {
      if (r.m !== method) continue;
      const m = path.match(r.re);
      if (m) { route = r; params = m.slice(1); break; }
    }
    if (!route) {
      // Deny by default: an unknown write is admin-only before it is "not found".
      if (isWrite) {
        const u = await Auth.authenticate(request, env);
        if (!u) return json({ error: "Not logged in" }, 401);
        if (u.role !== "admin") return json({ error: "Only an administrator can do that." }, 403);
      }
      return json({ error: "Not found" }, 404);
    }

    // Effective access, deny by default.
    let access = route.access;
    if (isWrite) {
      if (access === "public" && !PUBLIC_WRITES.has(route.key)) access = "admin";
      if (access === "user" && !USER_WRITES.has(route.key)) access = "admin";
    }

    const ctx = { request, env, url, p: params, user: null };
    if (access !== "public") {
      const user = await Auth.authenticate(request, env);
      if (!user) return json({ error: "Not logged in" }, 401);
      if (access === "admin" && user.role !== "admin") return json({ error: "Only an administrator can do that." }, 403);
      ctx.user = user;
    }
    return await route.h(ctx);
  } catch (err) {
    if (err instanceof ApiError || (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 && err.expose !== false && err.name === "ApiError")) {
      return json({ error: err.message }, err.status);
    }
    const id = crypto.randomUUID().slice(0, 8);
    console.error(`[${id}] ${request.method} ${url.pathname}:`, err && err.stack ? err.stack : err);
    return json({ error: "Something went wrong on the server.", request_id: id }, 500);
  }
}
