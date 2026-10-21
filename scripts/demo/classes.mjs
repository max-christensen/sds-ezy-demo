// GHS classification of every demo SDS, from the Safe Work Australia poster tables in public/lib/ghs-ref.mjs.
// Entry: [class id, category, optional list of the H-codes the sheet prints for that entry].
// Without the third element the sheet prints the first H-code of the poster row (both codes for aerosols).
// Signal word, pictograms and H-codes are DERIVED from this list, never typed in.
// Products carrying no classification are listed as [] (non-hazardous).
import { rowsFor } from '../../public/lib/ghs-ref.mjs';

export const CLASSES = {
  acetone: [['flam_liq', '2'], ['eye_dmg', '2A'], ['stot_se', '3', ['H336']]],
  metho_v1: [['flam_liq', '2'], ['eye_dmg', '2A']],
  metho: [['flam_liq', '2'], ['eye_dmg', '2A'], ['stot_se', '3', ['H336']]],
  turps: [['flam_liq', '3'], ['aspiration', '1'], ['stot_se', '3', ['H336']]],
  thinners: [['flam_liq', '2'], ['aspiration', '1'], ['skin_corr', '2'], ['eye_dmg', '2A'], ['stot_se', '3', ['H336']], ['repro_tox', '2', ['H361d']], ['stot_re', '2']],
  stain: [['flam_liq', '3'], ['aspiration', '1'], ['stot_se', '3', ['H336']]],
  varnish: [['flam_liq', '3'], ['aspiration', '1'], ['stot_se', '3', ['H336']]],
  contact: [['flam_liq', '2'], ['skin_corr', '2'], ['stot_se', '3', ['H336']], ['stot_re', '2']],
  grip: [['flam_liq', '3'], ['aspiration', '1'], ['skin_corr', '2'], ['stot_se', '3', ['H336']]],
  petrol: [['flam_liq', '1'], ['aspiration', '1'], ['skin_corr', '2'], ['stot_se', '3', ['H336']], ['germ_cell', '1B'], ['carcinogen', '1B'], ['repro_tox', '2', ['H361d']]],
  diesel: [['flam_liq', '3'], ['aspiration', '1'], ['skin_corr', '2'], ['acute_tox', '4', ['H332']], ['carcinogen', '2'], ['stot_re', '2']],
  twostroke: [['flam_liq', '1'], ['aspiration', '1'], ['skin_corr', '2'], ['stot_se', '3', ['H336']]],
  brushclean: [['flam_liq', '3'], ['aspiration', '1'], ['stot_se', '3', ['H336']]],
  decking: [['flam_liq', '4'], ['skin_sens', '1']],
  spayenamel: [['aerosol', '1'], ['eye_dmg', '2A'], ['stot_se', '3', ['H336']]],
  penetrant: [['aerosol', '1'], ['aspiration', '1'], ['skin_corr', '2'], ['stot_se', '3', ['H336']]],
  silicone: [['aerosol', '1'], ['stot_se', '3', ['H336']]],
  brakeclean: [['aerosol', '1'], ['skin_corr', '2'], ['eye_dmg', '2A'], ['stot_se', '3', ['H336']], ['stot_re', '2']],
  sprayglue: [['aerosol', '1'], ['skin_corr', '2'], ['eye_dmg', '2A'], ['stot_se', '3', ['H336']]],
  foam: [['aerosol', '1'], ['skin_corr', '2'], ['eye_dmg', '2A'], ['skin_sens', '1'], ['resp_sens', '1'], ['acute_tox', '4', ['H332']], ['stot_se', '3', ['H335']], ['stot_re', '2']],
  lpg: [['flam_gas', '1A'], ['gas_pressure', 'Liquefied gas']],
  acetylene: [['flam_gas', '1A'], ['gas_pressure', 'Dissolved gas']],
  oxygen: [['ox_gas', '1'], ['gas_pressure', 'Compressed gas']],
  shield: [['gas_pressure', 'Compressed gas']],
  hcl: [['skin_corr', '1B'], ['corr_metal', '1'], ['stot_se', '3', ['H335']]],
  caustic: [['skin_corr', '1A'], ['corr_metal', '1']],
  bleach: [['skin_corr', '1B'], ['corr_metal', '1']],
  drain: [['skin_corr', '1B'], ['corr_metal', '1']],   // the sheet prints "Skin Corr. 1" with no A/B/C letter: the category is unconfirmed (flagged)
  battery: [['skin_corr', '1A'], ['corr_metal', '1']],
  peroxide: [['ox_liquid', '1'], ['acute_tox', '4', ['H302']], ['skin_corr', '1B'], ['stot_se', '3', ['H335']]],
  epoxyA: [['skin_corr', '2'], ['eye_dmg', '2A'], ['skin_sens', '1']],
  epoxyB: [['acute_tox', '4', ['H302']], ['skin_corr', '1B'], ['skin_sens', '1']],
  cement: [['skin_corr', '2'], ['eye_dmg', '1'], ['skin_sens', '1'], ['stot_se', '3', ['H335']]],
  plaster: [['eye_dmg', '2A'], ['stot_se', '3', ['H335']]],
  rustconv: [['corr_metal', '1'], ['skin_corr', '2'], ['eye_dmg', '2A']],
  flux: [['acute_tox', '4', ['H302']], ['skin_corr', '1B']],
  floorclean: [['eye_dmg', '2A']],
  // non-hazardous
  pva: [], pvad4: [], acrylic: [], floorfinish: [], sealer: [], wax: [], grease: [], hydraulic: [], chainoil: [], engineoil: [], silsealant: [],
  handgel: [], dishwash: [], glassclean: [],
};

/** The sheet's own category was left unlettered for these (the chemical stores the AI's reading with check:true and a flag). */
export const UNCONFIRMED_CATEGORY = { drain: { c: 'skin_corr', k: '1B' } };

export function entryCodes(c, k, codes) {
  if (codes) return codes;
  const row = rowsFor(c, k)[0];
  return c === 'aerosol' ? row.hCodes : [row.hCodes[0]];
}
export const asClassification = key => CLASSES[key].map(([c, k]) => ({ c, k }));
