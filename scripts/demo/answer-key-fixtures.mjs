// Synthetic stand-ins for the real answer-key files, used to prove scripts/answer-key.mjs parses correctly.
// Everything here is invented: fake brands, fake supplier names, no people, no phone numbers.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';

const SDS = [
  { file: 'fakefix-heavy-grip-sds.pdf', title: 'Fakefix Heavy Grip Adhesive', supplier: 'Fakefix Pty Ltd', products: ['Fakefix Heavy Grip 375 mL', 'Fakefix Heavy Grip 4 L'],
    un: '1133', cls: '3', pg: 'III', hazchem: '3Y', form: 'paste' },
  { file: 'plasterite-sds.pdf', title: 'Plasterite Plaster Products', supplier: 'Plasterite Building Products Pty Ltd', products: ['Plasterite Base Coat', 'Plasterite Set 45'],
    un: '', cls: '', pg: '', hazchem: '', form: 'powder' },
  { file: 'anchorbond-sds.pdf', title: 'Anchorbond 101 Plus', supplier: 'Anchorbond Chemicals Pty Ltd', products: ['Anchorbond 101 Plus'],
    un: '3077', cls: '9', pg: 'III', hazchem: '2Z', form: 'paste' },
];

// Each assessment: what the (fictional) Word checklist says. "ex" is what the stub reader returns for that SDS.
const ASSESS = [
  { sds: 0, product: SDS[0].products[0], style: 'glyph', routes: [1, 0, 1], risk: 'significant_controlled',
    controls: ['Lids kept on containers when not in use', 'Natural / general ventilation', 'No ignition sources nearby'], ppe: ['Safety glasses', 'Chemical-resistant gloves'] },
  { sds: 0, product: SDS[0].products[1], style: 'sdt', routes: [1, 0, 1], risk: 'significant_not_controlled',   // the stub reads this as significant_controlled: a deliberate mismatch
    controls: ['Lids kept on containers when not in use', 'Natural / general ventilation', 'No ignition sources nearby'], ppe: ['Safety glasses', 'Chemical-resistant gloves'] },
  { sds: 1, product: SDS[1].products[0], style: 'plain', routes: [1, 0, 0], risk: 'not_significant',
    controls: ['Natural / general ventilation'], ppe: ['Safety glasses', 'Chemical-resistant gloves', 'P2 dust mask'] },
  { sds: 1, product: SDS[1].products[1], style: 'glyph', routes: [1, 0, 1], risk: 'not_significant',               // the stub misses the absorption route: routes mismatch
    controls: ['Natural / general ventilation'], ppe: ['Safety glasses', 'Chemical-resistant gloves'] },
  { sds: 2, product: SDS[2].products[0], style: 'sdt', routes: [0, 0, 1], risk: 'significant_controlled',          // the stub reads a different supplier: supplier mismatch
    controls: ['Spill kit available'], ppe: ['Safety glasses', 'Chemical-resistant gloves'] },
  { sds: -1, product: 'Mysterysolv Cleaner XYZ', style: 'glyph', routes: [1, 0, 0], risk: 'uncertain', controls: [], ppe: [] },   // no SDS in the folder
];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = t => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = t => `<w:p>${run(t)}</w:p>`;
const cell = inner => `<w:tc><w:tcPr/>${inner}</w:tc>`;
const rowX = (...cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
const tbl = rows => `<w:tbl><w:tblPr/>${rows.join('')}</w:tbl>`;
const sdt = checked => `<w:p><w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="${checked ? 1 : 0}"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☐</w:t></w:r></w:sdtContent></w:sdt>`;
function boxP(text, checked, style) {
  if (style === 'sdt') return `${sdt(checked)}${run(' ' + text)}</w:p>`;
  if (style === 'plain') return para(`[${checked ? 'x' : ' '}] ${text}`);
  return para(`${checked ? '☒' : '☐'} ${text}`);
}
const RISKS = [['not_significant', 'Not significant'], ['significant_controlled', 'Significant but effectively controlled'], ['significant_not_controlled', 'Significant and not effectively controlled'], ['uncertain', 'Uncertain']];
const ISO = ['Lids kept on containers when not in use', 'Stored in a bunded or spill-contained area', 'Segregated from incompatible chemicals', 'Stored in a flammable liquids cabinet', 'Locked or access restricted storage'];
const VENT = ['Natural / general ventilation', 'Local exhaust ventilation', 'Fume cupboard', 'Use outdoors or in an open area'];
const OTHER = ['Small quantities only', 'Keep exposure time short', 'Read the SDS before use', 'No ignition sources nearby', 'Spill kit available', 'Wash hands after use; no eating or drinking'];
const PPE = ['Safety glasses', 'Chemical-resistant gloves', 'Overalls or long sleeves', 'Safety footwear'];
const APPE = ['Chemical goggles', 'Face shield', 'P2 dust mask', 'Half-face respirator with suitable filter', 'Chemical-resistant apron'];

function assessmentXml(a, i) {
  const s = a.sds >= 0 ? SDS[a.sds] : { supplier: 'Mysterysolv Pty Ltd', un: '', cls: '', pg: '', hazchem: '', form: 'liquid' };
  const list = (opts, chosen) => opts.map(o => boxP(o, chosen.includes(o), a.style)).join('');
  const out = [];
  out.push(para(`Hazard Risk Assessment ${i + 1}`));
  if (a.style === 'plain') {
    out.push(para(`Product name: ${a.product}`), para(`Supplier: ${s.supplier}`), para(`Physical form: ${s.form}`));
    out.push(para(`UN number: ${s.un}`), para(`Dangerous goods class: ${s.cls}`), para(`Packing group: ${s.pg}`), para(`Hazchem code: ${s.hazchem}`));
    out.push(para('Assessed by: Fictional Person'));   // a field the harness must never echo
    out.push(para('Routes of entry'), boxP('Inhalation', !!a.routes[0], a.style), boxP('Ingestion', !!a.routes[1], a.style), boxP('Skin absorption', !!a.routes[2], a.style));
    out.push(para('Isolation'), list(ISO, a.controls), para('Ventilation'), list(VENT, a.controls), para('Other controls'), list(OTHER, a.controls));
    out.push(para('PPE'), list(PPE, a.ppe), para('Additional PPE'), list(APPE, a.ppe));
    out.push(para('Risk level'), RISKS.map(([k, l]) => boxP(l, k === a.risk, a.style)).join(''));
  } else {
    const dl = x => x.split('\n').map(t => boxP(t, false, 'glyph')).join('');
    void dl;
    out.push(tbl([
      rowX(para('Product name'), para(a.product)), rowX(para('Supplier'), para(s.supplier)), rowX(para('Physical form'), para(s.form)),
      rowX(para('UN number'), para(s.un)), rowX(para('Dangerous goods class'), para(s.cls)), rowX(para('Packing group'), para(s.pg)), rowX(para('Hazchem code'), para(s.hazchem)),
      rowX(para('Assessed by'), para('Fictional Person 0400 000 000')),
      rowX(para('Routes of entry'), boxP('Inhalation', !!a.routes[0], a.style) + boxP('Ingestion', !!a.routes[1], a.style) + boxP('Skin absorption', !!a.routes[2], a.style)),
      rowX(para('Isolation'), list(ISO, a.controls)), rowX(para('Ventilation'), list(VENT, a.controls)), rowX(para('Other controls'), list(OTHER, a.controls)),
      rowX(para('PPE'), list(PPE, a.ppe)), rowX(para('Additional PPE'), list(APPE, a.ppe)),
      rowX(para('Risk level'), RISKS.map(([k, l]) => boxP(l, k === a.risk, a.style)).join('')),
    ]));
  }
  return out.join('');
}

export function makeDocx() {
  const body = ASSESS.map((a, i) => assessmentXml(a, i)).join('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(doc),
  });
}

