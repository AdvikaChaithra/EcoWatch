import type { Metadata } from "next";
import "./globals.css";
import { GlobalHeader } from "@/components/layout/GlobalHeader";
import { NotificationBanner } from "@/components/layout/NotificationBanner";
import { RealtimeProvider } from "@/components/layout/RealtimeProvider";

export const metadata: Metadata = {
  title: "EcoWatch — AI-Powered Civic Cleanliness Platform",
  description:
    "Real-time AI surveillance, citizen reporting, municipal task dispatch, and sanitation workforce management for a cleaner, smarter city.",
  keywords: "EcoWatch, civic tech, waste detection, AI surveillance, municipal, cleanliness",
  openGraph: {
    title: "EcoWatch — AI-Powered Civic Cleanliness Platform",
    description: "Real-time AI-powered cleanliness surveillance for smarter cities",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Sora:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* Start the TLS connection to the database while the page loads (saves ~0.5 s on first data). */}
        {process.env.NEXT_PUBLIC_SUPABASE_URL && (
          <>
            <link rel="preconnect" href={process.env.NEXT_PUBLIC_SUPABASE_URL} crossOrigin="anonymous" />
            <link rel="dns-prefetch" href={process.env.NEXT_PUBLIC_SUPABASE_URL} />
          </>
        )}
      </head>
      <body>
        <RealtimeProvider>
          <div className="flex flex-col min-h-screen">
            <GlobalHeader />
            <NotificationBanner />
            <main className="flex-1">{children}</main>
          </div>
        </RealtimeProvider>
      </body>
    </html>
  );
}
