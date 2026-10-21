-- SDS EZY database schema (Cloudflare D1 / SQLite).
-- Loaded automatically on every deploy (see the deploy script in package.json):
--   wrangler d1 execute DB --remote --file=./schema.sql
-- It is safe to run more than once: every statement is IF NOT EXISTS / INSERT OR IGNORE, so an
-- existing database is left exactly as it is. It never alters a table that already exists, so a
-- future column change needs its own migration step.
--
-- Rows-read note: D1 bills and limits by rows READ, and an unindexed query reads the whole table.
-- Every column used in a WHERE, JOIN or ORDER BY below has an index. The register screens read
-- only the `chemicals` table (which carries a few denormalised summary columns copied from the
-- current SDS and assessment, kept in step by the Worker) so they never need a join per row.

-- Users: admin or user. Only these two roles exist.
--   admin: everything.
--   user : read the register, and upload an SDS. Nothing else (enforced in the Worker).
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',      -- 'admin' | 'user'
  color TEXT NOT NULL DEFAULT '#3B6E71',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,         -- ISO timestamp, about 10 minutes after creation
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_codes_user ON login_codes(user_id);

-- ---------------------------------------------------------------------------------------------
-- SDS: one safety data sheet document (one PDF, one issue). One SDS often covers many products,
-- so chemicals link to an SDS and several chemicals can share one.
-- Versions: all versions of "the same" SDS share a doc_key. Exactly one row per doc_key has
-- is_current = 1. A new version replaces the current one (the old row is kept as history, with
-- is_current = 0) and every chemical pointing at the old row is re-pointed at the new one.
CREATE TABLE IF NOT EXISTS sds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_key TEXT NOT NULL,                  -- random id shared by every version of this SDS
  version_no INTEGER NOT NULL DEFAULT 1,  -- 1, 2, 3 ... within a doc_key
  is_current INTEGER NOT NULL DEFAULT 1,
  title TEXT,                             -- product name(s) as printed on the sheet
  supplier TEXT,
  r2_key TEXT,                            -- PDF in the R2 bucket (sds/<id>-<random>.pdf); NULL if no file
  file_name TEXT,
  file_size INTEGER,
  file_hash TEXT,                         -- SHA-256 hex of the PDF bytes (exact-duplicate check)
  issue_date TEXT,                        -- YYYY-MM-DD, only if it appears in the PDF text
  revision TEXT,                          -- version / revision as printed
  emergency_phone TEXT,                   -- the supplier's emergency number
  review_due TEXT,                        -- issue_date + 5 years (YYYY-MM-DD); NULL when issue_date unknown
  signal_word TEXT,                       -- as printed on the SDS: 'Danger' | 'Warning' | NULL (the chemical's own signal word is DERIVED from its classification)
  hazard_classification TEXT,             -- section 2 classification as printed, for reading; the structured classification is on the chemical
  h_statements TEXT,                      -- e.g. "H225 Highly flammable liquid and vapour; H319 ..."
  p_statements TEXT,
  poison_schedule TEXT,                   -- e.g. "S5", "S6", or NULL
  un_number TEXT,                         -- digits only, e.g. "1993"
  dg_class TEXT,                          -- dangerous goods class, e.g. "3", "8", "2.1"
  subsidiary_class TEXT,
  packing_group TEXT,                     -- 'I' | 'II' | 'III' | NULL
  hazchem_code TEXT,                      -- e.g. "3YE"
  proper_shipping_name TEXT,
  cas_numbers TEXT,                       -- comma list of CAS numbers found on the sheet
  unverified TEXT,                        -- JSON array of field names the AI returned but that were NOT found in the PDF text (left blank); includes "classification" when the H-codes did not match
  source TEXT NOT NULL DEFAULT 'manual',  -- 'upload' | 'manual' | 'import' | 'demo'
  ai_provider TEXT,                       -- which AI read it, or NULL if it was filled by hand
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  replaced_at TEXT                        -- set when a newer version takes over
);
CREATE INDEX IF NOT EXISTS idx_sds_doc ON sds(doc_key, version_no);
CREATE INDEX IF NOT EXISTS idx_sds_hash ON sds(file_hash);
CREATE INDEX IF NOT EXISTS idx_sds_review ON sds(review_due);
CREATE INDEX IF NOT EXISTS idx_sds_current ON sds(is_current);

