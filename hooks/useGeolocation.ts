"use client";
import { useState, useEffect } from "react";
import { getBestPosition, reverseGeocode, TARGET_ACCURACY_M } from "@/lib/geo";

interface GeolocationState {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;   // metres
  address: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Real device location. Watches the position for up to 15 s and keeps the most accurate fix
 * (stops early once within TARGET_ACCURACY_M = 50 m), then reverse-geocodes it.
 */
export function useGeolocation(autoFetch = false) {
  const [state, setState] = useState<GeolocationState>({
    lat: null, lng: null, accuracy: null, address: null, loading: false, error: null,
  });

  const fetchLocation = async (): Promise<GeolocationState> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const fix = await getBestPosition(TARGET_ACCURACY_M, 15000);
      const place = await reverseGeocode(fix.lat, fix.lng);
      const next: GeolocationState = {
        lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, address: place.name, loading: false, error: null,
      };
      setState(next);
      return next;
    } catch (e: any) {
      const next: GeolocationState = {
        lat: null, lng: null, accuracy: null, address: null, loading: false,
        error: e?.message ?? "Could not get your location",
      };
      setState(next);
      return next;
    }
  };

  useEffect(() => {
    if (autoFetch) fetchLocation();
  }, [autoFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, fetchLocation };
}
