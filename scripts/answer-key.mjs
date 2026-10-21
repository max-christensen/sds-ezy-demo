#!/usr/bin/env node
// Answer-key harness: compares what the app's AI reading produces for real SDS PDFs against the user's own
// completed hazard assessments (.docx) and register (.xlsx). Everything real lives in the git-ignored seed-local/ folder.
//
//   node scripts/answer-key.mjs [--dir seed-local] [--provider claude|openai|gemini|workers_ai|openai-compatible]
//        [--model NAME] [--base-url URL] [--api-key-env NAME] [--env-file .dev.vars]
//        [--extractor ./path/to/module.mjs] [--limit N] [--no-cache] [--detail] [--self-test]
//
// Privacy: the console shows only field names, counts and SDS file names. Assessed-by names, phone numbers and e-mail
// addresses are never read into the report. Reports are written to <dir>/answer-key-report.json (seed-local/ by default).
// With --detail, scrubbed mismatching values are also written to <dir>/answer-key-detail.json (never to the console).
//
// Extraction adapter: by default imports runExtraction from src/ai.js (the lead confirms the exact call; see callExtraction()).
// --extractor lets you plug any module whose default export is async ({text, fileName, provider, model, env}) => object.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- utilities
export function scrub(s) {
  return String(s ?? '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').replace(/\+?\(?\d[\d\s().-]{7,}\d/g, '[number]');
}
const STOP = new Set(['pty', 'ltd', 'the', 'and', 'of', 'for', 'a', 'co', 'inc', 'limited', 'australia', 'australian', 'pack', 'product', 'products']);
const words = s => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !STOP.has(w));
const norm = s => words(s).join(' ');
function overlap(a, b) { // share of the smaller token set found in the other
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}
const decodeXml = s => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// ---------------------------------------------------------------- option labels (from schema.sql, one place)
export function loadOptionLabels() {
  const sql = readFileSync(join(ROOT, 'schema.sql'), 'utf8');
  const out = [];
  for (const m of sql.matchAll(/\('(isolation|ventilation|other|ppe|additional_ppe)',\s*'([^']+)',\s*\d+\)/g)) out.push({ kind: m[1], label: m[2] });
  return out;
}
function matchOption(text, options) {
  let best = null, bestScore = 0;
  for (const o of options) {
    const s = Math.max(overlap(text, o.label) * (words(text).length >= 2 ? 1 : 0.5), 0);
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return bestScore >= 0.6 ? best : null;
}

// ---------------------------------------------------------------- PDF text (pdfjs-dist legacy build)
export async function readPdfText(path) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(path));
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    for (const it of c.items) text += it.str + (it.hasEOL ? '\n' : ' ');
    text += '\n';
  }
  return text;
}

// ---------------------------------------------------------------- DOCX assessments
const CHECKED = /^[☒☑✓✔]|^\[\s*[xX✓]\s*\]/;       // box with X / tick
const UNCHECKED = /^[☐]|^\[\s*\]/;
const isBox = t => CHECKED.test(t) || UNCHECKED.test(t);
const stripBox = t => t.replace(/^([☒☑✓✔☐]|\[\s*[xX✓]?\s*\])\s*/, '').trim();

function paraText(p) {
  // content-control checkboxes and symbol-font checkboxes become plain box characters
  p = p.replace(/<w:sdt>[\s\S]*?<\/w:sdt>/g, m => /<w14:checkbox>/.test(m) ? `<w:t>${/<w14:checked w14:val="(1|true|on)"/.test(m) ? '☒' : '☐'} </w:t>` : m);
  p = p.replace(/<w:sym [^>]*w:char="([0-9A-Fa-f]{4})"[^>]*\/>/g, (_, c) => `<w:t>${['F078', 'F0FE', 'F0FD', 'F052', 'F0FC'].includes(c.toUpperCase()) ? '☒' : '☐'} </w:t>`);
  let out = '';
  for (const m of p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:br [^>]*w:type="page"[^>]*\/>|<w:lastRenderedPageBreak\/>|<w:pageBreakBefore\/>/g)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0].startsWith('<w:tab')) out += ' ';
    else if (m[0].startsWith('<w:br/>')) out += '\n';
    else out += '\f';
  }
  return out;
}

