"use client";
import { useState, useEffect } from "react";

interface GeolocationState {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  address: string | null;
  loading: boolean;
  error: string | null;
}

export function useGeolocation(autoFetch = false) {
  const [state, setState] = useState<GeolocationState>({
    lat: null,
    lng: null,
    accuracy: null,
    address: null,
    loading: false,
    error: null,
  });

  const fetchLocation = (): Promise<GeolocationState> => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        const errorState: GeolocationState = { lat: null, lng: null, accuracy: null, address: null, loading: false, error: "Geolocation not supported" };
        setState(errorState);
        resolve(errorState);
        return;
      }

      setState((s) => ({ ...s, loading: true, error: null }));

      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude: lat, longitude: lng, accuracy } = pos.coords;

          // Reverse geocode using OpenStreetMap Nominatim (free)
          let address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
          try {
            const res = await fetch(
              `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
              { headers: { "Accept-Language": "en" } }
            );
            const data = await res.json();
            if (data?.display_name) address = data.display_name;
          } catch {
            // keep raw coords as address
          }

          const newState: GeolocationState = { lat, lng, accuracy, address, loading: false, error: null };
          setState(newState);
          resolve(newState);
        },
        (err) => {
          const errorState: GeolocationState = { lat: null, lng: null, accuracy: null, address: null, loading: false, error: err.message };
          setState(errorState);
          resolve(errorState);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  };

  useEffect(() => {
    if (autoFetch) fetchLocation();
  }, [autoFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, fetchLocation };
}
