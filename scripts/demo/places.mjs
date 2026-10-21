// The demo's places and which chemicals are kept where. Ids are fixed (deterministic) so links such as the sample job pack keep working after seeding.
// A link is [chemical (unique fragment of the product name), place key, quantity|null, unit|null, container note, spill compound|null].
// Spill compound: links in the same place with the same text share a compound (default: the place). Only matters for flammable liquids.

export const PLACES = [
  { key: 'W', id: 1, name: 'Tallowood workshop', place_type: 'workshop', registration: null, counts_toward_totals: 1, archived: 0,
    notes: 'Main workshop and yard: flammables cabinets, paint store, gas cage, fuel cube, maintenance store, cleaners cupboard and plaster store.' },
  { key: 'S', id: 2, name: 'Harbour Road job site', place_type: 'site', registration: null, counts_toward_totals: 1, archived: 0,
    notes: 'Current fit-out job (fictional). Heaters and cutting gear are kept on site for the length of the job.' },
  { key: 'U1', id: 3, name: 'Ute 1', place_type: 'vehicle', registration: 'TWD 001', counts_toward_totals: 0, archived: 0,
    notes: 'Painting and finishing kit.' },
  { key: 'U2', id: 4, name: 'Ute 2', place_type: 'vehicle', registration: 'TWD 002', counts_toward_totals: 0, archived: 0,
    notes: 'Maintenance, cleaning and aerosol kit.' },
  { key: 'A', id: 5, name: 'Ute 3 (sold)', place_type: 'vehicle', registration: 'TWD 003', counts_toward_totals: 0, archived: 1, archived_at: '2025-11-30 09:00:00',
    notes: 'Old maintenance ute, sold. Kept on record with its chemical links.' },
];

export const SAMPLE_PACK = { place: 'U2', client: 'Smith Street Primary School', ref: 'JOB-1042' };

const D = (frag, place, qty, unit, note, compound) => [frag, place, qty ?? null, unit ?? null, note || null, compound || null];
const CAB1 = 'Cabinet 1 sump', CAB2 = 'Cabinet 2 sump', PB = 'Paint store bund', FUEL = 'Fuel cube bund', MS = 'Maintenance store';

