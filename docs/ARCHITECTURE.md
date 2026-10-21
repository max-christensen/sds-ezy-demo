# SDS EZY: architecture and API contract

> **Superseded in part by [GHS-CHANGE.md](GHS-CHANGE.md):** pictograms are the nine official GHS images (GHS01 to GHS09), classification is stored as GHS class and category and drives the pictograms, signal word and decision, and placard and manifest quantities are totalled per Schedule 11 item (not by ADG class). Where the two documents disagree, GHS-CHANGE.md wins. Places, job packs and offline reading are in [PLACES-CHANGE.md](PLACES-CHANGE.md); chemical audits (photos, findings, disposals and offline audits) are in [AUDIT-CHANGE.md](AUDIT-CHANGE.md), which wins for anything about audits.

A chemical register plus a hazard risk assessment for each chemical. Someone uploads a safety data sheet (SDS),
the app reads it, drafts the assessment and adds it all to the register. **Out of scope:** work instructions,
SOPs, JSEAs, SWMS (a different product), scheduling, clients, jobs, calendars.

Stack: one Cloudflare Worker (`src/`), static front end (`public/`), D1 (`DB`), R2 (`FILES`), Workers AI (`AI`, optional).
Core pieces: login and sessions, admin/user plumbing, R2 file handling, company branding, print and CSV approach.

## Roles (enforced in the Worker, in `src/index.js`, one table; the interface only mirrors it)

| Action | admin | user |
|---|---|---|
| Read register, chemicals, SDS PDFs, assessments, manifest, review list, options, export data | yes | yes |
| Print, export (xlsx / PDF / zip are built in the browser from GET data) | yes | yes |
| `POST /api/uploads/precheck`, `POST /api/uploads` (upload an SDS) | yes | yes (rate limited) |
| Everything else that writes (chemicals, SDS edit/replace/delete, assessments, locations, options, import, settings, AI config, users, logo) | yes | **403** |

A user can NOT edit or delete anything, including their own uploads. Any non-GET request that is not on the
allow-list is admin-only by default (deny by default).

**Demo mode:** when the Worker var `DEMO_MODE` is `"1"`, every non-GET request except login/logout/verify returns 403
with `READ_ONLY_MESSAGE` for *everyone* (including the demo admin and demo user, so uploads are blocked too).
`/api/public-settings` then includes `demo: true` and `demo_logins: [{email, role, label}]` (from `DEMO_ADMIN_EMAIL`,
`DEMO_USER_EMAIL`). Demo logins skip the emailed two-factor code. There is no third role.

## Files and ownership

```
src/index.js        router, role table, demo guard, error handling
src/lib.js          json(), crypto/session/cookie helpers, loadSettings/saveSetting, small date helpers
src/auth.js         setup, login, 2FA verify, logout, public-settings
src/settings.js     company settings, branding/logo, users, AI settings (admin)
src/register.js     review list, chemicals CRUD + list/search, locations, manifest, options, history, refreshChemicalSummary()
src/sds.js          SDS metadata, PDF streaming, create/replace(version)/delete, link/unlink
src/assessments.js  assessments CRUD (+ controls)
src/import.js       one-time spreadsheet import (rows parsed in the browser)
src/ai.js           provider-neutral AI call, prompt, JSON validation, exact-field checking
src/upload.js       precheck + upload pipeline + guards (PDF only, size cap, rate limit, duplicate check)
schema.sql          D1 schema (run on every deploy, idempotent)
public/index.html   shell + CSS; public/app.js core; public/views/*.js one file per screen; public/help.html
public/disclaimer.js  the disclaimer wording, ONE place (window.DISCLAIMER)
public/vendor/      pdf.js, write-excel-file, read-excel-file, fflate, pdf-lib, qrcode-generator (vendored by scripts/vendor.mjs)
scripts/            vendor.mjs, demo generator, measure scripts
seed-local/         git-ignored: the user's real example files and anything with real names/phone numbers
```

