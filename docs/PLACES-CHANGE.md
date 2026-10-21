# Change: places, per-place totals, job packs, phone-first use and offline

For people who work on other people's sites. Products are mostly kept in vehicles and come out at the point of use, which is when the SDS and
the risk assessment must be at hand. Many PCBUs ask for copies before work starts. The two roles are unchanged: **admin**, and **user**
(read-only plus SDS upload). The chemical audit feature is a separate brief: do NOT build any of it.

This supersedes ARCHITECTURE.md and GHS-CHANGE.md wherever they mention `storage_locations`, "locations", or totals "across the site". Where documents disagree this one wins.

## Shared code that already exists (read it, do not copy it)

* `schema.sql` (updated, with the migration) and `tests/places-migration.test.mjs`.
* `public/lib/ghs-ref.mjs`: new `PLACE_TYPES`, `placeTypeLabel`, `defaultCountsTowardTotals`, `VEHICLE_TRANSPORT_NOTE`, `VEHICLE_TRANSPORT_CAVEAT`,
  `NEAR_FRACTION` (0.8), `computePlaceTotals(places, entries)`; `computeSiteTotals` now also sets `placardNear` / `manifestNear` on each item and raises a
  `no_quantity` issue. `tests/places-totals.test.mjs` is the specification. Totals are per place, never across the business.

## Places (data and API)

* `places`: `name`, `place_type` (`workshop` = "Workshop or depot", `vehicle`, `site`), `registration` (vehicles), `counts_toward_totals` (default on for workshop and site,
  off for vehicle; the admin can change it), `archived`, `notes`, `chemical_count` (summary kept in step by the Worker so the picker reads one small table).
* `chemical_places`: one row per chemical per place (`UNIQUE(chemical_id, place_id)`), optional `quantity` + `unit` (`L`|`kg`, both null or both set), `container_note`, `spill_compound`.
  Chemicals are NOT tracked moving between places. `storage_locations` is legacy: nothing may read or write it except the migration in `schema.sql`.
* Archived places drop off active lists, stay on record, keep their links, are not totalled, and cannot get new links.
* All reads: any signed-in user. All writes below: admin only (the role table in `src/index.js`; deny by default). Demo mode blocks all of them.

```
GET  /api/places?archived=0|1|all     -> [{id, name, place_type, registration, counts_toward_totals, archived, notes, chemical_count}]   (default archived=0; reads only `places`)
GET  /api/places/:id                  -> {place, chemicals, result}
       chemicals: [{link_id, chemical_id, product_name, supplier, decision, decision_overridden, pictograms, signal_word, risk_level, sds_id, sds_issue_date,
                    review_due, review_status, has_assessment, classification, quantity, unit, container_note, spill_compound}] ordered by product_name
       result:    computePlaceTotals([place], entries)[0]   (counts, totals, over, near, note, caveat)
POST /api/places                      {name, place_type, registration?, counts_toward_totals?, notes?} -> {id}     (admin)
PUT  /api/places/:id                  any of those + archived (true|false)                              (admin)  -- no DELETE: archive instead
POST /api/places/:id/chemicals        {chemical_id, quantity?, unit?, container_note?, spill_compound?} -> {id}   (admin)  (also POST /api/chemicals/:id/places {place_id, ...})
PUT  /api/chemical-places/:id         {quantity?, unit?, container_note?, spill_compound?}                (admin)
DELETE /api/chemical-places/:id                                                                          (admin)
```
* Validation: name required, at most 120 characters, unique among ACTIVE places of the same type (case-insensitive); type in the enum; registration only for vehicles (trimmed, upper-cased,
  at most 20 characters); quantity a number from 0 up with a unit, or both omitted; cannot link to an archived place (400). Link create/update/delete and chemical delete keep `places.chemical_count` right in the same `db.batch`.
* `GET /api/chemicals/:id` now returns `places: [{link_id, place_id, name, place_type, registration, archived, counts_toward_totals, quantity, unit, container_note, spill_compound}]` instead of `locations`.
* `GET /api/chemicals` (list) and the review list are unchanged.

## Totals per counting place; the manifest

* `GET /api/manifest` -> `{generated_at, places:[{place, counts:true, totals, over, near, rows}], not_counted:[{place, note, caveat}], summary}`: `places` = active places that count
  (`computePlaceTotals`), each with its own `rows` (one per hazardous chemical kept there: link_id, chemical_id, product_name, supplier, quantity, unit, container_note, spill_compound,
  classification, items, un_number, dg_class (ADG, illustration only), subsidiary_class, packing_group, hazchem_code, proper_shipping_name, signal_word, pictograms). `not_counted` = active places that do not
  count (vehicles by default) with the plain note. `summary` = `{over_placard:[{place_id, place_name, items}], over_manifest:[...], near_placard:[...]}`.
  Remove the old whole-business `totals`.
* A place's own page shows its check (counting places) or the vehicle note (vehicles / non-counting places). The manifest page lists the places that count, each with its items table, plus the places
  that do not count and why. A vehicle note reads: "Products in transit fall under the transport rules and are not counted here." with the caveat from the ref module in smaller text.
* **Open point (record it, do not hide it):** that products in a vehicle fall under the transport rules and are not counted is the project owner's understanding. It has NOT been confirmed with Safe Work Australia or
  the regulator. `docs/REFERENCE.md` records it as an open point, and the README says so. The admin can switch "counts toward totals" on for a vehicle if the regulator says otherwise.

