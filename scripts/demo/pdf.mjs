// Builds one clearly fictional, 16-section safety data sheet PDF with pdf-lib (standard fonts, real extractable text).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { P_TEXT, TAG_P, HAZARD_PHRASE, SUPPLIERS } from './text.mjs';
import { H_STATEMENTS, PICTOGRAMS, derive } from '../../public/lib/ghs-ref.mjs';
import { entryCodes, UNCONFIRMED_CATEGORY } from './classes.mjs';

export const BANNER = 'FICTIONAL DEMONSTRATION DOCUMENT - NOT A REAL SAFETY DATA SHEET';


const FIRST_AID = {
  flam: ['Inhalation: move to fresh air. Seek medical advice if symptoms persist.', 'Skin: remove contaminated clothing, wash skin with soap and water.', 'Eyes: rinse with water for at least 15 minutes. Seek medical advice.', 'Ingestion: do NOT induce vomiting. Rinse mouth and seek medical advice.'],
  aer: ['Inhalation: move to fresh air. Seek medical advice if symptoms persist.', 'Skin: wash with soap and water.', 'Eyes: rinse with water for at least 15 minutes.', 'Ingestion: rinse mouth. Seek medical advice.'],
  corr: ['Inhalation: move to fresh air; seek immediate medical attention.', 'Skin: remove contaminated clothing and flush skin with water for at least 15 minutes. Seek medical attention.', 'Eyes: flush with running water for at least 15 minutes, holding eyelids open. Seek immediate medical attention.', 'Ingestion: rinse mouth, drink water, do NOT induce vomiting. Seek immediate medical attention.'],
  gas: ['Inhalation: move to fresh air. If breathing has stopped give artificial respiration and call an ambulance.', 'Skin and eyes: not expected to cause harm. Frostbite from liquid release: flush with lukewarm water.', 'Ingestion: not applicable.'],
  ox: ['Inhalation: move to fresh air.', 'Skin: wash with plenty of water.', 'Eyes: rinse with water for at least 15 minutes.', 'Ingestion: rinse mouth, do NOT induce vomiting. Seek medical advice.'],
  dust: ['Inhalation: move to fresh air. Blow nose and rinse mouth.', 'Skin: wash with soap and water. Wet product can burn skin: remove wet clothing.', 'Eyes: rinse with water for at least 15 minutes. Do not rub.', 'Ingestion: rinse mouth, drink water. Seek advice if unwell.'],
  irrit: ['Inhalation: move to fresh air.', 'Skin: wash with soap and water.', 'Eyes: rinse with water for several minutes.', 'Ingestion: rinse mouth and drink water. Seek advice if unwell.'],
  sens: ['Inhalation: move to fresh air. Seek medical advice immediately if breathing is difficult or wheezing starts.', 'Skin: wash with soap and water. Seek advice if a rash develops.', 'Eyes: rinse with water for at least 15 minutes.', 'Ingestion: rinse mouth. Seek medical advice.'],
  env: [],
  none: ['Inhalation: move to fresh air if unwell.', 'Skin: wash with soap and water.', 'Eyes: rinse with water.', 'Ingestion: rinse mouth and drink water.'],
};

const FIRE = {
  flam: 'Use foam, dry chemical powder or carbon dioxide. Do not use a water jet. Containers may explode in a fire: cool with water spray from a distance.',
  aer: 'Use foam, dry chemical or carbon dioxide. Cool containers with water spray. Containers may burst and rocket when heated.',
  corr: 'Product is not flammable. Use an extinguishing agent suitable for the surrounding fire. Fire may release toxic or corrosive fumes.',
  gas: 'Stop the leak only if safe. Cool cylinders with water spray from a protected position. Let a gas fire burn out.',
  ox: 'Not combustible but supports combustion. Flood the area with water. Keep away from combustible material.',
  dust: 'Not combustible. Use an extinguishing agent suitable for the surrounding fire.',
  irrit: 'Not combustible. Use an extinguishing agent suitable for the surrounding fire.',
  sens: 'Use an extinguishing agent suitable for the surrounding fire. Wear self-contained breathing apparatus.',
  env: 'Use an extinguishing agent suitable for the surrounding fire.',
  none: 'Not combustible. Use an extinguishing agent suitable for the surrounding fire.',
};