Bindings (wrangler): `DB` (D1), `FILES` (R2 bucket for SDS PDFs and the logo), `ASSETS`, `AI` (Workers AI, optional).
Secrets / vars: `SESSION_SECRET`, `SETUP_KEY`, `RESEND_API_KEY`, `MAIL_FROM`, `DEMO_MODE`, `DEMO_ADMIN_EMAIL`,
`DEMO_USER_EMAIL`, and optional AI secrets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (an env secret wins over a
key stored from the Settings screen). `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `GEMINI_BASE_URL` may override provider URLs
(OpenAI-compatible endpoints, and local test stand-ins). R2 key layout: `sds/<uuid>.pdf`, `branding/logo`.

## Row-read rules (D1 limits rows read; a missing index reads the whole table)

* Every WHERE / JOIN / ORDER BY column is indexed (see schema.sql). Do not add a query that scans a table without checking.
* The review list, registers and search read **only `chemicals`**. The columns `sds_id, sds_issue_date, review_due, risk_level,
  dg_class, signal_word, pictograms` on `chemicals` are summary copies; call `refreshChemicalSummary(env, chemicalId | {sdsId})`
  after ANY change to a chemical's current SDS or current assessment, or the SDS fields that feed it.
* `search_text` = lower-cased product_name + supplier + synonyms + product_codes + CAS numbers, rebuilt on every chemical/SDS change.
* Long lists load lazily: SDS version history, assessment history, products-sharing-an-SDS are separate GETs fetched on demand.
* Use `db.batch([...])` for multi-statement writes (also saves round trips).
* Measure rows read (`meta.rows_read`) for: sign-in, the review list/register, a chemical page, search. Record numbers in the README.

## Vocabulary (use these exact strings everywhere)

* `users.role`: `admin` | `user`
* `chemicals.decision`: `hazardous` | `not_hazardous` | null (null = no decision yet)
* `chemicals.physical_form`: `liquid` `solid` `powder` `gas` `aerosol` `paste` `other`
* `assessments.risk_level`: `not_significant` ("Not significant") | `significant_controlled` ("Significant but effectively controlled") |
  `significant_not_controlled` ("Significant and not effectively controlled") | `uncertain` ("Uncertain", the default)
* `control_options.kind`: `isolation` `ventilation` `other` `ppe` `additional_ppe`
* pictogram codes (the eight GHS icons): `toxic` (acute toxicity, skull), `health` (health hazard), `flame`, `exclamation`,
  `oxidising`, `gas` (gas cylinder), `environment`, `corrosive`. Stored as a comma list in `sds.pictograms`.
  The front end draws them as inline SVG in `public/views/pictograms.js` (`App.pictogramSvg(code)`), red diamond border, black symbol.
* `unit`: `L` | `kg`
* review status (computed in the Worker, not stored): `overdue` (review_due < today), `due_soon` (within 90 days), `ok`, `no_sds`, `unknown` (SDS without an issue date)
* `source`: `upload` `manual` `import` `demo` (assessments also `ai`, `blank`)
* Dates are `YYYY-MM-DD` text. Timestamps are ISO strings or SQLite `datetime('now')`.
* `unverified` is a JSON array of field names (e.g. `["un_number","hazchem_code"]`) the AI returned that were not found in the PDF text;
  those fields are stored blank and the UI shows a "not found in the SDS text, check" flag.
* Review due = issue date + 5 years (same month and day; 29 Feb becomes 28 Feb).

## API (all JSON unless noted; errors are `{error: "message"}` with a proper status)

### Auth and settings 
* `POST /api/setup` `{setup_key?, name, email, password}` first admin. `POST /api/login` `{email,password}` → user or `{needs_code, challenge, sent_to}`.
  `POST /api/login/verify` `{challenge, code}`. `POST /api/logout`. `GET /api/me`.
* `GET /api/public-settings` (no login): `{company_name, has_logo, logo_version, main_color, accent_color, needs_setup, setup_key_required, demo?, demo_logins?}`
* `GET /api/logo` image. `GET /api/settings` (any user): company fields, colours, `twofa_enabled`, `resend_configured`, `setup_complete`.
  `PUT /api/settings` (admin) company fields (`company_name, company_address, company_phone, company_email, company_reg`), `main_color`, `accent_color`,
  `twofa_enabled`, `setup_complete`, `upload_max_mb`, `upload_rate_per_hour`. `POST /api/settings/logo` (multipart `file`), `DELETE /api/settings/logo` (admin).
* AI config (admin): `GET /api/settings/ai` → `{provider, model, key_source: "secret"|"stored"|"none", workers_ai_available, providers:[{id,label,default_model}]}`.
  `PUT /api/settings/ai` `{provider, model?, api_key?, clear_key?}` (the key is stored encrypted in D1 settings and is NEVER returned or logged).
  `POST /api/settings/ai/test` → `{ok, message}` (a tiny test call). `provider` ∈ `workers_ai` (default) | `claude` | `openai` | `gemini`.
* Users (admin): `GET /api/users`, `POST /api/users` `{name,email,password,role}`, `PUT /api/users/:id` (name, email, role, color, active, password).
  The last active admin cannot be demoted or deactivated.

### Register
* `GET /api/review` → `{as_of, counts:{overdue,due_soon,no_sds,no_decision}, overdue:[R], due_soon:[R], no_sds:[R], no_decision:[R]}` where
  `R = {id, product_name, supplier, sds_id, review_due, review_status}`. Each list is capped at 200 with `counts` giving the true totals.
* `GET /api/chemicals?filter=all|hazardous&q=&limit=&offset=` → `{items:[C], total}` with
  `C = {id, product_name, supplier, decision, sds_id, sds_issue_date, review_due, review_status, risk_level, dg_class, signal_word, pictograms, source}`.
  Default `limit` 500, max 2000. `q` searches `search_text` (substring, case-insensitive; every word must match), limit 50.
* `GET /api/chemicals/:id` → `{chemical, sds, sds_products, assessment, locations}`:
  `chemical` all columns minus `search_text`, plus `review_status`; `sds` the current sds row or null (plus `has_file`);
  `sds_products` `[{id, product_name}]` of OTHER chemicals sharing this SDS (max 50, `sds_products_total` also returned);
  `assessment` the current assessment with `controls: [{id, kind, label}]` or null; `locations` all storage locations.
* `GET /api/chemicals/:id/history` (lazy) → `{sds_versions:[sds rows of the same doc_key, newest first, no blobs], assessments:[older assessments, newest first]}`
* admin: `POST /api/chemicals` `{product_name, supplier, synonyms, product_codes, use_description, physical_form, decision, decision_note, sds_id?}` → `{id}`;
  `PUT /api/chemicals/:id` same fields; `DELETE /api/chemicals/:id` (also deletes its locations and assessments; the SDS and PDF are deleted too
  only if no other chemical uses that SDS).
  Setting `decision` records `decision_by` (user name) and `decision_at`.
* admin: `POST /api/chemicals/:id/locations` `{location, quantity, unit, container_note}`; `PUT /api/locations/:id`; `DELETE /api/locations/:id`.
* `GET /api/manifest` → `{generated_at, rows:[{location_id, chemical_id, product_name, supplier, location, quantity, unit, container_note, dg_class, subsidiary_class, un_number, packing_group, hazchem_code, proper_shipping_name, signal_word, pictograms}], totals:[{dg_class, litres, kg}]}`
  Only chemicals with `decision = 'hazardous'` that have a storage location. Rows sorted by dg_class then product_name. Totals grouped by `dg_class` (blank class grouped as "Unclassified").
* `GET /api/export/all` → everything the browser needs for the take-it-with-me exports in one go:
  `{generated_at, company, chemicals:[full chemical + sds fields flattened], locations:[...], assessments:[current assessments with control labels], sds_files:[{sds_id, file_name, product_names:[...], has_file}]}`
  (four reads, not one per chemical). SDS PDFs are then fetched one by one from `/api/sds/:id/file`.

### SDS
* `GET /api/sds/:id` metadata (any user). `GET /api/sds/:id/file` streams the PDF from R2
  (`Content-Type: application/pdf`, `Content-Disposition: inline; filename="..."`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=300`).