// Returns an array of row arrays (cells of text). Outside tables each paragraph is a one-cell row.
export function docxRows(buffer) {
  const files = unzipSync(new Uint8Array(buffer), { filter: f => f.name === 'word/document.xml' });
  const xml = strFromU8(files['word/document.xml'] || new Uint8Array());
  const body = xml.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/g, '');
  const rows = [];
  let inTbl = 0, row = null, cell = null;
  const re = /<w:tbl>|<\/w:tbl>|<w:tr[ >]|<\/w:tr>|<w:tc>|<\/w:tc>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
  for (const m of body.matchAll(re)) {
    const t = m[0];
    if (t === '<w:tbl>') inTbl++;
    else if (t === '</w:tbl>') inTbl = Math.max(0, inTbl - 1);
    else if (t.startsWith('<w:tr')) row = [];
    else if (t === '</w:tr>') { if (row) rows.push(row); row = null; }
    else if (t === '<w:tc>') cell = [];
    else if (t === '</w:tc>') { if (row && cell) row.push(cell.join('\n')); cell = null; }
    else if (t.startsWith('<w:p')) {
      const txt = t === '<w:p/>' ? '' : paraText(t);
      if (cell) cell.push(txt);
      else if (!inTbl) rows.push([txt]);
    }
  }
  return rows;
}

const RE = {
  product: /^(product(\s+name)?|chemical(\s+name)?|substance(\s+name)?|trade\s*name|name\s+of\s+(the\s+)?(product|chemical|substance))\b/i,
  supplier: /^(supplier|manufacturer|company|distributor)\b/i,
  form: /^((physical\s+)?form|physical\s+state|state)\b/i,
  un: /^un\s*(no\.?|number)?\b/i,
  cls: /^((dangerous\s+goods|dg)\s+)?class\b(?!.*subsid)/i,
  pg: /^packing\s+group\b/i,
  hazchem: /^hazchem\b/i,
};
const RISK = [
  [/not\s+significant/i, 'not_significant'],
  [/significant.*not\s+(effectively\s+)?controlled/i, 'significant_not_controlled'],
  [/significant.*controlled/i, 'significant_controlled'],
  [/uncertain/i, 'uncertain'],
];
const riskOf = t => (RISK.find(([r]) => r.test(t)) || [])[1] || null;
const FORMS = ['liquid', 'solid', 'powder', 'gas', 'aerosol', 'paste'];
const yes = v => /^(yes|y|true|x|☒|☑|✓|✔)\b/i.test(v.trim());

// Split rows into assessment records and pull out the checklist fields by label. Never reads names or phone numbers.
export function parseAssessments(rows, options = loadOptionLabels()) {
  const records = [];
  let cur = null;
  const startNew = () => { cur = { lines: [], section: '' }; records.push(cur); };
  for (const cells of rows) {
    const first = (cells[0] || '').replace(/\f/g, '').trim();
    const isProduct = cells.length > 1 ? RE.product.test(first) : RE.product.test(first) && /[:\-]/.test(first);
    if (!cur || (isProduct && cur.hasProduct)) startNew();
    if (isProduct) cur.hasProduct = true;
    cur.lines.push(cells.map(c => c.replace(/\f/g, '')));
  }
  return records.filter(r => r.hasProduct).map(r => extractRecord(r.lines, options));
}

