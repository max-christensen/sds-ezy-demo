// The label photo kept with a chemical, only when an admin saves a chemical they added "from a label photo". One photo per chemical,
// in R2 under chemicals/<id>/, shown on the chemical page. Reading the photo (label.js) never stores it.
import { json } from "./lib.js";
import { ApiError, bad, cleanId } from "./register.js";

const MAX_BYTES = 3 * 1024 * 1024;
export const labelPhotoKey = (chemicalId) => `chemicals/${chemicalId}/label-${crypto.randomUUID()}.jpg`;

export async function handleUploadLabelPhoto(c) {
  const { env, user } = c;
  const id = cleanId(c.p[0], "Chemical");
  const chem = await env.DB.prepare("SELECT id FROM chemicals WHERE id = ?").bind(id).first();
  if (!chem) throw new ApiError(404, "Chemical not found");
  let form;
  try { form = await c.request.formData(); } catch { throw bad("The photo could not be read from the upload"); }
  const file = form.get("image");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") throw bad("No photo was received");
  if (file.size > MAX_BYTES) throw new ApiError(413, "That photo is too large (3 MB at most)");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new ApiError(413, "That photo is too large (3 MB at most)");
  if (!(bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw bad("Only a JPEG photo can be kept");

  const old = await env.DB.prepare("SELECT r2_key FROM chemical_label_photos WHERE chemical_id = ?").bind(id).first();
  const key = labelPhotoKey(id);
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  try {
    await env.DB.prepare(
      "INSERT INTO chemical_label_photos (chemical_id, r2_key, bytes, uploaded_by) VALUES (?, ?, ?, ?) ON CONFLICT(chemical_id) DO UPDATE SET r2_key = excluded.r2_key, bytes = excluded.bytes, uploaded_by = excluded.uploaded_by, created_at = datetime('now')"
    ).bind(id, key, bytes.length, user.id).run();
  } catch (e) {
    await env.FILES.delete(key).catch(() => {});
    throw e;
  }
  if (old && old.r2_key) await env.FILES.delete(old.r2_key).catch(() => {});
  return json({ ok: true, bytes: bytes.length }, 201);
}

export async function handleGetLabelPhoto(c) {
  const id = cleanId(c.p[0], "Chemical");
  const row = await c.env.DB.prepare("SELECT r2_key FROM chemical_label_photos WHERE chemical_id = ?").bind(id).first();
  const obj = row ? await c.env.FILES.get(row.r2_key) : null;
  if (!obj) throw new ApiError(404, "No label photo");
  return new Response(obj.body, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...(obj.size !== undefined ? { "Content-Length": String(obj.size) } : {}) },
  });
}

/** Deletes the stored photo objects for a chemical (call before its row is removed). */
export async function deleteLabelPhotos(env, chemicalId) {
  const rows = await env.DB.prepare("SELECT r2_key FROM chemical_label_photos WHERE chemical_id = ?").bind(chemicalId).all();
  const keys = (rows.results || []).map((r) => r.r2_key);
  if (keys.length) await env.FILES.delete(keys).catch(() => {});
}
