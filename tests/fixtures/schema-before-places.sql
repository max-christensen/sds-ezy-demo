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

-- Storage locations: where a chemical is kept and how much. Quantities are totalled for each placard / manifest
-- item (Schedule 11, by GHS hazard class and category) across the site.
CREATE TABLE IF NOT EXISTS storage_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chemical_id INTEGER NOT NULL REFERENCES chemicals(id) ON DELETE CASCADE,
  location TEXT NOT NULL,                 -- e.g. "Workshop - flammables cabinet 1"
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'L',         -- 'L' | 'kg'
  container_note TEXT,                    -- e.g. "4 x 5 L drums"
  spill_compound TEXT,                    -- optional: locations that share a spill compound use the same text (default: the location). Used by the flammable liquid category 4 rule
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loc_chem ON storage_locations(chemical_id);

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
