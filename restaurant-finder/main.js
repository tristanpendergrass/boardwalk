// Lists restaurants within a 5 minute walk of the user's location, nearest first.
// Walk times come from the Routes API route matrix (real walking routes); if that
// call fails we fall back to straight-line estimates at a typical walking pace.
// The 400m search radius is a safe pre-filter either way: a walking route is never
// shorter than the straight line, so every <=5 min walk lies inside it.

const WALK_SPEED_M_PER_MIN = 80; // ~4.8 km/h
const MAX_WALK_MIN = 5;
const RADIUS_M = WALK_SPEED_M_PER_MIN * MAX_WALK_MIN;

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

async function main() {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!key) {
    setStatus("This build has no Google Maps API key baked in (VITE_GOOGLE_MAPS_API_KEY was not set at build time).");
    return;
  }

  setStatus("Getting your location…");
  const here = await getPosition();

  setStatus("Searching for restaurants…");
  await loadMapsApi(key);
  const { Place, SearchNearbyRankPreference } = await google.maps.importLibrary("places");
  const { places } = await Place.searchNearby({
    fields: ["id", "displayName", "location"],
    locationRestriction: { center: here, radius: RADIUS_M },
    includedPrimaryTypes: ["restaurant"],
    maxResultCount: 20,
    rankPreference: SearchNearbyRankPreference.DISTANCE,
  });

  if (places.length === 0) {
    setStatus(`No restaurants found within a ${MAX_WALK_MIN} minute walk.`);
    return;
  }

  setStatus("Computing walking times…");
  let estimated = false;
  let seconds;
  try {
    seconds = await walkingSeconds(key, here, places);
  } catch (err) {
    console.warn("Routes API unavailable, falling back to straight-line estimates:", err);
    estimated = true;
    seconds = places.map(
      (place) =>
        (haversineMeters(here, { lat: place.location.lat(), lng: place.location.lng() }) /
          WALK_SPEED_M_PER_MIN) *
        60
    );
  }

  const entries = places
    .map((place, i) => ({
      name: place.displayName,
      minutes: seconds[i] === null ? null : Math.max(1, Math.round(seconds[i] / 60)),
    }))
    .filter((e) => e.minutes !== null && e.minutes <= MAX_WALK_MIN)
    .sort((a, b) => a.minutes - b.minutes);

  if (entries.length === 0) {
    setStatus(`No restaurants found within a ${MAX_WALK_MIN} minute walk.`);
    return;
  }

  const qualifier = estimated ? " (walk times are rough estimates — routing was unavailable)" : "";
  setStatus(`${entries.length} restaurant${entries.length === 1 ? "" : "s"} within a ${MAX_WALK_MIN} minute walk:${qualifier}`);
  for (const entry of entries) {
    const li = document.createElement("li");
    li.textContent = `${entry.name} — ${entry.minutes} min walk`;
    resultsEl.appendChild(li);
  }
}

main().catch((err) => setStatus(`Something went wrong: ${err.message}`));
