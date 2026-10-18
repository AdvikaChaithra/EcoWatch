// Server-only helpers shared by the Next.js API routes (never import from client components).
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { NextResponse } from "next/server";

// 127.0.0.1 (not "localhost"): uvicorn listens on IPv4 only, and Node may resolve localhost to ::1.
export const BACKEND_URL = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:8000";

export class ConfigError extends Error {}

/** Server-side Supabase client. Prefers the service-role key when configured. */
export function serverSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new ConfigError("Supabase environment variables are not configured.");
  return createClient(url, key, {
    auth: { persistSession: false },
    // Fail fast instead of hanging the login request when the database is unreachable.
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8000) }) },
  });
}

export function fail(error: string, status: number) {
  return NextResponse.json({ success: false, error }, { status });
}

/** Log details server-side; return a generic message to the client. */
export function serverError(e: unknown, context: string) {
  console.error(`[api:${context}]`, e);
  if (e instanceof ConfigError) return fail(e.message, 503);
  const text = `${(e as any)?.message ?? ""} ${(e as any)?.details ?? ""}`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|timeout|aborted/i.test(text)) {
    return fail("Cannot reach the database right now. Please try again shortly.", 503);
  }
  return fail("Something went wrong. Please try again.", 500);
}

export async function readJson<T = Record<string, any>>(req: Request): Promise<T | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as T) : null;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Verifies "pbkdf2$iters$salt$hash" (same format as backend/security.py) or legacy plain text. */
export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  const s = (stored ?? "").trim();
  if (!s) return false;
  if (s.startsWith("pbkdf2$")) {
    const [, iters, saltHex, hashHex] = s.split("$");
    if (!iters || !saltHex || !hashHex) return false;
    const dk = crypto.pbkdf2Sync(secret, Buffer.from(saltHex, "hex"), parseInt(iters, 10), hashHex.length / 2, "sha256");
    return safeEqual(dk.toString("hex"), hashHex);
  }
  return safeEqual(secret.trim(), s);
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30s) ────────────────────────────────────
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error("Invalid base32 secret");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function verifyTotp(secret: string, code: string, window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter + w));
    const h = crypto.createHmac("sha1", key).update(buf).digest();
    const off = h[h.length - 1] & 0xf;
    const num = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
    if (safeEqual(num.toString().padStart(6, "0"), code)) return true;
  }
  return false;
}

export type EmbeddingResult =
  | { ok: true; embedding: number[] }
  | { ok: false; reason: "offline" | "no_face" | "error"; message: string };

/** Ask the FastAPI backend for a face embedding, distinguishing "offline" from "no face". */
export async function extractEmbedding(imageBase64: string): Promise<EmbeddingResult> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/extract-embedding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: imageBase64 }),
      // CPU-only face models can take several seconds when the machine is busy (camera engine,
      // website). Allow ample time instead of reporting a false "offline".
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(data.embedding)) return { ok: true, embedding: data.embedding };
    if (res.status === 422) return { ok: false, reason: "no_face", message: data.detail ?? "No face detected." };
    if (res.status === 503) return { ok: false, reason: "offline", message: data.detail ?? "Face recognition is unavailable." };
    console.error("[extractEmbedding] backend error", res.status, data);
    return { ok: false, reason: "error", message: data.detail ?? `Face service error (${res.status}).` };
  } catch (e: any) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    console.error("[extractEmbedding]", timedOut ? "timed out" : "request failed", e?.cause?.code ?? e?.message);
    if (timedOut) {
      return { ok: false, reason: "error", message: "Face service is busy. Please wait a few seconds and try again." };
    }
    return { ok: false, reason: "offline", message: `Face recognition backend not reachable at ${BACKEND_URL}. Start it with: python -m uvicorn backend.main:app --port 8000` };
  }
}
