// Static text tables for the demo generator: GHS statements, standard P statements by hazard tag, suppliers, company.
// Everything here is generic public wording or invented. No real manufacturers or trade names.

export const COMPANY = {
  name: 'Tallowood Joinery & Maintenance Pty Ltd',
  address: 'Unit 4, 12 Example Street, Sampleton NSW 2999',
  phone: '(02) 5550 0100',
  email: 'office@tallowood.example.invalid',
  reg: 'ABN 00 000 000 000 (fictional)',
  main_color: '#2E5E7E',
  accent_color: '#D9822B',
};

export const SUPPLIERS = {
  marlow:  { name: 'Marlow Industrial Solvents Pty Ltd',    phone: '1800 555 0101' },
  tide:    { name: 'Tidewater Cleaning Supplies Pty Ltd',   phone: '1800 555 0102' },
  kestrel: { name: 'Kestrel Coatings Pty Ltd',              phone: '1800 555 0103' },
  stick:   { name: 'Stickfast Adhesives Pty Ltd',           phone: '1800 555 0104' },
  bright:  { name: 'Brightboard Building Products Pty Ltd', phone: '1800 555 0105' },
  iron:    { name: 'Ironwood Lubricants Pty Ltd',           phone: '1800 555 0106' },
  fern:    { name: 'Fernhill Timber Care Pty Ltd',          phone: '1800 555 0107' },
  wattle:  { name: 'Wattlebird Workshop Supplies Pty Ltd',  phone: '1800 555 0108' },
  quill:   { name: 'Quillon Industrial Gases Pty Ltd',      phone: '1800 555 0109' },
  harbour: { name: 'Harbourlight Fuels Pty Ltd',            phone: '1800 555 0110' },
  blue:    { name: 'Bluegum Cement Co Pty Ltd',             phone: '1800 555 0111' },
};

// code -> [statement, classification line]
export const H_TEXT = {
  H220: ['Extremely flammable gas', 'Flammable gas, Category 1'],
  H222: ['Extremely flammable aerosol', 'Aerosol, Category 1'],
  H225: ['Highly flammable liquid and vapour', 'Flammable liquid, Category 2'],
  H226: ['Flammable liquid and vapour', 'Flammable liquid, Category 3'],
  H229: ['Pressurised container: may burst if heated', 'Aerosol, pressurised container'],
  H270: ['May cause or intensify fire; oxidiser', 'Oxidising gas, Category 1'],
  H271: ['May cause fire or explosion; strong oxidiser', 'Oxidising liquid, Category 1'],
  H280: ['Contains gas under pressure; may explode if heated', 'Gas under pressure'],
  H290: ['May be corrosive to metals', 'Corrosive to metals, Category 1'],
  H302: ['Harmful if swallowed', 'Acute toxicity (oral), Category 4'],
  H304: ['May be fatal if swallowed and enters airways', 'Aspiration hazard, Category 1'],
  H314: ['Causes severe skin burns and eye damage', 'Skin corrosion, Category 1B'],
  H315: ['Causes skin irritation', 'Skin irritation, Category 2'],
  H317: ['May cause an allergic skin reaction', 'Skin sensitisation, Category 1'],
  H318: ['Causes serious eye damage', 'Serious eye damage, Category 1'],
  H319: ['Causes serious eye irritation', 'Eye irritation, Category 2A'],
  H332: ['Harmful if inhaled', 'Acute toxicity (inhalation), Category 4'],
  H334: ['May cause allergy or asthma symptoms or breathing difficulties if inhaled', 'Respiratory sensitisation, Category 1'],
  H335: ['May cause respiratory irritation', 'STOT single exposure, Category 3 (respiratory)'],
  H336: ['May cause drowsiness or dizziness', 'STOT single exposure, Category 3 (narcotic effects)'],
  H373: ['May cause damage to organs through prolonged or repeated exposure', 'STOT repeated exposure, Category 2'],
  H411: ['Toxic to aquatic life with long lasting effects', 'Hazardous to the aquatic environment, chronic, Category 2'],
  H412: ['Harmful to aquatic life with long lasting effects', 'Hazardous to the aquatic environment, chronic, Category 3'],
};

export const P_TEXT = {
  P210: 'Keep away from heat, sparks, open flames and hot surfaces. No smoking',
  P233: 'Keep container tightly closed',
  P260: 'Do not breathe dust, mist or vapours',
  P261: 'Avoid breathing dust, fumes, gas, mist, vapours or spray',
  P264: 'Wash hands thoroughly after handling',
  P271: 'Use only outdoors or in a well-ventilated area',
  P280: 'Wear protective gloves, protective clothing and eye protection',
  P284: 'Wear respiratory protection',
  P301P330P331: 'IF SWALLOWED: rinse mouth. Do NOT induce vomiting',
  P303P361P353: 'IF ON SKIN (or hair): take off contaminated clothing and rinse skin with water',
  P304P340: 'IF INHALED: remove person to fresh air and keep comfortable for breathing',
  P305P351P338: 'IF IN EYES: rinse cautiously with water for several minutes. Remove contact lenses if present and easy to do. Continue rinsing',
  P310: 'Immediately call a POISONS INFORMATION CENTRE or doctor',
  P370P378: 'In case of fire: use dry chemical, foam or carbon dioxide to extinguish',
  P377: 'Leaking gas fire: do not extinguish unless the leak can be stopped safely',
  P403P235: 'Store in a well-ventilated place. Keep cool',
  P410P412: 'Protect from sunlight. Do not expose to temperatures exceeding 50 deg C',
  P405: 'Store locked up',
  P501: 'Dispose of contents and container to an approved waste facility',
};

export const TAG_P = {
  flam: ['P210', 'P233', 'P280', 'P303P361P353', 'P370P378', 'P403P235', 'P501'],
  aer: ['P210', 'P410P412', 'P271', 'P501'],
  corr: ['P260', 'P264', 'P280', 'P301P330P331', 'P305P351P338', 'P310', 'P405', 'P501'],
  gas: ['P210', 'P377', 'P403P235', 'P410P412'],
  ox: ['P210', 'P280', 'P305P351P338', 'P310', 'P501'],
  dust: ['P261', 'P264', 'P280', 'P284', 'P305P351P338', 'P501'],
  irrit: ['P264', 'P280', 'P305P351P338', 'P501'],
  env: ['P501'],
  sens: ['P261', 'P280', 'P284', 'P304P340', 'P501'],
  none: [],
};

export const HAZARD_PHRASE = {
  flam: 'Flammable. Vapours may form explosive mixtures with air and can travel to an ignition source.',
  aer: 'Pressurised aerosol container. Extremely flammable propellant. May burst if heated.',
  corr: 'Corrosive. Causes burns to skin and eyes on contact.',
  gas: 'Gas under pressure. Can displace oxygen in enclosed spaces.',
  ox: 'Oxidiser. May intensify fire and react with combustible material.',
  dust: 'Dust may irritate the eyes, nose and throat. Wet product may irritate skin.',
  irrit: 'May irritate the eyes and skin.',
  env: 'Toxic to aquatic life. Do not allow to enter drains or waterways.',
  sens: 'May cause allergic reactions on skin contact or inhalation.',
  none: 'Not classified as hazardous according to the criteria of the Globally Harmonised System (GHS).',
};