const SPILL = {
  flam: 'Remove ignition sources. Ventilate. Contain with absorbent material (sand, spill pads) and place in a sealed labelled container. Do not allow to enter drains.',
  aer: 'Remove ignition sources. Ventilate the area. Collect damaged containers and keep them outdoors.',
  corr: 'Wear full PPE. Contain and neutralise small spills with a suitable agent, absorb, and collect in a labelled container. Prevent entry to drains.',
  gas: 'Evacuate the area and ventilate. Stop the leak if safe to do so. Do not enter confined spaces until tested.',
  ox: 'Dilute with plenty of water. Keep away from combustible material. Do not return spilt product to the container.',
  dust: 'Avoid generating dust. Sweep or vacuum (with a suitable filter) and place in a labelled container.',
  irrit: 'Absorb with inert material and collect in a labelled container. Wash the area with water.',
  sens: 'Ventilate. Wear gloves and respiratory protection. Absorb with inert material and place in a labelled container.',
  env: 'Prevent entry to drains and waterways.',
  none: 'Wipe up or absorb with inert material. Wash the area with water.',
};

const STORAGE = {
  flam: 'Store in a cool, well-ventilated place away from heat and ignition sources, preferably in a flammable liquids cabinet. Keep containers tightly closed. Ground containers when transferring.',
  aer: 'Store below 50 deg C, away from direct sunlight and ignition sources. Do not pierce or burn, even after use.',
  corr: 'Store in the original, tightly closed container in a bunded, locked area, away from incompatible materials (acids from bases, oxidisers from organics).',
  gas: 'Store cylinders upright and secured, outdoors or in a ventilated cage, away from heat and incompatible gases. Keep valve caps on.',
  ox: 'Store away from combustible materials, fuels and reducing agents. Keep containers vented as required.',
  dust: 'Store in a cool, dry place in the original sealed bag or container. Keep dry.',
  irrit: 'Store in the original container, tightly closed, in a cool place.',
  sens: 'Store in a cool, dry, ventilated place. Keep containers tightly closed to avoid moisture contact.',
  env: 'Store in a bunded area to prevent releases to the environment.',
  none: 'Store in a cool, dry place in the original container.',
};

const PPE = {
  flam: 'Safety glasses; chemical-resistant gloves; overalls or long sleeves. Use with adequate ventilation or local exhaust. A respirator with an organic vapour filter is needed if ventilation is poor.',
  aer: 'Safety glasses; gloves. Use in a well-ventilated area.',
  corr: 'Chemical goggles or face shield; chemical-resistant gloves and apron; safety footwear. Ensure an eyewash is available.',
  gas: 'Safety glasses; safety footwear; gloves suitable for handling cylinders. Use a gas detector in enclosed spaces.',
  ox: 'Chemical goggles; chemical-resistant gloves; apron.',
  dust: 'Safety glasses; gloves; overalls; P2 respirator if dust is generated.',
  irrit: 'Safety glasses; gloves.',
  sens: 'Chemical goggles; chemical-resistant gloves; respiratory protection with a suitable filter.',
  env: 'As for other hazards. Avoid release to the environment.',
  none: 'No special requirements. Normal hygiene: wash hands after use.',
};

const winAnsi = s => String(s).replace(/[^\x20-\x7E]/g, '?');

function pCodes(code) { return code.replace(/P(\d{3})/g, (m, d, i) => (i ? '+' : '') + 'P' + d); }

