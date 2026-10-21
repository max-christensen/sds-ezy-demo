# Change: official pictograms, classification from the poster, quantities from Schedule 11

This supersedes the parts of ARCHITECTURE.md that mention eight hand-ticked pictograms, `pictograms` on the SDS, and totals "by
dangerous goods class". Everything below is decided; build to it. Where the reference documents are unclear we do NOT guess: the
code reports an `issue` and the screens show it.

## Single source of truth: `public/lib/ghs-ref.mjs`

A pure ES module (no dependencies, no I/O). The Worker imports it (`import ... from "../public/lib/ghs-ref.mjs"`), the browser loads it with
`await import("/lib/ghs-ref.mjs")`, the tests import it directly. **Never copy its tables or rules into another file.** Read the file; its header
comment and the tests in `tests/ghs-ref.test.mjs` are the specification. Exports you will use:

* `PICTOGRAMS` (nine: GHS01..GHS09, each `{code, name, file, meaning}`), `PICTOGRAM_CODES`, `pictogramInfo(code)`.
* `HAZARD_ROWS`, `HAZARD_CLASSES` (`{id, label, categories}`), `H_STATEMENTS`, `categoryText(k)`, `classLabel(c)`, `classificationLabel({c,k})`, `rowsFor(c,k)`.
* `normaliseClassification(list)` -> `{list, dropped}`; use it on ANY classification coming from a request body or the AI.
* `derive(classification)` -> `{known, decision, pictograms, signal_word, hCodes, rows}` and `effective(classification, {decision, pictograms})` ->
  `{decision, pictograms, signal_word, derived:{...}, decision_overridden, pictograms_overridden, known}`; `parsePictogramList`, `pictogramListToText`.
* `extractHCodes(text)`, `section2Text(text)`, `verifyClassification(aiList, text)` -> `{list, flags, removed}`, `promptClassList()`.
* `PLACARD_ITEMS` (Items 1 to 43), `PLACARD_NOTES`, `FLAM_LIQ_CAT4_RULE`, `ADG_COLUMN_NOTE`, `itemsForClassification(classification)`,
  `computeSiteTotals(entries)` (see the file for the entry shape and result shape).

## Pictograms

* The nine official images are in `public/pictograms/` (copied byte-for-byte from the project owner's `info/` folder; do not edit, redraw, trace,
  recolour or re-encode them). Eight are 220x220 GIF with a white background; the flame is a 220x220 JPEG. Always show them with
  `<img src="/pictograms/..." width height alt="GHS02 Flame">`; use `PICTOGRAMS[i].file`.
* The old inline-SVG pictograms and the old eight codes (`toxic health flame exclamation oxidising gas environment corrosive`) are REMOVED everywhere:
  code, UI, exports, demo, tests. Pictograms are stored and passed around as GHS codes (`"GHS02,GHS07"`).
* Sizes (they are only 220 px): screen 40 to 56 CSS px; printed pages and labels at most about 25 mm (about 220 dpi). Never upscale beyond that.
  Set `image-rendering: auto`. In the PDF bundle, pdf-lib cannot embed GIF: decode the GIF in the browser (`createImageBitmap` + canvas) and embed
  the result as PNG at the same pixel size (lossless, no resampling); embed the JPEG as is.

## Classification (D1: `schema.sql`, already updated; read it)

* `chemicals.ghs_classification`: JSON array `[{"c":"flam_liq","k":"2","src":"ai","check":true?}]`, or NULL = not classified yet, or `[]` = classified and carries none
  of the classifications (non-hazardous). Class ids and categories are exactly those in `HAZARD_CLASSES`.
* `chemicals.decision`, `signal_word`, `pictograms` are the EFFECTIVE values, maintained by the Worker from `effective(classification, {decision: decision_override,
  pictograms: pictograms_override})`. Never write them directly from a request. `decision_override` (`hazardous`|`not_hazardous`|NULL) and `pictograms_override`
  (NULL | comma list of GHS codes | `none`) hold the admin's overrides. An override is VISIBLE: wherever the effective value is shown on a chemical page, show
  "Overridden by an admin (derived: ...)" next to it; in registers a small marker.
* `classification_flags`: JSON array of message strings (mismatches with the SDS H-codes). `sds.unverified` also gets `"classification"` when there are flags.
* The SDS keeps what it printed: `signal_word`, `hazard_classification` text, `h_statements`, `p_statements`, `cas_numbers`. ADG class (`dg_class`, `subsidiary_class`),
  `un_number`, `packing_group`, `hazchem_code`, `proper_shipping_name` stay as separate SDS fields (they are on the SDS). The `sds.pictograms` and `sds.hazardous`
  columns no longer exist.
