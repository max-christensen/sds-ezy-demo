// GHS reference data and the rules built on it. ONE source of truth, used by the Worker (src/), the browser
// (public/views, via dynamic import) and the tests. Pure functions, no dependencies, no I/O.
//
// SOURCE OF THE DATA: Safe Work Australia.
//   * "Work Health and Safety Regulations: Classification and labelling for workplace hazardous chemicals" (poster, 7th revised
//     edition of the GHS): the hazard classes and categories, pictograms, signal words and hazard statements in HAZARD_ROWS.
//   * "Placard and manifest requirements under the model WHS Regulations" (updated July 2020, Schedule 11 of the WHS
//     Regulations): the Items 1 to 43 and their notes in PLACARD_ITEMS.
//   The pictogram images are the nine official GHS pictograms supplied by the project owner (see docs/REFERENCE.md).
// Reproduced here as reference data to help a business keep its register; the regulations and the supplier's SDS are the authority.
//
// WHAT THE POSTER DOES NOT SAY (and so is NOT decided here): it gives no pictogram precedence rules (for example GHS06 over
// GHS07), no environmental hazard classes (so GHS09 is never derived; an admin can add it as a visible override), and no
// guidance on how to combine a product that falls under several items. See docs/REFERENCE.md for each place we had to choose.

// ------------------------------------------------------------------------------------------------ pictograms

export const PICTOGRAMS = [
  { code: "GHS01", name: "Exploding bomb", file: "/pictograms/exploding_bomb.gif", meaning: "Explosion, fire, blast or projection hazard." },
  { code: "GHS02", name: "Flame", file: "/pictograms/ghs-flame-pictogram.jpg", meaning: "Flammable liquids, vapour, solids and gases; including self-heating and self-igniting substances." },
  { code: "GHS03", name: "Flame over circle", file: "/pictograms/flame_over_circle.gif", meaning: "Oxidising liquids, solids and gases, may cause or intensify fire." },
  { code: "GHS04", name: "Gas cylinder", file: "/pictograms/gas_cylinder.gif", meaning: "Gases under pressure." },
  { code: "GHS05", name: "Corrosion", file: "/pictograms/corrosion.gif", meaning: "Corrosive chemicals, may cause severe skin and eye damage and may be corrosive to metals." },
  { code: "GHS06", name: "Skull and crossbones", file: "/pictograms/skull_and_crossbones.gif", meaning: "Fatal or toxic if swallowed, inhaled or in contact with skin." },
  { code: "GHS07", name: "Exclamation mark", file: "/pictograms/exclamation-mark.gif", meaning: "Low level toxicity. Respiratory, skin and eye irritation, skin sensitisers and chemicals harmful if swallowed, inhaled or in contact with skin." },
  { code: "GHS08", name: "Health hazard", file: "/pictograms/health-hazard.gif", meaning: "Chronic health hazards: aspiratory and respiratory hazards, carcinogenicity, mutagenicity and reproductive toxicity." },
  { code: "GHS09", name: "Environment", file: "/pictograms/environment.gif", meaning: "Hazardous to aquatic life and the environment." },
];
export const PICTOGRAM_CODES = PICTOGRAMS.map(p => p.code);
export function pictogramInfo(code) { return PICTOGRAMS.find(p => p.code === code) || null; }

// ------------------------------------------------------------------------------------------------ hazard statements (poster)

export const H_STATEMENTS = {
  H200: "Unstable explosive", H201: "Explosive; mass explosion hazard", H202: "Explosive; severe projection hazard",
  H203: "Explosive; fire, blast or projection hazard", H204: "Fire or projection hazard", H205: "May mass explode in fire",
  H206: "Fire, blast or projection hazard; increased risk of explosion if desensitising agent is reduced",
  H207: "Fire or projection hazard; increased risk of explosion if desensitising agent is reduced",
  H208: "Fire hazard; increased risk of explosion if desensitising agent is reduced",
  H220: "Extremely flammable gas", H221: "Flammable gas", H222: "Extremely flammable aerosol", H223: "Flammable aerosol",
  H224: "Extremely flammable liquid and vapour", H225: "Highly flammable liquid and vapour", H226: "Flammable liquid and vapour",
  H227: "Combustible liquid", H228: "Flammable solid",
  H229: "Pressurised container: may burst if heated",
  H230: "May react explosively even in the absence of air",
  H231: "May react explosively even in the absence of air at elevated pressure and/or temperature",
  H232: "May ignite spontaneously if exposed to air",
  H240: "Heating may cause an explosion", H241: "Heating may cause a fire or explosion", H242: "Heating may cause a fire",
  H250: "Catches fire spontaneously if exposed to air", H251: "Self-heating; may catch fire",
  H252: "Self-heating in large quantities; may catch fire",
  H260: "In contact with water releases flammable gases which may ignite spontaneously",
  H261: "In contact with water releases flammable gases",
  H270: "May cause or intensify fire; oxidiser", H271: "May cause fire or explosion; strong oxidiser", H272: "May intensify fire; oxidiser",
  H280: "Contains gas under pressure; may explode if heated", H281: "Contains refrigerated gas; may cause cryogenic burns or injury.",
  H290: "May be corrosive to metals",
  H300: "Fatal if swallowed", H301: "Toxic if swallowed", H302: "Harmful if swallowed",
  H304: "May be fatal if swallowed and enters airways",
  H310: "Fatal in contact with skin", H311: "Toxic in contact with skin", H312: "Harmful in contact with skin",
  H314: "Causes severe skin burns and eye damage", H315: "Causes skin irritation", H317: "May cause an allergic skin reaction",
  H318: "Causes serious eye damage", H319: "Causes serious eye irritation", H320: "Causes eye irritation",
  H330: "Fatal if inhaled", H331: "Toxic if inhaled", H332: "Harmful if inhaled",
  H334: "May cause allergy or asthma symptoms or breathing difficulties if inhaled",
  H335: "May cause respiratory irritation", H336: "May cause drowsiness or dizziness",
  H340: "May cause genetic defects", H341: "Suspected of causing genetic defects",
  H350: "May cause cancer", H351: "Suspected of causing cancer",
  H360: "May damage fertility or the unborn child.", H360F: "May damage fertility.", H360D: "May damage the unborn child",
  H360FD: "May damage fertility. May damage the unborn child.", H360Fd: "May damage fertility. Suspected of damaging the unborn child.",
  H360Df: "May damage the unborn child. Suspected of damaging fertility.",
  H361: "Suspected of damaging fertility or the unborn child.", H361f: "Suspected of damaging fertility.",
  H361d: "Suspected of damaging the unborn child.", H361fd: "Suspected of damaging fertility. Suspected of damaging the unborn child.",
  H362: "May cause harm to breast-fed children.",
  H370: "Causes damage to organs", H371: "May cause damage to organs",
  H372: "Causes damage to organs through prolonged or repeated exposure",
  H373: "May cause damage to organs through prolonged or repeated exposure",
};