-- ---------------------------------------------------------------------------------------------
-- Chemicals: the main record (a product). sds_id always points at the CURRENT sds row.
-- The columns marked "summary" are copies kept in step by the Worker (refreshChemicalSummary)
-- so that the review list and the registers read one table only.
CREATE TABLE IF NOT EXISTS chemicals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_name TEXT NOT NULL,
  supplier TEXT,
  synonyms TEXT,                          -- other names, comma or line separated
  product_codes TEXT,                     -- supplier part / product codes
  use_description TEXT,
  physical_form TEXT,                     -- 'liquid' | 'solid' | 'powder' | 'gas' | 'aerosol' | 'paste' | 'other'
  -- GHS classification, from the Safe Work Australia poster (see public/lib/ghs-ref.mjs). JSON array of
  -- {"c": class id, "k": category, "src": "ai"|"h_code"|"admin", "check": true if the category is unconfirmed}.
  -- NULL = not classified yet (no decision can be derived). '[]' = classified and carries none of the classifications (non-hazardous).
  ghs_classification TEXT,
  classification_flags TEXT,              -- JSON array of messages: mismatches between the AI's reading and the H-codes in the SDS text
  decision_override TEXT,                 -- 'hazardous' | 'not_hazardous' | NULL. An admin override of the derived decision (shown as overridden)
  pictograms_override TEXT,               -- NULL, or a comma list of GHS01..GHS09, or 'none'. An admin override of the derived pictograms (shown as overridden)
  decision TEXT,                          -- EFFECTIVE decision: decision_override, else derived from ghs_classification; NULL = no decision yet
  decision_note TEXT,                     -- why, e.g. "Not classified as hazardous per SDS section 2"
  decision_by TEXT,                       -- who decided and how: user name, or "Prepared from the SDS (AI draft)"
  decision_at TEXT,
  sds_id INTEGER REFERENCES sds(id),      -- current SDS, NULL = no SDS on file
  sds_issue_date TEXT,                    -- summary: from the current SDS
  review_due TEXT,                        -- summary: from the current SDS (the review-due list reads this)
  risk_level TEXT,                        -- summary: from the current assessment (see assessments.risk_level)
  dg_class TEXT,                          -- summary: the ADG class from the current SDS. For illustration only: placard and manifest quantities use ghs_classification
  signal_word TEXT,                       -- derived from ghs_classification ('Danger' | 'Warning' | NULL)
  pictograms TEXT,                        -- EFFECTIVE pictograms: pictograms_override, else derived from ghs_classification (comma list of GHS01..GHS09)
  source TEXT NOT NULL DEFAULT 'manual',  -- 'upload' | 'manual' | 'import' | 'demo'
  search_text TEXT NOT NULL DEFAULT '',   -- lower-case name, supplier, synonyms, codes, CAS (maintained by the Worker)
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chem_name ON chemicals(product_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_chem_sds ON chemicals(sds_id);
CREATE INDEX IF NOT EXISTS idx_chem_review ON chemicals(review_due);
CREATE INDEX IF NOT EXISTS idx_chem_decision ON chemicals(decision);
CREATE INDEX IF NOT EXISTS idx_chem_risk ON chemicals(risk_level);

-- Places: where chemicals are kept. A place is a workshop or depot, a vehicle, or a site. Vehicles can have a registration.
-- Archiving hides a place from the active lists but keeps it (and its chemical links) on record.
-- counts_toward_totals: whether the place counts towards the Schedule 11 placard and manifest totals. Defaults (set by the Worker
-- when a place is created): on for workshops and sites, off for vehicles (products in transit fall under the transport rules;
-- see docs/REFERENCE.md, open point). Totals are worked out PER place, never across the whole business.
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  place_type TEXT NOT NULL DEFAULT 'workshop',   -- 'workshop' (workshop or depot) | 'vehicle' | 'site'
  registration TEXT,                              -- vehicles: registration number
  counts_toward_totals INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  notes TEXT,
  chemical_count INTEGER NOT NULL DEFAULT 0,      -- summary: number of chemical_places rows, kept in step by the Worker (so the place picker reads only this table)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_places_list ON places(archived, place_type, name COLLATE NOCASE);

-- A chemical is kept at one or more places, with an optional quantity (litres or kilograms). Chemicals are NOT tracked moving between places.
CREATE TABLE IF NOT EXISTS chemical_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chemical_id INTEGER NOT NULL REFERENCES chemicals(id) ON DELETE CASCADE,
  place_id INTEGER NOT NULL REFERENCES places(id),
  quantity REAL,                                  -- NULL = not recorded
  unit TEXT,                                      -- 'L' | 'kg' (NULL when quantity is NULL)
  container_note TEXT,                            -- e.g. "4 x 5 L drums, left-hand cabinet"
  spill_compound TEXT,                            -- optional: links in the same place with the same text share a spill compound (default: the place). Used by the flammable liquid category 4 rule
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (chemical_id, place_id)
);
CREATE INDEX IF NOT EXISTS idx_cp_place ON chemical_places(place_id);

