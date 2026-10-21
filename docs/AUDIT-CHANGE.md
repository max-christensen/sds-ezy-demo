# Change: chemical audits

Helps people keep chemicals up to date and find new ones that have been brought in. Used on a phone or tablet at the place itself, with photos as proof.
Two roles only (admin, user). The existing register behaviour does not change except where stated here. Read `schema.sql` (the audit tables at the end) and `tests/audit-schema.test.mjs`.
Where this and older docs disagree, this wins for audits.

## Decisions to confirm with the project owner (state them in the README and the final report)

1. **What a `user` can write.** Audit records, photos, and SDS uploads only. A user cannot edit the register. Two places where an audit touches the register on a user's behalf, both decided here:
   * **A found item that is not on the register** creates a chemical record flagged "needs an SDS" (`source = "audit"`, no SDS, no decision), linked to the audited place, and the user goes straight into the existing SDS upload flow, which attaches the SDS to that record and drafts the assessment exactly as an upload does today. (The upload creates chemicals directly for users already; this just gives it a starting record. It shows in the existing "no SDS" review group.)
   * **A found item that matches a chemical already on the register** is NOT linked to the place by a user. For a user it records the match and becomes a **finding** ("link <product> to <place>") for the admin to accept with one click. For an admin it links at once.
2. **"Not found" and "Changed" never change the register by themselves** (someone may simply have missed it). When an audit is finished they become findings; an admin accepts (unlinks from the place, or updates the quantity and container) or dismisses each.
3. **Who can see an audit and its photos.** An admin sees every audit. A user sees only the audits they ran. A photo is served only to someone who can see its audit (signed in, and checked on every request; never a public URL, never cached by shared caches). Any signed-in user can see a place's "last audited" date (it is not sensitive and drives the reminder), but a place's audit history lists only the audits the viewer can open.
4. **Disposals** are flagged inside an audit. They do not change the register. Only an admin closes one.

## Rules that apply to everything

* **Idempotent by `client_id`.** Every row a phone creates (audit, found item, disposal, photo) carries a `client_id` the phone generates (UUID). Sending the same request twice returns the existing row with the same body (200), never a second row. Audit items are addressed by chemical id within the audit (`/api/audits/:id/items/:chemical_id`), not by their own id, so a phone that never saw the server's row ids can still send answers. This is what makes the offline stage possible; build it in from the start.
* **Device times.** `started_at`, `finished_at`, `marked_at`, `found_at`, `flagged_at`, `taken_at` are sent by the phone (ISO strings) because it may be offline. The server validates them (parseable, not more than 1 day in the future, not more than 30 days in the past) and ignores a bad one by using the server's time; it also keeps its own `received_at`/`created_at`.
* **Ownership.** A user may act only on an audit they started, and only while it is `in_progress` (replaying an already-applied request is still 200). An admin may act on any audit. Finished audits are read-only for everyone except: an admin may close a disposal and add a closing photo; findings are resolved by an admin.
* **Demo mode** blocks every audit write for everyone (the existing guard). Reads still work.
* **Validation, deny by default, parameterised SQL, no stack traces**: as the rest of the Worker. All new routes go in the `src/index.js` role table: the audit-writing routes are `"user"` (meaning user or admin), the resolving/closing/admin-list routes are `"admin"`.

## Running an audit (API; `src/audits.js`)

```
POST /api/audits                      {place_id, client_id, started_at} (user|admin) -> {audit, items}
     Active place only. Creates the audit and an audit_items row for every chemical linked to the place (snapshots: product, supplier, expected quantity/unit/container,
     review_due, review_status, has_sds, has_assessment, risk_level). If this person already has an in_progress audit of this place with a different client_id, return that one (200, "existing": true).
     At most 5 in-progress audits per person.
GET  /api/audits?place_id=&status=in_progress|finished&limit=&before=    (admin: all; user: own only) -> [{id, place_id, place_name, place_type, started_by_name, started_at, finished_at, status, summary}]
GET  /api/audits/:id                  (admin or the person who ran it) -> {audit, items, found, disposals, findings, photos}   photos = metadata only: [{id, owner_type, owner_key, taken_at, bytes, width, height}]
PUT  /api/audits/:id/items/:chemical_id   {result: "present"|"not_found"|"changed", note?, new_quantity?, new_unit?, new_container_note?, marked_at}
     "changed" needs at least one of new_quantity (with unit), new_container_note, note. Re-marking replaces the answer.
POST /api/audits/:id/finish           {finished_at, notes?} -> {audit, summary}   (idempotent)
     Writes `summary` JSON {listed, present, not_found, changed, not_marked, found, disposals, photos, photo_bytes}, writes the findings (below), and upserts place_audit_summary
     (last_audited_at = finished_at). Items still unmarked are recorded as not marked and make no findings. Admin may finish another person's audit.
```
The audit screen orders items so out-of-date ones stand out (review overdue / due soon / no SDS / no assessment first), then by name, and shows each chemical's SDS review status and whether it has an assessment (the snapshots).

