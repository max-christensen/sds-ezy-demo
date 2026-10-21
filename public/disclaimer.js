// The disclaimer, in ONE place. Everything that shows it (the register, chemical and assessment pages,
// printed assessments, the manifest, every export, the first-run welcome) reads it from here, so changing
// the wording here changes it everywhere. The README carries a copy of the same words; keep them in step.
// A lawyer should review the final wording before this is relied on.
(function () {
  const points = [
    "The safety data sheet (SDS) information and risk assessments in this register are prepared from the supplier's safety data sheet. They are a guide and a starting point.",
    "Your business should review every assessment to make sure it is correct for your own workplace.",
    "It is always the worker's responsibility to do their own risk assessment, use the chemical the way the manufacturer intends, and be familiar with the SDS and the assessment before using it.",
    "Use this register together with your business's own SOPs, JSEAs and SWMS where they are required.",
    "If anything here is different from the supplier's current SDS, the supplier's current SDS is the authority.",
  ];
  window.DISCLAIMER = {
    title: "Important",
    // One line for tight spaces (page footers, spreadsheet header rows).
    short: "Prepared from the supplier's safety data sheet as a guide and a starting point only. Review it for your own workplace. The supplier's current SDS is the authority.",
    points,
    // The whole thing as one paragraph of plain text (exports, PDF pages).
    full: points.join(" "),
  };
})();