function extractRecord(lines, options) {
  const rec = { product: '', supplier: '', form: '', routes: { inhalation: null, ingestion: null, absorption: null }, controls: [], ppe: [], risk_level: null,
    un_number: null, dg_class: null, packing_group: null, hazchem_code: null, present: new Set() };
  const consider = (label, value) => {
    value = (value || '').trim();
    for (const [k, r] of Object.entries(RE)) {
      if (!r.test(label)) continue;
      const v = value.replace(/^[:\-\s]+/, '').trim();
      if (k === 'product') rec.product = v.split('\n')[0];
      else if (k === 'supplier') rec.supplier = v.split('\n')[0];
      else if (k === 'form') rec.form = FORMS.find(f => v.toLowerCase().includes(f)) || v.toLowerCase();
      else if (k === 'un') { rec.un_number = (v.match(/\d{3,4}/) || [null])[0]; rec.present.add('un'); }
      else if (k === 'cls') { rec.dg_class = (v.match(/\d(\.\d)?/) || [null])[0]; rec.present.add('cls'); }
      else if (k === 'pg') { rec.packing_group = (v.match(/\b(III|II|I)\b/) || [null])[0]; rec.present.add('pg'); }
      else if (k === 'hazchem') { rec.hazchem_code = v.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || null; rec.present.add('hazchem'); }
      return true;
    }
    return false;
  };
  const routeOf = t => /inhal|breath/i.test(t) ? 'inhalation' : /ingest|swallow/i.test(t) ? 'ingestion' : /absor|skin|dermal/i.test(t) ? 'absorption' : null;
  const item = (text, checked) => {
    const r = riskOf(text);
    if (r && /significant|uncertain/i.test(text)) { if (checked) rec.risk_level = r; rec.present.add('risk'); return; }
    const route = routeOf(text);
    if (route && words(text).length <= 6) { rec.routes[route] = checked; return; }
    if (!checked) return;
    const opt = matchOption(text, options);
    if (opt) (opt.kind === 'ppe' || opt.kind === 'additional_ppe' ? rec.ppe : rec.controls).push(opt.label);
  };
  for (const cells of lines) {
    const label = (cells[0] || '').trim();
    const rest = cells.slice(1).join('\n');
    // label/value rows
    if (cells.length > 1 && label && !isBox(label) && consider(label, rest)) { /* handled */ }
    else if (cells.length === 1 && /^[^:]{2,40}:\s*(\S.*)?$/.test(label) && !isBox(label)) { const [l, ...v] = label.split(':'); consider(l, v.join(':')); }
    // route rows written as "Inhalation: Yes"
    if (cells.length > 1 && routeOf(label) && !isBox(label) && words(label).length <= 4 && rest.trim()) rec.routes[routeOf(label)] = yes(rest);
    // checkbox items (in any cell, one per line)
    for (const cell of cells) for (const ln of cell.split('\n')) {
      const t = ln.trim();
      if (!isBox(t)) continue;
      item(stripBox(t), CHECKED.test(t));
    }
  }
  rec.controls = [...new Set(rec.controls)]; rec.ppe = [...new Set(rec.ppe)];
  return rec;
}

// ---------------------------------------------------------------- XLSX register
export async function readRegister(path) {
  const { default: readXlsx } = await import('read-excel-file/node');
  const sheets = await readXlsx(path);
  const data = (Array.isArray(sheets) && sheets[0] && sheets[0].data) ? sheets.flatMap(s => s.data) : sheets;
  const cols = { product: /product|chemical|substance|name/i, supplier: /supplier|manufacturer/i, un: /\bun\b|un\s*(no|number)/i, cls: /class/i, pg: /packing/i, hazchem: /hazchem/i };
  const hi = data.findIndex(r => r.some(c => /product|chemical|substance/i.test(String(c ?? ''))));
  if (hi < 0) return [];
  const map = {};
  data[hi].forEach((h, i) => { for (const [k, r] of Object.entries(cols)) if (!(k in map) && r.test(String(h ?? ''))) map[k] = i; });
  return data.slice(hi + 1).filter(r => r[map.product]).map(r => Object.fromEntries(Object.entries(map).map(([k, i]) => [k, r[i] == null ? '' : String(r[i]).trim()])));
}

// ---------------------------------------------------------------- AI extraction adapter
export function parseEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const l of readFileSync(path, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  return env;
}

