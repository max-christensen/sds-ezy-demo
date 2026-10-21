# Reference data and where it comes from

## Source: Safe Work Australia

The classification table, the placard and manifest table and the pictogram descriptions in SDS EZY are taken from material published by
**Safe Work Australia** (https://www.safeworkaustralia.gov.au):

| Used for | Document |
|---|---|
| Hazard classes and categories, pictogram codes, signal words, hazard statements (`HAZARD_ROWS`, `H_STATEMENTS`) | *Work Health and Safety Regulations: Classification and labelling for workplace hazardous chemicals* (poster; based on the 7th revised edition of the GHS) |
| Items 1 to 43, placard and manifest quantities, notes, flammable liquid category 4 rule (`PLACARD_ITEMS`, `PLACARD_NOTES`) | *Placard and manifest requirements under the model WHS Regulations* (table updated July 2020; Schedule 11 of the WHS Regulations) |
| Pictogram names and one-line meanings | Safe Work Australia's *GHS pictograms for hazards* web page (safeworkaustralia.gov.au/safety-topic/hazards/chemicals) |

The code is in `public/lib/ghs-ref.mjs`. It is reference data to help a business keep its register. The regulations, the supplier's SDS and your regulator are the authority;
where this app and those differ, they win.

The poster's own notes say it is based on information provided by the Irish Health and Safety Authority and the German Federal Institute for Occupational Health and Safety (BAuA).

## The nine pictogram images

`public/pictograms/` holds the nine official GHS pictograms, copied unchanged (byte for byte) from the project owner's reference folder:
exploding bomb (GHS01), flame (GHS02), flame over circle (GHS03), gas cylinder (GHS04), corrosion (GHS05), skull and crossbones (GHS06), exclamation mark (GHS07),
health hazard (GHS08), environment (GHS09). All are 220 x 220 pixels; eight are GIF and the flame (GHS02) is a JPEG.

**Origin and usage terms are not stated in the files.** The Safe Work Australia page says the pictograms can be downloaded from the United Nations Economic Commission for
Europe (UNECE), and six of the file names (`exploding_bomb`, `flame_over_circle`, `gas_cylinder`, `corrosion`, `skull_and_crossbones`, `environment`) match UNECE's. But the flame
(`ghs-flame-pictogram.jpg`) and the two hyphenated names (`exclamation-mark.gif`, `health-hazard.gif`) do not, so at least some of the set was fetched from somewhere else.
No licence or source file came with them. **Check the usage terms of whichever site each image came from before this repository is made public.**

## Decisions where the source is not clear

The documents are silent or ambiguous in these places. SDS EZY does not guess: it takes the cautious reading below, shows the reader what happened, and leaves it for a person to
confirm. If you disagree with one, the rule is in one place (`computeSiteTotals` / `itemsForClassification` / `derive` in `public/lib/ghs-ref.mjs`).

1. **A product that falls under more than one item.** The placard table does not say how to combine them (only gases and the flammable liquid category 4 rule are covered).
   The product's whole quantity is counted in **each** item it qualifies for, and the manifest shows a notice naming the items. This can overstate a site's position; it never understates it.
2. **Gases.** Following the table and its note 5, a gas under pressure counts under item 2 (acute toxicity, categories 1 to 4), item 3 (skin corrosion 1A to 1C) or item 1 (flammable gas),
   and only under item 4 ("not specified elsewhere") if none of those apply. The table says note 5 for acute toxicity; the same is applied to skin corrosion because the table lists it under gases.
   Item 2 covers acute toxicity category 4 only up to an LC50 of 5000 ppmV. The LC50 is not held in the register, so a category 4 gas is counted and flagged "check the LC50".
3. **Kilograms and litres.** Items 1 to 10 are in litres, items 14 and 15 in kilograms, all others "kg or L". No density is held, so a quantity in the wrong unit for an item is **not converted
   and not counted**; it is listed as an issue. For "kg or L" items the kilograms and litres are added as plain numbers, as the table gives one number for both.
4. **"Exceeds".** A site is flagged when its total is strictly more than the quantity in the table.
5. **Mixing items** (9, 16, 20, 24, 28, 32, 36, 41, 43). The table says they apply "where none of the items exceeds the quantities in columns 4 or 5 on their own". This is applied to the
   placard column and the manifest column separately: the mixing item's placard quantity is checked only if none of its items is over its own placard quantity, and the same for the manifest column.
   Where one item is already over on its own, that item is the flag and the mixing item is shown as "not applied".
6. **Spill compound** (flammable liquid category 4 rule). The register does not model spill compounds. Each storage location can carry an optional "spill compound" name; locations with the same
   text are one compound. If it is blank, the location itself is treated as the compound. Category 4 liquid in a compound with a category 1, 2 or 3 flammable liquid is counted as the lowest category present
   (lowest category number = lowest flash point), as in the table's own example.
7. **Flammable liquid category 4 and the Item 10 note.** Only liquids with a flash point up to 93 C are flammable liquids (note 3). The register does not hold flash points; it relies on the classification.
8. **Items the table does not give.** Explosives of Divisions 1.1 to 1.6, desensitised explosives, oxidising gases that are not also gases under pressure, and acute toxicity category 4 for liquids and solids have no
   item in the table. They are reported as issues, not counted. (Unstable explosives are item 42.)
9. **Pictograms.** The poster lists the pictograms for each class but no precedence rules (for example, that GHS06 replaces GHS07). None are applied: every pictogram listed for each of a product's classes is shown.
   The poster has no environmental hazard classes, so **GHS09 (environment) is never derived**. An admin can add it as an override, which is shown as an override.
10. **Where the category cannot be told from the hazard statement.** Some categories share hazard statements on the poster (acute toxicity 1 and 2, skin corrosion 1A, 1B and 1C, oxidisers and water-reactive 2 and 3,
    self-reactive/organic peroxide types C and D versus E and F, flammable solids 1 and 2). When the AI's category cannot be found in the SDS text next to the class name, the class is kept but marked
    "category not confirmed", the placard item is worked out from the AI's category and flagged, and the signal word uses the most severe category if no category is known.
11. **Hazard statements outside the poster** (for example the H400 series for aquatic toxicity, EUH codes) are ignored for classification.
12. **ADG class.** Kept as a separate SDS field (UN number, ADG class, packing group, Hazchem, proper shipping name come from SDS section 14) and shown "for illustration only". Nothing is derived from it.

## Open points (not yet confirmed; do not rely on them)

1. **Vehicles are not counted towards the placard and manifest totals.** SDS EZY treats a vehicle as a place whose "counts toward totals" setting is OFF by default, and says on the vehicle's page and the
   manifest: "Products in transit fall under the transport rules and are not counted here." That is the project owner's understanding, **not** something the two Safe Work Australia documents state. It **must be confirmed
   with Safe Work Australia or the WHS regulator** (for example: when a vehicle is parked at a depot or a site, or when product is left in it overnight, does it count?). Until then it is a default an admin can change per place.
2. **Totals are worked out per place, not across the whole business.** The Safe Work Australia table talks about quantities at a "workplace". Treating each place that counts (workshop, depot, site) as its own workplace is our reading;
   please confirm it with the regulator, especially for places close together or sharing a spill compound.
3. **"Near" a quantity (80%).** The screens call a total "near" a placard or manifest quantity from 80%. That is a reading aid of ours, not part of Schedule 11.