* `GET /api/sds/:id/chemicals` (lazy) → products using that SDS (max 200).
* admin: `POST /api/sds` multipart (`file` optional PDF, `data` JSON of sds fields, optional `chemical_ids`) → `{id}`;
  `PUT /api/sds/:id` JSON sds fields (changing `issue_date` recomputes `review_due` unless `review_due` is sent) ;
  `POST /api/sds/:id/replace` multipart (`file`, `data`) → creates the NEXT version of the same doc_key, marks the old not current, re-points every chemical
  that used the old row, re-drafts nothing → `{id}`;
  `DELETE /api/sds/:id` only when no chemical uses it; deletes the PDF too.
  `POST /api/chemicals/:id/link-sds` `{sds_id}` ; `POST /api/chemicals/:id/unlink-sds`.

### Assessments
* `GET /api/assessments/:id` (with controls). admin: `POST /api/chemicals/:id/assessments` body = assessment fields + `control_option_ids: []` → `{id}`
  (becomes current, previous current set `is_current = 0`); `PUT /api/assessments/:id` same body; `DELETE /api/assessments/:id`.
  Fields: `assessed_date, sds_date, form, use_description, route_inhalation, route_ingestion, route_absorption, fire_response, spill_response, controls_notes, ppe_notes, risk_level, monitoring_needed, monitoring_note, surveillance_needed, surveillance_note, assessed_by`.
  `assessed_by` defaults to the logged-in admin's name. After any change call `refreshChemicalSummary`.
* Options: `GET /api/options` → `{isolation:[{id,label,active}], ventilation:[...], other:[...], ppe:[...], additional_ppe:[...]}` (inactive only returned for admins, flagged `active:0`).
  admin: `POST /api/options` `{kind,label}`, `PUT /api/options/:id` `{label?, active?, sort_order?}`, `DELETE /api/options/:id` (deactivates if in use).

### Upload (user and admin)
Guards (all enforced in the Worker): PDF only (`%PDF-` magic bytes AND type/extension), size cap (setting `upload_max_mb`, default 15, hard max 25),
per-login rate limit (setting `upload_rate_per_hour`, default 10, counted in `upload_log`), duplicate check (below). Demo mode blocks it.