export function pCodeList(spec) {
  const out = [];
  for (const t of spec.tags) for (const c of TAG_P[t]) if (!out.includes(c)) out.push(c);
  return out;
}
export function pList(spec) { return pCodeList(spec).map(c => `${pCodes(c)} ${P_TEXT[c]}`); }
const ABBR = { flam_gas: 'Flam. Gas', aerosol: 'Aerosol', ox_gas: 'Ox. Gas', flam_liq: 'Flam. Liq.', ox_liquid: 'Ox. Liq.', corr_metal: 'Met. Corr.',
  acute_tox: 'Acute Tox.', resp_sens: 'Resp. Sens.', skin_sens: 'Skin Sens.', germ_cell: 'Muta.', carcinogen: 'Carc.', repro_tox: 'Repr.', stot_se: 'STOT SE', stot_re: 'STOT RE', aspiration: 'Asp. Tox.' };
export function abbrevLabel(spec, c, k) {
  if (c === 'skin_corr') return k === '2' ? 'Skin Irrit. 2' : (UNCONFIRMED_CATEGORY[spec.k]?.c === c ? 'Skin Corr. 1' : 'Skin Corr. ' + k);
  if (c === 'eye_dmg') return k === '1' ? 'Eye Dam. 1' : 'Eye Irrit. ' + k;
  if (c === 'gas_pressure') return 'Press. Gas (' + k + ')';
  return ABBR[c] + ' ' + k;
}
/** [{text: 'Flam. Liq. 2 (H225)', codes, statements:[...]}] for section 2, in the usual abbreviations. */
export function classificationLines(spec) {
  return spec.cls.map(([c, k, codes]) => {
    const cs = entryCodes(c, k, codes);
    return { text: abbrevLabel(spec, c, k) + ' (' + cs.join(', ') + ')', codes: cs };
  });
}
export function hCodeList(spec) { return [...new Set(classificationLines(spec).flatMap(l => l.codes))]; }
export function hList(spec) { return hCodeList(spec).map(c => c + ' ' + H_STATEMENTS[c]); }
export function derivedFor(spec) { return derive(spec.cls.map(([c, k]) => ({ c, k }))); }
export function classificationText(spec) { return classificationLines(spec).map(l => l.text).join('; '); }

function fmtLong(iso) {
  const m = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [y, mo, d] = iso.split('-').map(Number);
  return `${d} ${m[mo - 1]} ${y}`;
}

