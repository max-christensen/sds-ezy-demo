// The "Find SDS" link builder and the short supplier list.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { findSdsLink, knownSupplier } = require("../public/lib/find-sds.js");
const SUPPLIERS = require("../public/lib/sds-suppliers.js");

const q = (url) => decodeURIComponent(new URL(url).searchParams.get("q"));

test("a web search is built from supplier, name, code and the words SDS Australia, and opens in a new tab as a plain link", () => {
  const l = findSdsLink({ name: "Liquid Nails", supplier: "Selleys", code: "LN-100" });
  assert.equal(l.known, null);
  const u = new URL(l.url);
  assert.equal(u.origin + u.pathname, "https://www.google.com/search");
  assert.equal(q(l.url), "Selleys Liquid Nails LN-100 SDS Australia");
});

test("the search text is URL-encoded so it cannot break out of the query", () => {
  const l = findSdsLink({ name: "A&B=C #1 <script>", supplier: "50% off/Co" });
  assert.ok(!/[ <>#]/.test(l.url.replace("https://www.google.com/search?q=", "")), l.url);
  assert.ok(!l.url.includes("&B="), "an ampersand in the name must not start a new parameter");
  assert.equal(new URL(l.url).searchParams.get("q"), "50% off/Co A&B=C #1 <script> SDS Australia");
  assert.equal(new URL(l.url).searchParams.size, 1);
});

test("empty fields: nothing to search gives no link; a name or a supplier alone is enough", () => {
  assert.equal(findSdsLink({}).url, null);
  assert.equal(findSdsLink().url, null);
  assert.equal(findSdsLink({ name: "  ", supplier: "", code: "ABC" }).url, null, "a code alone is not enough");
  assert.equal(q(findSdsLink({ name: "Acetone" }).url), "Acetone SDS Australia");
  assert.equal(q(findSdsLink({ supplier: "Bunnings" }).url), "Bunnings SDS Australia");
  assert.equal(q(findSdsLink({ name: null, supplier: undefined, code: "" }.name ? {} : { name: "X", supplier: null, code: undefined }).url), "X SDS Australia");
});

test("control characters and very long text are tidied and capped", () => {
  const l = findSdsLink({ name: "Tidy\u0000\u0007\n  name", supplier: "S".repeat(500) });
  assert.ok(q(l.url).startsWith("S".repeat(200) + " Tidy name"));
});

test("a supplier on the known list goes to its own SDS search page, however it is written", () => {
  for (const s of ["Bostik", "BOSTIK Australia Pty Ltd", "bostik-australia"]) {
    const l = findSdsLink({ name: "No More Nails", supplier: s });
    assert.equal(l.url, "https://www.bostik.com/australia/en_AU/resources-and-tools/bostik-sds/", s);
    assert.equal(l.known, "Bostik Australia");
  }
  for (const s of ["WD-40", "WD40 Company", "wd 40", "WD-40 Australia Pty Ltd"]) assert.equal(findSdsLink({ name: "Multi-Use", supplier: s }).known, "WD-40 Australia", s);
});

test("a supplier that only contains a known name inside another word is not matched; unknown suppliers use the web search", () => {
  for (const s of ["Bostikco", "Notbostik", "Selleys", "Dulux", ""]) {
    assert.equal(findSdsLink({ name: "P", supplier: s }).known, null, s);
    assert.match(findSdsLink({ name: "P", supplier: s }).url, /^https:\/\/www\.google\.com\/search\?q=/);
  }
});

test("a known supplier with no product name still links to the supplier's page", () => {
  assert.equal(findSdsLink({ supplier: "Bostik" }).known, "Bostik Australia");
});

test("every entry in the supplier list is well formed (so extending it is hard to get wrong)", () => {
  assert.ok(SUPPLIERS.length >= 1);
  const seen = new Set();
  for (const s of SUPPLIERS) {
    assert.ok(s.name && Array.isArray(s.words) && s.words.length, s.name);
    assert.match(s.url, /^https:\/\/[a-z0-9.-]+\/\S*$/i, s.name);
    for (const w of s.words) { assert.equal(w, w.toLowerCase().replace(/[^a-z0-9]/g, ""), `${s.name}: words are lower-case letters and digits only`); assert.ok(!seen.has(w), `duplicate word ${w}`); seen.add(w); }
    assert.equal(knownSupplier(s.words[0]).name, s.name);
  }
});
