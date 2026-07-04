// Boardwalk root build: builds every game folder and assembles the publish dir (dist/).
//
// A "game" is any top-level folder with a package.json containing a "build" script.
// Each game's build must write its final static assets to <game>/dist/, which gets
// copied to dist/<game>/. A landing page is generated at dist/index.html.
//
// Behaviors:
//  - Incremental: a game is skipped when its source hash matches .buildcache.json
//    and its output already exists in dist/. Pass --force to rebuild everything.
//  - Fault-tolerant: a game whose build fails is skipped with a warning; its
//    last-good output in dist/ (if any) keeps being served. The script exits
//    nonzero only if dist/ ends up with zero games.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const CACHE_FILE = path.join(ROOT, ".buildcache.json");
const FORCE = process.argv.includes("--force");
const SKIP_DIRS = new Set(["dist", "scripts", "node_modules"]);

function findGames() {
  const games = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const pkgPath = path.join(ROOT, entry.name, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      console.warn(`! ${entry.name}: unreadable package.json, ignoring folder`);
      continue;
    }
    if (pkg.scripts?.build) games.push({ name: entry.name, dir: path.join(ROOT, entry.name), pkg });
  }
  return games.sort((a, b) => a.name.localeCompare(b.name));
}

// Content hash of a game's source tree (everything except node_modules/dist).
function hashSourceTree(dir) {
  const hash = createHash("sha256");
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childRel);
      } else if (entry.isFile()) {
        hash.update(childRel);
        hash.update(fs.readFileSync(path.join(dir, childRel)));
      }
    }
  };
  walk("");
  return hash.digest("hex");
}

function npm(args, cwd) {
  const result = spawnSync("npm", args, { cwd, shell: true, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function buildGame(game) {
  const hasDeps = Object.keys({ ...game.pkg.dependencies, ...game.pkg.devDependencies }).length > 0;
  if (hasDeps && !fs.existsSync(path.join(game.dir, "node_modules"))) {
    console.log(`  ${game.name}: installing dependencies...`);
    npm(["install"], game.dir);
  }
  npm(["run", "build"], game.dir);
  const gameDist = path.join(game.dir, "dist");
  if (!fs.existsSync(path.join(gameDist, "index.html"))) {
    throw new Error(`build succeeded but ${game.name}/dist/index.html is missing`);
  }
  const target = path.join(DIST, game.name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(gameDist, target, { recursive: true });
}

function generateIndex(deployedNames, games) {
  // Proof of life for the Netlify env var pipeline: the key is injected when the
  // build runs via `netlify deploy`/`netlify build`, absent in plain local builds.
  const keyStatus = process.env.VITE_GOOGLE_MAPS_API_KEY ? "loaded" : "missing";
  const byName = new Map(games.map((g) => [g.name, g]));
  const items = deployedNames
    .map((name) => {
      const display = byName.get(name)?.pkg.displayName ?? name;
      return `    <li><a href="/${name}/">${display}</a></li>`;
    })
    .join("\n");
  fs.writeFileSync(
    path.join(DIST, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Boardwalk</title>
</head>
<body>
  <h1>Boardwalk</h1>
  <p>A collection of games.</p>
  <ul>
${items}
  </ul>
  <p><small>Google Maps API key: ${keyStatus}</small></p>
</body>
</html>
`
  );
}

function main() {
  fs.mkdirSync(DIST, { recursive: true });
  let cache = {};
  if (!FORCE && fs.existsSync(CACHE_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    } catch {
      cache = {};
    }
  }

  const games = findGames();
  if (games.length === 0) {
    console.error("No game folders found (a game is a folder with a package.json containing a build script).");
    process.exit(1);
  }

  const newCache = {};
  let built = 0;
  let skipped = 0;
  let failed = 0;

  for (const game of games) {
    const hash = hashSourceTree(game.dir);
    const outputExists = fs.existsSync(path.join(DIST, game.name, "index.html"));
    if (cache[game.name] === hash && outputExists) {
      console.log(`- ${game.name}: unchanged, skipped`);
      newCache[game.name] = hash;
      skipped++;
      continue;
    }
    try {
      buildGame(game);
      console.log(`+ ${game.name}: built`);
      newCache[game.name] = hash;
      built++;
    } catch (err) {
      failed++;
      console.warn(`! ${game.name}: BUILD FAILED, skipping this game`);
      console.warn(String(err.message).split("\n").map((l) => `    ${l}`).join("\n"));
      if (outputExists) console.warn(`    (last-good output in dist/${game.name}/ is kept)`);
    }
  }

  // Games present in dist/ after this run: fresh builds, unchanged skips, and last-good leftovers.
  const deployed = games.map((g) => g.name).filter((name) => fs.existsSync(path.join(DIST, name, "index.html")));
  // Drop dist/ folders for games that no longer exist in the repo.
  for (const entry of fs.readdirSync(DIST, { withFileTypes: true })) {
    if (entry.isDirectory() && !deployed.includes(entry.name)) {
      fs.rmSync(path.join(DIST, entry.name), { recursive: true, force: true });
    }
  }
  generateIndex(deployed, games);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(newCache, null, 2));

  console.log(`\nbuilt: ${built}, unchanged: ${skipped}, failed: ${failed} — ${deployed.length} game(s) in dist/`);
  if (deployed.length === 0) {
    console.error("No games made it into dist/; refusing to produce an empty site.");
    process.exit(1);
  }
}

main();
