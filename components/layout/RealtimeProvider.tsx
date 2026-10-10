"use client";
import { useRealtime } from "@/hooks/useRealtime";

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  useRealtime(); // Mount WebSocket connection at root level
  return <>{children}</>;
}
