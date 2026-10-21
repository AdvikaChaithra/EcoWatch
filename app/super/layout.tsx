"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Crown, Loader2, LogIn } from "lucide-react";
import { useEcoStore } from "@/lib/store";
import { ForceChangeCredential } from "@/components/auth/ForceChangeCredential";

/** Super Admin portal guard: only the Municipal Commissioner (role super_admin). */
export default function SuperLayout({ children }: { children: React.ReactNode }) {
  const { currentUser, isAuthenticated, logout } = useEcoStore();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const router = useRouter();
  const allowed = isAuthenticated && currentUser?.role === "super_admin" && !!currentUser?.token;

  if (!mounted) {
    return <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 text-amber-400 animate-spin" /></div>;
  }

  if (!allowed) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
        <Crown className="w-12 h-12 text-amber-400/60" />
        <h2 className="font-display text-2xl font-bold text-slate-100">Super Admin access only</h2>
        <p className="text-slate-400 text-sm max-w-md">
          This portal is for the Municipal Commissioner, who manages admins, sectors and the city-wide workforce.
          {isAuthenticated && currentUser ? ` You are signed in as ${currentUser.name} (${currentUser.role.replace("_", " ")}).` : ""}
        </p>
        <button
          onClick={() => { if (isAuthenticated) logout(); router.push("/auth/admin"); }}
          className="btn-eco"
        >
          <LogIn className="w-4 h-4" /> Sign in as Super Admin
        </button>
      </div>
    );
  }
  if (currentUser?.must_change) return <ForceChangeCredential kind="password" />;
  return <>{children}</>;
}
