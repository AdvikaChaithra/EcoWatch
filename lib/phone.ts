/** Phone numbers are stored in one format: "+91" + 10 digits for Indian mobiles, else "+"/digits as typed (no spaces). */
export function normalizePhone(raw: string): string {
  const s = (raw ?? "").trim().replace(/[\s()-]/g, "");
  const digits = s.replace(/\D/g, "");
  if (/^[6-9]\d{9}$/.test(digits) && !s.startsWith("+")) return `+91${digits}`;       // 98765 43210
  if (/^91[6-9]\d{9}$/.test(digits) && !s.startsWith("+")) return `+${digits}`;      // 919876543210
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;                   // 09876543210
  return s.startsWith("+") ? `+${digits}` : digits;
}

/** Every stored form a typed number may match (older accounts were saved exactly as typed). */
export function phoneVariants(raw: string): string[] {
  const n = normalizePhone(raw);
  const digits = n.replace(/\D/g, "");
  const out = new Set<string>([n, (raw ?? "").trim(), digits]);
  if (n.startsWith("+91") && digits.length === 12) out.add(digits.slice(2));          // 10-digit form
  return Array.from(out).filter(Boolean);
}