// The one place that knows how to call the app's reader. Edit here if src/ai.js's signature differs.
export async function callExtraction(ctx, opts) {
  if (opts.extractorFn) return opts.extractorFn(ctx);
  if (opts.extractor) {
    const mod = await import(pathToFileURL(resolve(opts.extractor)).href);
    return (mod.default || mod.runExtraction)(ctx);
  }
  const ai = await import(pathToFileURL(join(ROOT, 'src', 'ai.js')).href);
  if (typeof ai.runExtraction !== 'function') throw new Error('src/ai.js does not export runExtraction yet; use --extractor');
  // src/ai.js: runExtraction(env, {text, answers, optionLabels}) -> {ok, data: {sds, products, assessment, ...}} | {ok:false, error}
  const labels = loadOptionLabels().map(o => o.label);
  const res = await ai.runExtraction(ctx.env, { text: ctx.text, answers: {}, optionLabels: labels });
  if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'the reader returned no result');
  const d = res.data || {};
  const p0 = Array.isArray(d.products) && d.products[0] ? d.products[0] : {};
  return { ...(d.sds || {}), ...(d.assessment || {}), product_name: p0.product_name || (d.sds && d.sds.title), physical_form: p0.physical_form || (d.assessment && d.assessment.form) };
}

// Flatten whatever shape the reader returns into the fields we compare.
export function normalizeExtraction(raw) {
  if (!raw) return null;
  const flat = {};
  const take = o => { if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (!(k in flat) || flat[k] == null || flat[k] === '') flat[k] = v; };
  take(raw); for (const k of ['sds', 'chemical', 'assessment', 'result', 'data']) take(raw[k]);
  const pick = (...ks) => { for (const k of ks) if (flat[k] != null && flat[k] !== '') return flat[k]; return null; };
  const labels = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => typeof x === 'string' ? x : x?.label).filter(Boolean);
  const r = flat.routes;
  const route = n => pick('route_' + n) != null ? !!+pick('route_' + n) : r && !Array.isArray(r) && n in r ? !!r[n] : Array.isArray(r) ? r.some(x => String(x).toLowerCase().includes(n.slice(0, 5))) : null;
  const allControls = [...labels(flat.control_labels), ...labels(flat.controls), ...labels(flat.isolation), ...labels(flat.ventilation), ...labels(flat.other_controls), ...labels(flat.other)];
  const ppe = [...labels(flat.ppe), ...labels(flat.additional_ppe), ...labels(flat.ppe_labels)];
  return {
    product: pick('product_name', 'title', 'name', 'product'), supplier: pick('supplier', 'manufacturer'), form: String(pick('physical_form', 'form') ?? '').toLowerCase(),
    routes: { inhalation: route('inhalation'), ingestion: route('ingestion'), absorption: route('absorption') },
    controls: allControls, ppe, risk_level: pick('risk_level', 'risk'),
    un_number: String(pick('un_number', 'un') ?? '').replace(/\D/g, '') || null, dg_class: String(pick('dg_class', 'class') ?? '').replace(/[^0-9.]/g, '') || null,
    packing_group: String(pick('packing_group') ?? '').toUpperCase().replace(/[^IV]/g, '') || null, hazchem_code: String(pick('hazchem_code', 'hazchem') ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || null,
    title: pick('title', 'product_name'),
  };
}

// ---------------------------------------------------------------- matching and comparing
const tokens = s => words(s).filter(w => w.length >= 2 && !/^(kg|ml|l|g|litre|litres)$/.test(w));
function matchScore(product, sds) {
  const t = tokens(product);
  if (!t.length) return 0;
  const hay = new Set(words(sds.text + ' ' + (sds.ex?.product || '') + ' ' + sds.fileName));
  const phrase = norm(sds.text).includes(norm(product)) ? 0.5 : 0;
  return t.filter(w => hay.has(w)).length / t.length + phrase;
}
export function matchToSds(product, sdsList) {
  const scored = sdsList.map((s, i) => ({ i, s: matchScore(product, s) })).sort((a, b) => b.s - a.s);
  return scored.length && scored[0].s >= 0.75 ? scored[0].i : -1;
}