// ------------------------------------------------------------------------------------------------ the classification table (poster)
// One row per row of the poster. `categories` lists every category id the row covers. `pictograms` is [] where the poster says
// "No Pictogram". `signal` is "Danger", "Warning" or null ("No Signal Word"). `hCodes` is every H-code on the row; `keyCodes`
// are the codes that identify the row when reading an SDS (they differ from hCodes only for aerosols, where H229 is on all rows).

const R = (cls, clsLabel, categories, pictograms, signal, hCodes, extra = {}) =>
  ({ class: cls, classLabel: clsLabel, categories, pictograms, signal, hCodes, keyCodes: extra.keyCodes || hCodes, note: extra.note || null });

export const HAZARD_ROWS = [
  // Explosives
  R("explosives", "Explosives", ["Unstable explosive"], ["GHS01"], "Danger", ["H200"]),
  R("explosives", "Explosives", ["Division 1.1"], ["GHS01"], "Danger", ["H201"]),
  R("explosives", "Explosives", ["Division 1.2"], ["GHS01"], "Danger", ["H202"]),
  R("explosives", "Explosives", ["Division 1.3"], ["GHS01"], "Danger", ["H203"]),
  R("explosives", "Explosives", ["Division 1.4"], ["GHS01"], "Warning", ["H204"]),
  R("explosives", "Explosives", ["Division 1.5"], [], "Danger", ["H205"], { note: "No GHS pictogram. Label with the Dangerous Goods class label under the Australian Explosives Code." }),
  R("explosives", "Explosives", ["Division 1.6"], [], null, [], { note: "No GHS pictogram, no signal word, no hazard statement. Label with the Dangerous Goods class label under the Australian Explosives Code." }),
  // Flammable gases (pyrophoric and chemically unstable gases must always also be classified as category 1A)
  R("flam_gas", "Flammable gases", ["1A"], ["GHS02"], "Danger", ["H220"]),
  R("flam_gas", "Flammable gases", ["Pyrophoric gas"], ["GHS02"], "Danger", ["H232"], { note: "Must always also be classified as flammable gas category 1A." }),
  R("flam_gas", "Flammable gases", ["Chemically unstable gas A"], ["GHS02"], "Danger", ["H230"], { note: "Must always also be classified as flammable gas category 1A." }),
  R("flam_gas", "Flammable gases", ["Chemically unstable gas B"], ["GHS02"], "Danger", ["H231"], { note: "Must always also be classified as flammable gas category 1A." }),
  R("flam_gas", "Flammable gases", ["1B"], ["GHS02"], "Danger", ["H221"]),
  // Aerosols
  R("aerosol", "Aerosols", ["1"], ["GHS02"], "Danger", ["H222", "H229"], { keyCodes: ["H222"] }),
  R("aerosol", "Aerosols", ["2"], ["GHS02"], "Warning", ["H223", "H229"], { keyCodes: ["H223"] }),
  R("aerosol", "Aerosols", ["3"], [], "Warning", ["H229"], { keyCodes: ["H229"], note: "No pictogram." }),
  // Oxidising gases, gases under pressure
  R("ox_gas", "Oxidising gases", ["1"], ["GHS03"], "Danger", ["H270"]),
  R("gas_pressure", "Gases under pressure", ["Compressed gas", "Liquefied gas", "Dissolved gas"], ["GHS04"], "Warning", ["H280"]),
  R("gas_pressure", "Gases under pressure", ["Refrigerated liquefied gas"], ["GHS04"], "Warning", ["H281"]),
  // Flammable liquids and solids
  R("flam_liq", "Flammable liquids", ["1"], ["GHS02"], "Danger", ["H224"]),
  R("flam_liq", "Flammable liquids", ["2"], ["GHS02"], "Danger", ["H225"]),
  R("flam_liq", "Flammable liquids", ["3"], ["GHS02"], "Warning", ["H226"]),
  R("flam_liq", "Flammable liquids", ["4"], [], "Warning", ["H227"], { note: "No pictogram." }),
  R("flam_solid", "Flammable solids", ["1"], ["GHS02"], "Danger", ["H228"]),
  R("flam_solid", "Flammable solids", ["2"], ["GHS02"], "Warning", ["H228"]),
  // Self-reactive substances and mixtures, organic peroxides (two classes that share the same categories)
  ...[["self_reactive", "Self-reactive substances and mixtures"], ["org_peroxide", "Organic peroxides"]].flatMap(([c, l]) => [
    R(c, l, ["Type A"], ["GHS01"], "Danger", ["H240"]),
    R(c, l, ["Type B"], ["GHS01", "GHS02"], "Danger", ["H241"]),
    R(c, l, ["Type C and D"], ["GHS02"], "Danger", ["H242"]),
    R(c, l, ["Type E and F"], ["GHS02"], "Warning", ["H242"]),
    R(c, l, ["Type G"], [], null, [], { note: "No pictogram, no signal word, no hazard statement." }),
  ]),
  R("pyro_liquid", "Pyrophoric liquids", ["1"], ["GHS02"], "Danger", ["H250"]),
  R("pyro_solid", "Pyrophoric solids", ["1"], ["GHS02"], "Danger", ["H250"]),
  R("self_heating", "Self-heating substances and mixtures", ["1"], ["GHS02"], "Danger", ["H251"]),
  R("self_heating", "Self-heating substances and mixtures", ["2"], ["GHS02"], "Warning", ["H252"]),
  R("water_reactive", "Substances and mixtures which, in contact with water, emit flammable gases", ["1"], ["GHS02"], "Danger", ["H260"]),
  R("water_reactive", "Substances and mixtures which, in contact with water, emit flammable gases", ["2"], ["GHS02"], "Danger", ["H261"]),
  R("water_reactive", "Substances and mixtures which, in contact with water, emit flammable gases", ["3"], ["GHS02"], "Warning", ["H261"]),
  // Oxidising liquids and solids (two classes that share the same categories)
  ...[["ox_liquid", "Oxidising liquids"], ["ox_solid", "Oxidising solids"]].flatMap(([c, l]) => [
    R(c, l, ["1"], ["GHS03"], "Danger", ["H271"]),
    R(c, l, ["2"], ["GHS03"], "Danger", ["H272"]),
    R(c, l, ["3"], ["GHS03"], "Warning", ["H272"]),
  ]),
  R("corr_metal", "Corrosive to metals", ["1"], ["GHS05"], "Warning", ["H290"]),
  // Desensitised explosives
  R("desens_explosive", "Desensitised explosives", ["1"], ["GHS02"], "Danger", ["H206"]),
  R("desens_explosive", "Desensitised explosives", ["2"], ["GHS02"], "Danger", ["H207"]),
  R("desens_explosive", "Desensitised explosives", ["3"], ["GHS02"], "Warning", ["H207"]),
  R("desens_explosive", "Desensitised explosives", ["4"], ["GHS02"], "Warning", ["H208"]),
  // Acute toxicity (oral, dermal or inhalation). Categories 1 and 2 share the same H-codes on the poster.
  R("acute_tox", "Acute toxicity (oral, dermal or inhalation)", ["1"], ["GHS06"], "Danger", ["H300", "H310", "H330"]),
  R("acute_tox", "Acute toxicity (oral, dermal or inhalation)", ["2"], ["GHS06"], "Danger", ["H300", "H310", "H330"]),
  R("acute_tox", "Acute toxicity (oral, dermal or inhalation)", ["3"], ["GHS06"], "Danger", ["H301", "H311", "H331"]),
  R("acute_tox", "Acute toxicity (oral, dermal or inhalation)", ["4"], ["GHS07"], "Warning", ["H302", "H312", "H332"]),
  // Skin and eye
  R("skin_corr", "Skin corrosion / irritation", ["1A", "1B", "1C"], ["GHS05"], "Danger", ["H314"]),
  R("skin_corr", "Skin corrosion / irritation", ["2"], ["GHS07"], "Warning", ["H315"]),
  R("eye_dmg", "Serious eye damage / eye irritation", ["1"], ["GHS05"], "Danger", ["H318"]),
  R("eye_dmg", "Serious eye damage / eye irritation", ["2", "2A"], ["GHS07"], "Warning", ["H319"]),
  R("eye_dmg", "Serious eye damage / eye irritation", ["2B"], [], "Warning", ["H320"], { note: "No pictogram." }),
  // Sensitisers, mutagenicity, carcinogenicity, reproductive toxicity
  R("resp_sens", "Respiratory sensitisers", ["1", "1A", "1B"], ["GHS08"], "Danger", ["H334"]),
  R("skin_sens", "Skin sensitisers", ["1", "1A", "1B"], ["GHS07"], "Warning", ["H317"]),
  R("germ_cell", "Germ cell mutagenicity", ["1A", "1B"], ["GHS08"], "Danger", ["H340"]),
  R("germ_cell", "Germ cell mutagenicity", ["2"], ["GHS08"], "Warning", ["H341"]),
  R("carcinogen", "Carcinogenicity", ["1A", "1B"], ["GHS08"], "Danger", ["H350"]),
  R("carcinogen", "Carcinogenicity", ["2"], ["GHS08"], "Warning", ["H351"]),
  R("repro_tox", "Reproductive toxicity", ["1A", "1B"], ["GHS08"], "Danger", ["H360", "H360F", "H360D", "H360FD", "H360Fd", "H360Df"]),
  R("repro_tox", "Reproductive toxicity", ["2"], ["GHS08"], "Warning", ["H361", "H361f", "H361d", "H361fd"]),
  R("repro_tox", "Reproductive toxicity", ["Lactation"], [], null, ["H362"], { note: "Additional category for effects on or via lactation. No pictogram, no signal word." }),
  // Specific target organ toxicity, aspiration
  R("stot_se", "Specific target organ toxicity (single exposure)", ["1"], ["GHS08"], "Danger", ["H370"]),
  R("stot_se", "Specific target organ toxicity (single exposure)", ["2"], ["GHS08"], "Warning", ["H371"]),
  R("stot_se", "Specific target organ toxicity (single exposure)", ["3"], ["GHS07"], "Warning", ["H335", "H336"]),
  R("stot_re", "Specific target organ toxicity (repeated exposure)", ["1"], ["GHS08"], "Danger", ["H372"]),
  R("stot_re", "Specific target organ toxicity (repeated exposure)", ["2"], ["GHS08"], "Warning", ["H373"]),
  R("aspiration", "Aspiration hazard", ["1"], ["GHS08"], "Danger", ["H304"]),
];