// ctx: { issue (YYYY-MM-DD|null), codes: [product codes], products: [names], replacesIssue, versionNo }
export async function buildSdsPdf(spec, ctx) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const when = new Date((ctx.issue || '2020-01-01') + 'T00:00:00Z');
  doc.setTitle(winAnsi(spec.t) + ' (fictional demo SDS)');
  doc.setAuthor('SDS EZY demo generator');
  doc.setProducer('SDS EZY demo generator');
  doc.setCreator('SDS EZY demo generator');
  doc.setCreationDate(when);
  doc.setModificationDate(when);

  const W = 595, H = 842, M = 50, TOP = H - 60, BOTTOM = 55, LH = 12.5;
  let page, y;
  const pages = [];
  const newPage = () => {
    page = doc.addPage([W, H]); pages.push(page);
    page.drawRectangle({ x: 0, y: H - 30, width: W, height: 30, color: rgb(0.7, 0.1, 0.1) });
    page.drawText(BANNER, { x: M, y: H - 20, size: 9.5, font: bold, color: rgb(1, 1, 1) });
    y = TOP;
  };
  const need = n => { if (y - n < BOTTOM) newPage(); };
  const wrap = (text, f, size, width) => {
    const out = [];
    for (const para of winAnsi(text).split('\n')) {
      let line = '';
      for (const w of para.split(/\s+/)) {
        const t = line ? line + ' ' + w : w;
        if (f.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = w; } else line = t;
      }
      out.push(line);
    }
    return out;
  };
  const para = (text, { size = 9.5, f = font, indent = 0, gap = 3 } = {}) => {
    for (const l of wrap(text, f, size, W - 2 * M - indent)) { need(LH); page.drawText(l, { x: M + indent, y, size, font: f }); y -= LH; }
    y -= gap;
  };
  const kv = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    const key = winAnsi(k) + ': ';
    const kw = bold.widthOfTextAtSize(key, 9.5);
    const lines = wrap(v, font, 9.5, W - 2 * M - kw);
    need(LH);
    page.drawText(key, { x: M, y, size: 9.5, font: bold });
    lines.forEach((l, i) => { if (i) need(LH); page.drawText(l, { x: M + kw, y, size: 9.5, font }); y -= LH; });
    y -= 1;
  };
  const section = (n, title) => { need(40); y -= 6; page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.88, 0.9, 0.93) }); page.drawText(`SECTION ${n}: ${title.toUpperCase()}`, { x: M + 4, y, size: 10, font: bold }); y -= 20; };

  newPage();
  page.drawText('SAFETY DATA SHEET (FICTIONAL EXAMPLE)', { x: M, y, size: 15, font: bold }); y -= 20;
  para(spec.t, { size: 12, f: bold, gap: 2 });
  para('Prepared in the format of the 16 section GHS safety data sheet, for demonstration of the SDS EZY chemical register only. The company, product, numbers and advice below are invented. Never use this page to handle a real chemical.', { size: 8.5, gap: 4 });

  const sup = SUPPLIERS[spec.s];
  const tags = spec.tags;
  const hz = spec.cls.length > 0;
  const dv = derivedFor(spec);
  section(1, 'Identification');
  kv('Product name', spec.t);
  kv('Product code(s)', (ctx.codes || []).filter(Boolean).join(', ') || 'n/a');
  if (ctx.products && ctx.products.length > 1) kv('This sheet covers', ctx.products.join('; '));
  kv('Recommended use', 'Workshop, maintenance and building use by trained workers (fictional)');
  kv('Supplier', sup.name);
  kv('Address', 'Fictional Industrial Estate, Sampleton NSW 2999');
  kv('Emergency telephone', sup.phone + ' (24 hours, fictional number)');
  kv('Revision', spec.rev);
  if (ctx.issue) kv('Issue date', fmtLong(ctx.issue)); else kv('Issue date', 'not stated');

  section(2, 'Hazards identification');
  if (hz) { para('GHS classification', { f: bold, gap: 1 }); classificationLines(spec).forEach(l => para(l.text, { indent: 8, gap: 0 })); y -= 3; }
  else kv('GHS classification', 'Not classified as hazardous');
  kv('Signal word', hz && dv.signal_word ? dv.signal_word : 'None');
  kv('Pictograms', dv.pictograms.length ? dv.pictograms.map(p => p + ' ' + PICTOGRAMS.find(x => x.code === p).name).join('; ') : 'None required');
  if (hz) {
    para('Hazard statements', { f: bold, gap: 1 });
    hList(spec).forEach(l => para(l, { indent: 8, gap: 0 }));
    y -= 3;
    if (spec.extraH) kv('Other hazard statements (not GHS classes on the Safe Work Australia table)', spec.extraH.map(c => c + ' ' + {H411: 'Toxic to aquatic life with long lasting effects'}[c]).join('; '));
    para('Precautionary statements', { f: bold, gap: 1 });
    pList(spec).forEach(l => para(l, { indent: 8, gap: 0 }));
    y -= 3;
  }
  tags.forEach(t => para(HAZARD_PHRASE[t], { gap: 1 }));
  if (spec.ps) kv('Poisons schedule (SUSMP)', spec.ps);

  section(3, 'Composition / information on ingredients');
  for (const [n, cas, pct] of spec.comp) kv(n, `${cas ? 'CAS ' + cas + '; ' : ''}${pct} %`);

  section(4, 'First aid measures');
  const fa = FIRST_AID[tags[0]] || FIRST_AID.none;
  fa.forEach(l => para(l, { gap: 1 }));
  para('Advice to doctor: treat symptomatically. In an emergency call 000.', { gap: 2 });

  section(5, 'Fire fighting measures');
  para(FIRE[tags[0]]);
  para('Firefighters should wear self-contained breathing apparatus and protective clothing.');

  section(6, 'Accidental release measures');
  para(SPILL[tags[0]]);

  section(7, 'Handling and storage');
  para('Handling: avoid contact with skin and eyes. Read the label and this sheet before use. Do not eat, drink or smoke while handling. Wash hands after use.');
  para('Storage: ' + STORAGE[tags[0]]);

  section(8, 'Exposure controls / personal protection');
  para('Exposure standards: refer to the current Safe Work Australia workplace exposure standards for the ingredients listed in section 3.');
  para('Engineering controls: ' + (tags.some(t => ['flam', 'aer', 'sens', 'corr'].includes(t)) ? 'use in a well-ventilated area or with local exhaust ventilation.' : 'general ventilation is normally adequate.'));
  para('Personal protective equipment: ' + PPE[tags[0]]);

  section(9, 'Physical and chemical properties');
  kv('Appearance / form', `${spec.form}; ${spec.ph}`);
  kv('Flash point', spec.fp || 'Not applicable');
  kv('Solubility in water', tags.includes('none') || tags.includes('corr') ? 'Soluble / miscible' : 'See section 12; may be insoluble');

  section(10, 'Stability and reactivity');
  para('Stable under normal conditions of storage and use. Avoid heat, ignition sources and incompatible materials listed in section 7. Hazardous decomposition products on burning: carbon monoxide and carbon dioxide.');

  section(11, 'Toxicological information');
  para(hz ? 'Health effects relate to the hazard statements in section 2. Acute and chronic effects depend on dose, duration and route of exposure. (Demonstration text only.)' : 'No significant health effects expected under normal use. (Demonstration text only.)');

  section(12, 'Ecological information');
  para(tags.includes('env') ? 'Toxic to aquatic life. Do not allow to enter drains, soil or waterways.' : 'No significant ecological effects expected when used as directed. Avoid release to the environment.');

  section(13, 'Disposal considerations');
  para('Dispose of contents and containers through an approved waste contractor in accordance with local regulations. Do not pour onto the ground or into drains.');

  section(14, 'Transport information');
  if (spec.dg) {
    const [un, cls, sub, pg, hc, psn] = spec.dg;
    kv('UN number', un);
    kv('Proper shipping name', psn);
    kv('Dangerous goods class', cls);
    if (sub) kv('Subsidiary risk', sub);
    kv('Packing group', pg || 'None assigned');
    kv('Hazchem code', hc);
    kv('Transport', 'Australian Dangerous Goods Code. Fictional entry for demonstration.');
  } else {
    para('Not classified as dangerous goods for transport by road or rail according to the Australian Dangerous Goods Code. No UN number, class, packing group or Hazchem code applies.');
  }

  section(15, 'Regulatory information');
  para(hz ? 'Classified as a hazardous chemical according to the model Work Health and Safety Regulations (GHS).' : 'Not classified as a hazardous chemical according to the model Work Health and Safety Regulations.');
  if (spec.ps) kv('Poisons Standard (SUSMP) schedule', spec.ps);
  kv('CAS numbers', spec.cas.join(', '));

  section(16, 'Other information');
  kv('Revision', spec.rev);
  if (ctx.issue) kv('Date of issue', fmtLong(ctx.issue));
  if (ctx.versionNo > 1 && ctx.replacesIssue) kv('Replaces', 'the version issued ' + fmtLong(ctx.replacesIssue));
  para('This sheet should be reviewed at least every five years. This is a FICTIONAL DEMONSTRATION DOCUMENT and is not a real safety data sheet.');

  const total = pages.length;
  pages.forEach((p, i) => p.drawText(winAnsi(`Page ${i + 1} of ${total}   |   ${spec.t}   |   Fictional demonstration document`), { x: M, y: 28, size: 7.5, font, color: rgb(0.35, 0.35, 0.35) }));
  return await doc.save({ useObjectStreams: false });
}