-- LEGACY: the old single-workplace storage locations. Nothing writes here any more. The migration below copies every
-- row into places / chemical_places and then empties the table, so running schema.sql again (every deploy) changes nothing.
CREATE TABLE IF NOT EXISTS storage_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chemical_id INTEGER NOT NULL REFERENCES chemicals(id) ON DELETE CASCADE,
  location TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'L',
  container_note TEXT,
  spill_compound TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- MIGRATION, storage_locations -> places. Each distinct location name becomes a workshop-or-depot place that counts towards the totals
-- (that is what a storage location was). Each (chemical, location) becomes one link. If the same chemical had the same location with two
-- different units, only the first unit's row is kept (a link has one quantity); this was never a supported case. Safe to repeat:
-- places are only created when missing, links use INSERT OR IGNORE, and the legacy rows are removed once copied.
INSERT INTO places (name, place_type, counts_toward_totals)
  SELECT d.name, 'workshop', 1
  FROM (SELECT MIN(trim(location)) AS name FROM storage_locations WHERE trim(location) != '' GROUP BY lower(trim(location)) ORDER BY lower(trim(location))) d
  WHERE NOT EXISTS (SELECT 1 FROM places p WHERE p.name = d.name COLLATE NOCASE AND p.place_type = 'workshop');
INSERT OR IGNORE INTO chemical_places (chemical_id, place_id, quantity, unit, container_note, spill_compound)
  SELECT l.chemical_id,
         (SELECT p.id FROM places p WHERE p.name = trim(l.location) COLLATE NOCASE AND p.place_type = 'workshop' ORDER BY p.id LIMIT 1),
         SUM(l.quantity), l.unit, group_concat(l.container_note, '; '), MAX(l.spill_compound)
  FROM storage_locations l WHERE trim(l.location) != ''
  GROUP BY l.chemical_id, lower(trim(l.location)), l.unit
  ORDER BY MIN(l.id);
UPDATE places SET chemical_count = (SELECT COUNT(*) FROM chemical_places cp WHERE cp.place_id = places.id)
  WHERE EXISTS (SELECT 1 FROM chemical_places cp WHERE cp.place_id = places.id) OR chemical_count != 0;
DELETE FROM storage_locations WHERE trim(location) != '';

