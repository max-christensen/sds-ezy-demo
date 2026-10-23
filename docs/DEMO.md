# SDS EZY demo

A read-only demo register for a made-up business, **Tallowood Joinery & Maintenance Pty Ltd** (a small joinery, workshop
and building maintenance company). Everything is fictional: the company, its address (`Sampleton NSW 2999`), phone numbers
(`(02) 5550 0100`, `1800 555 01xx`), e-mail addresses (`example.invalid`), the suppliers and brands (Marlow, Kestrel,
Stickfast, Brightboard, Ironwood, Fernhill, Wattlebird, Quillon, Harbourlight, Tidewater, Bluegum) and the safety data sheets.
Every generated PDF carries the banner **FICTIONAL DEMONSTRATION DOCUMENT - NOT A REAL SAFETY DATA SHEET** at the top of every
page. The CAS numbers are the real, public numbers of the generic substances named (acetone 67-64-1, ethanol 64-17-5, and so on).

## Demo logins

| Role | Email | Password |
|---|---|---|
| Admin | `demo-admin@example.invalid` | `demo-Ezy-2026` |
| User | `demo-user@example.invalid` | `demo-Ezy-2026` |

This password is public on purpose and exists **only** for the demo. Never reuse it for anything real. Demo logins skip the
emailed code. In the demo Worker (`DEMO_MODE=1`) every write is blocked for both roles, so uploads are blocked too.

## What is in it (for `--today 2026-10-19`; the counts stay the same for any date)

* **67 chemicals**: 50 hazardous, 15 not hazardous, 2 with no decision yet (the two-stroke fuel mix, which is **not classified**: `ghs_classification` is NULL; and the "needs an SDS" placeholder found during the Ute 2 audit).
* **GHS classification** (Safe Work Australia poster table, `public/lib/ghs-ref.mjs`) on every chemical, stored as JSON in `ghs_classification`; `decision`, `signal_word` and `pictograms`
  are the effective values from `effective()`. Non-hazardous products are `[]`. Examples: lacquer thinners = Flam. Liq. 2, Asp. Tox. 1, Skin Irrit. 2, Eye Irrit. 2A, STOT SE 3, Repr. 2, STOT RE 2;
  battery acid = Skin Corr. 1A + Met. Corr. 1; cement = Skin Irrit. 2, Eye Dam. 1, Skin Sens. 1, STOT SE 3; spray paints = Aerosol 1.
