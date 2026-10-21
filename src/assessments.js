// Assessments: get, create (becomes current), update, delete.
import { json } from "./lib.js";
import {
  ApiError, bad, readJson, cleanId, cleanAssessment, cleanOptionIds, assertOptionsExist, createAssessment, summaryStatements,
} from "./register.js";

const COLS = `id, chemical_id, sds_id, is_current, assessed_date, sds_date, form, use_description, route_inhalation, route_ingestion,
  route_absorption, fire_response, spill_response, controls_notes, ppe_notes, risk_level, monitoring_needed, monitoring_note,
  surveillance_needed, surveillance_note, assessed_by, source, unverified, created_at, updated_at`;

export async function handleGetAssessment(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Assessment");
  const a = await env.DB.prepare(`SELECT ${COLS} FROM assessments WHERE id = ?`).bind(id).first();
  if (!a) throw new ApiError(404, "Assessment not found");
  const ctl = await env.DB.prepare(
    "SELECT o.id, o.kind, o.label FROM assessment_controls ac JOIN control_options o ON o.id = ac.option_id WHERE ac.assessment_id = ? ORDER BY o.kind, o.sort_order, o.id"
  ).bind(id).all();
  a.controls = ctl.results;
  return json(a);
}

export async function handleCreateAssessment(c) {
  const chemId = cleanId(c.p[0], "Chemical");
  const body = await readJson(c.request);
  const fields = { ...body };
  // Only the upload pipeline may set these.
  delete fields.source; delete fields.answers; delete fields.unverified; delete fields.sds_id;
  fields.source = "manual";
  const id = await createAssessment(c.env, chemId, fields, body.control_option_ids, c.user.id);
  return json({ id }, 201);
}

export async function handleUpdateAssessment(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Assessment");
  const body = await readJson(c.request);
  const row = await env.DB.prepare("SELECT id, chemical_id FROM assessments WHERE id = ?").bind(id).first();
  if (!row) throw new ApiError(404, "Assessment not found");
  const f = cleanAssessment(body);
  const ids = cleanOptionIds(body.control_option_ids);
  const keys = Object.keys(f);
  if (!keys.length && ids === undefined) throw bad("Nothing to update");
  if (ids) await assertOptionsExist(env, ids);
  const stmts = [];
  stmts.push(env.DB.prepare(
    `UPDATE assessments SET ${[...keys.map(k => `${k} = ?`), "source = CASE WHEN source IN ('ai','blank') THEN 'manual' ELSE source END", "updated_at = datetime('now')"].join(", ")} WHERE id = ?`
  ).bind(...keys.map(k => f[k]), id));
  if (ids !== undefined) {
    stmts.push(env.DB.prepare("DELETE FROM assessment_controls WHERE assessment_id = ?").bind(id));
    if (ids.length) {
      stmts.push(env.DB.prepare(
        `INSERT INTO assessment_controls (assessment_id, option_id) SELECT ?, id FROM control_options WHERE id IN (${ids.map(() => "?").join(",")})`
      ).bind(id, ...ids));
    }
  }
  stmts.push(...summaryStatements(env, { chemicalId: row.chemical_id }));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

export async function handleDeleteAssessment(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Assessment");
  const row = await env.DB.prepare("SELECT id, chemical_id, is_current FROM assessments WHERE id = ?").bind(id).first();
  if (!row) throw new ApiError(404, "Assessment not found");
  const stmts = [
    env.DB.prepare("DELETE FROM assessment_controls WHERE assessment_id = ?").bind(id),
    env.DB.prepare("DELETE FROM assessments WHERE id = ?").bind(id),
  ];
  if (row.is_current) {
    // The newest remaining assessment (if any) takes over as current.
    stmts.push(env.DB.prepare(
      "UPDATE assessments SET is_current = 1 WHERE id = (SELECT id FROM assessments WHERE chemical_id = ? ORDER BY id DESC LIMIT 1)"
    ).bind(row.chemical_id));
  }
  stmts.push(...summaryStatements(env, { chemicalId: row.chemical_id }));
  await env.DB.batch(stmts);
  return json({ ok: true });
}
