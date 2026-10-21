"use client";
import { useState } from "react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { authFetch } from "@/lib/api";
import { useEcoStore } from "@/lib/store";

/**
 * Shown instead of the portal until a user with a temporary password (admins) or a one-time
 * PIN (workers) sets their own. Also reused from profile pages for voluntary changes.
 */
export function ForceChangeCredential({ kind, onDone, voluntary = false }:
  { kind: "password" | "pin"; onDone?: () => void; voluntary?: boolean }) {
  const user = useEcoStore((s) => s.currentUser);
  const setCurrentUser = useEcoStore((s) => s.setCurrentUser);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  const isPin = kind === "pin";
  const label = isPin ? "PIN" : "password";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (next !== confirm) { setError(`The new ${label}s do not match.`); return; }
    setBusy(true);
    try {
      await authFetch(isPin ? "/api/auth/change-pin" : "/api/auth/change-password", {
        method: "POST", body: JSON.stringify({ current, next }),
      });
      if (user) setCurrentUser({ ...user, must_change: false });
      setOk(true);
      setCurrent(""); setNext(""); setConfirm("");
      onDone?.();
    } catch (err: any) {
      setError(err?.message ?? `Could not change ${label}.`);
    } finally { setBusy(false); }
  }

  if (ok && voluntary) {
    return <p className="flex items-center gap-2 text-sm text-eco-300"><ShieldCheck className="w-4 h-4" /> {isPin ? "PIN" : "Password"} changed.</p>;
  }

  const inputProps = isPin
    ? { inputMode: "numeric" as const, maxLength: 4, pattern: "\\d{4}", type: "password" }
    : { type: "password", minLength: 8 };

  return (
    <form onSubmit={submit} className={voluntary ? "space-y-3" : "max-w-md mx-auto glass-card p-6 space-y-4 mt-10"}>
      {!voluntary && (
        <div className="text-center space-y-2">
          <KeyRound className="w-10 h-10 text-blue-400 mx-auto" />
          <h2 className="font-display text-xl font-bold text-slate-100">Set your own {label}</h2>
          <p className="text-sm text-slate-400">
            You signed in with a {isPin ? "one-time PIN" : "temporary password"} issued by your administrator.
            Choose a new {label} to continue.
          </p>
        </div>
      )}
      <input className="input-civic" placeholder={`Current ${isPin ? "PIN" : "password"}`} value={current}
             onChange={(e) => setCurrent(e.target.value)} required {...inputProps} />
      <input className="input-civic" placeholder={isPin ? "New 4-digit PIN" : "New password (min 8, letters + numbers)"} value={next}
             onChange={(e) => setNext(e.target.value)} required {...inputProps} />
      <input className="input-civic" placeholder={`Confirm new ${label}`} value={confirm}
             onChange={(e) => setConfirm(e.target.value)} required {...inputProps} />
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <button type="submit" disabled={busy} className="btn-eco w-full justify-center">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} Save new {label}
      </button>
    </form>
  );
}
