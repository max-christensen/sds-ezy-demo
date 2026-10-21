/* The nine official GHS pictograms, shown as the supplied image files (public/pictograms/, never edited).
   The list, names, files and meanings come from public/lib/ghs-ref.mjs, the one source of truth. */
(function () {
  const App = window.App;

  // Load the reference module once. App.start() waits for this, so App.GHS is ready before any screen draws.
  let promise = null;
  App.ghs = function () {
    if (!promise) promise = import('/lib/ghs-ref.mjs').then((m) => { App.GHS = m; App.PICTOGRAM_CODES = m.PICTOGRAM_CODES; return m; });
    return promise;
  };
  App.ghsReady = App.ghs();

  const alt = (p) => `${p.code} ${p.name}`;
  function parse(list) {
    if (!App.GHS || list == null) return [];
    return App.GHS.parsePictogramList(list) || [];
  }

  App.pictogramCodes = () => (App.GHS ? App.GHS.PICTOGRAM_CODES : []);
  App.pictogramLabel = (code) => { const p = App.GHS && App.GHS.pictogramInfo(code); return p ? alt(p) : String(code); };

  // One pictogram. Screen sizes are 40 to 56 px; the images are only 220 px, so never go bigger than about 25 mm in print.
  App.pictogramImg = function (code, size) {
    const p = App.GHS && App.GHS.pictogramInfo(String(code || '').toUpperCase());
    if (!p) return '';
    size = size || 44;
    return `<img class="picto" src="${App.esc(p.file)}" width="${size}" height="${size}" alt="${App.esc(alt(p))}" title="${App.esc(p.meaning)}" loading="lazy" decoding="async">`;
  };
  App.pictogramRow = function (list, size) {
    const codes = parse(list);
    if (!codes.length) return '';
    return `<span class="picto-row">${codes.map((c) => App.pictogramImg(c, size || 44)).join('')}</span>`;
  };
  // "Flame, Exclamation mark" as plain text, for tables and CSV.
  App.pictogramNames = (list) => parse(list).map((c) => App.GHS.pictogramInfo(c).name).join(', ');
  // Older name, kept so any screen that still calls it keeps working.
  App.pictogramSvg = App.pictogramImg;
})();