export const HAZARD_CLASSES = (() => {
  const out = [];
  for (const r of HAZARD_ROWS) {
    let c = out.find(x => x.id === r.class);
    if (!c) out.push(c = { id: r.class, label: r.classLabel, categories: [] });
    for (const k of r.categories) if (!c.categories.includes(k)) c.categories.push(k);
  }
  return out;
})();

export function categoryText(k) { return /^\d/.test(String(k)) ? `Category ${k}` : String(k); }
export function classLabel(c) { const x = HAZARD_CLASSES.find(h => h.id === c); return x ? x.label : String(c); }
export function classificationLabel(e) { return e.k ? `${classLabel(e.c)}, ${categoryText(e.k)}` : classLabel(e.c); }

/** The poster rows a classification entry {c, k} refers to. With k null/absent (category not known) every row of the class. */
export function rowsFor(c, k) {
  return HAZARD_ROWS.filter(r => r.class === c && (k == null || r.categories.includes(String(k))));
}
export function isValidEntry(e) {
  return !!e && typeof e === "object" && typeof e.c === "string" && rowsFor(e.c, e.k == null ? null : String(e.k)).length > 0;
}

/**
 * Clean a classification list from untrusted input (a request body, the AI): drops invalid pairs and duplicates, keeps
 * {c, k, src?, check?}. Returns {list, dropped:[...]}. `k` may be null when the class is known but the category is not.
 */
export function normaliseClassification(input) {
  const list = [], dropped = [];
  if (!Array.isArray(input)) return { list, dropped: input == null ? [] : ["not a list"] };
  for (const raw of input.slice(0, 40)) {
    const e = raw && typeof raw === "object" ? { c: String(raw.c ?? raw.class ?? "").trim(), k: raw.k ?? raw.category ?? null } : null;
    if (e && e.k !== null && e.k !== undefined) e.k = String(e.k).trim();
    if (e && (e.k === "" || e.k === undefined)) e.k = null;
    if (!e || !isValidEntry(e)) { dropped.push(JSON.stringify(raw).slice(0, 80)); continue; }
    if (list.some(x => x.c === e.c && x.k === e.k)) continue;
    const out = { c: e.c, k: e.k };
    if (raw.src && ["ai", "h_code", "admin"].includes(raw.src)) out.src = raw.src;
    if (raw.check) out.check = true;
    list.push(out);
  }
  return { list, dropped };
}

// ------------------------------------------------------------------------------------------------ derivation

const SIGNAL_RANK = { Danger: 2, Warning: 1 };

/**
 * Derive pictograms, signal word and the hazardous / not hazardous decision from a classification.
 *   classification: array of {c, k} or null/undefined when the product has not been classified yet.
 * Returns {known, decision, pictograms:[GHSnn...], signal_word, hCodes, rows}.
 *   * not classified yet (null)         -> decision null (no decision can be made)
 *   * classified, no class on the poster -> "not_hazardous" ("a product carrying none of the classifications is non-hazardous")
 *   * any class with a hazard statement  -> "hazardous"
 * Where the category is unknown (k null) every poster row of the class is used and the most severe signal word wins.
 * The poster gives no pictogram precedence rules, so none are applied: every pictogram listed for each class is shown.
 */
export function derive(classification) {
  if (classification == null) return { known: false, decision: null, pictograms: [], signal_word: null, hCodes: [], rows: [] };
  const rows = [];
  for (const e of classification) for (const r of rowsFor(e.c, e.k == null ? null : String(e.k))) if (!rows.includes(r)) rows.push(r);
  const pict = new Set(); let signal = null; const h = new Set();
  for (const r of rows) {
    for (const p of r.pictograms) pict.add(p);
    if (r.signal && (!signal || SIGNAL_RANK[r.signal] > SIGNAL_RANK[signal])) signal = r.signal;
    for (const c of r.hCodes) h.add(c);
  }
  return {
    known: true,
    decision: h.size ? "hazardous" : "not_hazardous",
    pictograms: PICTOGRAM_CODES.filter(c => pict.has(c)),
    signal_word: signal,
    hCodes: [...h],
    rows,
  };
}

