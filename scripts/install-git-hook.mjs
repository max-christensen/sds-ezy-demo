// Installs a LOCAL pre-commit hook (it lives in git's hooks folder, so it is never committed or pushed) that refuses a commit
// if the staged wrangler.toml is not the safe placeholder. Run once per clone:  npm run hooks:install
//
// It asks git where hooks live (`git rev-parse --git-path hooks`), so it works in a linked worktree and when core.hooksPath is set.
// If you use a hook manager (husky and similar), add this line to your pre-commit step instead:
//   node scripts/check-deploy-config.mjs --staged
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARK = "# sds-ezy: wrangler.toml placeholder check";
const body = `${MARK}\nnode scripts/check-deploy-config.mjs --staged || { echo "Commit refused: wrangler.toml must stay a placeholder."; exit 1; }\n`;

let hooksDir;
try { hooksDir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: ROOT, encoding: "utf8" }).trim(); }
catch { console.error("Not a git checkout: nothing to install."); process.exit(1); }
if (!isAbsolute(hooksDir)) hooksDir = join(ROOT, hooksDir);

let custom = "";
try { custom = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { /* not set */ }
if (custom) console.log(`Note: core.hooksPath is set (${custom}), so the hook is installed there, in ${hooksDir}. A hook manager may overwrite it: add \`node scripts/check-deploy-config.mjs --staged\` to its pre-commit step too.`);

mkdirSync(hooksDir, { recursive: true });
const hook = join(hooksDir, "pre-commit");
const old = existsSync(hook) ? readFileSync(hook, "utf8") : "";
if (old.includes(MARK)) { console.log("The pre-commit hook is already installed."); process.exit(0); }
writeFileSync(hook, old ? old.replace(/\s*$/, "\n") + body : "#!/bin/sh\n" + body);
chmodSync(hook, 0o755);
console.log(`Installed ${hook} (local only; not committed).`);
