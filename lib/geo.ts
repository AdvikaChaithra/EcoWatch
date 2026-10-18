"use client";
// Real device location helpers (browser Geolocation API + OpenStreetMap reverse geocoding).

export const TARGET_ACCURACY_M = 50;

export interface GeoFix {
  lat: number;
  lng: number;
  accuracy: number; // metres (68% confidence radius reported by the device)
}

/**
 * Watch the device position and return the most accurate fix seen, stopping early as soon as
 * one is within `targetAccuracy` metres. Laptops without GPS usually report 30-150 m (Wi-Fi
 * positioning); phones with GPS usually reach < 20 m outdoors.
 */
export function getBestPosition(targetAccuracy = TARGET_ACCURACY_M, maxWaitMs = 15000): Promise<GeoFix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation is not supported by this browser."));
      return;
    }
    let best: GeoFix | null = null;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      navigator.geolocation.clearWatch(watchId);
      clearTimeout(timer);
      if (best) resolve(best);
      else reject(err ?? new Error("Could not get a location fix. Allow location access and try again."));
    };
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        if (!best || fix.accuracy < best.accuracy) best = fix;
        if (fix.accuracy <= targetAccuracy) finish();
      },
      (err) => {
        // PERMISSION_DENIED is final; other errors: keep waiting for a better fix until timeout
        if (err.code === err.PERMISSION_DENIED) finish(new Error("Location permission denied. Allow location access in the browser."));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs },
    );
    const timer = setTimeout(() => finish(), maxWaitMs);
  });
}

export interface PlaceInfo {
  name: string; // human-readable address
  ward: string; // locality / suburb (used as ward label)
}

/** Reverse geocode with OpenStreetMap Nominatim; falls back to raw coordinates. */
export async function reverseGeocode(lat: number, lng: number): Promise<PlaceInfo> {
  const fallback = { name: `${lat.toFixed(6)}, ${lng.toFixed(6)}`, ward: "" };
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      { headers: { "Accept-Language": "en" }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return fallback;
    const d = await res.json();
    const a = d?.address ?? {};
    const ward = a.suburb || a.neighbourhood || a.city_district || a.quarter || a.village || "";
    return { name: d?.display_name || fallback.name, ward };
  } catch {
    return fallback;
  }
}
