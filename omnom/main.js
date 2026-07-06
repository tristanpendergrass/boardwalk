// Lists nearby restaurants at an automatically chosen walking distance.
//
// The radius is picked by stepping up through walk-time levels, aiming for a
// list with enough well-rated options (details opaque to the user):
//   - start at the smallest level
//   - stop when the current level has 3+ restaurants rated 4.5+
//   - stop when the next level up would not add a new 4.5+ restaurant,
//     unless the current level has fewer than 5 restaurants total
//   - the largest level is a hard cap
//
// Each level runs two Places nearby searches (nearest 20 + most popular 20,
// deduped — the API caps each search at 20 results), then the Routes API route
// matrix for real walking durations, filtered to the level's time limit.
// Durations are cached per place, so peeking at the next level only routes
// places we haven't seen yet. If routing fails we fall back to straight-line
// estimates at a typical walking pace, labeled as such.
// The search radius is a safe pre-filter: a walking route is never shorter
// than the straight line, so every walk under the limit lies inside it.

const WALK_SPEED_M_PER_MIN = 80; // ~4.8 km/h
const WALK_LEVELS_MIN = [2, 5, 10, 20, 30];
const GOOD_RATING = 4.5;
const ENOUGH_GOOD = 3;
const MIN_RESULTS = 5;

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

function setStatus(text) {
  statusEl.textContent = text;
}

