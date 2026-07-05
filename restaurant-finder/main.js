// Lists restaurants within a 5 minute walk of the user's location, nearest first.
// Walk time is estimated from straight-line distance at a typical walking pace,
// so it slightly understates real-world walks (no routing API involved).

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
    fields: ["displayName", "location"],
    locationRestriction: { center: here, radius: RADIUS_M },
    includedPrimaryTypes: ["restaurant"],
    maxResultCount: 20,
    rankPreference: SearchNearbyRankPreference.DISTANCE,
  });

  if (places.length === 0) {
    setStatus(`No restaurants found within a ${MAX_WALK_MIN} minute walk.`);
    return;
  }

  setStatus(`${places.length} restaurant${places.length === 1 ? "" : "s"} within a ${MAX_WALK_MIN} minute walk:`);
  for (const place of places) {
    const meters = haversineMeters(here, {
      lat: place.location.lat(),
      lng: place.location.lng(),
    });
    const minutes = Math.max(1, Math.round(meters / WALK_SPEED_M_PER_MIN));
    const li = document.createElement("li");
    li.textContent = `${place.displayName} — about ${minutes} min walk`;
    resultsEl.appendChild(li);
  }
}

main().catch((err) => setStatus(`Something went wrong: ${err.message}`));