* **Visible overrides and flags** (one each): Marlow Mineral Turpentine has a pictogram override adding GHS09 (environment; the table never derives it); Ironwood Hydraulic Oil 46 has a decision override
  (classification `[]`, derives not hazardous, overridden to hazardous because it is used hot); Tidewater Drain Unblocker Gel has a `check:true` entry
  (Skin Corr. 1B is the AI's reading, its sheet prints "Skin Corr. 1" with no letter) plus a `classification_flags` message and `sds.unverified = ["classification"]`.
  The concrete sealer tin has no SDS and an admin-entered classification (`src: "admin"`).
* **51 SDS rows / PDFs**: 50 current + 1 old version. Section 2 of each sheet states the classification in the usual abbreviations with H-codes ("Flam. Liq. 2 (H225)"), the signal word, and pictogram names and codes as text (no images).
  Their sheets are checked by `verifyClassification` in the tests: nothing removed and no flags, apart from the one deliberately flagged sheet.
* **Shared SDS**: Brightboard plaster sheet shared by 10 products, Stickfast Grip Max adhesive sheet by 4 pack sizes
  (cartridges and a pail), Kestrel acrylic paints by 3, Kestrel oil stain by 2.
* **SDS version history**: Marlow Methylated Spirits, v1 (replaced) and v2 (current); the chemical page shows the history and an older assessment.
* **Review status**: 5 past the five-year review date (overdue), 4 due within 90 days, 55 in date, 1 SDS with no issue date (unknown), 1 chemical with no SDS.
* **Risk levels** (current assessment): 25 not significant, 33 significant but controlled, 4 significant and not controlled, 3 uncertain (one is a blank assessment, one has no SDS), plus 1 chemical with no assessment at all (the soldering flux).
* **Places** (5, ids fixed so links stay valid after seeding) and **109 chemical links** (`chemical_places`; `places.chemical_count` matches the links; the legacy `storage_locations` table is not written):

  | id | Place | Type | Counts toward totals | Chemicals | Notes |
  |---|---|---|---|---|---|
  | 1 | Tallowood workshop | workshop | yes | 62 | gas cage, fuel cube, flammables cabinets, paint, maintenance, cleaners, plaster and yard stock |
  | 2 | Harbour Road job site | site | yes | 11 | heaters, cutting kit, aerosols, a few finishing products |
  | 3 | Ute 1 (rego TWD 001) | vehicle | no | 15 | painting and finishing kit |
  | 4 | Ute 2 (rego TWD 002) | vehicle | no | 18 | maintenance, cleaning and aerosol kit |
  | 5 | Ute 3 (sold) (rego TWD 003) | vehicle, **archived** | no | 3 | keeps its links on record, is not totalled |

  Every chemical is kept in at least one place (35 are in two or more). Some links have no quantity (hand cleaner in both utes, glass cleaner in Ute 2, the plaster patch compound on site). Quantities are in L and kg; a link with a quantity always has a unit.
  Spill compounds are named on the flammable-liquid links (Cabinet 1 sump, Cabinet 2 sump, Paint store bund, Fuel cube bund, Generator shed, Maintenance store, Site generator, Decking area).

### Expected per-place totals (asserted in `tests/demo-data.test.mjs` with `computePlaceTotals`)

Totals are per place, never across the business. Vehicles and the archived place count nothing (they show the transport note, which is the project owner's unconfirmed understanding).

| Place | Item | Total | Placard | Manifest | Status |
|---|---|---|---|---|---|
| Tallowood workshop | 8 Flammable liquids cat 3 | 854.6 L | 1000 | 10000 | **NEAR** the placard quantity (85%); includes the 20 L of category 4 decking oil that shares the "Paint store bund" compound with the stains and varnish (counted as category 3), and 760 L of diesel (700 L in the fuel cube + 60 L cans) |
| Tallowood workshop | 9 Flammable liquids, any mix of items 6 to 8 | 943.6 L | 1000 | 10000 | **NEAR** (94%); item 6 = 30 L (limit 50), item 7 = 59 L (limit 250), item 8 as above, none over on its own |
| Tallowood workshop | 1 Flammable gases | 145 L | 200 | 5000 | under (45 kg LPG cylinder about 105 L + acetylene 40 L) |
| Tallowood workshop | 4, 5, 25, 28, 37, 38, 40, 41 | | | | all well under |
| Harbour Road job site | 1 Flammable gases | 210 L | 200 | 5000 | **OVER the placard quantity** (2 x 45 kg LPG heater cylinders) |
| Harbour Road job site | 10 Flammable liquids cat 4 | 10 L | 10000 | 100000 | decking oil in its own tray ("Decking area"), so it is not counted as category 1 with the petrol |
| Harbour Road job site | 6 / 8 / 9 / 5 | 20 / 4 / 24 / 3 | | | well under |

* **Vehicles matter**: Ute 1 and Ute 2 together hold about 152 L of category 3 flammable liquid (120 L of diesel cans in Ute 2). If their stock were added to the workshop, item 8 would reach 1006.6 L and go OVER its placard quantity. The test checks this. Because vehicles do not count, the workshop stays "near".
* **No place is over a manifest quantity** (those start at 2500 L for anything this business holds, which a small joinery cannot realistically reach without breaking the rest of the story).
* **Unit mismatch** (job site): the 12 x 400 g spray enamel cans are recorded as 4.8 kg; item 5 (aerosols) is in litres, so that quantity is not counted and appears as an issue.
* **Other issues**: in the workshop, acute toxicity category 4 liquids have no item (counted as issues), 1 "no classification" (the two-stroke fuel mix, 5 L), and products that count towards more than one item; the job site has 1 acute toxicity category 4 notice.

### Sample job pack

Open (after signing in as either demo login): `#/pack?place=4&client=Smith%20Street%20Primary%20School&ref=JOB-1042&date=2026-10-19`
(`make-demo` writes the exact link, with the build date, to `demo-out/summary.json` as `sample_pack`). It builds a pack from **Ute 2** (id 4, 18 chemicals: aerosols, adhesives, cleaning products, petrol, diesel cans, rust converter and so on).
It is built to show the "missing" wording:

* **No SDS on file**: "Concrete Sealer (solvent-based, unlabelled tin)" (chemical id 66, classified by an admin from the can, has an assessment) and the audit placeholder "Rapidset Tile Adhesive (found on Ute 2, needs an SDS)" (id 67).
* **No assessment on file**: "Wattlebird Soldering Flux Paste" (id 38, has an SDS) and the placeholder (id 67).
* Everything else in Ute 2 has an SDS and an assessment; two of its SDS are past their review date (brake cleaner and the neutral cure silicone sealant) so the review badge is also visible.

Issue dates are computed from the build date (`--today`), so the overdue/due-soon counts do not drift as time passes.

### Audits (the audit story)

Three audits are seeded (tables `audits`, `audit_items`, `audit_found`, `audit_disposals`, `audit_findings`, `audit_photos`, `place_audit_summary`; built by `scripts/demo/audits.mjs`, dates relative to `--today`).
Links assume the demo is signed in as the user named; the demo admin sees all three, `demo-user` sees only its own (audits 1 and 2).

| id | Place | Who | When | State | Open it |
|---|---|---|---|---|---|
| 1 | Ute 2 (id 4) | demo-user | 3 days ago, 09:10 to 10:05 | **finished** | `#/audit/1/summary`, report `#/audit/1/report` |
| 2 | Tallowood workshop (id 1) | demo-user | started today 08:30 | **in progress**, 21 of 62 marked | `#/audit/2` |
| 3 | Tallowood workshop (id 1) | demo-admin | 130 days ago | finished (older than the 90-day reminder) | `#/audit/3/report` (admin) |

Lists: `#/audits` (my audits; the admin sees all), `#/findings` and `#/disposals` (admin). Place pages: `#/place/4` (Ute 2, last audited 3 days ago) and `#/place/1` (workshop, last audited 130 days ago).

**Audit 1 (Ute 2, completed).** 17 items (the chemicals linked when it started): 15 present, 1 **not found** (the 5 L liquid chlorine bottle), 1 **changed** (petrol 10 L, now 5 L in a "half-used 10 L jerry can");
notes on the petrol, the cracked soldering flux and the unlabelled concrete sealer. Items are listed out-of-date first (overdue, due soon, no SDS, then the rest).
Two **found items**: a tile adhesive that is not on the register became a "needs an SDS" placeholder chemical (chemical id 67, `source = "audit"`, no SDS, no classification, no decision, no assessment, linked to Ute 2 with no quantity, so Ute 2 now has 18 links);
a dishwashing detergent matched an existing chemical (outcome `link_suggested`, because a user cannot link: it became a `found_link` finding and is **not** linked to Ute 2 yet).
Two **disposals**: expired brake cleaner (open, to dispose, with a photo) and a cracked drain-unblocker bottle (disposed: closed by demo-admin the next day with a note and a closing photo).
Summary JSON: `{listed 17, present 15, not_found 1, changed 1, not_marked 0, found 2, disposals 2, photos 9, photo_bytes}` (the closing photo was added a day after the audit finished, so it is not in the summary count; it is in the report).
**Findings**: open = 1 not_found (liquid chlorine), 1 changed (petrol), 1 found_link (dishwashing detergent). From audit 3 (the old workshop walk-round): 1 **accepted** (turpentine quantity changed, already reflected on its link) and 1 **dismissed** (hand cleaner "not found", still on the register), so all three states show.

**Photos**: 11 fictional JPEGs in total (640 x 480, about 30 KB each), drawn cartoons of a tin, jerry can, tub, bottle, aerosol or shelf on a bench with a blocky-text label and "FICTIONAL DEMO PHOTO" in the corner (generated with `jpeg-js`, no real brands or people).
10 on audit 1 (3 item photos, 3 on found items, 2 on disposals, 1 closing photo, 1 audit-level shelf photo) and 1 on audit 2. Storage per audit (R2 bytes): audit 1 about 320 KB, audit 2 about 34 KB (well under the 40 MB cap). Files are in `demo-out/photos/audits/<audit id>/<uuid>.jpg` and `seed-demo-local.mjs` uploads them to the local bucket under the same `audits/<id>/<uuid>.jpg` key.

**Reminders** (90 days): the Review home's "not audited" list shows the workshop (130 days), the Harbour Road job site and Ute 1 (never). Ute 2 is recent, and the archived ute is excluded.
Chemical counts after the audit: 67 chemicals (50 hazardous, 15 not hazardous, 2 with no decision: the two-stroke mix and the audit placeholder), 109 links.

## Build and load locally

```bash
node scripts/make-demo.mjs --today 2026-10-19      # writes demo-out/demo.sql, demo-out/pdfs/sds/*.pdf, demo-out/summary.json
node scripts/seed-demo-local.mjs                    # builds if needed, then loads LOCAL D1 + LOCAL R2 only
node scripts/seed-demo-local.mjs --persist-to ./.wrangler/state --dry-run   # print the wrangler commands without running them
```

`demo-out/` is git-ignored (it has its own `.gitignore`); only the generator (`scripts/make-demo.mjs`, `scripts/demo/`) is committed.
`seed-demo-local.mjs` refuses `--remote`, passes `--local --persist-to <dir>` to every wrangler call and reads nothing from
`wrangler.toml` (wrangler resolves the `DB` binding itself). It applies `schema.sql`, runs `demo.sql`, then uploads each PDF to the
local `sds-ezy-files` bucket under the same key stored in the `sds.r2_key` column. `demo.sql` begins by clearing the register
tables (users, sds, chemicals, locations, assessments), so only ever load it into a throwaway or demo database.

Then start the Worker on the same state: `npx wrangler dev --persist-to ./.wrangler/state`.

Suggested npm scripts for `package.json`:

```json
"demo:build": "node scripts/make-demo.mjs",
"demo:seed:local": "node scripts/seed-demo-local.mjs",
"answer-key": "node scripts/answer-key.mjs",
"answer-key:selftest": "node scripts/answer-key.mjs --self-test"
```

## The live demo (https://sds-ezy-demo.max-christensen.workers.dev)

The live demo is a **separate Worker, `sds-ezy-demo`, with its own D1 database (`sds-ezy-db`) and R2 bucket (`sds-ezy-files`)**, created by the Deploy to Cloudflare button. It never shares a database or bucket with a real register. It was set up like this (the IDs belong in a git-ignored config outside the repository, never in a commit):

1. The button deployed the Worker. On its first request the Worker created its own tables ([DEPLOY.md](DEPLOY.md)).
2. Build the data for the day: `node scripts/make-demo.mjs --today YYYY-MM-DD`.
3. Make a config that names only the demo Worker, its database ID and its bucket (not committed), and pass it with `-c` to every remote command. Check `wrangler whoami` and the database ID first.
4. Load the data: `wrangler d1 execute DB --remote --yes --file=./demo-out/demo.sql -c <that config>`. `demo.sql` clears and reloads the register tables and leaves `settings` alone, so the Worker keeps its signing key.
5. Upload the PDFs and photos (key = path under `demo-out/pdfs` or `demo-out/photos`; PDFs go to `sds/<file>.pdf`, photos to `audits/<id>/<file>.jpg`):

   ```bash
   for f in demo-out/pdfs/sds/*.pdf; do
     wrangler r2 object put "sds-ezy-files/sds/$(basename "$f")" --file "$f" --content-type application/pdf --remote -c <config>
   done
   for f in demo-out/photos/audits/*/*.jpg; do
     wrangler r2 object put "sds-ezy-files/${f#demo-out/photos/}" --file "$f" --content-type image/jpeg --remote -c <config>
   done
   ```
6. Switch on demo mode with **secrets**, not dashboard or config variables, because the button's builds run `wrangler deploy` on every change and that removes variables that are not in the committed config (secrets survive):

   ```bash
   echo -n 1 | wrangler secret put DEMO_MODE -c <config>
   echo -n demo-admin@example.invalid | wrangler secret put DEMO_ADMIN_EMAIL -c <config>
   echo -n demo-user@example.invalid | wrangler secret put DEMO_USER_EMAIL -c <config>
   ```

   No AI key, `RESEND_API_KEY` or `SETUP_KEY` is set on the demo.

To refresh the dates later, rebuild with a new `--today` and repeat steps 4 and 5. In demo mode the app itself cannot change anything, so refreshing is done with these commands.

### Rows read on the live database (measured 22 Oct 2026, D1 `meta.rows_read` per request, via a temporary `DEBUG_ROWS` secret that was removed straight afterwards)

| Request | Rows read |
|---|---|
| Sign in (admin / user) | 1 to 2 |
| Who am I (`/api/me`) | 1 |
| Register (all 67 chemicals) | 68 |
| A chemical page (ids 1, 5, 30, 66) | 44, 45, 53, 8 |
| Place page (workshop, 62 chemicals) | 130 |
| Review home | 35 |

The free plan allows 5 million rows read per day, so a demo visit costs a tiny part of it.

## Answer-key harness (real files, kept out of git)

`scripts/answer-key.mjs` checks the app's AI reading against your own completed work. Put these in the git-ignored `seed-local/` folder:

* a Word file of the completed hazard assessments (`.docx`, the 54 assessments)
* the Excel register (`M.E.C. SDS Register.xlsx`)
* the real SDS PDFs (Liquid Nails Heavy Duty, Gyprock plaster-based cements and adhesives, Chemset 101 Plus)

```bash
node scripts/answer-key.mjs                                   # uses src/ai.js runExtraction with env from .dev.vars
node scripts/answer-key.mjs --provider claude --model <name>  # pick a provider (claude | openai | gemini | workers_ai)
node scripts/answer-key.mjs --provider openai-compatible --base-url http://localhost:11434/v1 --api-key-env LOCAL_KEY --model <name>
node scripts/answer-key.mjs --extractor ./my-reader.mjs       # any module: default export async ({text, fileName, provider, model, env}) => object
node scripts/answer-key.mjs --self-test                       # runs against invented stand-in files, no AI, no real data
```

It extracts text from each PDF (pdfjs legacy build), reads each SDS with the app's reader, parses the `.docx` (checkbox glyphs `☒ ☐`, `[x]`,
Word content-control checkboxes and symbol-font boxes, table or plain "Label: value" layouts), matches each assessment to its SDS (an assessment
product name is found in the sheet text, which is how ten plaster products map to one sheet), and prints a table of how many assessments agree on
product, supplier, form, routes of entry, controls, PPE, risk level, UN number, class, packing group and Hazchem. A second line compares the register.

Privacy: the console shows only field names, counts and SDS file names. "Assessed by" names, phone numbers and e-mails are never extracted.
Reports go to `seed-local/answer-key-report.json` (and, with `--detail`, scrubbed values to `seed-local/answer-key-detail.json`). Reader results are
cached in `seed-local/answer-key-cache/` (`--no-cache` to skip). With the files absent it prints what to add and exits 0.

## Tests

`npm test` runs `tests/demo-data.test.mjs` (loads the generated SQL into an in-memory SQLite via `node:sqlite` after `schema.sql`; needs Node 22.5 or newer, otherwise it
skips with a message) `tests/demo-audits.test.mjs` (the audit story against `schema.sql`: counts, visibility, findings match items, summary JSON matches rows, every photo decodes as a JPEG, the reminder list, R2 bytes per audit) and `tests/demo-answer-key.test.mjs` (parsers against synthetic stand-ins, privacy checks, and the `--remote` refusal).
