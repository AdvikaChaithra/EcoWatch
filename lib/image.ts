/** Browser-side photo helpers shared by the citizen report tool and the worker proof upload. */

export interface GpsStamp { lat: number; lng: number; address?: string }

/** Draw the EcoWatch GPS/time watermark along the bottom of a canvas. */
export function drawGpsStamp(ctx: CanvasRenderingContext2D, width: number, height: number, gps: GpsStamp) {
  const now = new Date();
  const lines = [
    `📍 ${gps.address ?? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}`}`,
    `⏱ ${now.toLocaleString("en-IN")} | ${now.toLocaleDateString("en-IN", { weekday: "long" })}`,
    `🛰 GPS: ${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}`,
    "EcoWatch™ Verified",
  ];
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, height - 90, width, 90);
  ctx.fillStyle = "#10b981";
  ctx.font = "bold 13px monospace";
  lines.forEach((line, i) => ctx.fillText(line, 10, height - 75 + i * 20));
}

/** Downscale a chosen photo (max 1280 px) to a JPEG data URL, optionally GPS-stamped. */
export async function fileToJpegDataUrl(file: File, gps?: GpsStamp): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Could not read that image")); i.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (gps) drawGpsStamp(ctx, c.width, c.height, gps);
    return c.toDataURL("image/jpeg", 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}