/**
 * The effective values: derived, unless the admin has overridden. Returns each value plus what was derived and whether it is overridden,
 * so the screens can show an override. `overrides` = {decision, pictograms} where each is null (no override) or a value
 * ("hazardous"/"not_hazardous"; an array or comma list of GHS codes, possibly empty for "none").
 */
export function effective(classification, overrides = {}) {
  const d = derive(classification);
  const pOv = parsePictogramList(overrides.pictograms);
  const dOv = overrides.decision === "hazardous" || overrides.decision === "not_hazardous" ? overrides.decision : null;
  return {
    decision: dOv ?? d.decision,
    pictograms: pOv ?? d.pictograms,
    signal_word: d.signal_word,
    derived: { decision: d.decision, pictograms: d.pictograms, signal_word: d.signal_word },
    decision_overridden: dOv !== null && dOv !== d.decision,
    pictograms_overridden: pOv !== null && pOv.join() !== d.pictograms.join(),
    known: d.known,
  };
}

/** "GHS02,GHS07" / ["GHS02"] -> sorted valid codes; null/undefined -> null (no override); "none" or "" with explicit empty array -> []. */
export function parsePictogramList(v) {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(",").map(s => s.trim()).filter(Boolean);
  if (arr.length === 1 && String(arr[0]).toLowerCase() === "none") return [];
  const set = new Set(arr.map(s => String(s).toUpperCase()).filter(c => PICTOGRAM_CODES.includes(c)));
  return PICTOGRAM_CODES.filter(c => set.has(c));
}
export function pictogramListToText(list) { return Array.isArray(list) && list.length ? list.join(",") : ""; }

// ------------------------------------------------------------------------------------------------ reading H-codes from SDS text

// H-codes the poster covers, with their canonical spelling (the reproductive toxicity codes are case sensitive: F/D vs f/d).
const CANON = new Map(Object.keys(H_STATEMENTS).map(c => [c.toLowerCase(), c]));

/** Every poster H-code present in the text, in canonical spelling. "H 302", "H302+H312", "H360FD" are all found. */
export function extractHCodes(text) {
  const found = new Set();
  const s = String(text || "");
  for (const m of s.matchAll(/(?<![A-Za-z0-9])H[ -]?(\d{3})([A-Za-z]{0,2})(?![A-Za-z0-9])/g)) {
    const base = "H" + m[1], suf = m[2] || "";
    let code = null;
    if (suf && H_STATEMENTS[base + suf]) code = base + suf;                  // exact case: H360Fd
    else if (suf && CANON.has((base + suf).toLowerCase())) code = CANON.get((base + suf).toLowerCase());
    else if (!suf && H_STATEMENTS[base]) code = base;
    if (code) found.add(code);
    else if (suf && H_STATEMENTS[base]) found.add(base);                     // an unknown suffix: keep the base code
  }
  return [...found];
}

/** The text of SDS section 2 if it can be found ("SECTION 2" up to "SECTION 3"), else the whole text. */
export function section2Text(text) {
  const s = String(text || "");
  const a = s.search(/section\s*2\b[\s:.\-–—]*(?:hazards?\s*identification|hazard)/i);
  if (a < 0) return s;
  const rest = s.slice(a + 8);
  const b = rest.search(/section\s*3\b/i);
  return b < 0 ? s.slice(a) : s.slice(a, a + 8 + b);
}

/** Poster rows whose key H-codes appear in `codes`. Aerosol category 3 is "H229 on its own" (without H222 or H223). */
export function rowsForHCodes(codes) {
  const set = new Set(codes);
  const out = [];
  for (const r of HAZARD_ROWS) {
    if (!r.keyCodes.length) continue;
    if (r.class === "aerosol" && r.categories[0] === "3") { if (set.has("H229") && !set.has("H222") && !set.has("H223")) out.push(r); continue; }
    if (r.class === "acute_tox" && r.categories[0] === "4" && !r.keyCodes.some(k => set.has(k))) continue;
    if (r.keyCodes.some(k => set.has(k))) out.push(r);
  }
  return out;
}

const CLASS_WORDS = {
  explosives: /explosive/i, flam_gas: /flam(?:mable)?\.?\s*gas/i, aerosol: /aerosol/i, ox_gas: /oxidi[sz]ing\s*gas|ox\.?\s*gas/i,
  gas_pressure: /gases?\s*under\s*pressure|press\.?\s*gas/i, flam_liq: /flam(?:mable)?\.?\s*liq/i, flam_solid: /flam(?:mable)?\.?\s*sol/i,
  self_reactive: /self[- ]?reactive/i, org_peroxide: /organic\s*peroxide|org\.?\s*perox/i, pyro_liquid: /pyrophoric\s*liq|pyr\.?\s*liq/i,
  pyro_solid: /pyrophoric\s*sol|pyr\.?\s*sol/i, self_heating: /self[- ]?heating/i, water_reactive: /in\s*contact\s*with\s*water|water[- ]react/i,
  ox_liquid: /oxidi[sz]ing\s*liq|ox\.?\s*liq/i, ox_solid: /oxidi[sz]ing\s*sol|ox\.?\s*sol/i, corr_metal: /corrosive\s*to\s*metal|met\.?\s*corr/i,
  desens_explosive: /desensiti[sz]ed/i, acute_tox: /acute\s*tox/i, skin_corr: /skin\s*(?:corr|irrit)/i,
  eye_dmg: /eye\s*(?:dam|irrit)|serious\s*eye/i, resp_sens: /resp(?:iratory)?\.?\s*sens/i, skin_sens: /skin\s*sens/i,
  germ_cell: /germ\s*cell|mutagen/i, carcinogen: /carcinogen/i, repro_tox: /repro(?:ductive)?/i,
  stot_se: /(?:stot|specific\s*target)[^.\n]{0,40}(?:single|\bse\b)|stot[\s-]*se/i, stot_re: /(?:stot|specific\s*target)[^.\n]{0,40}(?:repeat|\bre\b)|stot[\s-]*re/i,
  aspiration: /aspiration/i,
};
function categoryToken(k) {
  const s = String(k);
  if (s === "Type C and D") return "type\\s*[cd]";
  if (s === "Type E and F") return "type\\s*[ef]";
  if (/^type/i.test(s)) return s.replace(/\s+/g, "\\s*");
  if (/^division/i.test(s)) return s.replace(/\s+/g, "\\s*").replace(".", "\\.");
  if (s === "Lactation") return "lact";
  return `(?:cat(?:egory|\\.)?\\s*)?${s}\\b`;
}
/** Does the text name this class together with this category (e.g. "Skin Corr. 1B", "Acute Tox. 3 (Oral)")? Used for categories the H-code cannot tell apart. */
export function categoryAppearsInText(c, k, text) {
  const cw = CLASS_WORDS[c];
  if (!cw || k == null) return false;
  const re = new RegExp(`(?:${cw.source})[^\\n]{0,60}?(?<![\\w.])${categoryToken(k)}`, "i");
  return re.test(String(text || ""));
}