-- ---------------------------------------------------------------------------------------------
-- Assessments: the one-page hazard risk assessment checklist. Linked to the chemical and the SDS
-- it was prepared from. A chemical has one CURRENT assessment (is_current = 1); older ones stay
-- as history. There is no approval step and no reviewer field. assessed_by says who made it:
-- a user's name, or "Prepared from the SDS (AI draft)".
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chemical_id INTEGER NOT NULL REFERENCES chemicals(id) ON DELETE CASCADE,
  sds_id INTEGER REFERENCES sds(id),
  is_current INTEGER NOT NULL DEFAULT 1,
  assessed_date TEXT,                     -- date of assessment, YYYY-MM-DD
  sds_date TEXT,                          -- SDS issue date at the time
  form TEXT,                              -- physical form
  use_description TEXT,                   -- description of use
  route_inhalation INTEGER NOT NULL DEFAULT 0,
  route_ingestion INTEGER NOT NULL DEFAULT 0,
  route_absorption INTEGER NOT NULL DEFAULT 0,
  fire_response TEXT,
  spill_response TEXT,
  controls_notes TEXT,                    -- extra isolation / ventilation / other controls in words
  ppe_notes TEXT,                         -- extra PPE in words
  risk_level TEXT NOT NULL DEFAULT 'uncertain',
                                          -- 'not_significant' | 'significant_controlled' | 'significant_not_controlled' | 'uncertain'
  monitoring_needed INTEGER,              -- atmospheric monitoring: 1 yes, 0 no, NULL not decided
  monitoring_note TEXT,
  surveillance_needed INTEGER,            -- health surveillance: 1 yes, 0 no, NULL not decided
  surveillance_note TEXT,
  assessed_by TEXT,                       -- user name, or "Prepared from the SDS (AI draft)"
  source TEXT NOT NULL DEFAULT 'manual',  -- 'ai' | 'manual' | 'import' | 'demo' | 'blank'
  answers TEXT,                           -- JSON: the upload questions and answers this was drafted from
  unverified TEXT,                        -- JSON array of fields flagged because they were not found in the SDS text
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assess_chem ON assessments(chemical_id, is_current);
CREATE INDEX IF NOT EXISTS idx_assess_sds ON assessments(sds_id);

-- Standard option lists the admin can add to: controls and PPE.
CREATE TABLE IF NOT EXISTS control_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                     -- 'isolation' | 'ventilation' | 'other' | 'ppe' | 'additional_ppe'
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (kind, label)
);
CREATE INDEX IF NOT EXISTS idx_opt_kind ON control_options(kind, sort_order);

CREATE TABLE IF NOT EXISTS assessment_controls (
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES control_options(id) ON DELETE CASCADE,
  PRIMARY KEY (assessment_id, option_id)
);
CREATE INDEX IF NOT EXISTS idx_ac_option ON assessment_controls(option_id);

-- One row per upload attempt by a login, for the per-hour rate limit.
CREATE TABLE IF NOT EXISTS upload_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL                -- ISO timestamp
);
CREATE INDEX IF NOT EXISTS idx_upload_user_time ON upload_log(user_id, created_at);

-- Starting option lists. INSERT OR IGNORE, so admin changes (renames, deactivations) survive a redeploy.
INSERT OR IGNORE INTO control_options (kind, label, sort_order) VALUES
  ('isolation', 'Lids kept on containers when not in use', 10),
  ('isolation', 'Stored in a bunded or spill-contained area', 20),
  ('isolation', 'Segregated from incompatible chemicals', 30),
  ('isolation', 'Stored in a flammable liquids cabinet', 40),
  ('isolation', 'Locked or access restricted storage', 50),
  ('ventilation', 'Natural / general ventilation', 10),
  ('ventilation', 'Local exhaust ventilation', 20),
  ('ventilation', 'Fume cupboard', 30),
  ('ventilation', 'Use outdoors or in an open area', 40),
  ('other', 'Small quantities only', 10),
  ('other', 'Keep exposure time short', 20),
  ('other', 'Read the SDS before use', 30),
  ('other', 'No ignition sources nearby', 40),
  ('other', 'Spill kit available', 50),
  ('other', 'Wash hands after use; no eating or drinking', 60),
  ('ppe', 'Safety glasses', 10),
  ('ppe', 'Chemical-resistant gloves', 20),
  ('ppe', 'Overalls or long sleeves', 30),
  ('ppe', 'Safety footwear', 40),
  ('additional_ppe', 'Chemical goggles', 10),
  ('additional_ppe', 'Face shield', 20),
  ('additional_ppe', 'P2 dust mask', 30),
  ('additional_ppe', 'Half-face respirator with suitable filter', 40),
  ('additional_ppe', 'Chemical-resistant apron', 50);

