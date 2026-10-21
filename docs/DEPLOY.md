# Deploying SDS EZY (the Deploy to Cloudflare button, and by hand)

This follows the same pattern as the Wrangla project: a committed `wrangler.toml` of placeholders, a `deploy` script, and a README button that points at the repository.

## What the button does

The button URL is `https://deploy.workers.cloudflare.com/?url=https://github.com/max-christensen/SDS-EZY`. Following Cloudflare's
documentation ("Deploy buttons"), it:

1. Copies the repository into the visitor's own GitHub or GitLab account. **The repository must be public** for anyone else to use the
   button (Cloudflare's rule), so the button does nothing for other people until you make the repository public.
2. Reads `wrangler.toml` to see which resources are needed: a D1 database (`DB`), an R2 bucket (`FILES`), Workers AI (`AI`) and the static assets.
   It creates the database and the bucket in the visitor's account and fills the real database ID in for that deploy.
3. Reads `package.json`: the `deploy` script is detected and used (otherwise it would run `npx wrangler deploy`), and the `cloudflare.bindings`
   descriptions are shown on the setup page.
4. Reads `.dev.vars.example` for secrets to ask for. Ours has none active (every line is commented out), so the visitor is asked for nothing.
5. Builds and deploys with Workers Builds, and keeps redeploying whenever the visitor's copy changes on its main branch.

## What runs on every deploy (`npm run deploy`)

```
npm run predeploy      node scripts/bump-version.mjs && node scripts/build-schema.mjs
                       writes public/app-version.js (a hash of the app files) so phones replace their cached copy,
                       and src/schema.generated.js (schema.sql split into statements)
wrangler deploy
```

* **The Worker creates its own tables.** The first request after a deploy checks a `schema_hash` row in the `settings` table; if it is missing or
  differs from the hash of `schema.sql`, the Worker runs the statements in `src/schema.generated.js` and stores the new hash. On a fresh database that
  creates everything, on an existing one it is a no-op or a safe upgrade, and each Worker instance checks only once. Nothing about the database is
  needed at build time.
* **Why there is no `db:init` step in `deploy` (error 7404).** An earlier version ran `wrangler d1 execute DB --remote --yes --file=./schema.sql` before
  `wrangler deploy`. On the button's first build that failed with `The database ... could not be found [code: 7404]`, because the build ran the
  command before the database it had just been given was usable. Not depending on the database during the build removes the failure. `npm run db:init`
  remains for loading the schema by hand; it does the same thing as the Worker's own check.

* **The schema is safe to repeat.** `schema.sql` is `CREATE ... IF NOT EXISTS` and `INSERT OR IGNORE`, plus one migration that
  copies the old single-workplace storage locations into places and then clears that legacy table (so on a fresh database it does nothing, and after the
  first run it is a no-op). It never drops or alters a table. Tests check this, including that a link someone deleted later is not brought back.
* `npm run db:init` refers to the database by its **binding name** (`DB`), not its name, because the button can rename resources.
* **First run from a fresh deploy needs nothing configured.** No `SETUP_KEY` and no `SESSION_SECRET`: the first person to open the Worker
  address creates the admin account (the setup closes itself once an admin exists), and the signing key is generated on first use and kept in the
  database. Reading safety data sheets uses Workers AI with no setup. Optional extras (a setup key, your own AI key, emailed sign-in codes) are in
  the README.
* **The first-admin window is open on a public `workers.dev` address.** Until the first admin exists, whoever opens the address first becomes the admin. The
  button asks for no setup key (every line of `.dev.vars.example` is commented out, by design: "nothing configured"), so **open the address and create the admin
  straight after the deploy.** If you want a guard, add a `SETUP_KEY` secret in the Cloudflare dashboard (Workers, your Worker, Settings, Variables and Secrets)
  BEFORE you first open the address; setup then asks for it. A project that wants the button itself to prompt for it can add an active `SETUP_KEY=` line to
  `.dev.vars.example`, which trades the "nothing to type" first run for a prompt.

## How the committed placeholder and your own local file coexist

The committed `wrangler.toml` is a placeholder: names only, `database_id = "REPLACE_WITH_YOUR_DATABASE_ID"`, no account, no secrets. Anyone
who works on the code and wants their own IDs in that file has three safe options, from simplest:

1. **Don't edit it (the safest).** Put your own settings in `wrangler.local.toml` (git-ignored) and pass it to Wrangler with `-c`. `npm run dev` and
   `npm run db:init:local` (and the demo seed script) already do this for you when that file exists. The `npm run deploy` and `npm run db:init` scripts
   deliberately use the plain `wrangler.toml` (that is what the button runs), so to deploy to YOUR OWN account with your real IDs, run the steps yourself (`npm run predeploy` first, so phones replace their cached copy and the schema file is current):
   ```
   npx wrangler deploy -c wrangler.local.toml
   ```
   The tables are created by the Worker on its first request. To load them straight away instead:
   ```
   npx wrangler d1 execute DB --remote --yes --file=./schema.sql -c wrangler.local.toml
   ```
2. **Edit `wrangler.toml` locally and tell git to ignore your edits:** `git update-index --skip-worktree wrangler.toml`. Git then keeps the
   committed placeholder in its index and does not compare or commit your working copy. (To undo: `git update-index --no-skip-worktree wrangler.toml`.)
   **This is optional and fragile.** Any git operation that has to change `wrangler.toml` (a pull or rebase where the placeholder changed upstream, `git stash`,
   `git checkout` or `git switch` across such a change) refuses with "would be overwritten" until you undo the flag, move your copy aside, run the command and put your
   copy back. It also hides your own edits from `git status`, including ones you do want to commit. Prefer option 1.
3. **Do nothing special, and rely on the safety net below.**

The safety net: `npm run hooks:install` adds a **local** pre-commit hook (it lives in git's hooks folder, so it is never committed or pushed; it asks git where that is, so it works in a worktree, and
if `core.hooksPath` or a hook manager such as husky is in use, add the line below to that manager's pre-commit step instead) that runs
`node scripts/check-deploy-config.mjs --staged` and **refuses a commit** if the staged `wrangler.toml` contains anything but placeholders (a real database ID, an account
ID, a secret, an environment, extra variables). `npm test` also checks the committed `wrangler.toml`, so a clean clone proves what the button will read.

`npm run dev` never uses the committed file's `[ai]` block (Workers AI would call Cloudflare's real service from your machine): it uses your
`wrangler.local.toml` if you have one, otherwise it writes `wrangler.generated.toml` (git-ignored) from `wrangler.toml` without `[ai]`, and never modifies `wrangler.toml`.
If your own `wrangler.local.toml` still contains an `[ai]` block, `npm run dev` warns you. `npm run db:init:local` uses the same config as `npm run dev`, which matters because local D1
state is keyed by the config's `database_id`: two different configs would give you two different local databases ("no such table").

## What can only be tested with a real deploy

* That the button accepts this repository and its placeholder ID (it needs the repository to be public).
* Provisioning of the D1 database and R2 bucket in a real account, and the Worker creating its tables on the first request against the freshly provisioned database.
* The Workers AI binding and reading a real SDS with it, R2 serving real files, the service worker and "Add to Home Screen" on a `workers.dev` HTTPS address.
* Resend (emailed sign-in codes) and any custom domain.

## Testing a fresh deploy without deploying (smoke test)

The simulation cannot prove the items in the list above (the real button flow, real resource provisioning, Workers AI, HTTPS on `workers.dev`), but everything else about a fresh deploy from the committed files can be rehearsed locally:

`node scripts/smoke-fresh-clone.mjs [--keep] [--ref <git ref>]` (about 30 seconds after the npm install) makes a fresh clone of the committed files in a temporary folder with LF line endings (as the Linux builder behind the button has), runs `npm ci`, the placeholder and cache-version checks, the deploy-related tests and `wrangler deploy --dry-run`, applies `schema.sql` twice to a local database, starts `npm run dev` with no secrets and no AI binding, and walks the first-run path (setup, second setup refused, sign-in, signing key stored but never returned, place, chemical, logo and PDF in R2, plain user cannot write, audit, review). It prints a PASS/FAIL table and exits 1 on any failure; `--keep` keeps the temporary folder. It uses only `--local` and `--dry-run` Wrangler commands and never touches your `wrangler.local.toml` or `.dev.vars`.