/**
 * Check a classification read by the AI against the H-codes really present in the SDS text. Returns:
 *   list     the classification to store ({c, k, src, check?}): AI entries whose H-code is in the text, plus entries added
 *            from H-codes the AI missed (only where the H-code points at one row, or at one class)
 *   flags    human messages for every mismatch (shown on the chemical page, and stored in `unverified` as "classification")
 *   removed  AI entries dropped because their H-code is not in the text
 *   hCodesInText / hCodesInSection2
 * An AI entry is kept when ANY of its poster H-codes is in the text. When the H-codes cannot tell categories apart (for example
 * acute toxicity 1 vs 2, or skin corrosion 1A/1B/1C) the category must appear in the text next to the class name; if it does not,
 * the entry is kept but marked check:true, because the class is confirmed and the category is not.
 */
export function verifyClassification(aiList, text) {
  const norm = normaliseClassification(aiList);
  const all = extractHCodes(text);
  const sec = extractHCodes(section2Text(text));
  const flags = [];
  const removed = [];
  const list = [];
  for (const e of norm.dropped) flags.push(`The AI returned a classification that is not on the poster and it was ignored (${e}).`);
  for (const e of norm.list) {
    const rows = rowsFor(e.c, e.k);
    const withCodes = rows.filter(r => r.keyCodes.length);
    if (!withCodes.length) { removed.push(e); flags.push(`${classificationLabel(e)} has no hazard statement, so it cannot be checked against the SDS text. It was not stored.`); continue; }
    const present = withCodes.filter(r => rowsForHCodes(all).includes(r));
    if (!present.length) {
      removed.push(e);
      flags.push(`${classificationLabel(e)} was read from the SDS but none of its hazard statements (${withCodes[0].keyCodes.join(", ")}) appear in the SDS text. It was not stored.`);
      continue;
    }
    const out = { c: e.c, k: e.k, src: "ai" };
    // Categories the H-codes cannot tell apart: the H-codes confirm the class, so look for the category in the text.
    const sharedRows = HAZARD_ROWS.filter(r => r.class === e.c && r.keyCodes.some(k => withCodes.some(w => w.keyCodes.includes(k))));
    const ambiguous = e.k != null && (sharedRows.length > withCodes.length || (e.c === "skin_corr" && ["1A", "1B", "1C"].includes(e.k)));
    if (e.k == null) { out.check = true; flags.push(`${classLabel(e.c)}: the category was not read. Check it against SDS section 2.`); }
    else if (ambiguous && !categoryAppearsInText(e.c, e.k, text)) {
      out.check = true;
      flags.push(`${classificationLabel(e)}: the hazard statement is in the SDS but the category could not be confirmed from the text. Check it against SDS section 2.`);
    }
    list.push(out);
  }
  // H-codes in section 2 that no kept classification explains: the AI missed them.
  const explained = new Set(derive(list).hCodes);
  const missing = sec.filter(c => !explained.has(c));
  const missingRows = rowsForHCodes(missing);
  const byClass = new Map();
  for (const r of missingRows) { if (!byClass.has(r.class)) byClass.set(r.class, []); byClass.get(r.class).push(r); }
  for (const [cls, rows] of byClass) {
    if (list.some(x => x.c === cls)) continue; // a class we already have: its other H-codes are for other routes, not a new class
    const cats = [...new Set(rows.flatMap(r => r.categories))];
    const codes = [...new Set(rows.flatMap(r => r.keyCodes.filter(k => missing.includes(k))))];
    // One poster row: the H-code identifies it. A row that lists equivalent categories (eye damage 2 / 2A, sensitiser 1 / 1A / 1B, 1A / 1B) is stored under its
    // first category; skin corrosion 1A / 1B / 1C is the exception because each category is a different placard item, so its category is left to be checked.
    if (rows.length === 1 && (rows[0].categories.length === 1 || cls !== "skin_corr")) {
      list.push({ c: cls, k: rows[0].categories[0], src: "h_code" });
      flags.push(`${codes.join(", ")} appears in SDS section 2 but the AI did not report it. ${classificationLabel({ c: cls, k: rows[0].categories[0] })} was added from the hazard statement.`);
    } else {
      list.push({ c: cls, k: null, src: "h_code", check: true });
      flags.push(`${codes.join(", ")} appears in SDS section 2 but the AI did not report it. ${classLabel(cls)} was added from the hazard statement; its category (${cats.join(", ")}) needs checking.`);
    }
  }
  return { list, flags, removed, hCodesInText: all, hCodesInSection2: sec };
}

/** The class/category choices as one text block for the AI prompt. */
export function promptClassList() {
  return HAZARD_CLASSES.map(c => `${c.id} (${c.label}): ${c.categories.map(k => JSON.stringify(k)).join(", ")}`).join("\n");
}

// ------------------------------------------------------------------------------------------------ placard and manifest items (Schedule 11)

const IT = (item, group, desc, placard, manifest, unit, adg, extra = {}) => ({ item, group, desc, placard, manifest, unit, adg, mixOf: extra.mixOf || null, notes: extra.notes || [] });