export const LINKS = [
  // ---- flammable liquids
  D('Marlow Acetone', 'W', 15, 'L', 'Flammables cabinet 1: 2 x 5 L cans; maintenance store: 1 x 5 L can', CAB1),
  D('Marlow Acetone', 'A', 5, 'L', '1 x 5 L can'),
  D('Methylated Spirits', 'W', 20, 'L', 'Flammables cabinet 1: 4 x 5 L cans', CAB1),
  D('Methylated Spirits', 'U1', 5, 'L', '1 x 5 L can'),
  D('Mineral Turpentine', 'W', 24, 'L', 'Flammables cabinet 1: 4 x 4 L; paint store: 2 x 4 L', CAB1),
  D('Mineral Turpentine', 'U1', 8, 'L', '2 x 4 L cans'),
  D('Lacquer Thinners', 'W', 13, 'L', 'Flammables cabinet 2: 3 x 4 L cans; 1 decanted bottle at the spray bench', CAB2),
  D('Oil Stain - Walnut', 'W', 8, 'L', 'Paint store: 8 x 1 L tins', PB),
  D('Oil Stain - Walnut', 'U1', 4, 'L', '4 x 1 L tins'),
  D('Oil Stain - Jarrah', 'W', 6, 'L', 'Paint store: 6 x 1 L tins', PB),
  D('Oil Stain - Jarrah', 'U1', 3, 'L', '3 x 1 L tins'),
  D('Polyurethane Varnish', 'W', 12, 'L', 'Paint store: 3 x 4 L tins', PB),
  D('Polyurethane Varnish', 'U1', 4, 'L', '1 x 4 L tin'),
  D('Contact Adhesive 500', 'W', 11, 'L', 'Flammables cabinet 2: 2 x 5 L tins; working tin on the bench', CAB2),
  D('Contact Adhesive 500', 'U1', 5, 'L', '1 x 5 L tin'),
  D('290 mL cartridge', 'U2', 7, 'L', '24 x 290 mL cartridges', MS),
  D('290 mL cartridge', 'S', 4, 'L', '14 x 290 mL cartridges'),
  D('375 mL cartridge', 'W', 9, 'L', 'Maintenance store: 24 x 375 mL cartridges', MS),
  D('600 mL sausage', 'W', 3.6, 'L', 'Maintenance store: 6 x 600 mL sausages', MS),
  D('4 L pail', 'W', 8, 'L', 'Maintenance store: 2 x 4 L pails', MS),
  D('Unleaded Petrol', 'W', 30, 'L', 'Generator shed: 3 x 10 L approved jerry cans', 'Generator shed'),
  D('Unleaded Petrol', 'U2', 10, 'L', '1 x 10 L jerry can'),
  D('Unleaded Petrol', 'S', 20, 'L', '2 x 10 L approved jerry cans for the site generator', 'Site generator'),
  D('Diesel Fuel', 'W', 760, 'L', '1 x 1000 L bunded fuel cube holding 700 L, plus 3 x 20 L jerry cans in the generator shed', FUEL),
  D('Diesel Fuel', 'U2', 120, 'L', '6 x 20 L jerry cans for the site generator and compressor'),
  D('Two-Stroke Fuel Mix', 'W', 5, 'L', 'Yard shed: 1 x 5 L can', 'Yard shed'),
  D('Brush Cleaner', 'W', 4, 'L', 'Paint store: 2 x 2 L cans', PB),
  D('Brush Cleaner', 'U1', 2, 'L', '1 x 2 L can'),
  D('Decking Oil', 'W', 20, 'L', 'Paint store: 2 x 10 L tins, same bund as the stains and varnish (category 4 counted with category 3)', PB),
  D('Decking Oil', 'S', 10, 'L', '1 x 10 L tin on the deck, own tray', 'Decking area'),
  D('Decking Oil', 'U1', 5, 'L', '1 x 5 L tin'),
  D('Concrete Sealer', 'U2', 4, 'L', '1 x 4 L tin, label missing (no SDS on file)'),
  // ---- aerosols
  D('Spray Enamel', 'W', 2.4, 'L', 'Flammables cabinet 2: 6 x 400 mL aerosols', CAB2),
  D('Spray Enamel', 'U1', 2.4, 'L', '6 x 400 mL aerosols'),
  D('Spray Enamel', 'S', 4.8, 'kg', '12 x 400 g aerosols, recorded by weight in kg (the table gives aerosols in litres, so this is flagged)'),
  D('Penetrating Spray', 'W', 3.6, 'L', 'Maintenance store: 12 x 300 g aerosols', MS),
  D('Penetrating Spray', 'U2', 0.6, 'L', '2 x 300 g aerosols'),
  D('Silicone Lubricant Spray', 'W', 1.8, 'L', 'Bench: 6 x 300 g aerosols'),
  D('Silicone Lubricant Spray', 'U2', 0.6, 'L', '2 x 300 g aerosols'),
  D('Brake and Parts Cleaner', 'W', 3, 'L', 'Maintenance store: 6 x 500 mL aerosols', MS),
  D('Brake and Parts Cleaner', 'U2', 1, 'L', '2 x 500 mL aerosols'),
  D('Spray Adhesive', 'W', 2.4, 'L', 'Flammables cabinet 2: 6 x 400 g aerosols', CAB2),
  D('Spray Adhesive', 'U2', 0.8, 'L', '2 x 400 g aerosols'),
  D('Expanding Foam', 'W', 4.5, 'L', 'Maintenance store: 6 x 750 mL cans', MS),
  D('Expanding Foam', 'U2', 1.5, 'L', '2 x 750 mL cans'),
  D('Expanding Foam', 'S', 3, 'L', '4 x 750 mL cans'),
  // ---- found during the Ute 2 audit: a placeholder chemical linked to the ute (no quantity)
  D('Rapidset Tile Adhesive', 'U2', null, null, 'Tub found under the passenger seat'),
  // ---- gases (litres of water capacity)
  D('LPG Cylinders', 'W', 105, 'L', 'Gas cage: 1 x 45 kg cylinder for the workshop heater (about 105 L water capacity)'),
  D('LPG Cylinders', 'S', 210, 'L', '2 x 45 kg cylinders for the site heaters (about 105 L water capacity each)'),
  D('Acetylene', 'W', 40, 'L', 'Gas cage: 1 x G size cylinder (water capacity)'),
  D('Oxygen', 'W', 50, 'L', 'Gas cage: 1 x G size cylinder (water capacity)'),
  D('Shielding Gas', 'W', 50, 'L', 'Gas cage: 1 x E size cylinder (water capacity)'),
  // ---- corrosives, oxidisers, epoxy, cement
  D('Hydrochloric Acid', 'W', 10, 'L', 'Maintenance store: 2 x 5 L bottles in a bunded tray'),
  D('Caustic Soda', 'W', 5, 'kg', 'Maintenance store: 2 x 2.5 kg tubs'),
  D('Liquid Chlorine', 'W', 20, 'L', 'Cleaners cupboard: 1 x 20 L drum'),
  D('Liquid Chlorine', 'U2', 5, 'L', '1 x 5 L bottle'),
  D('Drain Unblocker', 'W', 4, 'L', 'Cleaners cupboard: 4 x 1 L bottles'),
  D('Drain Unblocker', 'U2', 1, 'L', '1 x 1 L bottle'),
  D('Battery Acid', 'W', 5, 'L', 'Maintenance store: 1 x 5 L bottle'),
  D('Hydrogen Peroxide', 'W', 5, 'L', 'Cleaners cupboard: 1 x 5 L bottle'),
  D('Epoxy Resin', 'W', 3, 'L', 'Paint store: 3 x 1 L tins'),
  D('Epoxy Resin', 'U1', 1, 'L', '1 x 1 L tin'),
  D('Epoxy Hardener', 'W', 1.5, 'L', 'Paint store: 3 x 500 mL tins'),
  D('Epoxy Hardener', 'U1', 0.5, 'L', '1 x 500 mL tin'),
  D('General Purpose Cement', 'W', 100, 'kg', 'Yard shed: 5 x 20 kg bags'),
  D('General Purpose Cement', 'S', 60, 'kg', '3 x 20 kg bags'),
  D('Rust Converter', 'W', 2, 'L', 'Maintenance store: 2 x 1 L bottles'),
  D('Rust Converter', 'U2', 1, 'L', '1 x 1 L bottle'),
  D('Soldering Flux', 'U2', 0.2, 'kg', '2 x 100 g tubs'),
  D('Floor Cleaner Concentrate', 'W', 5, 'L', 'Cleaners cupboard: 1 x 5 L bottle'),
  // ---- plaster (ten products, one SDS)
  D('Base Coat Plaster', 'W', 20, 'kg', 'Plaster store: 1 x 20 kg bag'),
  D('Finishing Plaster', 'W', 20, 'kg', 'Plaster store: 1 x 20 kg bag'),
  D('Set 20 Setting', 'W', 40, 'kg', 'Plaster store: 2 x 20 kg bags'),
  D('Set 45 Setting', 'W', 40, 'kg', 'Plaster store: 2 x 20 kg bags'),
  D('Set 45 Setting', 'S', 20, 'kg', '1 x 20 kg bag'),
  D('Set 90 Setting', 'W', 20, 'kg', 'Plaster store: 1 x 20 kg bag'),
  D('Cornice Adhesive', 'W', 20, 'kg', 'Plaster store: 1 x 20 kg bag'),
  D('Patch and Repair', 'S'),   // no quantity recorded
  D('Jointing Cement', 'W', 10, 'kg', 'Plaster store: 1 bag'),
  D('Texture Coat Fine', 'W', 20, 'kg', 'Plaster store: 1 x 20 kg bag'),
  D('Lightweight Topping', 'W', 15, 'kg', 'Plaster store: 1 bag'),
  // ---- not hazardous
  D('PVA Wood Glue', 'W', 5, 'L', 'Bench: 1 x 5 L pail'),
  D('PVA Wood Glue', 'S', 1, 'L', '1 x 1 L bottle'),
  D('Weatherproof Wood Glue', 'W', 4, 'L', 'Bench: 2 x 2 L bottles'),
  D('Interior Warm White', 'W', 10, 'L', 'Paint store: 1 x 10 L tin'),
  D('Interior Warm White', 'U1', 4, 'L', '1 x 4 L tin'),
  D('Exterior Surf', 'W', 10, 'L', 'Paint store: 1 x 10 L tin'),
  D('Exterior Surf', 'S', 10, 'L', '1 x 10 L tin'),
  D('Ceiling White', 'W', 10, 'L', 'Paint store: 1 x 10 L tin'),
  D('Water-Based Floor Finish', 'W', 8, 'L', 'Paint store: 2 x 4 L tins'),
  D('Timber Sealer', 'W', 4, 'L', 'Paint store: 1 x 4 L tin'),
  D('Timber Sealer', 'U1', 2, 'L', '1 x 2 L tin'),
  D('Beeswax Furniture Polish', 'W', 0.5, 'kg', 'Bench: 1 x 500 g tin'),
  D('Beeswax Furniture Polish', 'U1', 0.5, 'kg', '1 x 500 g tin'),
  D('General Purpose Grease', 'W', 0.9, 'kg', 'Maintenance store: 2 x 450 g cartridges'),
  D('General Purpose Grease', 'U2', 0.45, 'kg', '1 x 450 g cartridge'),
  D('Hydraulic Oil', 'W', 20, 'L', 'Maintenance store: 1 x 20 L drum'),
  D('Bar and Chain Oil', 'W', 5, 'L', 'Yard shed: 1 x 5 L can'),
  D('10W-40 Engine Oil', 'W', 10, 'L', 'Generator shed: 2 x 5 L cans'),
  D('Neutral Cure Silicone', 'W', 3, 'L', 'Maintenance store: 10 x 300 mL cartridges'),
  D('Neutral Cure Silicone', 'U2', 1.2, 'L', '4 x 300 mL cartridges'),
  D('Hand Cleaner Gel', 'W', 4, 'L', 'Bench: 1 x 4 L pump pack'),
  D('Hand Cleaner Gel', 'U1'),
  D('Hand Cleaner Gel', 'U2'),
  D('Dishwashing Detergent', 'W', 5, 'L', 'Cleaners cupboard: 1 x 5 L bottle'),
  D('Glass and Surface Cleaner', 'W', 1.5, 'L', 'Cleaners cupboard: 2 x 750 mL trigger bottles'),
  D('Glass and Surface Cleaner', 'U2'),
  // ---- the archived ute keeps its old links
  D('Contact Adhesive 500', 'A', 5, 'L', '1 x 5 L tin'),
  D('Penetrating Spray', 'A', 0.6, 'L', '2 x 300 g aerosols'),
];

/** Resolve link fragments to chemical ids (1-based order of CHEMICALS). Throws if a fragment matches none or more than one chemical. */
export function resolveLinks(chemicals) {
  return LINKS.map(([frag, place, quantity, unit, note, compound]) => {
    const hits = chemicals.map((c, i) => [c, i + 1]).filter(([c]) => c.n.includes(frag));
    if (hits.length !== 1) throw new Error(`link "${frag}" matches ${hits.length} chemicals`);
    const pl = PLACES.find(p => p.key === place);
    return { chemical_id: hits[0][1], place_id: pl.id, place_key: place, quantity, unit, container_note: note, spill_compound: compound };
  });
}