const tokOverlap = (a, b) => { const A = tokens(a), B = new Set(tokens(b)); return A.length ? A.filter(w => B.has(w)).length / A.length : 0; };
const FIELDS = ['product', 'supplier', 'form', 'routes', 'controls', 'ppe', 'risk_level', 'un_number', 'dg_class', 'packing_group', 'hazchem_code'];
const same = {
  product: (a, e) => !!a.product && !!e.product && (tokOverlap(a.product, e.product) >= 0.75 || tokOverlap(e.product, a.product) >= 0.75),
  supplier: (a, e) => !!e.supplier && overlap(a.supplier, e.supplier) >= 0.6,
  form: (a, e) => !!e.form && FORMS.find(f => e.form.includes(f)) === a.form,
  routes: (a, e) => ['inhalation', 'ingestion', 'absorption'].every(k => !!a.routes[k] === !!e.routes[k]),
  controls: (a, e) => jaccard(a.controls.map(norm), e.controls.map(x => matchOption(x, OPTS)?.label || x).map(norm)) === 1,
  ppe: (a, e) => jaccard(a.ppe.map(norm), e.ppe.map(x => matchOption(x, OPTS)?.label || x).map(norm)) === 1,
  risk_level: (a, e) => !!a.risk_level && a.risk_level === e.risk_level,
  un_number: (a, e) => (a.un_number || null) === (e.un_number || null),
  dg_class: (a, e) => (a.dg_class || null) === (e.dg_class || null),
  packing_group: (a, e) => (a.packing_group || null) === (e.packing_group || null),
  hazchem_code: (a, e) => (a.hazchem_code || null) === (e.hazchem_code || null),
};
let OPTS = [];
const hasValue = (a, f) => {
  switch (f) {
    case 'routes': return Object.values(a.routes).some(v => v !== null);
    case 'controls': case 'ppe': return a[f].length > 0;
    case 'un_number': return a.present.has('un'); case 'dg_class': return a.present.has('cls');
    case 'packing_group': return a.present.has('pg'); case 'hazchem_code': return a.present.has('hazchem');
    default: return !!a[f];
  }
};
function overlapScore(a, e, f) { return f === 'controls' || f === 'ppe' ? jaccard(a[f].map(norm), e[f].map(x => matchOption(x, OPTS)?.label || x).map(norm)) : null; }

export function compareAll(assessments, sdsList, register = []) {
  OPTS = loadOptionLabels();
  const stats = Object.fromEntries(FIELDS.map(f => [f, { compared: 0, matched: 0, overlap_sum: 0 }]));
  const per = [];
  let unmatched = 0;
  assessments.forEach((a, idx) => {
    if (!a.supplier) { const r = register.find(r => overlap(r.product, a.product) >= 0.9); if (r?.supplier) a.supplier = r.supplier; }
    const si = matchToSds(a.product, sdsList);
    if (si < 0 || !sdsList[si].ex) { unmatched++; per.push({ n: idx + 1, product: a.product, matched_sds: null }); return; }
    const e = sdsList[si].ex;
    const res = {};
    for (const f of FIELDS) {
      if (!hasValue(a, f)) continue;
      stats[f].compared++;
      const ok = same[f](a, e);
      if (ok) stats[f].matched++;
      const ov = overlapScore(a, e, f); if (ov !== null) stats[f].overlap_sum += ov;
      res[f] = ok;
    }
    per.push({ n: idx + 1, product: a.product, matched_sds: sdsList[si].fileName, fields: res });
  });
  return { stats, per, unmatched };
}

