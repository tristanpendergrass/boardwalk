# omnom

Lists nearby restaurants with their Google Maps rating, review count, and real
walking time, at an automatically chosen walking distance. The user sees only
the resulting list — never the search knobs.

Line format: **Name** (4.7★, 1,234 reviews) — 3 min walk. Sorted by rating,
best first; unrated places sink to the bottom, walk time breaks ties.

## Adaptive walk radius

The app steps through walk-time levels of **2, 5, 10, 20, 30 minutes**,
starting at 2, and picks the level to display by these rules, in order:

1. **Enough good options → stop.** If the current level has **3 or more
   restaurants rated 4.5★+**, display it.
2. **Too few results → keep expanding.** If the current level has **fewer than
   5 restaurants total**, move up a level regardless of rule 3.
3. **Expansion must earn its keep.** Peek at the next level: if it would not
   add at least one **new** 4.5★+ restaurant, stop at the current level.
4. **30 minutes is a hard cap.**

## How a level is evaluated

- A level's radius is `minutes × 80 m` (~4.8 km/h walking pace). This is a safe
  pre-filter: a walking route is never shorter than the straight line, so every
  walk under the limit lies inside the circle.
- Two Places API (New) nearby searches run per level — nearest 20 and most
  popular 20 (`rankPreference` DISTANCE and POPULARITY) — deduped by place ID,
  because the API hard-caps each search at 20 results.
- Real walking durations come from one Routes API `computeRouteMatrix` call
  (travel mode WALK, the user as origin, place IDs as destinations), then
  results are filtered to the level's time limit. Durations are cached per
  place for the session, so the rule-3 look-ahead only routes unseen places.
- If the matrix call fails, straight-line estimates at 80 m/min are used and
  the status line says so.

## Location

The user's position comes from the browser geolocation prompt. For testing,
`?lat=..&lng=..` URL parameters skip geolocation entirely, e.g.
`/omnom/?lat=47.6062&lng=-122.3321`.

## Build

`npm run build` (Vite). Requires `VITE_GOOGLE_MAPS_API_KEY` at build time — in
this repo it's injected from Netlify by the root deploy scripts (see the root
CLAUDE.md). The key must be allowed for the Maps JavaScript API, Places API
(New), and Routes API.
