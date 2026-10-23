// "Find SDS": the link the add-chemical screen opens in a new tab. A supplier on the short known list (sds-suppliers.js) goes to its own
// SDS search page; anything else is a web search for the name, supplier, product code and the words "SDS Australia". Nothing is fetched here.
(function (root, factory) {
  const suppliers = typeof module === "object" && module.exports ? require("./sds-suppliers.js") : (root.SDSLib && root.SDSLib.sdsSuppliers) || [];
  const m = factory(suppliers);
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).findSds = m;
})(typeof self !== "undefined" ? self : this, function (SUPPLIERS) {
  const SEARCH = "https://www.google.com/search?q=";
  const tidy = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

  /** The known-supplier entry for a supplier text, or null. A word matches when it equals the whole text or one of its words
   *  ("WD-40 Australia Pty Ltd" has the word "wd" and "40", so also match the text with spaces and hyphens removed from its start). */
  function knownSupplier(supplier, list = SUPPLIERS) {
    const t = tidy(supplier);
    if (!t) return null;
    const words = t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const squashedPrefixes = new Set();
    for (let i = 0; i < words.length; i++) { let acc = ""; for (let j = i; j < Math.min(words.length, i + 3); j++) { acc += words[j]; squashedPrefixes.add(acc); } }
    return list.find((s) => s.words.some((w) => squashedPrefixes.has(squash(w)))) || null;
  }

  /** {url, known (the supplier's own page, or null), query}. url is null when there is nothing to search for. */
  function findSdsLink({ name, supplier, code } = {}) {
    const n = tidy(name), s = tidy(supplier), c = tidy(code);
    if (!n && !s) return { url: null, known: null, query: "" };
    const known = knownSupplier(s);
    if (known) return { url: known.url, known: known.name, query: "" };
    const query = [s, n, c, "SDS Australia"].filter(Boolean).join(" ");
    return { url: SEARCH + encodeURIComponent(query), known: null, query };
  }

  return { findSdsLink, knownSupplier, tidy };
});
