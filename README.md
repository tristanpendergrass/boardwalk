# Boardwalk

A collection of small static games, hosted at [boardwalk.tristanpendergrass.com](https://boardwalk.tristanpendergrass.com).

Each top-level folder is a self-contained game with its own `package.json` and `build` script that outputs static assets to `<game>/dist/`. The root build (`npm run build`) assembles every game into `dist/<game>/` plus an auto-generated landing page, and `npm run deploy` pushes it to Netlify.

## Quick start

```sh
npm install
npm run build      # build all games into dist/
npm run preview    # serve dist/ locally
npm run deploy     # build + deploy to production
```

See [CLAUDE.md](CLAUDE.md) for the game folder convention and how to add a new game.
