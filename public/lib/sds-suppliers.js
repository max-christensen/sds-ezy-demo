// Suppliers whose own safety data sheet search page is known, for the "Find SDS" button. Keep this list SHORT and CHECKED: only add a
// supplier once you have opened its page and seen that it searches safety data sheets. When in doubt leave it out, because the button
// falls back to a web search that works for every supplier.
//   words: lower-case words to look for in the supplier text (any one matching is enough); matched as whole words, ignoring case,
//          punctuation and spaces, so "WD-40", "WD40" and "wd 40" are all "wd40".
//   url:   the supplier's SDS search page.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).sdsSuppliers = m;
})(typeof self !== "undefined" ? self : this, function () {
  return [
    { name: "Bostik Australia", words: ["bostik"], url: "https://www.bostik.com/australia/en_AU/resources-and-tools/bostik-sds/" },
    { name: "WD-40 Australia", words: ["wd40"], url: "https://www.wd40.com.au/safety-data-sheets/" },
  ];
});