/** Items 1 to 43 exactly as in the Safe Work Australia table. `unit`: "L", "kg" or "kg or L" as printed in columns 4 and 5. */
export const PLACARD_ITEMS = [
  IT(1, "Flammable gases", "Category 1A, 1B or any combination of categories 1A and 1B", 200, 5000, "L", "2.1"),
  IT(2, "Gases under pressure", "Acute toxicity, categories 1, 2, 3 or 4 (category 4 only up to LC50 of 5000 ppmV)", 50, 500, "L", "2.3 - Note 2", { notes: [1, 2, 5] }),
  IT(3, "Gases under pressure", "Skin corrosion categories 1A, 1B or 1C", 50, 500, "L", "2.3 - Note 2", { notes: [2] }),
  IT(4, "Gases under pressure", "Not specified elsewhere in this table", 1000, 10000, "L", "2.2"),
  IT(5, "Aerosols", "Category 1, category 2, category 3 or any combination of these categories", 5000, 10000, "L", "2.1 or 2.2"),
  IT(6, "Flammable liquids", "Category 1", 50, 500, "L", "3 (PG I)"),
  IT(7, "Flammable liquids", "Category 2", 250, 2500, "L", "3 (PG II)"),
  IT(8, "Flammable liquids", "Category 3", 1000, 10000, "L", "3 (PG III)"),
  IT(9, "Flammable liquids", "Any mix of chemicals from Items 6 - 8 where none of the items exceeds the quantities in columns 4 or 5 on their own", 1000, 10000, "L", "", { mixOf: [6, 7, 8] }),
  IT(10, "Flammable liquids", "Category 4", 10000, 100000, "L", "Note 3", { notes: [3] }),
  IT(11, "Self-reactive substances", "Type A", 5, 50, "kg or L", "GTDTBT - Note 4", { notes: [4] }),
  IT(12, "Self-reactive substances", "Type B", 50, 500, "kg or L", "4.1 (Type B)"),
  IT(13, "Self-reactive substances", "Type C-F", 250, 2500, "kg or L", "4.1 (Type C-F)"),
  IT(14, "Flammable solids", "Category 1", 250, 2500, "kg", "4.1 (PG II)"),
  IT(15, "Flammable solids", "Category 2", 1000, 10000, "kg", "4.1 (PG III)"),
  IT(16, "Flammable solids", "Any mix of chemicals from Items 12 - 15 where none of the items exceeds the quantities in columns 4 or 5 on their own", 1000, 10000, "kg or L", "", { mixOf: [12, 13, 14, 15] }),
  IT(17, "Pyrophoric liquids and pyrophoric solids", "Category 1", 50, 500, "kg or L", "4.2 (PG I)"),
  IT(18, "Self heating substances and mixtures", "Category 1", 250, 2500, "kg or L", "4.2 (PG II)"),
  IT(19, "Self heating substances and mixtures", "Category 2", 1000, 10000, "kg or L", "4.2 (PG III)"),
  IT(20, "Self heating substances and mixtures", "Any mix of chemicals from Items 17 - 19 where none of the items exceeds the quantities in columns 4 or 5 on their own", 1000, 10000, "kg or L", "", { mixOf: [17, 18, 19] }),
  IT(21, "Substances which in contact with water emit flammable gas", "Category 1", 50, 500, "kg or L", "4.3 (PG I)"),
  IT(22, "Substances which in contact with water emit flammable gas", "Category 2", 250, 2500, "kg or L", "4.3 (PG II)"),
  IT(23, "Substances which in contact with water emit flammable gas", "Category 3", 1000, 10000, "kg or L", "4.3 (PG III)"),
  IT(24, "Substances which in contact with water emit flammable gas", "Any mix of chemicals from Items 21 - 23 where none of the items exceeds the quantities in columns 4 or 5 on their own", 1000, 10000, "kg or L", "", { mixOf: [21, 22, 23] }),
  IT(25, "Oxidising liquids and oxidising solids", "Category 1", 50, 500, "kg or L", "5.1 (PG I)"),
  IT(26, "Oxidising liquids and oxidising solids", "Category 2", 250, 2500, "kg or L", "5.1 (PG II)"),
  IT(27, "Oxidising liquids and oxidising solids", "Category 3", 1000, 10000, "kg or L", "5.1 (PG III)"),
  IT(28, "Oxidising liquids and oxidising solids", "Any mix of chemicals from Items 25 - 27 where none of the items exceeds the quantities in columns 4 or 5 on their own", 1000, 10000, "kg or L", "", { mixOf: [25, 26, 27] }),
  IT(29, "Organic peroxides", "Type A", 5, 50, "kg or L", "GTDTBT - Note 4", { notes: [4] }),
  IT(30, "Organic peroxides", "Type B", 50, 500, "kg or L", "5.2 (Type B)"),
  IT(31, "Organic peroxides", "Type C-F", 250, 2500, "kg or L", "5.2 (Type C-F)"),
  IT(32, "Organic peroxides", "Any mix of chemicals from Items 30 and 31 where none of the items exceeds the quantities in columns 4 or 5 on their own", 250, 2500, "kg or L", "", { mixOf: [30, 31] }),
  IT(33, "Acute toxicity", "Category 1", 50, 500, "kg or L", "6.1 (PG I)", { notes: [5] }),
  IT(34, "Acute toxicity", "Category 2", 250, 2500, "kg or L", "6.1 (PG II)", { notes: [5] }),
  IT(35, "Acute toxicity", "Category 3", 1000, 10000, "kg or L", "6.1 (PG III)", { notes: [5] }),
  IT(36, "Acute toxicity", "Any mix of chemicals from Items 33 - 35 where none of the items exceeds the quantities in columns 4 or 5 on their own", 1000, 10000, "kg or L", "", { mixOf: [33, 34, 35], notes: [5] }),
  IT(37, "Skin corrosion", "Category 1A", 50, 500, "kg or L", "8 (PG I)"),
  IT(38, "Skin corrosion", "Category 1B", 250, 2500, "kg or L", "8 (PG II)"),
  IT(39, "Skin corrosion", "Category 1C", 1000, 10000, "kg or L", "8 (PG III)"),
  IT(40, "Corrosive to metals", "Category 1", 1000, 10000, "kg or L", "8 (PG III)"),
  IT(41, "Corrosive to metals", "Any mix of chemicals from Items 37 - 40 where none of the items exceeds the quantities in columns 4 or 5 on their own", 1000, 10000, "kg or L", "", { mixOf: [37, 38, 39, 40] }),
  IT(42, "Unstable explosives", "", 5, 50, "kg or L", "GTDTBT - Note 4", { notes: [4] }),
  IT(43, "Unstable explosives", "Any mix of chemicals from items 11, 29 and 42 where none of the items exceed the quantities in columns 4 or 5 on their own", 5, 50, "kg or L", "GTDTBT - Note 4", { mixOf: [11, 29, 42], notes: [4] }),
];
export function placardItem(n) { return PLACARD_ITEMS.find(i => i.item === n) || null; }

export const PLACARD_NOTES = {
  1: "For item 2, gases under pressure with acute toxicity category 4 only applies up to a LC50 of 5000 ppmV, which is equivalent to Div. 2.3 under the ADG code.",
  2: "Division 2.3 under the ADG Code includes gases and vapours as acutely toxic (categories 1, 2 and 3) and gases which are corrosive to skin (category 1).",
  3: "Only liquids with a flash point of up to 93°C are classified as flammable liquids under the WHS Regulations. C1 combustible liquids with flash points between 93°C and 150°C are not classified as flammable liquids under the GHS or WHS Regulations.",
  4: "GTDTBT = Goods too dangerous to be transported.",
  5: "For gases classified with Acute Toxicity, the placard and manifest quantities as defined under item 2, rather than items 33-36, should be used.",
};
export const FLAM_LIQ_CAT4_RULE = "For the purposes of this table, if a flammable liquid of category 4 is used, handled or stored in the same spill compound as one or more flammable liquids of categories 1, 2 or 3, the total quantity of flammable liquid is determined as if the flammable liquid of category 4 had the same classification as the flammable liquid in the spill compound with the lowest flash point. For example, 1000 L of flammable liquid category 1 and 1000 L of flammable liquid category 4 is considered to contain 2000 L of flammable liquid category 1.";
export const ADG_COLUMN_NOTE = "The ADG Code classes in this table are for illustration only. Placard and manifest quantities are worked out from GHS hazard classes and categories.";

// Which placard item each classification entry falls under (everything not listed here has no item in the table).
const ITEM_OF = {
  flam_liq: { "1": 6, "2": 7, "3": 8, "4": 10 },
  flam_solid: { "1": 14, "2": 15 },
  self_reactive: { "Type A": 11, "Type B": 12, "Type C and D": 13, "Type E and F": 13 },
  org_peroxide: { "Type A": 29, "Type B": 30, "Type C and D": 31, "Type E and F": 31 },
  pyro_liquid: { "1": 17 }, pyro_solid: { "1": 17 },
  self_heating: { "1": 18, "2": 19 },
  water_reactive: { "1": 21, "2": 22, "3": 23 },
  ox_liquid: { "1": 25, "2": 26, "3": 27 }, ox_solid: { "1": 25, "2": 26, "3": 27 },
  corr_metal: { "1": 40 },
  acute_tox: { "1": 33, "2": 34, "3": 35 },
  skin_corr: { "1A": 37, "1B": 38, "1C": 39 },
  aerosol: { "1": 5, "2": 5, "3": 5 },
  explosives: { "Unstable explosive": 42 },
};
const GAS_FLAM = ["1A", "1B", "Pyrophoric gas", "Chemically unstable gas A", "Chemically unstable gas B"];

