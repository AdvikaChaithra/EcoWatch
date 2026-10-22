"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEcoStore } from "@/lib/store";
import { Camera, Loader2, LogIn } from "lucide-react";

/**
 * Surveillance layout — auth guard. The live camera shows people's faces, so it is for
 * municipal admins and the super admin only. Anyone else sees why, with a sign-in button
 * that brings them back here after login (no silent redirect).
 */
export default function SurveillanceLayout({ children }: { children: React.ReactNode }) {
  const { currentUser, isAuthenticated } = useEcoStore();
  // Hydration fix: the saved session is only known in the browser, so render the
  // same placeholder as the server until mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const router = useRouter();
  const allowed = isAuthenticated && !!currentUser && (currentUser.role === "admin" || currentUser.role === "super_admin");

  if (!mounted) {
    return <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 text-red-400 animate-spin" /></div>;
  }

  if (!allowed) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
        <Camera className="w-12 h-12 text-red-400/60" />
        <h2 className="font-display text-2xl font-bold text-slate-100">AI Surveillance is for municipal admins</h2>
        <p className="text-slate-400 text-sm max-w-md">
          The live camera shows people&apos;s faces, so only admins and the Municipal Commissioner can open it.
          {isAuthenticated && currentUser ? ` You are signed in as ${currentUser.name} (${currentUser.role.replace("_", " ")}).` : " You are not signed in."}
        </p>
        <button onClick={() => router.push("/auth/admin?from=surveillance")} className="btn-eco">
          <LogIn className="w-4 h-4" /> Sign in as admin
        </button>
        <p className="text-xs text-slate-500">After signing in you will come straight back to AI Surveillance.</p>
      </div>
    );
  }

  return <>{children}</>;
}