* `POST /api/uploads/precheck` `{file_hash, file_name, file_size, text_head}` (`text_head` = first ~4000 characters of extracted text)
  → `{ok, exact_duplicate: null | {sds_id, title, chemical_ids}, candidates:[{sds_id, title, supplier, issue_date, chemical_ids, reason}], limits:{max_mb, remaining_this_hour}, ai:{configured, provider}}`.
  Exact duplicate = same `file_hash` already on file as a current or historic version: the UI tells the user and offers nothing to create.
  Candidates = a registered chemical or SDS title that appears in the text head (offered as "this looks like a newer version of ...").
* `POST /api/uploads` multipart: `file` (PDF), `text` (the extracted text, capped at 150,000 chars server-side), `answers` (JSON, below),
  optional `replace_sds_id` (the user chose "newer version of this SDS"), optional `request_id`.
  `answers = {use_where_how, aerosolised: "no"|"sometimes"|"yes", quantity_amount, quantity_unit: "L"|"kg", quantity_note, exposure: "under_15_min"|"15_to_60_min"|"1_to_4_hours"|"over_4_hours"|"not_sure", ventilation: "outdoors"|"good"|"poor"|"none_enclosed"|"not_sure"}`.
  Pipeline: guards → store PDF in R2 → ask the AI (if configured) → validate JSON → check exact fields against the PDF text (blank + flag if absent)
  → create/replace SDS, create chemical(s), draft assessment(s), storage location if a quantity was given → `refreshChemicalSummary`.
  If the same supplier + product name already exists (or `replace_sds_id` given) it becomes a NEW VERSION of that SDS, never a second copy.
  If no AI is configured or the call/validation fails: the SDS and a chemical are still created with the PDF attached (name from the file name or text head),
  `decision` null, and an EMPTY assessment (`source: "blank"`, `risk_level: "uncertain"`) for the admin to complete.
  Response: `{ok, mode: "ai"|"draft_only"|"new_version", chemical_ids, sds_id, assessment_ids, unverified:[...], warnings:[...], ai_error?}`.
* The risk level defaults to `uncertain` unless the SDS text and answers clearly support another level. No reviewer/approval field exists.

### Import (admin)
* `POST /api/import` `{rows:[{product_name, supplier, location, quantity, unit, ...}], dry_run?}` creates chemicals + locations from rows the browser parsed from the
  user's spreadsheet (mapping done in the browser). Returns `{created, skipped, errors:[...]}`. Existing product names (case-insensitive, same supplier) are skipped.

## Front end

Single page, hash routes, no framework. `public/index.html` (shell, CSS theme tokens, login/setup/code screens, nav, print CSS),
`public/app.js` (core), `public/views/<name>.js` (one per screen, self-registering). Libraries come from `/vendor/` (pdf.js is loaded with dynamic
`import()`; the rest are classic scripts loaded on demand by the view that needs them via `App.loadScript(url)`).

Core API on `window.App`:
`App.api(path, {method, body})` → parsed JSON (throws Error with `.status`, `.message`); `App.apiUpload(path, formData)`; `App.me` ({id,name,email,role});
`App.isAdmin()`; `App.settings` (GET /api/settings result) and `App.publicSettings`; `App.esc(s)`; `App.fmtDate(iso)` ("19 Oct 2026");
`App.toast(msg, kind)`; `App.modal({title, body(HTMLElement|string), buttons})`; `App.navigate('#/chemical/12')`;
`App.views.register(name, {title, adminOnly, nav?, render(root, params)})`; `App.loadScript(src)`; `App.loadCss(href)`;
`App.disclaimerHtml()` returns the boxed disclaimer (from `window.DISCLAIMER`); `App.printHeaderHtml()` company name + logo block for printed pages;
`App.riskLabel(level)`, `App.riskBadge(level)`, `App.reviewBadge(status, date)`, `App.pictogramSvg(code, size)`, `App.pictogramRow(list, size)`;
`App.download(filename, blobOrString, mime)`; `App.csv(rows)`; `App.onLeave(fn)` registers cleanup when the route changes.

Routes: `#/review` (home), `#/register`, `#/hazardous`, `#/manifest`, `#/chemical/:id`, `#/chemical/:id/label`, `#/chemical/:id/edit` (admin), `#/upload`,
`#/take-away` (exports), `#/import` (admin), `#/settings` (admin; business, branding, AI, upload limits), `#/users` (admin), `#/options` (admin), `#/help` (opens help.html).
After login the app goes to the hash the user opened (so QR labels work), otherwise `#/review`.

The disclaimer (`App.disclaimerHtml()`) appears on: register, hazardous register, chemical page, assessment (screen and print), manifest, the take-away screen,
the first-run welcome the admin sees after install, and inside every export (spreadsheet header rows, PDF page 1 and footers, the zip's README.txt). Wording lives only in `public/disclaimer.js`.