/**
 * Which items a chemical's classification counts towards.
 * Returns {items:[{item, via, check}], issues:[{code, message}]}.
 *   * gases (a gas under pressure class): acute toxicity (any category 1-4) -> item 2; skin corrosion 1A/1B/1C -> item 3; flammable gas -> item 1;
 *     otherwise item 4 ("not specified elsewhere"). Note 5 of the table says acute toxicity of gases uses item 2 and not items 33-36; the same
 *     is applied to skin corrosion (item 3 rather than 37-39), because the table lists it under gases.
 *   * a chemical that qualifies under several items counts towards EACH of them. The table does not say how to combine them; see docs/REFERENCE.md.
 *   * a category the table does not give an item for (explosives divisions 1.1-1.6, desensitised explosives, oxidising gases on their own,
 *     acute toxicity category 4 for liquids and solids) is reported as an issue, not guessed.
 * `check` is true when the category was not confirmed against the SDS, so the item depends on an unverified reading.
 */
export function itemsForClassification(classification) {
  const items = [], issues = [];
  if (classification == null) return { items, issues: [{ code: "no_classification", message: "No GHS classification has been recorded for this chemical, so it cannot be placed in a placard item." }] };
  const add = (item, via, check) => { if (!items.some(i => i.item === item)) items.push({ item, via, check: !!check }); };
  const has = (c) => classification.filter(e => e.c === c);
  const isGas = has("gas_pressure").length > 0;
  for (const e of classification) {
    const label = classificationLabel(e);
    const chk = !!e.check;
    if (e.k == null && (ITEM_OF[e.c] || ["acute_tox", "skin_corr", "flam_gas", "gas_pressure", "ox_gas", "desens_explosive"].includes(e.c))) {
      if (!(isGas && ["flam_gas", "acute_tox", "skin_corr", "gas_pressure"].includes(e.c))) {
        issues.push({ code: "category_unknown", message: `${label}: the category is not known, so the placard item cannot be worked out.` });
        continue;
      }
    }
    const k = e.k == null ? null : String(e.k);
    if (e.c === "gas_pressure") continue; // handled below
    if (e.c === "flam_gas") { if (GAS_FLAM.includes(k) || k === null) add(1, label, chk); continue; }
    if (e.c === "acute_tox") {
      if (isGas) { if (["1", "2", "3", "4"].includes(k) || k === null) add(2, label, chk); if (k === "4" || k === null) issues.push({ code: "gas_lc50", message: `${label} (gas): item 2 applies to category 4 only up to an LC50 of 5000 ppmV. The LC50 is not held here, so check it.` }); }
      else if (k === "4") issues.push({ code: "acute4_not_in_table", message: `${label}: acute toxicity category 4 has no item for liquids and solids in the table, so it is not counted.` });
      else if (ITEM_OF.acute_tox[k]) add(ITEM_OF.acute_tox[k], label, chk);
      continue;
    }
    if (e.c === "skin_corr") {
      if (isGas) { if (["1A", "1B", "1C"].includes(k)) add(3, label, chk); }
      else if (ITEM_OF.skin_corr[k]) add(ITEM_OF.skin_corr[k], label, chk);
      continue;
    }
    if (e.c === "ox_gas") { if (!isGas) issues.push({ code: "ox_gas_alone", message: `${label}: oxidising gases have no item of their own in the table. If this is a gas under pressure, record that class as well.` }); continue; }
    if (e.c === "explosives") {
      if (k === "Unstable explosive") add(42, label, chk);
      else issues.push({ code: "explosives_not_in_table", message: `${label}: explosives of Divisions 1.1 to 1.6 are not in this table (only unstable explosives are). They are covered by the Australian Explosives Code.` });
      continue;
    }
    if (e.c === "desens_explosive") { issues.push({ code: "desens_not_in_table", message: `${label}: desensitised explosives are not in this table.` }); continue; }
    const map = ITEM_OF[e.c];
    if (map && map[k] !== undefined) add(map[k], label, chk);
    else if (map && k !== null) issues.push({ code: "no_item", message: `${label}: no item in the table for this category.` });
  }
  if (isGas && !items.some(i => i.item === 1 || i.item === 2 || i.item === 3)) add(4, classLabel("gas_pressure"), classification.filter(e => e.c === "gas_pressure").some(e => e.check));
  return { items, issues };
}

// ------------------------------------------------------------------------------------------------ site totals

/** How close counts as "near" a quantity: 80%. A reading aid for the screens, not part of Schedule 11. */
export const NEAR_FRACTION = 0.8;

const lc = (s) => String(s || "").trim().toLowerCase();

/**
 * Total the stored quantities for each item across the site and compare them with the placard and manifest quantities.
 *   entries: [{id, chemical_id, name, classification:[{c,k,check?}]|null, quantity, unit:"L"|"kg", location, spill_compound?}]
 * Returns {items:[{item, def, totalL, totalKg, total, counted, placardOver, manifestOver, isMix, mixApplies:{placard,manifest}, contributors}], issues, over}.
 *   * Only quantities in the unit the table uses are added: "L" items take litres, "kg" items take kilograms, "kg or L" items take both
 *     (the table prints one number for both; no density conversion is attempted). A quantity in the other unit is reported, not converted.
 *   * "Over" means strictly more than the quantity in the table ("exceeds").
 *   * Flammable liquid category 4 in the same spill compound (default: same location) as category 1, 2 or 3 is counted as the lowest category
 *     in that compound (the table's flammable liquid classification rule). Otherwise it is item 10.
 *   * Mixing items (9, 16, 20, 24, 28, 32, 36, 41, 43) add the totals of the items they cover. As the table says, they apply only
 *     where none of those items exceeds its own quantity; the placard column and the manifest column are checked separately.
 */
