"use client";
import { useEffect, useRef, useCallback } from "react";
import { useEcoStore, LiveAlert } from "@/lib/store";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws";

export function useRealtime() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const store = useEcoStore();

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[EcoWatch WS] Connected");
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === "violation") {
            const alert: LiveAlert = {
              id: msg.id ?? crypto.randomUUID(),
              type: "violation",
              message: `🚨 Litter violation detected — ${msg.location ?? "Unknown"}`,
              location: msg.location,
              timestamp: msg.timestamp ?? new Date().toISOString(),
              citizenName: msg.citizen_name,
              confidence: msg.confidence_score,
            };
            store.addLiveAlert(alert);
            store.setTotalViolationsToday(store.totalViolationsToday + 1);

            // SMS-style notification banner
            store.showNotificationBanner(
              `EcoWatch Alert: ${msg.citizen_name ?? "A citizen"} was detected littering at ${msg.location} on ${new Date().toLocaleString("en-IN")}. A fine of ₹200 has been issued.`
            );
            setTimeout(() => store.hideNotificationBanner(), 8000);
          }

          if (msg.type === "report") {
            const alert: LiveAlert = {
              id: msg.id ?? crypto.randomUUID(),
              type: "report",
              message: `📍 New dump report — ${msg.category} at ${msg.location}`,
              location: msg.location,
              timestamp: new Date().toISOString(),
            };
            store.addLiveAlert(alert);
            store.setActiveDumpReports(store.activeDumpReports + 1);
          }

          if (msg.type === "worker_status") {
            store.setWorkersOnDuty(msg.count ?? store.workersOnDuty);
          }

          if (msg.type === "worker_location" && msg.worker_id) {
            store.setWorkerLocation(msg.worker_id, {
              lat: msg.lat,
              lng: msg.lng,
              name: msg.name ?? "Worker",
              ward: msg.ward ?? "",
            });
          }

          if (msg.type === "civic_index") {
            store.setCivicIndex(msg.value ?? store.civicIndex);
          }
        } catch (err) {
          console.error("[EcoWatch WS] Parse error:", err);
        }
      };

      ws.onerror = () => {
        console.warn("[EcoWatch WS] Connection error — will retry");
      };

      ws.onclose = () => {
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        reconnectRef.current = setTimeout(connect, 5000);
      };
    } catch {
      // Backend not running — silent fail, UI works normally
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [connect]);

  const sendMessage = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { sendMessage };
}