export function registerCheck(register, sdsList) {
  const out = { rows: register.length, matched_to_sds: 0, supplier: { compared: 0, matched: 0 }, un_number: { compared: 0, matched: 0 }, dg_class: { compared: 0, matched: 0 }, packing_group: { compared: 0, matched: 0 }, hazchem_code: { compared: 0, matched: 0 } };
  for (const r of register) {
    const si = matchToSds(r.product, sdsList);
    if (si < 0 || !sdsList[si].ex) continue;
    out.matched_to_sds++;
    const e = sdsList[si].ex;
    const chk = (f, rv, ev, eq) => { if (!rv) return; out[f].compared++; if (eq(rv, ev)) out[f].matched++; };
    chk('supplier', r.supplier, e.supplier, (a, b) => overlap(a, b || '') >= 0.6);
    chk('un_number', (r.un || '').replace(/\D/g, ''), e.un_number, (a, b) => a === (b || ''));
    chk('dg_class', (r.cls || '').replace(/[^0-9.]/g, ''), e.dg_class, (a, b) => a === (b || ''));
    chk('packing_group', (r.pg || '').toUpperCase().replace(/[^IV]/g, ''), e.packing_group, (a, b) => a === (b || ''));
    chk('hazchem_code', (r.hazchem || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(), e.hazchem_code, (a, b) => a === (b || ''));
  }
  return out;
}

// ---------------------------------------------------------------- run
const LABELS = { product: 'Product', supplier: 'Supplier', form: 'Physical form', routes: 'Routes of entry', controls: 'Controls', ppe: 'PPE', risk_level: 'Risk level', un_number: 'UN number', dg_class: 'Class', packing_group: 'Packing group', hazchem_code: 'Hazchem' };

export function formatTable(stats) {
  const rows = [['Field', 'Compared', 'Matched', 'Match %']];
  for (const f of FIELDS) { const s = stats[f]; rows.push([LABELS[f], String(s.compared), String(s.matched), s.compared ? Math.round(100 * s.matched / s.compared) + '%' : '-']); }
  const w = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  return rows.map((r, i) => r.map((c, j) => j ? c.padStart(w[j]) : c.padEnd(w[j])).join('  ') + (i === 0 ? '\n' + w.map(n => '-'.repeat(n)).join('  ') : '')).join('\n');
}

function safeReportDir(dir, allowElsewhere) {
  const d = resolve(dir);
  const ok = d === resolve(ROOT, 'seed-local') || d.startsWith(resolve(ROOT, 'seed-local') + sep) || d.startsWith(resolve(tmpdir()) + sep) || allowElsewhere;
  if (!ok) throw new Error('Reports may only be written under seed-local/ (or a temp dir). Use --dir seed-local.');
  return d;
}

export async function run(opts) {
  const log = opts.log || console.log;
  const dir = resolve(opts.dir || join(ROOT, 'seed-local'));
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const docx = files.filter(f => /\.docx$/i.test(f) && !f.startsWith('~$'));
  const xlsx = files.filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
  const pdfs = files.filter(f => /\.pdf$/i.test(f));
  const missing = [];
  if (!docx.length) missing.push('a Word file of completed hazard assessments (.docx)');
  if (!xlsx.length) missing.push('the Excel register (.xlsx)');
  if (!pdfs.length) missing.push('the SDS PDFs (.pdf)');
  if (!docx.length || !pdfs.length) {
    log(`Answer-key harness: nothing to compare yet. Put these in ${dir}:`);
    missing.forEach(m => log('  - ' + m));
    log('Nothing was run. (This is not an error.)');
    return { skipped: true, missing };
  }
  if (missing.length) log('Note: ' + missing.join(' and ') + ' not found; continuing without it.');
  const reportDir = safeReportDir(dir, opts.allowReportElsewhere);

  OPTS = loadOptionLabels();
  const assessments = [];
  for (const f of docx) assessments.push(...parseAssessments(docxRows(readFileSync(join(dir, f))), OPTS));
  const pref = xlsx.find(f => /register/i.test(f)) || xlsx[0];
  const register = pref ? await readRegister(join(dir, pref)) : [];
  log(`Parsed ${assessments.length} assessments, ${register.length} register rows, ${pdfs.length} SDS PDFs.`);

  const env = { ...parseEnvFile(resolve(ROOT, opts.envFile || '.dev.vars')), ...(opts.env || {}) };
  if (opts.baseUrl) { env.OPENAI_BASE_URL = opts.baseUrl; }
  if (opts.apiKeyEnv && process.env[opts.apiKeyEnv]) env.OPENAI_API_KEY = process.env[opts.apiKeyEnv];
  const provider = opts.provider === 'openai-compatible' ? 'openai' : (opts.provider || 'workers_ai');
  const cacheDir = join(dir, 'answer-key-cache');
  const sdsList = [];
  for (const f of pdfs.slice(0, opts.limit || pdfs.length)) {
    const text = await readPdfText(join(dir, f));
    let ex = null, error = null;
    const key = createHash('sha1').update(text).update(provider + '|' + (opts.model || '') + '|' + (opts.extractor || '')).digest('hex');
    const cpath = join(cacheDir, key + '.json');
    try {
      if (!opts.noCache && existsSync(cpath)) ex = JSON.parse(readFileSync(cpath, 'utf8'));
      else {
        const raw = await callExtraction({ text: text.slice(0, 150000), fileName: f, provider, model: opts.model, env }, opts);
        ex = normalizeExtraction(raw);
        if (!opts.noCache && ex) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cpath, JSON.stringify(ex)); }
      }
    } catch (e) { error = scrub(e.message || e); }
    if (error) log(`  ${f}: reading failed (${error})`);
    sdsList.push({ fileName: f, text, ex });
  }
  const { stats, per, unmatched } = compareAll(assessments, sdsList, register);
  const reg = registerCheck(register, sdsList);
  log('\nPer-field match (assessment vs the app\'s reading of the matched SDS):\n');
  log(formatTable(stats));
  log(`\nAssessments with no matching SDS in the folder: ${unmatched} of ${assessments.length}`);
  if (register.length) log(`Register rows matched to an SDS: ${reg.matched_to_sds} of ${reg.rows} (supplier ${reg.supplier.matched}/${reg.supplier.compared}, UN ${reg.un_number.matched}/${reg.un_number.compared}, class ${reg.dg_class.matched}/${reg.dg_class.compared})`);

  mkdirSync(reportDir, { recursive: true });
  const report = {
    generated_at: new Date().toISOString(), provider, model: opts.model || null,
    counts: { assessments: assessments.length, register_rows: register.length, sds_pdfs: sdsList.length, sds_read: sdsList.filter(s => s.ex).length, assessments_without_sds: unmatched },
    fields: Object.fromEntries(FIELDS.map(f => [f, { compared: stats[f].compared, matched: stats[f].matched, mean_overlap: stats[f].overlap_sum && stats[f].compared ? +(stats[f].overlap_sum / stats[f].compared).toFixed(3) : undefined }])),
    register: reg,
    assessments: per.map(p => ({ n: p.n, product: scrub(p.product), matched_sds: p.matched_sds, fields: p.fields })),
  };
  const rpath = join(reportDir, 'answer-key-report.json');
  writeFileSync(rpath, JSON.stringify(report, null, 2));
  log(`\nReport written to ${rpath}`);
  if (opts.detail) {
    const detail = assessments.map((a, i) => ({ n: i + 1, product: scrub(a.product), docx: { supplier: scrub(a.supplier), form: a.form, routes: a.routes, controls: a.controls, ppe: a.ppe, risk_level: a.risk_level, un_number: a.un_number, dg_class: a.dg_class, packing_group: a.packing_group, hazchem_code: a.hazchem_code } }));
    writeFileSync(join(reportDir, 'answer-key-detail.json'), JSON.stringify({ assessments: detail, sds: sdsList.map(s => ({ file: s.fileName, ex: s.ex })) }, null, 2));
    log('Detail written to answer-key-detail.json (not printed).');
  }
  return { report, stats, per, unmatched };
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const o = {}; const v = f => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : undefined; };
  Object.assign(o, { dir: v('--dir'), provider: v('--provider'), model: v('--model'), baseUrl: v('--base-url'), apiKeyEnv: v('--api-key-env'), envFile: v('--env-file'), extractor: v('--extractor'),
    limit: v('--limit') ? +v('--limit') : undefined, noCache: argv.includes('--no-cache'), detail: argv.includes('--detail'), selfTest: argv.includes('--self-test') });
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  try {
    if (o.selfTest) {
      const { makeFixtures, FIXTURE_EXPECTED } = await import('./demo/answer-key-fixtures.mjs');
      const tmp = mkdtempSync(join(tmpdir(), 'sdsezy-ak-'));
      try {
        const fx = await makeFixtures(tmp);
        const r = await run({ ...o, dir: tmp, extractorFn: fx.extractorFn, noCache: true, detail: true });
        console.log('\nSelf-test expectations:', JSON.stringify(FIXTURE_EXPECTED.counts));
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    } else await run(o);
  } catch (e) { console.error('answer-key failed: ' + scrub(e.message || e)); process.exit(1); }
}
