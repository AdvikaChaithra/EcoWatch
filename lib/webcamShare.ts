"use client";
// On a single laptop the AI camera engine and the browser cannot use the webcam at the same
// time (Windows gives the device to one program). Before the website opens the camera it asks
// the engine to release it; when the website is done it hands it back. If the engine is not
// running these calls simply fail fast and are ignored.

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:8001";

let pausedByUs = false;

async function call(path: string, timeoutMs = 1500): Promise<{ status?: string; paused?: boolean } | null> {
  try {
    const res = await fetch(`${ENGINE_URL}${path}`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // engine not running - nothing to release
  }
}

/** Ask the engine to release the webcam; resolves once it has had time to let go. */
export async function borrowWebcam(seconds = 180): Promise<void> {
  const r = await call(`/camera/pause?seconds=${seconds}`);
  if (r) {
    pausedByUs = true;
    // the engine releases on its camera thread; give Windows a moment to free the device
    await new Promise((res) => setTimeout(res, 1200));
  }
}

/** Give the webcam back to the engine (no-op if we didn't pause it). */
export function returnWebcam(): void {
  if (!pausedByUs) return;
  pausedByUs = false;
  call("/camera/resume");
}
