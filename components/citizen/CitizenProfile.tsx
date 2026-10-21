"use client";
import { useEffect, useState } from "react";
import { UserCircle, Pencil, Save, X, Loader2, CheckCircle2, ScanFace, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useEcoStore } from "@/lib/store";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { formatDate } from "@/lib/utils";

interface Profile {
  id: string; name: string; phone: string; email: string | null; address: string | null; ward: string | null;
  gov_id: string | null; eco_points: number; tier: string; created_at: string;
  face_enrolled?: boolean | null; face_consent_at?: string | null;
}

const COLS = "id,name,phone,email,address,ward,gov_id,eco_points,tier,created_at,face_enrolled,face_consent_at";
const PHONE_RE = /^\+?[0-9]{8,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function maskId(id: string | null) {
  if (!id) return "—";
  return id.length <= 4 ? "****" : `${"*".repeat(Math.max(0, id.length - 4))}${id.slice(-4)}`;
}

/** Citizen's own profile: view personal details and edit contact information. */
export function CitizenProfile() {
  const user = useEcoStore((s) => s.currentUser);
  const setCurrentUser = useEcoStore((s) => s.setCurrentUser);
  const [p, setP] = useState<Profile | null>(null);
  const [form, setForm] = useState({ phone: "", email: "", address: "", ward: "" });
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function load() {
    if (!user?.id) return;
    setLoading(true);
    const { data, error: e } = await supabase.from("citizens").select(COLS).eq("id", user.id).single();
    if (e) setError(errMsg(e, "Could not load your profile."));
    else {
      setP(data as Profile);
      setForm({ phone: data.phone ?? "", email: data.email ?? "", address: data.address ?? "", ward: data.ward ?? "" });
      // keep the header (points / tier) in sync with the database
      setCurrentUser({ ...user, eco_points: data.eco_points, tier: data.tier, phone: data.phone, email: data.email ?? undefined, ward: data.ward ?? undefined });
    }
    setLoading(false);
  }
  useEffect(() => { load(); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!p || !user) return;
    const phone = form.phone.replace(/[\s-]/g, "");
    const email = form.email.trim().toLowerCase();
    if (!PHONE_RE.test(phone)) { setError("Enter a valid phone number (8-15 digits, optional +country code)."); return; }
    if (!EMAIL_RE.test(email)) { setError("Enter a valid email address."); return; }
    setSaving(true); setError(""); setOk("");
    try {
      // uniqueness: phone and email identify an account
      const { data: clash, error: ce } = await supabase.from("citizens").select("id")
        .or(`phone.eq.${phone},email.eq.${email}`).neq("id", p.id).limit(1);
      if (ce) throw ce;
      if (clash && clash.length) throw new Error("That phone number or email is already used by another account.");

      const { data, error: ue } = await supabase.from("citizens")
        .update({ phone, email, address: form.address.trim() || null, ward: form.ward.trim() || null })
        .eq("id", p.id).select(COLS).single();
      if (ue) throw ue;
      setP(data as Profile);
      setCurrentUser({ ...user, phone: data.phone, email: data.email ?? undefined, ward: data.ward ?? undefined });
      setEditing(false);
      setOk(phone !== p.phone || email !== (p.email ?? "")
        ? "Profile updated. Use your new email and phone number the next time you log in."
        : "Profile updated.");
    } catch (e) {
      setError(errMsg(e, "Could not update your profile."));
    } finally { setSaving(false); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-eco-400 animate-spin" /></div>;
  if (!p) return <ErrorNote message={error || "Profile not found."} />;

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex justify-between gap-4 py-2 border-b border-white/5 text-sm">
      <span className="text-slate-400">{label}</span><span className="text-slate-200 text-right break-all">{value}</span>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      {ok && <p className="flex items-center gap-2 text-sm text-eco-300"><CheckCircle2 className="w-4 h-4" />{ok}</p>}

      <div className="glass-card p-6 space-y-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-eco-600/20 border border-eco-500/30 flex items-center justify-center">
            <UserCircle className="w-8 h-8 text-eco-400" />
          </div>
          <div className="flex-1">
            <h2 className="font-display text-xl font-bold text-slate-100">{p.name}</h2>
            <p className="text-xs text-slate-400">Citizen · Member since {formatDate(p.created_at)} · {p.eco_points} Eco-Points · {p.tier}</p>
          </div>
          {!editing && (
            <button onClick={() => { setEditing(true); setOk(""); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 text-sm text-slate-200 hover:bg-white/5">
              <Pencil className="w-4 h-4" /> Edit
            </button>
          )}
        </div>

        {!editing ? (
          <div>
            <Row label="Phone" value={p.phone} />
            <Row label="Email" value={p.email ?? "—"} />
            <Row label="Address" value={p.address ?? "—"} />
            <Row label="Ward / Area" value={p.ward ?? "—"} />
            <Row label="Govt ID" value={maskId(p.gov_id)} />
          </div>
        ) : (
          <div className="space-y-3">
            {([
              ["phone", "Phone (+91XXXXXXXXXX)", "tel"],
              ["email", "Email", "email"],
              ["address", "Residential address", "text"],
              ["ward", "Ward / Area", "text"],
            ] as const).map(([key, label, type]) => (
              <div key={key}>
                <label className="text-xs text-slate-400 block mb-1">{label}</label>
                <input type={type} className="input-civic" value={form[key]}
                       onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
              </div>
            ))}
            <p className="text-[11px] text-slate-500">Name and Govt ID can only be changed by the municipal office.</p>
            <div className="flex gap-2">
              <button onClick={save} disabled={saving} className="btn-eco flex-1 justify-center">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save changes
              </button>
              <button onClick={() => { setEditing(false); setError(""); setForm({ phone: p.phone, email: p.email ?? "", address: p.address ?? "", ward: p.ward ?? "" }); }}
                      className="flex items-center gap-1.5 px-4 rounded-xl border border-white/15 text-sm text-slate-300 hover:bg-white/5">
                <X className="w-4 h-4" /> Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="glass-card p-5 space-y-2">
        <p className="text-sm font-semibold text-slate-200 flex items-center gap-2"><ScanFace className="w-4 h-4 text-eco-400" /> Face enrollment</p>
        {p.face_enrolled ? (
          <p className="text-sm text-slate-300 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-eco-400" />
            Enrolled{p.face_consent_at ? ` with your consent on ${formatDate(p.face_consent_at)}` : ""}. Only a numeric face template is stored (not your photo); it is used by the AI camera to identify littering linked to your account.
          </p>
        ) : (
          <p className="text-sm text-orange-300">Not enrolled.</p>
        )}
      </div>
    </div>
  );
}
