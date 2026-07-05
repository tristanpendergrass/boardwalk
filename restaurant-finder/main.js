// Lists restaurants within a chosen walking time of the user's location.
// Each distance button re-runs the search: two Places nearby searches (nearest 20
// + most popular 20, deduped — the API caps each search at 20 results), then the
// Routes API route matrix for real walking durations, filtered to the time limit
// and sorted nearest-first. If routing fails we fall back to straight-line
// estimates at a typical walking pace, labeled as such.
// The search radius is a safe pre-filter: a walking route is never shorter than
// the straight line, so every walk under the limit lies inside it.

const WALK_SPEED_M_PER_MIN = 80; // ~4.8 km/h
const DEFAULT_WALK_MIN = 5;

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const buttons = [...document.querySelectorAll("button[data-minutes]")];

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
// as origin, every found place as a destination. Returns seconds per place index
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
    fields: ["id", "displayName", "location", "rating"],
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
  return [...seen.values()];
}

async function runSearch(maxMin) {
  for (const b of buttons) b.disabled = true;
  resultsEl.replaceChildren();
  try {
    setStatus("Searching for restaurants…");
    const places = await findPlaces(maxMin);

    if (places.length === 0) {
      setStatus(`No restaurants found within a ${maxMin} minute walk.`);
      return;
    }

    setStatus("Computing walking times…");
    let estimated = false;
    let seconds;
    try {
      seconds = await walkingSeconds(ctx.key, ctx.here, places);
    } catch (err) {
      console.warn("Routes API unavailable, falling back to straight-line estimates:", err);
      estimated = true;
      seconds = places.map(
        (place) =>
          (haversineMeters(ctx.here, { lat: place.location.lat(), lng: place.location.lng() }) /
            WALK_SPEED_M_PER_MIN) *
          60
      );
    }

    const entries = places
      .map((place, i) => ({
        name: place.displayName,
        rating: place.rating,
        minutes: seconds[i] === null ? null : Math.max(1, Math.round(seconds[i] / 60)),
      }))
      .filter((e) => e.minutes !== null && e.minutes <= maxMin)
      .sort((a, b) => a.minutes - b.minutes || a.name.localeCompare(b.name));

    if (entries.length === 0) {
      setStatus(`No restaurants found within a ${maxMin} minute walk.`);
      return;
    }

    const qualifier = estimated ? " (walk times are rough estimates — routing was unavailable)" : "";
    setStatus(`${entries.length} restaurant${entries.length === 1 ? "" : "s"} within a ${maxMin} minute walk:${qualifier}`);
    for (const entry of entries) {
      const line = document.createElement("div");
      const rating = entry.rating ? ` — ${entry.rating}★` : "";
      line.textContent = `${entry.name} — ${entry.minutes} min walk${rating}`;
      resultsEl.appendChild(line);
    }
  } finally {
    // Re-enable all buttons except the active selection.
    for (const b of buttons) b.disabled = Number(b.dataset.minutes) === maxMin;
  }
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
  ctx = { key, here, Place, SearchNearbyRankPreference };

  for (const button of buttons) {
    button.addEventListener("click", () => {
      runSearch(Number(button.dataset.minutes)).catch((err) => setStatus(`Something went wrong: ${err.message}`));
    });
  }
  await runSearch(DEFAULT_WALK_MIN);
}

init().catch((err) => setStatus(`Something went wrong: ${err.message}`));