-- ---------------------------------------------------------------------------------------------
-- CHEMICAL AUDITS. Someone walks a place (workshop, vehicle or site) and marks each chemical Present, Not found or Changed,
-- photographs things, records items found that are not on the register, and flags items for disposal. Nothing here changes the
-- register by itself: "Not found" and "Changed" become FINDINGS that an admin accepts or dismisses. A user can write audit
-- records and uploads only (see docs/AUDIT-CHANGE.md). These tables are all new, so there is nothing to migrate and no existing
-- table is altered. Rows keep snapshots (place name, product name, expected quantity) so an old audit still reads correctly after
-- the register changes, and chemical / link ids in these tables are plain numbers, not foreign keys, for the same reason.
--
-- Every row a phone creates carries a client_id the phone made up, so any request can be sent twice (a flaky signal, an offline
-- queue replaying) without making a second row. Times that matter (started, marked, taken, found, flagged) are the DEVICE's time,
-- because the phone may be offline; received_at / created_at are the server's.

CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT,                                 -- made up by the phone; unique per person
  place_id INTEGER NOT NULL REFERENCES places(id),
  place_name TEXT NOT NULL,                       -- snapshots
  place_type TEXT NOT NULL,
  place_registration TEXT,
  started_by INTEGER NOT NULL REFERENCES users(id),
  started_by_name TEXT NOT NULL,
  started_at TEXT NOT NULL,                       -- device time, ISO
  finished_at TEXT,                               -- device time, ISO; NULL while in progress
  finished_by INTEGER REFERENCES users(id),
  finished_by_name TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',     -- 'in_progress' | 'finished'
  notes TEXT,
  summary TEXT,                                   -- JSON of the counts, written when the audit is finished
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (started_by, client_id)
);
CREATE INDEX IF NOT EXISTS idx_audits_place ON audits(place_id, started_at);
CREATE INDEX IF NOT EXISTS idx_audits_user ON audits(started_by, started_at);
CREATE INDEX IF NOT EXISTS idx_audits_status ON audits(status, started_at);

-- One row per chemical linked to the place when the audit started.
CREATE TABLE IF NOT EXISTS audit_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  chemical_id INTEGER NOT NULL,                   -- plain number (see above)
  link_id INTEGER,                                -- chemical_places.id at the start; may be gone later
  product_name TEXT NOT NULL,                     -- snapshots at the start of the audit
  supplier TEXT,
  expected_quantity REAL,
  expected_unit TEXT,
  expected_container_note TEXT,
  review_due TEXT,
  review_status TEXT,                             -- 'overdue' | 'due_soon' | 'ok' | 'no_sds' | 'unknown'
  has_sds INTEGER NOT NULL DEFAULT 0,
  has_assessment INTEGER NOT NULL DEFAULT 0,
  risk_level TEXT,
  result TEXT,                                    -- NULL = not marked yet | 'present' | 'not_found' | 'changed'
  note TEXT,
  new_quantity REAL,                              -- 'changed': what it is now (any of these, with or without a note)
  new_unit TEXT,
  new_container_note TEXT,
  marked_at TEXT,                                 -- device time
  UNIQUE (audit_id, chemical_id)
);
CREATE INDEX IF NOT EXISTS idx_aitems_audit ON audit_items(audit_id);

