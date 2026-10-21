// Audit model: pure helpers shared by the audit screens (no DOM, no network). Node-testable.
// Ordering of the run screen, progress, photo size maths, which "taken at" time to trust, and the plain-words wording.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).auditModel = m;
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_SIDE = 1600;          // longest side of a photo after compression, in pixels
  const JPEG_QUALITY = 0.7;
  const MAX_PHOTOS_PER_OWNER = 3; // server cap, mirrored so the camera button can switch off
  const TAKEN_AT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

  const RESULTS = ["present", "not_found", "changed"];
  const RESULT_LABEL = { present: "Present", not_found: "Not found", changed: "Changed" };
  const REASONS = [
    { value: "expired", label: "Expired" },
    { value: "unlabelled", label: "Unlabelled" },
    { value: "damaged", label: "Damaged" },
    { value: "unknown", label: "Unknown product" },
    { value: "no_sds", label: "No SDS" },
  ];
  const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.value, r.label]));

  // ---- ordering: out-of-date and missing paperwork first, then by name
  function attentionRank(it) {
    const st = it.review_status;
    if (st === "overdue") return 0;
    if (st === "due_soon") return 1;
    if (st === "no_sds" || !it.has_sds) return 2;
    if (!it.has_assessment) return 3;
    if (st === "unknown") return 4;
    return 5;
  }
  function needsAttention(it) { return attentionRank(it) < 4; }
  function sortItems(items) {
    return (items || []).map((it, i) => [it, i]).sort((a, b) => {
      const ra = attentionRank(a[0]), rb = attentionRank(b[0]);
      if (ra !== rb) return ra - rb;
      const na = String(a[0].product_name || "").toLowerCase(), nb = String(b[0].product_name || "").toLowerCase();
      if (na !== nb) return na < nb ? -1 : 1;
      return a[1] - b[1];
    }).map((x) => x[0]);
  }

  // ---- progress
  function progress(items) {
    const list = items || [];
    const total = list.length;
    const marked = list.filter((i) => RESULTS.includes(i.result)).length;
    return { marked, total, unmarked: total - marked, pct: total ? Math.round((marked / total) * 100) : 100 };
  }
  function progressText(p) { return p.total ? `${p.marked} of ${p.total} marked` : "No chemicals listed for this place"; }

  // What the start screen says about the register side of a place.
  function placeReadiness(chemicals) {
    const list = chemicals || [];
    let outOfDate = 0, noSds = 0, noAssessment = 0, attention = 0;
    for (const c of list) {
      const od = c.review_status === "overdue" || c.review_status === "due_soon";
      const ns = !c.sds_id || c.review_status === "no_sds";
      const na = !c.has_assessment;
      if (od) outOfDate++;
      if (ns) noSds++;
      if (na) noAssessment++;
      if (od || ns || na) attention++;
    }
    return { total: list.length, outOfDate, noSds, noAssessment, attention };
  }

  // ---- the "Changed" form: needs a quantity with a unit, or a container note, or a note
  function changedProblem(f) {
    const qty = f.newQuantity == null ? "" : String(f.newQuantity).trim();
    const unit = f.newUnit || "";
    const cont = String(f.newContainerNote || "").trim();
    const note = String(f.note || "").trim();
    if (qty && !(Number(qty) >= 0)) return "The new quantity must be a number from 0 up.";
    if (qty && !unit) return "Choose a unit (L or kg) for the new quantity.";
    if (!qty && unit && !cont && !note) return "Enter the new quantity, or describe what changed.";
    if (!(qty && unit) && !cont && !note) return "Say what changed: a new quantity, the containers, or a note.";
    return "";
  }

  // ---- photos
  function scaleSize(width, height, maxSide) {
    const max = maxSide || MAX_SIDE;
    const w = Number(width), h = Number(height);
    if (!(w > 0) || !(h > 0)) return { width: 0, height: 0, scale: 1 };
    const longest = Math.max(w, h);
    if (longest <= max) return { width: Math.round(w), height: Math.round(h), scale: 1 }; // never upscale
    const scale = max / longest;
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
  }
  // File.lastModified is the capture time for a camera capture. Trust it only when it is recent and not in the future.
  function pickTakenAt(lastModified, nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    const lm = Number(lastModified);
    const ok = Number.isFinite(lm) && lm > 0 && lm <= now && now - lm <= TAKEN_AT_WINDOW_MS;
    return new Date(ok ? lm : now).toISOString();
  }
  function mbText(bytes) {
    const b = Number(bytes) || 0;
    if (b <= 0) return "0 MB";
    const mb = b / 1048576;
    return (mb < 0.1 ? "less than 0.1" : mb.toFixed(1)) + " MB";
  }

  // ---- summary wording
  function parseSummary(s) {
    if (!s) return null;
    if (typeof s === "string") { try { return JSON.parse(s); } catch (e) { return null; } }
    return s;
  }
  // Counts for the summary screen; falls back to counting the audit's own rows when the server has none.
  function summaryFromAudit(d) {
    const s = parseSummary(d && d.audit && d.audit.summary);
    if (s) return Object.assign({ listed: 0, present: 0, not_found: 0, changed: 0, not_marked: 0, found: 0, disposals: 0, photos: 0, photo_bytes: 0 }, s);
    const items = (d && d.items) || [];
    const count = (r) => items.filter((i) => i.result === r).length;
    const photos = (d && d.photos) || [];
    return {
      listed: items.length, present: count("present"), not_found: count("not_found"), changed: count("changed"),
      not_marked: items.filter((i) => !RESULTS.includes(i.result)).length,
      found: ((d && d.found) || []).length, disposals: ((d && d.disposals) || []).length,
      photos: photos.length, photo_bytes: photos.reduce((a, p) => a + (Number(p.bytes) || 0), 0),
    };
  }
  function summaryRows(s) {
    return [
      ["Chemicals listed", s.listed], ["Present", s.present], ["Not found", s.not_found], ["Changed", s.changed],
      ["Not marked", s.not_marked], ["Found items", s.found], ["Flagged for disposal", s.disposals],
      ["Photos", `${s.photos} (${mbText(s.photo_bytes)})`],
    ];
  }
  function nextSteps(s) {
    const out = [];
    if (s.not_found + s.changed > 0) out.push("Not found and Changed items go to an admin to review. Nothing on the register has changed yet.");
    else out.push("Nothing on the register needs to change because of this audit.");
    if (s.found > 0) out.push("Items you found that are not on the register are with the admin, or need an SDS uploaded.");
    if (s.disposals > 0) out.push("Items flagged for disposal stay on the list until an admin closes them.");
    if (s.not_marked > 0) out.push(`${s.not_marked} chemical${s.not_marked === 1 ? " was" : "s were"} not marked. They are not recorded as missing.`);
    return out;
  }
  function unmarkedWarning(n) {
    return n === 1 ? "1 chemical is not marked. It won't be recorded as missing."
      : `${n} chemicals are not marked. They won't be recorded as missing.`;
  }
  function foundOutcomeText(outcome, isAdmin) {
    switch (outcome) {
      case "linked": return "Linked to this place";
      case "link_suggested": return isAdmin ? "Linked to this place" : "Sent to the admin to link";
      case "created": return "Added as a new product. It needs an SDS";
      default: return "Recorded in this audit";
    }
  }
  function pendingText(p) {
    const parts = [];
    const n = (v, one, many) => v + " " + (v === 1 ? one : many);
    if (p.answers) parts.push(n(p.answers, "answer", "answers"));
    if (p.photos) parts.push(n(p.photos, "photo", "photos"));
    if (p.other) parts.push(n(p.other, "other item", "other items"));
    return parts.length ? "Not yet sent: " + parts.join(", ") : "";
  }
  function expectedText(it, fmt) {
    const f = fmt || ((q) => String(q));
    const q = it.expected_quantity != null && it.expected_unit ? f(it.expected_quantity) + " " + it.expected_unit : "";
    return [q, it.expected_container_note].filter(Boolean).join(" · ");
  }

  // ---- offline outbox (stage 8). A queue entry looks like {id, kind: "answer"|"photo"|"found"|"disposal"|"start"|"finish", status: "queued"|"sending"|"failed", auditId, chemicalId?, ownerType?, ownerKey?, clientId?, message?}
  function isLocalId(id) { return /^local-/.test(String(id == null ? "" : id)); }
  function sameAudit(entryAuditId, ids, serverAuditId) { return (ids || []).some((x) => x != null && (String(x) === String(entryAuditId) || (serverAuditId != null && String(x) === String(serverAuditId)))); }
  function cardState(queue, ids, chemicalId) {
    const mine = (queue || []).filter((q) => q.kind === "answer" && String(q.chemicalId) === String(chemicalId) && sameAudit(q.auditId, ids, q.serverAuditId));
    const failed = mine.find((q) => q.status === "failed");
    if (failed) return { state: "failed", message: failed.message || "It could not be sent." };
    if (mine.some((q) => q.status === "sending")) return { state: "sending", message: "" };
    if (mine.length) return { state: "queued", message: "" };
    return { state: "", message: "" };
  }
  function cardStateText(st) {
    if (!st || !st.state) return "";
    if (st.state === "failed") return "Needs attention: " + st.message;
    return "Saved on this phone, not sent yet";
  }
  function headerText(p) {
    p = p || {};
    const base = pendingText(p);
    const f = Number(p.failed) || 0;
    if (!f) return base;
    const tail = f + (f === 1 ? " needs" : " need") + " attention";
    return base ? base + ". " + tail : "Needs attention: " + f + " not sent";
  }
  function pendingTotal(p) { p = p || {}; return (Number(p.answers) || 0) + (Number(p.photos) || 0) + (Number(p.other) || 0) + (Number(p.failed) || 0); }
  function isSending(queue) { return (queue || []).some((q) => q.status === "sending"); }
  function isUnsentPhoto(queue, photo, ids) {
    if (photo.unsent) return true;
    return (queue || []).some((q) => q.kind === "photo" && ((q.clientId && q.clientId === photo.client_id) || (q.id != null && String(q.id) === String(photo.id))));
  }
  function hasQueuedFinish(queue, ids) { return (queue || []).some((q) => q.kind === "finish" && sameAudit(q.auditId, ids, q.serverAuditId)); }
  function unsentForAudit(queue, ids) { return (queue || []).some((q) => sameAudit(q.auditId, ids, q.serverAuditId)); }
  // The body the found screen sends when there is no signal: typed only, recorded only, flagged for the admin to check.
  function offlineFoundBody(f) {
    return { productName: String(f.name || "").trim(), supplier: String(f.supplier || "").trim(), note: String(f.note || "").trim(), source: "typed", action: "record", unchecked: true };
  }
  const NO_SIGNAL_FOUND = "No signal: you can't check the register or read the label now. Type what you can see; it is recorded in this audit and flagged for the admin to check.";
  const SAVE_PLACE_FIRST = "Save this place for offline first (on the place page).";
  const FINISHED_ON_PHONE = "Finished on this phone. It will be sent when you have signal; nothing is lost.";
  const OFFLINE_START_NOTICE = "Offline: this audit will be sent when you have signal.";

  const CSS = `
.au-head{margin:0 0 6px}
.au-head h1{font-size:18px;margin:0}
.au-head .au-sub{color:var(--muted);font-size:13px}
.au-prog{position:sticky;top:57px;z-index:20;background:var(--bg);margin:0 -14px 10px;padding:6px 14px 2px;border-bottom:1px solid var(--border)}
.au-prog .au-count{font-weight:700;font-size:15px}
.au-prog .progress{margin:4px 0 6px}
.au-unsent{background:var(--warn-bg);color:var(--warn);border:1px solid #E8D4A0;border-radius:6px;padding:6px 12px;margin:4px 0;font-size:14px;font-weight:600}
.au-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:12px}
.au-card.attn{border-left:5px solid var(--warn)}
.au-card.done-present{border-left:5px solid var(--done)}
.au-card.done-not_found{border-left:5px solid var(--danger)}
.au-card.done-changed{border-left:5px solid var(--office)}
.au-name{font-size:17px;font-weight:700;overflow-wrap:anywhere}
.au-sup{color:var(--muted);font-size:14px}
.au-exp{color:var(--ink-soft);font-size:14px;margin-top:4px}
.au-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.au-three{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
.au-three button{min-height:56px;font-size:15px;font-weight:700;padding:6px 4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border-width:2px}
.au-three button[aria-pressed=true]{color:#fff;border-color:transparent}
.au-three button[data-r=present][aria-pressed=true]{background:var(--done)}
.au-three button[data-r=not_found][aria-pressed=true]{background:var(--danger-ink)}
.au-three button[data-r=changed][aria-pressed=true]{background:#2F5559}
.au-three .au-tick{font-size:13px;font-weight:600}
.au-state{font-size:13px;margin-top:6px;min-height:18px;color:var(--muted)}
.au-state.err{color:var(--danger-ink);font-weight:700}
.au-state button{margin-left:6px}
.au-form{border-top:1px dashed var(--border);margin-top:10px;padding-top:4px}
.au-photos{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:flex-start}
.au-ph{position:relative;width:76px;height:76px;border-radius:6px;overflow:hidden;border:1px solid var(--border);background:#EFEDE6}
.au-ph img{width:100%;height:100%;object-fit:cover;display:block}
.au-ph .au-phs{position:absolute;left:0;right:0;bottom:0;background:rgba(31,42,36,.8);color:#fff;font-size:11px;text-align:center;padding:1px 0}
.au-ph.err{border-color:var(--danger)}
.au-ph.err .au-phs{background:var(--danger-ink)}
.au-cam{min-height:76px;width:76px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:12px;padding:4px}
.au-links{display:flex;gap:16px;margin-top:10px;font-size:14px;flex-wrap:wrap}
.au-links button.link{min-height:44px}
.au-bar{position:sticky;bottom:0;z-index:25;background:var(--bg);border-top:1px solid var(--border);margin:0 -14px;padding:8px 14px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.au-bar[hidden]{display:none}
.au-bar button{min-height:52px;font-size:13.5px;font-weight:700;padding:6px 4px;line-height:1.2}
@media (max-width:860px){.au-bar{bottom:calc(58px + env(safe-area-inset-bottom))}}
@media (min-width:861px){.au-prog{margin:0 0 10px;top:0;padding-left:0;padding-right:0}.au-bar{margin:0}}
.au-sheet-ov{position:fixed;inset:0;background:rgba(31,42,36,.5);z-index:60;display:flex;align-items:flex-end;justify-content:center}
.au-sheet{background:var(--surface);width:100%;max-width:560px;max-height:92vh;overflow-y:auto;border-radius:14px 14px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom))}
.au-sheet h2{margin:0 0 6px;font-size:18px}
.au-reasons{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.au-reasons button{min-height:48px;font-weight:600;border-width:2px}
.au-reasons button[aria-pressed=true]{background:var(--main);color:var(--on-main);border-color:var(--main)}
.au-list{list-style:none;margin:0;padding:0}
.au-list li{padding:8px 0;border-bottom:1px solid var(--border);font-size:14px}
.au-cand{border:2px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:10px;background:var(--surface)}
.au-cand.exact{border-color:var(--done);background:var(--done-bg)}
.au-cand button{margin-top:8px}
.au-big{min-height:56px;font-size:17px;font-weight:700;width:100%}
.au-check{font-size:12.5px;color:var(--warn);font-weight:700;margin-top:2px}
.au-sum{width:100%;border-collapse:collapse;font-size:16px}
.au-sum td{padding:10px 4px;border-bottom:1px solid var(--border)}
.au-sum td:last-child{text-align:right;font-weight:700}
.au-ro{margin:6px 0 0;font-weight:700}
`;
  function ensureCss() {
    if (typeof document === "undefined" || document.getElementById("auCss")) return;
    const s = document.createElement("style");
    s.id = "auCss";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  return {
    MAX_SIDE, JPEG_QUALITY, MAX_PHOTOS_PER_OWNER, TAKEN_AT_WINDOW_MS, RESULTS, RESULT_LABEL, REASONS, REASON_LABEL,
    attentionRank, needsAttention, sortItems, progress, progressText, placeReadiness, changedProblem,
    scaleSize, pickTakenAt, mbText, parseSummary, summaryFromAudit, summaryRows, nextSteps, unmarkedWarning,
    foundOutcomeText, pendingText, expectedText, CSS, ensureCss,
    isLocalId, cardState, cardStateText, headerText, pendingTotal, isSending, isUnsentPhoto, unsentForAudit, hasQueuedFinish, offlineFoundBody,
    NO_SIGNAL_FOUND, SAVE_PLACE_FIRST, FINISHED_ON_PHONE, OFFLINE_START_NOTICE,
  };
});
