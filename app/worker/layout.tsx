"use client";
import { ForceChangeCredential } from "@/components/auth/ForceChangeCredential";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEcoStore } from "@/lib/store";
import { HardHat, Loader2 } from "lucide-react";

export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  const { currentUser, isAuthenticated } = useEcoStore();
  // Hydration fix: the saved session is only known in the browser, so render the
  // same placeholder as the server until mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated || currentUser?.role !== "worker") {
      router.replace("/auth/worker");
    }
  }, [isAuthenticated, currentUser, router]);

  if (!mounted || !isAuthenticated || currentUser?.role !== "worker") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <HardHat className="w-12 h-12 text-yellow-400/40" />
        <p className="text-slate-400 text-sm">Redirecting to Worker Login…</p>
        <Loader2 className="w-5 h-5 text-yellow-400 animate-spin" />
      </div>
    );
  }

  if (currentUser?.must_change) return <ForceChangeCredential kind="pin" />;
  return <>{children}</>;
}