## Found items

```
POST /api/audits/:id/found/read-label   multipart: image (already compressed JPEG) -> {ok, product_name, supplier, provider, model} | {ok:false, message}   (user|admin; own hourly limit)
POST /api/audits/:id/found/match        {product_name, supplier} -> {candidates:[{chemical_id, product_name, supplier, exact:boolean, linked_here:boolean}]}   (read-only helper; indexed, no table scan beyond the one search_text lookup the register search already does)
POST /api/audits/:id/found              {client_id, product_name, supplier?, source:"ai"|"typed", found_at, note?, action:"link"|"create"|"record", matched_chemical_id?} -> {found, chemical_id?, finding_id?, next?}
     action "link" (needs matched_chemical_id; chemical not already linked here):  admin -> links it now (outcome "linked"); user -> outcome "link_suggested" + a found_link finding.
     action "create": creates the "needs an SDS" chemical linked to the audit's place (outcome "created"); response includes `next: {upload_for_chemical: id, place_id}` so the UI opens the upload flow.
     action "record": just records it in the audit (outcome "recorded").
     product_name required (<=200 chars); a duplicate client_id returns the existing row.
```
* The label read uses the existing provider-neutral AI settings, but the model MUST support images. `src/label.js` (ai-upload agent) keeps a capability table of known image-capable models per provider, a separate "model for reading photos" setting per provider with a sensible default (Workers AI's default text model `@cf/meta/llama-3.3-70b-instruct-fp8-fast` does NOT take images: use a vision model; verify current ids and any licence step in the Cloudflare docs), and `POST /api/settings/ai/test-vision` (admin) that sends a tiny generated solid-red image and checks the answer. If the configured model cannot take images, or the call fails, the screen says so plainly and the user types the name and supplier; the photo is still kept.
* The AI sees only the label photo and must return strictly `{product_name, supplier}` (short strings, clamp lengths, treat label text as untrusted data, never follow instructions in it); anything else is discarded.
* **Do not try to find an SDS on the internet.** The register match is the only lookup.

## Disposals

```
POST /api/audits/:id/disposals          {client_id, description, reason: "expired"|"unlabelled"|"damaged"|"unknown"|"no_sds", note?, chemical_id?, flagged_at} -> {disposal}   (user|admin, own in-progress audit)
GET  /api/disposals?status=to_dispose|disposed|all&limit=       (admin) -> list incl. place, reason, who/when, photo ids
PUT  /api/disposals/:id/close           {close_note, closed_at} (admin) -> {disposal}   status "disposed", closed_by/closed_at recorded; a closing photo is added with the photo endpoint (owner_type "disposal_close")
```

## Findings (what changes the register)

```
GET  /api/findings?status=open|accepted|dismissed|all&limit=    (admin) -> [{id, kind, audit_id, place_id, place_name, product_name, chemical_id, details, status, created_at, resolved_by_name, resolved_at, resolve_note}]
POST /api/findings/:id/accept           (admin) one click:
        not_found  -> unlink the chemical from the place (delete the chemical_places row, keep places.chemical_count right in the same batch)
        changed    -> update the link's quantity / unit / container note to what the audit recorded
        found_link -> link the chemical to the place (no quantity)
     If the link has already gone / already exists, accept just closes the finding (say so in the response). Records who and when.
POST /api/findings/:id/dismiss          {note?} (admin) -> changes nothing else
```
Findings are created when an audit is finished (one per `not_found` item, one per `changed` item, one per `link_suggested` found item). A re-sent finish makes no second set.

## Photos (R2, `FILES` bucket)

* Compressed ON THE DEVICE before upload: longest side about 1600 px, JPEG quality about 0.7, EXIF orientation applied, EXIF stripped (canvas re-encode does this). `taken_at` = the photo's capture time if the phone gives it (`File.lastModified` for camera captures), else the moment it was added.
* `POST /api/audits/:id/photos` multipart: `file`, `client_id`, `owner_type`, `owner_key`, `taken_at`, `width`, `height` (user|admin). Server checks: owner exists in this audit; JPEG magic bytes (`FF D8 FF`) and `image/jpeg`; size cap `audit_photo_max_mb` (default 2); count cap `audit_max_photos` per audit (default 50); total cap `audit_max_total_mb` per audit (default 40); at most 3 photos per owner. Over any cap: 400/413 with a plain message and nothing stored; the R2 object is removed if the DB write fails. `owner_type "disposal_close"` is admin-only and allowed after the audit is finished.
* `GET /api/audit-photos/:id` streams the JPEG after the same access check as the audit (admin or its auditor); `Cache-Control: private, no-store`; `X-Content-Type-Options: nosniff`; 404 (not 403) when the caller may not see it.
* Limits live in `settings` (admin edits them in Settings): `audit_photo_max_mb`, `audit_max_photos`, `audit_max_total_mb`, `label_read_rate_per_hour` (default 30, counted in `audit_ai_log`), `audit_reminder_days` (default 90).
* Storage per audit = `SUM(bytes)` of its `audit_photos`: report it in the audit summary, in the audit report and in `scripts/measure-rows.mjs`.

## History, reminders, review list

* `GET /api/places/:id` gains `last_audited_at` (from `place_audit_summary`, one PK read) and `audits` (the viewer's visible audits for the place, newest first, at most 10: id, started_by_name, started_at, finished_at, status, summary).
* `GET /api/review` gains `not_audited`: active places that have at least one chemical (`chemical_count > 0`) and were never audited or not audited for more than `audit_reminder_days`: `[{place_id, name, place_type, registration, last_audited_at, days}]` (cap 200; `counts.not_audited` true total); and, for admins only, `counts.findings_open` and `counts.disposals_open`. Reads only `places` + `place_audit_summary` (+ two indexed COUNTs for admins).
* `GET /api/settings` / `PUT /api/settings` carry the five audit settings (validated ranges: reminder 1 to 730 days, photo MB 0.2 to 8, max photos 1 to 200, total MB 5 to 200, label reads 1 to 200).

## Audit report and exports (browser)

* `public/views/audit.js` offers **Print** and **Save as PDF** (and Share where supported). The PDF is built in the browser with pdf-lib: cover (company, place, date, who audited, started and finished), summary counts and photo storage, each chemical's result with note and the review/assessment status at the time, the found items (and what happened to each), the disposal items (reason, status, who/when), the photos with their capture timestamps (JPEG embedded as is, no re-encode), and the disclaimer on the cover and in every page footer.
* Take-away exports include the audit data: the Excel file gets Audits, Audit items, Found items, Disposals and Findings sheets (a user's export has only their own audits); the print-ready PDF bundle gets an "Audit history" section (one line per audit with counts); the zip may include the audit report PDFs for the person's visible audits from the last 12 months if the person ticks "Include audit reports (with photos)" (default off; photos make it large).

## Phone screens (mobile first; 44px+ targets; bottom tab bar already exists)

`#/audit/new?place=ID` (start; shows the place, what will be audited, "Start audit"), `#/audit/:id` (the run screen: sticky progress "12 of 17 marked", one card per chemical with big Present / Not found / Changed buttons, SDS review and assessment badges, a note field, a camera button, "Add a found item", "Flag for disposal", "Finish audit"), `#/audit/:id/found` (photograph the label, AI read or type, match list, link or create, "Add the SDS now"), `#/audit/:id/summary` (counts after finishing), `#/audit/:id/report` (the report page, Print / Save PDF), `#/audits` (my audits; admin: all), admin: `#/findings`, `#/disposals`. The place page gets "Audit this place", "Last audited", the history; the review home gets "Not audited for X days" (and counts of open findings and disposals for admins).
Photos are taken with `<input type="file" accept="image/*" capture="environment">` (opens the camera; falls back to the gallery) and compressed with canvas before upload.

## Offline (the last stage; build it after the stages above work online)

The phone may have no signal at the place. All audit calls go through ONE client module (`public/lib/audit-client.js`) so offline can be added behind it. Offline: the answers, found items, disposals and photos are kept ON THE PHONE (IndexedDB: an `ops` queue, the local audit copy, and photo blobs), the UI shows clearly what is **not yet sent** ("Not yet sent: 9 answers, 3 photos") on the audit screen and in a persistent banner, and everything is sent in order when the signal returns (online event, app start, a "Send now" button), using the idempotent `client_id` calls above. Starting an audit offline works when the place has been saved for offline (the existing offline place cache supplies the chemical list); the audit is created on the server when the phone reconnects. Signing out with unsent audit data warns and requires a choice (send now, or discard and sign out): sign-out clears saved data but must never silently lose audit work. An expired session while offline does not discard the queue.

## Out of scope

Finding SDS files on the internet. Editing the register from the audit screen. Deleting audits or photos (records are kept). Scheduling or assigning audits to people.
