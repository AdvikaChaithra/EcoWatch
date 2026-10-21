"use client";
import { useEcoStore } from "@/lib/store";

/** fetch() for privileged API routes: attaches the signed session token; returns parsed JSON. */
export async function authFetch<T = any>(path: string, init: RequestInit = {}): Promise<T & { success?: boolean; error?: string }> {
  const token = useEcoStore.getState().currentUser?.token;
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return data;
}
