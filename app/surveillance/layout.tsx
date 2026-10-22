/**
 * AI Surveillance is a public detection screen: no login. It shows the live camera with
 * detections and littering events; identities are never shown here (each fine goes only to
 * that citizen's own portal).
 */
export default function SurveillanceLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