async function makePdf(s) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = ['FICTIONAL DEMONSTRATION DOCUMENT (answer-key self-test)', `Safety data sheet: ${s.title}`, `Supplier: ${s.supplier}`, `Covers: ${s.products.join('; ')}`,
    s.un ? `UN number ${s.un}  Class ${s.cls}  Packing group ${s.pg}  Hazchem ${s.hazchem}` : 'Not classified as dangerous goods'];
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 18, size: 11, font }));
  return await doc.save();
}

export async function makeFixtures(dir) {
  for (const s of SDS) writeFileSync(join(dir, s.file), await makePdf(s));
  writeFileSync(join(dir, 'Fixture Assessments.docx'), makeDocx());
  const { default: writeExcelFile } = await import('write-excel-file/node');
  await writeExcelFile([
    ['Product', 'Supplier', 'UN number', 'Class', 'Packing group', 'Hazchem', 'Location'],
    [SDS[0].products[0], SDS[0].supplier, '1133', '3', 'III', '3Y', 'Shed A'],
    [SDS[0].products[1], SDS[0].supplier, '1133', '3', 'III', '3Y', 'Shed A'],
    [SDS[1].products[0], SDS[1].supplier, '', '', '', '', 'Shed B'],
    [SDS[2].products[0], SDS[2].supplier, '3077', '9', 'III', '2Z', 'Shed B'],
    ['Mysterysolv Cleaner XYZ', 'Mysterysolv Pty Ltd', '', '', '', '', 'Shed C'],
  ]).toFile(join(dir, 'Fixture SDS Register.xlsx'));

  // Stub reader: returns the right answers except for the three deliberate errors noted in ASSESS.
  const readers = {
    [SDS[0].file]: { sds: { product_name: SDS[0].title, supplier: SDS[0].supplier, un_number: '1133', dg_class: '3', packing_group: 'III', hazchem_code: '3Y' },
      assessment: { physical_form: 'paste', route_inhalation: 1, route_ingestion: 0, route_absorption: 1, risk_level: 'significant_controlled',
        control_labels: ['Lids kept on containers when not in use', 'Natural / general ventilation', 'No ignition sources nearby'], ppe: ['Safety glasses', 'Chemical-resistant gloves'] } },
    [SDS[1].file]: { sds: { product_name: SDS[1].title + ' (Plasterite Base Coat, Plasterite Set 45)', supplier: SDS[1].supplier, un_number: null, dg_class: null, packing_group: null, hazchem_code: null },
      assessment: { physical_form: 'powder', route_inhalation: 1, route_ingestion: 0, route_absorption: 0, risk_level: 'not_significant',
        control_labels: ['Natural / general ventilation'], ppe: ['Safety glasses', 'Chemical-resistant gloves'] } },
    [SDS[2].file]: { sds: { product_name: SDS[2].title, supplier: 'Some Other Company Pty Ltd', un_number: '3077', dg_class: '9', packing_group: 'III', hazchem_code: '2Z' },
      assessment: { physical_form: 'paste', route_inhalation: 0, route_ingestion: 0, route_absorption: 1, risk_level: 'significant_controlled', control_labels: ['Spill kit available'], ppe: ['Safety glasses', 'Chemical-resistant gloves'] } },
  };
  return { extractorFn: async ctx => readers[ctx.fileName] };
}

// What the self-test must report (checked by tests/demo-answer-key.test.mjs).
// 5 assessments have an SDS in the folder, 1 does not. Mismatches: #2 risk, #4 routes and PPE (misses P2 mask? no: #4 has no P2 so PPE matches), #5 supplier.
export const FIXTURE_EXPECTED = {
  counts: { assessments: 6, register_rows: 5, sds_pdfs: 3, assessments_without_sds: 1 },
  fields: {
    product: { compared: 5, matched: 5 }, supplier: { compared: 5, matched: 4 }, form: { compared: 5, matched: 5 },
    routes: { compared: 5, matched: 4 }, controls: { compared: 5, matched: 5 }, ppe: { compared: 5, matched: 4 },
    risk_level: { compared: 5, matched: 4 }, un_number: { compared: 5, matched: 5 }, dg_class: { compared: 5, matched: 5 },
    packing_group: { compared: 5, matched: 5 }, hazchem_code: { compared: 5, matched: 5 },
  },
};