export function computeSiteTotals(entries) {
  const totals = new Map(PLACARD_ITEMS.map(def => [def.item, { item: def.item, def, totalL: 0, totalKg: 0, total: 0, counted: 0, contributors: [], placardOver: false, manifestOver: false, isMix: !!def.mixOf, mixApplies: null }]));
  const issues = [];
  const list = (entries || []).filter(e => Number(e.quantity) > 0);

  // Spill compounds: the lowest flammable liquid category (1 = lowest flash point) present in each.
  const compoundMin = new Map();
  for (const e of list) {
    const cl = e.classification || [];
    const fl = cl.filter(x => x.c === "flam_liq" && ["1", "2", "3"].includes(String(x.k)));
    if (!fl.length) continue;
    const key = lc(e.spill_compound || e.location);
    const m = Math.min(...fl.map(x => Number(x.k)));
    compoundMin.set(key, Math.min(compoundMin.get(key) ?? 9, m));
  }

  const seenIssue = new Set();
  const issue = (e, code, message) => { const k = `${code}|${e.chemical_id}|${message}`; if (!seenIssue.has(k)) { seenIssue.add(k); issues.push({ code, message, chemical_id: e.chemical_id, name: e.name, location_id: e.id ?? null }); } };

  // A chemical that falls under an item but has no quantity recorded makes the totals look lower than they are: say so.
  for (const e of (entries || [])) {
    if (e.quantity === null || e.quantity === undefined || e.quantity === "") {
      if (itemsForClassification(e.classification).items.length) issue(e, "no_quantity", `${e.name}: no quantity is recorded here, so it is not in the totals.`);
    }
  }

  for (const e of list) {
    const q = Number(e.quantity), unit = e.unit === "kg" ? "kg" : "L";
    let res = itemsForClassification(e.classification);
    let itemList = res.items.map(i => ({ ...i }));
    for (const is of res.issues) issue(e, is.code, `${e.name}: ${is.message}`);
    // Flammable liquid category 4 spill compound rule.
    const cat4 = itemList.find(i => i.item === 10);
    if (cat4) {
      const m = compoundMin.get(lc(e.spill_compound || e.location));
      if (m) {
        const moved = { 1: 6, 2: 7, 3: 8 }[m];
        itemList = itemList.filter(i => i.item !== 10);
        itemList.push({ item: moved, via: `${cat4.via} (counted as category ${m}: same spill compound as a category ${m} flammable liquid)`, check: cat4.check, rule: "spill_compound" });
      }
    }
    if (itemList.length > 1) issue(e, "multiple_items", `${e.name} counts towards ${itemList.length} items (${itemList.map(i => i.item).join(", ")}). The table does not say how to combine them, so its quantity is counted in each.`);
    for (const it of itemList) {
      const t = totals.get(it.item), def = t.def;
      const okUnit = def.unit === "kg or L" || def.unit === unit;
      if (!okUnit) {
        issue(e, "unit_mismatch", `${e.name} (${q} ${unit}) counts towards item ${it.item}, which the table gives in ${def.unit}. There is no density here to convert it, so this quantity is NOT in the total.`);
        t.contributors.push({ ...contrib(e, q, unit, it), counted: false });
        continue;
      }
      if (unit === "L") t.totalL += q; else t.totalKg += q;
      t.counted += q;
      t.contributors.push({ ...contrib(e, q, unit, it), counted: true });
    }
  }

  // Item totals, then the mixing items.
  for (const t of totals.values()) if (!t.isMix) t.total = round(t.counted);
  for (const t of totals.values()) {
    if (t.isMix) {
      const parts = t.def.mixOf.map(n => totals.get(n));
      const sum = parts.reduce((s, p) => s + p.counted, 0);
      t.total = round(sum); t.counted = sum; t.totalL = round(parts.reduce((s, p) => s + p.totalL, 0)); t.totalKg = round(parts.reduce((s, p) => s + p.totalKg, 0));
      t.mixApplies = {
        placard: parts.every(p => p.counted <= p.def.placard),
        manifest: parts.every(p => p.counted <= p.def.manifest),
      };
      t.mixParts = parts.map(p => ({ item: p.item, total: round(p.counted) }));
      t.placardOver = t.mixApplies.placard && sum > t.def.placard;
      t.manifestOver = t.mixApplies.manifest && sum > t.def.manifest;
    } else {
      t.placardOver = t.counted > t.def.placard;
      t.manifestOver = t.counted > t.def.manifest;
    }
    // "Near": at least NEAR_FRACTION of the quantity but not over it. A reading aid only; the table has no such threshold.
    t.placardNear = (!t.isMix || t.mixApplies.placard) && !t.placardOver && t.counted > 0 && t.counted >= NEAR_FRACTION * t.def.placard;
    t.manifestNear = (!t.isMix || t.mixApplies.manifest) && !t.manifestOver && t.counted > 0 && t.counted >= NEAR_FRACTION * t.def.manifest;
    t.totalL = round(t.totalL); t.totalKg = round(t.totalKg);
  }
  const out = [...totals.values()];
  return {
    items: out,
    issues,
    over: { placard: out.filter(t => t.placardOver).map(t => t.item), manifest: out.filter(t => t.manifestOver).map(t => t.item) },
  };
}
function contrib(e, q, unit, it) {
  return { location_id: e.id ?? null, chemical_id: e.chemical_id, name: e.name, location: e.location || "", quantity: q, unit, via: it.via, check: !!it.check, rule: it.rule || null };
}
function round(n) { return Math.round(n * 1000) / 1000; }

// ------------------------------------------------------------------------------------------------ places

export const PLACE_TYPES = [
  { id: "workshop", label: "Workshop or depot", counts_default: true },
  { id: "vehicle", label: "Vehicle", counts_default: false },
  { id: "site", label: "Site", counts_default: true },
];
export function placeTypeLabel(id) { const t = PLACE_TYPES.find(x => x.id === id); return t ? t.label : String(id); }
export function defaultCountsTowardTotals(type) { const t = PLACE_TYPES.find(x => x.id === type); return t ? t.counts_default : true; }

/** Shown on a vehicle's page, on the manifest and in exports. OPEN POINT: not yet confirmed with Safe Work Australia or the regulator (docs/REFERENCE.md). */
export const VEHICLE_TRANSPORT_NOTE = "Products in transit fall under the transport rules and are not counted here.";
export const VEHICLE_TRANSPORT_CAVEAT = "This is our understanding and has not been confirmed with Safe Work Australia or your WHS regulator. Check with them.";

/**
 * Placard and manifest totals PER PLACE, never across the whole business.
 *   places:  [{id, name, place_type, counts_toward_totals, archived}]
 *   entries: [{place_id, id, chemical_id, name, classification, quantity, unit, spill_compound}] (one per chemical-place link)
 * Returns one result per place: {place, counts, totals, over, near, note, caveat}. A place that does not count (a vehicle by default, an archived
 * place, or one switched off) gets counts: false, no totals and, for a vehicle, the transport note. The flammable liquid category 4 spill
 * compound rule works inside one place (a link's spill_compound, default the place).
 */
export function computePlaceTotals(places, entries) {
  return (places || []).map(place => {
    if (place.archived || !place.counts_toward_totals) {
      return {
        place, counts: false, totals: null, over: { placard: [], manifest: [] }, near: { placard: [], manifest: [] },
        note: place.archived ? "This place is archived." : place.place_type === "vehicle" ? VEHICLE_TRANSPORT_NOTE : "This place is set not to count towards the placard and manifest totals.",
        caveat: !place.archived && place.place_type === "vehicle" ? VEHICLE_TRANSPORT_CAVEAT : null,
      };
    }
    const own = (entries || []).filter(e => String(e.place_id) === String(place.id)).map(e => ({ ...e, location: place.name }));
    const totals = computeSiteTotals(own);
    return {
      place, counts: true, totals, over: totals.over,
      near: { placard: totals.items.filter(i => i.placardNear).map(i => i.item), manifest: totals.items.filter(i => i.manifestNear).map(i => i.item) },
      note: null, caveat: null,
    };
  });
}