* A product carrying none of the classifications is non-hazardous (`derive([])`). A product that has not been classified (`null`) has NO decision: it appears
  in the review list's "no decision" group.
* `refreshChemicalSummary` keeps copying `sds_id, sds_issue_date, review_due, dg_class` (from the current SDS), `risk_level` and `search_text` in SQL. A new helper
  (suggest `applyClassification(env, chemicalId|ids, classification, source)` in register.js) computes the effective decision/signal/pictograms in JS from the
  ref module and writes them. Call it whenever `ghs_classification`, `decision_override` or `pictograms_override` change.

## API changes

* `GET /api/chemicals` list items: `pictograms` is a GHS comma list; add `decision_overridden` and `pictograms_overridden` booleans.
* `GET /api/chemicals/:id` -> chemical gains `classification` (parsed array or null), `classification_flags` (array), `decision_override`, `pictograms_override`, and
  `derived: {decision, pictograms, signal_word}`, `decision_overridden`, `pictograms_overridden`. The old `sds.pictograms` is gone.
* `POST/PUT /api/chemicals`: accept `ghs_classification` (array or null; run through `normaliseClassification`; admin entries get `src:"admin"`; `null` clears to
  "not classified"; `[]` means "classified: none"), `decision_override` (`hazardous`|`not_hazardous`|null to clear), `pictograms_override` (array, comma list, `"none"`, or null to clear).
  The plain `decision` field is no longer accepted (ignore it). Setting any of these recomputes the effective columns and records `decision_by`/`decision_at`
  when the effective decision changes.
* Storage locations accept and return `spill_compound`.
* `GET /api/manifest` -> `{generated_at, rows, totals}`: `rows` = one row per storage location of a chemical whose effective decision is hazardous: location_id, chemical_id,
  product_name, supplier, location, spill_compound, quantity, unit, container_note, classification (array|null), items (array of item numbers the row counts towards),
  un_number, dg_class (ADG, illustration only), subsidiary_class, packing_group, hazchem_code, proper_shipping_name, signal_word, pictograms. `totals` = the result of
  `computeSiteTotals(entries)` for every storage location of every chemical that has a quantity (NOT only the hazardous ones: a chemical with a decision override of
  not_hazardous but a classification still counts; decide by classification, not by decision) with each entry `{id, chemical_id, name, classification, quantity, unit, location, spill_compound}`.
  Remove the old "totals by dg_class" and its tests.
* `GET /api/export/all` gains `ghs_classification`, `pictograms` (GHS list), overrides and `spill_compound` on locations, and `manifest_totals` (the same `totals` object).
* `POST /api/import`: imported chemicals are NOT classified (`ghs_classification` NULL): the ADG class from a spreadsheet says nothing about GHS category. A decision column
  in the sheet becomes `decision_override`. Transport fields still go to the placeholder SDS row. The manifest will list these as "not classified".
* Upload (AI): the AI returns `classification: [{class, category}]` using the ids from `promptClassList()` instead of `pictograms`; the prompt must tell it to read SDS section 2
  and to give only classes/categories it can see there. The Worker runs `verifyClassification(list, text)`: the verified list is stored on every chemical created (or on the
  chemicals of the replaced SDS: not if any existing entry has `src:"admin"` or an override exists; then add a warning instead), flags go to `classification_flags` and
  `sds.unverified` gets `"classification"`. Signal word, pictograms and decision are then DERIVED, never taken from the AI. If the AI fails: `ghs_classification` stays NULL.
  The exact-field checks for UN number, packing group, Hazchem, ADG class, CAS, dates are unchanged.

## Placard and manifest quantities (Schedule 11)

Totals are by GHS hazard class and category, NOT by ADG class (which is shown "for illustration only", as the PDF says). The rules live in `computeSiteTotals`; the
decisions where the PDF is silent are listed in `docs/REFERENCE.md` ("Decisions where the source is not clear"): quantity counted in every item a product qualifies for,
no density conversion (kg vs L), no pictogram precedence, spill compound defaults to the location, mixing items checked separately for the placard and the manifest column.
The manifest page shows, for every item, the site total against the placard quantity and the manifest quantity, with a clear OVER flag for each, the contributing products,
and the list of `issues` (never hide an issue). Items with no stock are collapsed behind "Show all 43 items" but all 43 appear in every export.

## Disclaimer, credit

The disclaimer is unchanged (one place: `public/disclaimer.js`). Credit Safe Work Australia as the source of the reference data on the manifest page (footer line), the
help page, the exports (a source line) and the README.