-- Something found that is not on the register (or not linked to this place).
CREATE TABLE IF NOT EXISTS audit_found (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  supplier TEXT,
  source TEXT NOT NULL DEFAULT 'typed',           -- 'ai' (read from the label photo) | 'typed'
  ai_provider TEXT,
  matched_chemical_id INTEGER,                    -- a register match the person confirmed
  chemical_id INTEGER,                            -- the chemical it ended up as (the match, or the new "needs an SDS" one)
  outcome TEXT NOT NULL DEFAULT 'recorded',       -- 'linked' (admin linked it now) | 'link_suggested' (a user: becomes a finding) | 'created' (new chemical, needs an SDS) | 'recorded'
  note TEXT,
  found_at TEXT NOT NULL,                         -- device time
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (audit_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_afound_audit ON audit_found(audit_id);

-- An item flagged for disposal, from an audit. Status to_dispose -> disposed (an admin closes it with a note and optionally a photo).
CREATE TABLE IF NOT EXISTS audit_disposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  place_id INTEGER NOT NULL,
  place_name TEXT NOT NULL,
  chemical_id INTEGER,                            -- optional: the register chemical it is
  description TEXT NOT NULL,
  reason TEXT NOT NULL,                           -- 'expired' | 'unlabelled' | 'damaged' | 'unknown' | 'no_sds'
  note TEXT,
  status TEXT NOT NULL DEFAULT 'to_dispose',      -- 'to_dispose' | 'disposed'
  flagged_by INTEGER NOT NULL,
  flagged_by_name TEXT NOT NULL,
  flagged_at TEXT NOT NULL,                       -- device time
  closed_by INTEGER,
  closed_by_name TEXT,
  closed_at TEXT,
  close_note TEXT,
  UNIQUE (audit_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_adisp_status ON audit_disposals(status, flagged_at);
CREATE INDEX IF NOT EXISTS idx_adisp_audit ON audit_disposals(audit_id);

-- What the admin works through. Written when an audit is finished. Accepting one changes the register (unlink from the place,
-- update the quantity, link a found item); dismissing changes nothing.
CREATE TABLE IF NOT EXISTS audit_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                             -- 'not_found' | 'changed' | 'found_link'
  chemical_id INTEGER,
  place_id INTEGER NOT NULL,
  place_name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  link_id INTEGER,
  audit_item_id INTEGER,
  found_id INTEGER,
  details TEXT,                                   -- JSON: expected quantity/unit/container, new quantity/unit/container, the person's note
  status TEXT NOT NULL DEFAULT 'open',            -- 'open' | 'accepted' | 'dismissed'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_by INTEGER,
  resolved_by_name TEXT,
  resolved_at TEXT,
  resolve_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_afind_status ON audit_findings(status, created_at);
CREATE INDEX IF NOT EXISTS idx_afind_audit ON audit_findings(audit_id);

-- Photos, kept in R2 (key audits/<audit_id>/<uuid>.jpg). Only ever served to someone who can see the audit.
CREATE TABLE IF NOT EXISTS audit_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,                       -- 'item' | 'found' | 'disposal' | 'disposal_close' | 'audit'
  owner_key TEXT,                                 -- item: the chemical id; found / disposal / disposal_close: that row's client_id; audit: NULL
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  taken_at TEXT NOT NULL,                         -- when the photo was taken (device time)
  uploaded_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (audit_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_aphotos_audit ON audit_photos(audit_id, owner_type, owner_key);

-- When each place was last audited (a small summary table so the review list and the place picker never read audit history).
CREATE TABLE IF NOT EXISTS place_audit_summary (
  place_id INTEGER PRIMARY KEY REFERENCES places(id),
  last_audit_id INTEGER NOT NULL,
  last_audited_at TEXT NOT NULL                   -- the finish time of the latest finished audit
);
CREATE INDEX IF NOT EXISTS idx_pas_when ON place_audit_summary(last_audited_at);

-- One row per label-photo read by the AI, for the per-person hourly limit.
CREATE TABLE IF NOT EXISTS audit_ai_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aailog_user_time ON audit_ai_log(user_id, created_at);