## Job packs (no server write)

* Any signed-in user (user or admin). Nothing is saved on the server, so no write permission is needed: it is a read endpoint plus work in the browser.
* `GET /api/pack?ids=1,2,3` (at most 100 ids) -> `{generated_at, chemicals:[{chemical, sds, assessment, places}]}`: each with the public chemical columns incl. `classification`, the current SDS (public columns + `has_file`),
  the current assessment with `controls`, and `places`. Batched by primary key (`WHERE id IN (...)`), no per-chemical request. SDS PDFs are fetched from `GET /api/sds/:id/file`.
* The pack screen (`#/pack`, query `?place=&ids=&client=&ref=&date=` pre-fills): choose a place (default: the remembered place, e.g. a vehicle) and tick its chemicals, OR tick chemicals directly (search the register);
  enter client or site name, job reference and date (default today). Build in the browser:
  1. ONE print-ready PDF: a cover page (company details from settings, client or site, job reference, date, the place, who prepared it, and the list of chemicals with, for each, "No SDS on file" or "No assessment on file" where that is so),
     a register page (product, supplier, hazardous or not, pictograms, SDS date and review status, risk level), then for each chemical its assessment followed by its SDS pages. A chemical with no SDS or no assessment is NOT left out: it is
     named on the cover and gets a one-line placeholder page where the missing part would be. The disclaimer is on the cover and in the footer of every generated page.
  2. A zip of the SDS PDFs named by product, with a `README.txt` (job details, the chemical list, anything missing, the disclaimer).
  Offer the PDF through the Web Share API where the phone supports sharing files, as well as download. Nothing is stored server-side.

## Phone first

The phone is the main design target (desktop must still work well). Big tap targets (at least 44 px), one-column layouts, a bottom tab bar on phones (My place, Find, Job pack, More), a top bar showing the company and the current place.

* Place picker (`#/places`): active places grouped by type (vehicles show their registration), search box, big tappable rows with the chemical count. Tapping a place makes it **my place**: remembered on this phone
  (`localStorage`, keyed by user id, so another person signing in on the same phone does not inherit it) and opens `#/place/:id`. Admin: add, edit, archive places from here (archived ones behind "Show archived").
* After sign-in with no hash: go to my place if one is remembered (and still active), otherwise the picker (with "Skip: go to the Review list"). A QR label link (`#/place/:id` or `#/chemical/:id`) is kept through sign-in as before.
* Place page (`#/place/:id`): name, type, registration; the chemical list FIRST as large cards (product, supplier, official pictograms, signal word, risk and SDS-review badges, quantity) each with two big buttons, **SDS** (opens the PDF) and
  **Assessment** (opens the chemical page at the assessment); then the placard check card (or vehicle note); "Build a job pack from this place"; "Save this place for offline"; place QR label; admin: edit, add chemical, archive.
* Place QR label: reuse the existing label code (`public/views/label.js`): `#/place/:id/label`, QR to `${origin}/#/place/${id}` (opens that place's chemical list after sign-in), place name, type, registration, company name.
* The existing screens (Review, Register, Hazardous, Manifest, Upload SDS, Take-away, admin screens, Help) stay, reachable from "More" on a phone and the sidebar on desktop.

## Installable, and offline for read

* Installable to the home screen: `public/manifest.webmanifest`, PNG icons (192, 512, maskable) generated by a script from the placeholder mark, theme colour, a service worker `public/sw.js`. "Install app" in More where the browser offers it; on iOS a short "Share, then Add to Home Screen" hint.
* **Save this place for offline** (place page): stores that place's `GET /api/places/:id`, each chemical's `GET /api/chemicals/:id` (page and assessment), each SDS's metadata and PDF (`GET /api/sds/:id/file`), the company settings and the signed-in user, in a Cache Storage cache whose NAME carries the app version.
  Shows when it was last updated, how many chemicals and SDS files, and the size; "Update now" and "Remove from this phone". The app shell (HTML, JS, CSS, pictograms, the libraries) is cached by the service worker so the app opens with no signal.
* **Offline is read-only.** Saved place pages, chemical pages, assessments and SDS PDFs open with no signal. Anything else says plainly "You're offline. This isn't saved on this phone." An upload (and every other write) needs a signal: the upload screen
  says so clearly and the button is off while offline. An "Offline: showing what is saved on this phone" banner shows when there is no connection.
* **Signing out clears the saved data**: the data cache(s), the offline metadata and the service worker's copies (also when the sign-out request itself cannot reach the server). A session that merely expires does not wipe the data (people lose signal and sessions on site); only an explicit sign-out does.
* **Versioned cache**: `public/app-version.js` (`APP_VERSION`, a content hash written by `scripts/bump-version.mjs`, run automatically before `npm run deploy`) is imported by `sw.js`, so a new version replaces the shell and data caches; saved places from an older version are dropped and the place page says "Updated app: save this place again".
  The service worker never caches API responses by itself (nothing signed-in is stored unless the user presses Save); it only serves what was saved, when the network fails.

## Rows read (D1)

Measure and put in the README table: the place picker (`GET /api/places`), a place page (`GET /api/places/:id` with 20 chemicals), the pack data (`GET /api/pack?ids=` with 10 and with 30 chemicals), the per-place manifest. The picker must read only `places`.

## Out of scope

The chemical audit feature (a separate brief). Tracking chemicals moving between places. Any server-side storage of packs. Editing anything offline.
