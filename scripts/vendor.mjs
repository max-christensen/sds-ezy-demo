// Copies the browser libraries we ship from node_modules into public/vendor, so the app has no CDN dependency.
// Run with: npm run vendor   (the copied files are committed, with their licences in public/vendor/LICENSES.txt)
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
const out = "public/vendor";
mkdirSync(out, { recursive: true });
const files = [
  ["node_modules/pdfjs-dist/build/pdf.min.mjs", "pdf.min.mjs"],
  ["node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["node_modules/write-excel-file/bundle/write-excel-file.min.js", "write-excel-file.min.js"],
  ["node_modules/read-excel-file/bundle/read-excel-file.min.js", "read-excel-file.min.js"],
  ["node_modules/fflate/umd/index.js", "fflate.js"],
  ["node_modules/pdf-lib/dist/pdf-lib.min.js", "pdf-lib.min.js"],
  ["node_modules/qrcode-generator/dist/qrcode.js", "qrcode.js"],
];
for (const [from, to] of files) {
  if (!existsSync(from)) { console.error("missing", from); process.exitCode = 1; continue; }
  copyFileSync(from, `${out}/${to}`);
}
const pkgs = ["pdfjs-dist", "write-excel-file", "read-excel-file", "fflate", "pdf-lib", "qrcode-generator"];
let lic = "Third-party libraries shipped in public/vendor. Each is used under its own licence, reproduced below.\n\n";
for (const p of pkgs) {
  const v = JSON.parse(readFileSync(`node_modules/${p}/package.json`, "utf8")).version;
  const f = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map(n => `node_modules/${p}/${n}`).find(existsSync);
  lic += `==== ${p} ${v} ====\n${f ? readFileSync(f, "utf8") : "(licence file not found; see the package on npm)"}\n\n`;
}
writeFileSync(`${out}/LICENSES.txt`, lic);
