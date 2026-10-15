"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEcoStore } from "@/lib/store";
import { Camera, Loader2 } from "lucide-react";

/**
 * Surveillance layout — auth guard.
 * Allows admin AND surveillance roles.
 * Unauthenticated users → redirect to /auth/admin.
 */
export default function SurveillanceLayout({ children }: { children: React.ReactNode }) {
  const { currentUser, isAuthenticated } = useEcoStore();
  // Hydration fix: the saved session is only known in the browser, so render the
  // same placeholder as the server until mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const router = useRouter();

  useEffect(() => {
    // Surveillance is for admins and surveillance-role users
    if (!isAuthenticated || !currentUser) {
      router.replace("/auth/admin?from=surveillance");
    }
  }, [isAuthenticated, currentUser, router]);

  if (!mounted || !isAuthenticated || !currentUser) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Camera className="w-12 h-12 text-red-400/40" />
        <p className="text-slate-400 text-sm">Authentication required for AI Surveillance access.</p>
        <p className="text-slate-500 text-xs">Redirecting to Admin Login…</p>
        <Loader2 className="w-5 h-5 text-red-400 animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