function loadMapsApi(key) {
  return new Promise((resolve, reject) => {
    // Google calls this on auth errors (invalid key, referrer not allowed, etc.)
    // that otherwise only surface in the console.
    window.gm_authFailure = () =>
      setStatus("Google Maps rejected the API key (invalid key or this site is not in its referrer allowlist).");
    window.__mapsApiReady = resolve;
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__mapsApiReady`;
    script.onerror = () => reject(new Error("could not load the Google Maps script"));
    document.head.appendChild(script);
  });
}

// ?lat=..&lng=.. in the URL overrides device geolocation (useful for testing).
function getPosition() {
  const params = new URLSearchParams(window.location.search);
  const lat = parseFloat(params.get("lat"));
  const lng = parseFloat(params.get("lng"));
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return Promise.resolve({ lat, lng });
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("this browser does not support geolocation"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        const reasons = {
          [err.PERMISSION_DENIED]: "location permission was denied",
          [err.POSITION_UNAVAILABLE]: "your location is unavailable",
          [err.TIMEOUT]: "finding your location took too long",
        };
        reject(new Error(reasons[err.code] ?? err.message));
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// Real walking durations via the Routes API route matrix: one request, the user
// as origin, every given place as a destination. Returns seconds per place index
// (null where no route came back).
async function walkingSeconds(key, origin, places) {
  const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
    },
    body: JSON.stringify({
      origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } }],
      destinations: places.map((p) => ({ waypoint: { placeId: p.id } })),
      travelMode: "WALK",
    }),
  });
  if (!res.ok) {
    throw new Error(`route matrix request failed (HTTP ${res.status})`);
  }
  const elements = await res.json();
  const seconds = new Array(places.length).fill(null);
  for (const el of elements) {
    if (el.condition === "ROUTE_EXISTS" && typeof el.duration === "string") {
      seconds[el.destinationIndex] = parseInt(el.duration, 10); // e.g. "212s"
    }
  }
  return seconds;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Set once by init(), used by every search.
let ctx = null;

async function findPlaces(maxMin) {
  const { Place, SearchNearbyRankPreference, here } = ctx;
  const request = {
    fields: [
      "id",
      "displayName",
      "location",
      "rating",
      "userRatingCount",
      // The three fields isOpen() needs to answer locally, without extra requests.
      "businessStatus",
      "regularOpeningHours",
      "utcOffsetMinutes",
    ],
    locationRestriction: { center: here, radius: maxMin * WALK_SPEED_M_PER_MIN },
    includedPrimaryTypes: ["restaurant"],
    maxResultCount: 20,
  };
  // Two searches, deduped: each is capped at 20 results, so the nearest 20 and
  // the 20 most popular together give better coverage of larger radii.
  const [byDistance, byPopularity] = await Promise.all([
    Place.searchNearby({ ...request, rankPreference: SearchNearbyRankPreference.DISTANCE }),
    Place.searchNearby({ ...request, rankPreference: SearchNearbyRankPreference.POPULARITY }),
  ]);
  const seen = new Map();
  for (const place of [...byDistance.places, ...byPopularity.places]) {
    if (!seen.has(place.id)) seen.set(place.id, place);
  }
  const merged = [...seen.values()];
  // Only places open for business right now: not temporarily/permanently closed,
  // and confirmed open at this moment (unknown hours count as closed). Filtering
  // here keeps closed places out of the route matrix and the level-picking rules.
  return merged.filter((place) => place.businessStatus === "OPERATIONAL" && isOpenNow(place));
}

// Whether a place is open at this moment, computed from its weekly opening
// periods in the place's own timezone (Place.isOpen() needs the beta API channel,
// so we do the math ourselves). Unknown hours count as closed.
function isOpenNow(place) {
  const periods = place.regularOpeningHours?.periods;
  const offset = place.utcOffsetMinutes;
  if (!periods || periods.length === 0 || typeof offset !== "number") return false;
  // Open 24/7 is encoded as a single period with no close.
  if (periods.length === 1 && !periods[0].close) return true;

  const WEEK_MIN = 7 * 24 * 60;
  // "Now" as minutes into the week at the place's location.
  const local = new Date(Date.now() + offset * 60000);
  const now = local.getUTCDay() * 1440 + local.getUTCHours() * 60 + local.getUTCMinutes();

  return periods.some((p) => {
    if (!p.open || !p.close) return false;
    const start = p.open.day * 1440 + p.open.hour * 60 + p.open.minute;
    let end = p.close.day * 1440 + p.close.hour * 60 + p.close.minute;
    if (end <= start) end += WEEK_MIN; // spans midnight (or Saturday→Sunday)
    return (now >= start && now < end) || (now + WEEK_MIN >= start && now + WEEK_MIN < end);
  });
}

// Walking seconds per place, routing only places not already cached this session.
async function secondsFor(places) {
  const uncached = places.filter((p) => !ctx.secondsByPlaceId.has(p.id));
  if (uncached.length > 0) {
    let seconds;
    try {
      seconds = await walkingSeconds(ctx.key, ctx.here, uncached);
    } catch (err) {
      console.warn("Routes API unavailable, falling back to straight-line estimates:", err);
      ctx.anyEstimated = true;
      seconds = uncached.map(
        (place) =>
          (haversineMeters(ctx.here, { lat: place.location.lat(), lng: place.location.lng() }) /
            WALK_SPEED_M_PER_MIN) *
          60
      );
    }
    uncached.forEach((place, i) => ctx.secondsByPlaceId.set(place.id, seconds[i]));
  }
  return places.map((p) => ctx.secondsByPlaceId.get(p.id));
}

// All restaurants reachable within maxMin minutes of walking.
async function entriesWithin(maxMin) {
  const places = await findPlaces(maxMin);
  const seconds = await secondsFor(places);
  return places
    .map((place, i) => ({
      id: place.id,
      name: place.displayName,
      rating: place.rating,
      ratingCount: place.userRatingCount,
      minutes: seconds[i] === null ? null : Math.max(1, Math.round(seconds[i] / 60)),
    }))
    .filter((e) => e.minutes !== null && e.minutes <= maxMin);
}

function countGood(entries) {
  return entries.filter((e) => e.rating >= GOOD_RATING).length;
}

function render(entries, maxMin) {
  resultsEl.replaceChildren();
  if (entries.length === 0) {
    setStatus(`No restaurants found within a ${maxMin} minute walk.`);
    return;
  }
  const sorted = [...entries].sort(
    // Best-rated first; unrated places sink to the bottom, walk time breaks ties.
    (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.minutes - b.minutes
  );
  // Clear the progress message; the list speaks for itself.
  setStatus(ctx.anyEstimated ? "Walk times are rough estimates — routing was unavailable." : "");
  for (const entry of sorted) {
    const line = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = entry.name;
    line.append(name);
    if (entry.rating) {
      const reviews = entry.ratingCount ? `, ${entry.ratingCount.toLocaleString()} reviews` : "";
      line.append(` (${entry.rating}★${reviews})`);
    }
    line.append(` — ${entry.minutes} min walk — `);
    // Google Maps URL scheme: opens the place's profile in the Google Maps app
    // on phones that have it, where the user can start directions themselves.
    const mapLink = document.createElement("a");
    mapLink.href =
      "https://www.google.com/maps/search/?api=1" +
      `&query=${encodeURIComponent(entry.name)}` +
      `&query_place_id=${encodeURIComponent(entry.id)}`;
    mapLink.textContent = "Map";
    mapLink.target = "_blank";
    mapLink.rel = "noopener";
    line.append(mapLink);
    resultsEl.appendChild(line);
  }
}

async function autoSearch() {
  setStatus("Searching for restaurants…");
  let level = WALK_LEVELS_MIN[0];
  let entries = await entriesWithin(level);
  for (let i = 0; i + 1 < WALK_LEVELS_MIN.length; i++) {
    if (countGood(entries) >= ENOUGH_GOOD) break;
    const nextEntries = await entriesWithin(WALK_LEVELS_MIN[i + 1]);
    // Expanding must earn its keep: stop unless the next level adds a well-rated
    // option — but too-short lists always expand.
    if (entries.length >= MIN_RESULTS && countGood(nextEntries) <= countGood(entries)) break;
    level = WALK_LEVELS_MIN[i + 1];
    entries = nextEntries;
  }
  render(entries, level);
}

async function init() {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!key) {
    setStatus("This build has no Google Maps API key baked in (VITE_GOOGLE_MAPS_API_KEY was not set at build time).");
    return;
  }

  setStatus("Getting your location…");
  const here = await getPosition();

  setStatus("Loading Google Maps…");
  await loadMapsApi(key);
  const { Place, SearchNearbyRankPreference } = await google.maps.importLibrary("places");
  ctx = { key, here, Place, SearchNearbyRankPreference, secondsByPlaceId: new Map(), anyEstimated: false };

  await autoSearch();
}

init().catch((err) => setStatus(`Something went wrong: ${err.message}`));
