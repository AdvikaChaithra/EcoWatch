"use client";
import { useEffect, useRef, useCallback } from "react";
import { useEcoStore } from "@/lib/store";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws";
const MAX_BACKOFF_MS = 30_000;

export function useRealtime() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const unmountedRef = useRef(false);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0; // reset backoff after a successful connection
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          // Always read fresh state: this closure outlives many renders.
          const store = useEcoStore.getState();

          // Fines are never announced globally with a citizen's name; each citizen gets their own
          // alert in their dashboard (violations realtime + notifications table).

          if (msg.type === "littering_event") {
            // Vision-engine candidate (identity still pending) — surface as an alert only.
            store.addLiveAlert({
              id: msg.event_id || crypto.randomUUID(),
              type: "violation",
              message: `🎥 Littering event detected — ${msg.location?.name ?? msg.camera_id ?? "camera"}`,
              location: msg.location?.name,
              timestamp: msg.timestamp ?? new Date().toISOString(),
              confidence: msg.event_confidence,
            });
          }

          // Backend identity result: only count real, newly created fines. No citizen details
          // are shown globally; each citizen's own alert arrives through their dashboard.
          if (msg.type === "identity_result" && msg.identity_status === "MATCH" && msg.violation_created) {
            store.setTotalViolationsToday(store.totalViolationsToday + 1);
          }

          if (msg.type === "report") {
            store.addLiveAlert({
              id: msg.id || crypto.randomUUID(),
              type: "report",
              message: `📍 New dump report — ${msg.category} at ${msg.location}`,
              location: msg.location,
              timestamp: new Date().toISOString(),
            });
            store.setActiveDumpReports(store.activeDumpReports + 1);
          }

          if (msg.type === "report_verified" && msg.approved) {
            store.setActiveDumpReports(Math.max(0, store.activeDumpReports - 1));
          }

          if (msg.type === "worker_status") {
            store.setWorkersOnDuty(typeof msg.count === "number" ? msg.count : store.workersOnDuty);
          }

          if (
            msg.type === "worker_location" &&
            msg.worker_id &&
            Number.isFinite(msg.lat) &&
            Number.isFinite(msg.lng)
          ) {
            const prev = store.workerLocations[msg.worker_id];
            store.setWorkerLocation(msg.worker_id, {
              lat: msg.lat,
              lng: msg.lng,
              name: msg.name || prev?.name || "Worker",
              ward: msg.ward || prev?.ward || "",
            });
          }
        } catch (err) {
          console.error("[EcoWatch WS] Message handling error:", err);
        }
      };

      ws.onerror = () => {
        console.warn("[EcoWatch WS] Connection error — will retry");
      };

      ws.onclose = () => {
        if (unmountedRef.current) return; // intentional close on unmount: don't reconnect
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        const delay = Math.min(1000 * 2 ** attemptRef.current, MAX_BACKOFF_MS);
        attemptRef.current += 1;
        reconnectRef.current = setTimeout(connect, delay);
      };
    } catch (err) {
      console.warn("[EcoWatch WS] Could not open socket:", err);
      if (!unmountedRef.current) {
        const delay = Math.min(1000 * 2 ** attemptRef.current, MAX_BACKOFF_MS);
        attemptRef.current += 1;
        reconnectRef.current = setTimeout(connect, delay);
      }
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connect();
    return () => {
      unmountedRef.current = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { sendMessage };
}
