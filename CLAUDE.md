# Boardwalk

Static games monorepo. Production site: https://boardwalk.tristanpendergrass.com (Netlify site `boardwalk-tristan`, also reachable at https://boardwalk-tristan.netlify.app). Each top-level folder is one game, served at `/<folder-name>/`. The site root is an auto-generated index page listing all games. There is no server component — everything is static assets.

## Game folder convention

A game is any top-level folder with a `package.json` whose `scripts.build` writes final static assets (including an `index.html`) to `<game>/dist/`. Optional `displayName` field in package.json sets the name shown on the landing page (falls back to folder name).

To add a new game: create a new kebab-case folder following the `hello-world/` structure (any stack is fine — Vite, plain HTML, whatever — as long as `npm run build` produces `dist/index.html`).

**Games must use relative asset paths** (`./main.js`, not `/main.js`) — they are served from `/<game>/`, not the site root. For Vite games, set `base: "./"` in vite.config.

## Commands (run from repo root)

- `npm run build` — builds all games into `dist/` and regenerates the landing page. Incremental: unchanged games are skipped (source hash in `.buildcache.json`); pass `-- --force` to rebuild everything. Fault-tolerant: a game whose build fails is warned about and skipped (its last-good `dist/` output keeps being served), so one broken game never blocks deploying the others.
- `npm run preview` — serve `dist/` locally.
- `npm run deploy:draft` — build + deploy to a draft URL for checking.
- `npm run deploy` — build + deploy to production.

Both deploy scripts run the build through the Netlify CLI (`netlify deploy` builds by default), which injects environment variables configured in the Netlify UI into the local build. `VITE_GOOGLE_MAPS_API_KEY` holds the Google Maps API key (referrer-restricted browser key; the value is set in Netlify, never committed). The landing page footer shows "Google Maps API key: loaded/missing" as proof of the env var pipeline — plain `npm run build` shows "missing", which is expected.

The folder is linked to the Netlify site via `.netlify/state.json`; the Netlify CLI is a devDependency, so no global install is needed.
