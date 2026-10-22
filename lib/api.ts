"use client";
import { useEcoStore } from "@/lib/store";

/** fetch() for privileged API routes: attaches the signed session token; returns parsed JSON. */
export async function authFetch<T = any>(path: string, init: RequestInit = {}): Promise<T & { success?: boolean; error?: string }> {
  const token = useEcoStore.getState().currentUser?.token;
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch {
    // The browser could not reach the server at all (it was restarting or stopped) - not a rejection.
    throw new Error("Could not reach the EcoWatch server. Check that the website (npm start) is running, then try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return data;
}
