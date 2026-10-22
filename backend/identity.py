"""
backend/identity.py — event-time identity pipeline
==================================================
Runs ONLY after the vision engine confirms a littering event (never per frame):

  head crops of the responsible person track
    -> InsightFace detection + quality gate (size, detector score, blur, pose)
    -> ArcFace 512-D embeddings (L2-normalised, averaged)
    -> pgvector top-2 candidates (SQL fn match_face_candidates)
    -> decision: MATCH / UNCERTAIN / NO_MATCH / NO_FACE   (never guesses)
    -> MATCH: idempotent violation insert + per-citizen notification (+ SMS if configured)
    -> otherwise: an "unidentified" record for admin review, NO citizen fine

All thresholds are env-configurable and should be tuned on real rehearsal footage.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np

from backend.security import send_sms, utcnow_iso

# ── Configuration ────────────────────────────────────────────────────────────
# Calibrated on this webcam: enrolled user vs. own evidence frame = 0.575 (2026-10-18 rehearsal);
# ArcFace (buffalo_l) different-person similarity is typically < 0.3. A clear margin over the
# runner-up is also required (FACE_MATCH_MARGIN), so 0.45 is not a loose match.
FACE_MATCH_THRESHOLD   = float(os.getenv("FACE_MATCH_THRESHOLD", "0.45"))   # cosine similarity for MATCH
FACE_REVIEW_THRESHOLD  = float(os.getenv("FACE_REVIEW_THRESHOLD", "0.32"))  # below this: NO_MATCH, between: UNCERTAIN
FACE_MATCH_MARGIN      = float(os.getenv("FACE_MATCH_MARGIN", "0.08"))      # top1 - top2 gap required
FACE_MIN_PX            = int(os.getenv("FACE_MIN_PX", "70"))                # min face width in pixels
FACE_MIN_DET_SCORE     = float(os.getenv("FACE_MIN_DET_SCORE", "0.60"))
FACE_MIN_BLUR_VAR      = float(os.getenv("FACE_MIN_BLUR_VAR", "25"))        # Laplacian variance of face region
FACE_MAX_YAW_DEG       = float(os.getenv("FACE_MAX_YAW_DEG", "50"))
FINE_AMOUNT            = float(os.getenv("LITTERING_FINE_AMOUNT", "500"))
PUBLIC_BACKEND_URL     = os.getenv("PUBLIC_BACKEND_URL", "http://localhost:8000")
CAMERA_SECTOR_ID       = os.getenv("CAMERA_SECTOR_ID", "")


@dataclass
class IdentityResult:
    status: str                       # MATCH | UNCERTAIN | NO_MATCH | NO_FACE | ERROR
    reason: str = ""
    citizen_id: Optional[str] = None
    citizen_name: Optional[str] = None
    similarity: Optional[float] = None
    runner_up: Optional[float] = None
    faces_used: int = 0
    crops_received: int = 0
    notes: List[str] = field(default_factory=list)


# ── Face quality + embedding ─────────────────────────────────────────────────

def _blur_score(img: np.ndarray, bbox) -> float:
    import cv2
    x1, y1, x2, y2 = [int(v) for v in bbox]
    h, w = img.shape[:2]
    roi = img[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
    if roi.size == 0:
        return 0.0
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (112, 112))   # normalise size so the score is comparable
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def embed_crop(b64: str, notes: Optional[List[str]] = None):
    """Returns (unit embedding, det_score) for the best usable face in the crop, else None."""
    from backend.routers.auth import _get_face_analyzer, _decode_b64_to_cv2
    fa = _get_face_analyzer()
    img = _decode_b64_to_cv2(b64)
    faces = fa.get(img)
    if not faces:
        if notes is not None: notes.append("no_face_detected")
        return None
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    width = float(face.bbox[2] - face.bbox[0])
    det = float(getattr(face, "det_score", 0.0))
    if width < FACE_MIN_PX:
        if notes is not None: notes.append(f"face_too_small({width:.0f}px)")
        return None
    if det < FACE_MIN_DET_SCORE:
        if notes is not None: notes.append(f"low_det_score({det:.2f})")
        return None
    pose = getattr(face, "pose", None)
    if pose is not None and len(pose) >= 2 and abs(float(pose[1])) > FACE_MAX_YAW_DEG:
        if notes is not None: notes.append(f"extreme_yaw({float(pose[1]):.0f}deg)")
        return None
    blur = _blur_score(img, face.bbox)
    if blur < FACE_MIN_BLUR_VAR:
        if notes is not None: notes.append(f"blurry({blur:.0f})")
        return None
    emb = face.embedding.astype(np.float32)
    emb = emb / (np.linalg.norm(emb) + 1e-9)
    return emb, det


def decide(candidates: List[Dict[str, Any]]) -> IdentityResult:
    """
    Pure decision function (unit-testable). `candidates` = [{id,name,similarity}, ...] best first.
    MATCH needs similarity >= threshold AND a margin over the runner-up (different person).
    """
    if not candidates:
        return IdentityResult(status="NO_MATCH", reason="no enrolled faces in database")
    top = candidates[0]
    sim = float(top["similarity"])
    runner = float(candidates[1]["similarity"]) if len(candidates) > 1 else None
    if sim >= FACE_MATCH_THRESHOLD and (runner is None or sim - runner >= FACE_MATCH_MARGIN):
        return IdentityResult(status="MATCH", reason="similarity above threshold with clear margin",
                              citizen_id=top["id"], citizen_name=top.get("name"),
                              similarity=sim, runner_up=runner)
    if sim >= FACE_REVIEW_THRESHOLD:
        why = ("margin to runner-up too small" if sim >= FACE_MATCH_THRESHOLD
               else "similarity between review and match thresholds")
        # never attach an uncertain identity to an account
        return IdentityResult(status="UNCERTAIN", reason=why, similarity=sim, runner_up=runner)
    return IdentityResult(status="NO_MATCH", reason="best similarity below review threshold",
                          similarity=sim, runner_up=runner)


def identify(sb, face_crops: List[str]) -> IdentityResult:
    """Blocking (CPU-bound) — call from a worker thread."""
    notes: List[str] = []
    n = len(face_crops or [])
    if n == 0:
        return IdentityResult(status="NO_FACE", reason="engine sent no head crops for this person", crops_received=0)
    try:
        embs, weights = [], []
        for crop in face_crops:
            try:
                res = embed_crop(crop, notes)
            except ImportError:
                return IdentityResult(status="ERROR", reason="FACE_MODEL_ERROR: insightface not installed", crops_received=n)
            if res is not None:
                embs.append(res[0]); weights.append(res[1])
        if not embs:
            status = "NO_FACE" if all(x.startswith("no_face") for x in notes) else "UNCERTAIN"
            return IdentityResult(status=status, reason="no crop passed the face-quality gate",
                                  crops_received=n, notes=notes)
        avg = np.average(np.stack(embs), axis=0, weights=weights)
        avg = avg / (np.linalg.norm(avg) + 1e-9)
        try:
            rpc = sb.rpc("match_face_candidates", {"query_embedding": avg.tolist(), "k": 2}).execute()
        except Exception as e:
            print(f"[Identity] PGVECTOR_ERROR: {e}")
            return IdentityResult(status="ERROR", reason="PGVECTOR_ERROR: could not query face database",
                                  faces_used=len(embs), crops_received=n, notes=notes)
        result = decide(rpc.data or [])
        result.faces_used, result.crops_received, result.notes = len(embs), n, notes
        return result
    except Exception as e:
        print(f"[Identity] FACE_MODEL_ERROR: {e}")
        return IdentityResult(status="ERROR", reason=f"FACE_MODEL_ERROR: {e}", crops_received=n, notes=notes)


# ── Awareness messages (a different one for each violation) ──────────────────
# Each message is two short points: why littering harms the city/environment + what to do.
AWARENESS_MESSAGES: List[str] = [
    "• A plastic bottle takes ~450 years to break down; littered plastic ends up in drains and lakes.\n"
    "• Please carry your waste to the nearest bin - clean streets start with you.",
    "• Litter blocks storm-water drains and causes flooding during the monsoon.\n"
    "• Hold on to your waste until you find a bin.",
    "• Dumped waste collects rainwater and breeds mosquitoes that spread dengue and malaria.\n"
    "• Keeping your street clean protects your family's health.",
    "• Plastic breaks into microplastics that end up in our water and food.\n"
    "• Choose reusable bottles and bags.",
    "• Stray animals and birds eat littered packaging and plastic, often fatally.\n"
    "• Dispose of food waste and wrappers properly.",
    "• Littered waste cannot be segregated or recycled, so it ends up in landfills.\n"
    "• Separate wet and dry waste and use the right bin.",
    "• Cleaning littered streets costs the city money that comes from your taxes.\n"
    "• Repeated violations are recorded on your civic profile.",
    "• Burnt or dumped garbage releases toxic gases that worsen the air we breathe.\n"
    "• Report illegal dumps on EcoWatch instead of adding to them.",
    "• Waste that reaches lakes kills fish and damages the whole ecosystem.\n"
    "• Every bottle in a bin is one less in a lake.",
    "• Litter on roads can cause accidents for two-wheelers and pedestrians.\n"
    "• Keep roads and footpaths free of waste.",
    "• A clean neighbourhood is healthier, safer and more welcoming for everyone.\n"
    "• Lead by example - others follow good habits.",
    "• You can earn Eco-Points by reporting dumps and keeping your area clean.\n"
    "• Use them to reduce fines or get rewards - instead of paying penalties.",
]


def pick_awareness_message(sb, citizen_id: str) -> str:
    """Rotate through the messages so a citizen never gets the same one as their recent fines."""
    used: List[str] = []
    try:
        rows = (sb.table("violations").select("awareness_message")
                .eq("citizen_id", citizen_id).order("created_at", desc=True)
                .limit(len(AWARENESS_MESSAGES)).execute().data) or []
        used = [r["awareness_message"] for r in rows if r.get("awareness_message")]
    except Exception as e:
        print(f"[Identity] could not read previous messages: {e}")
    start = len(used) % len(AWARENESS_MESSAGES)
    for i in range(len(AWARENESS_MESSAGES)):
        m = AWARENESS_MESSAGES[(start + i) % len(AWARENESS_MESSAGES)]
        if m not in used:
            return m
    return AWARENESS_MESSAGES[start]


# ── Violation creation (server-side, idempotent) ─────────────────────────────

def _nearest_sector(sb, lat: Optional[float], lng: Optional[float]) -> Optional[str]:
    if CAMERA_SECTOR_ID:
        return CAMERA_SECTOR_ID
    if lat is None or lng is None:
        return None
    try:
        rows = sb.table("sectors").select("id,lat,lng").eq("active", True).execute().data or []
        if not rows:
            return None
        return min(rows, key=lambda s: (s["lat"] - lat) ** 2 + (s["lng"] - lng) ** 2)["id"]
    except Exception as e:
        print(f"[Identity] sector lookup failed: {e}")
        return None


def record_event(sb, event: Dict[str, Any], result: IdentityResult) -> Dict[str, Any]:
    """
    Inserts the violation (or an unidentified review record). Idempotent on event_id.
    Returns {"violation": row, "created": bool, "notification": row|None}
    """
    event_id = event["event_id"]
    existing = sb.table("violations").select("*").eq("event_id", event_id).execute().data
    if existing:
        return {"violation": existing[0], "created": False, "notification": None}

    loc = event.get("location") or {}
    lat, lng = loc.get("latitude"), loc.get("longitude")
    try:
        lat = float(lat) if lat not in (None, "") else None
        lng = float(lng) if lng not in (None, "") else None
    except (TypeError, ValueError):
        lat = lng = None

    evidence_dir = event.get("evidence_dir")
    snapshot_url = f"{PUBLIC_BACKEND_URL}/evidence/{evidence_dir}/3_confirmed.jpg" if evidence_dir else None
    matched = result.status == "MATCH" and bool(result.citizen_id)
    row = {
        "citizen_id":       result.citizen_id if matched else None,
        "location_name":    loc.get("name"),
        "lat":              lat,
        "lng":              lng,
        "fine_amount":      FINE_AMOUNT if matched else 0,
        "status":           "Pending" if matched else "Unidentified",
        "snapshot_url":     snapshot_url,
        "confidence_score": round(float(event.get("event_confidence", 0)) * 100, 2),
        "timestamp":        event.get("timestamp") or utcnow_iso(),
        "event_id":         event_id,
        "camera_id":        event.get("camera_id"),
        "face_similarity":  round(result.similarity, 4) if result.similarity is not None else None,
        "evidence_path":    evidence_dir,
        "identity_status":  "MATCHED" if matched else result.status,
        "sector_id":        _nearest_sector(sb, lat, lng),
        "awareness_message": pick_awareness_message(sb, result.citizen_id) if matched else None,
    }
    try:
        ins = sb.table("violations").insert(row).execute()
    except Exception:
        # Unique-index race (engine retry / double delivery) -> already recorded.
        again = sb.table("violations").select("*").eq("event_id", event_id).execute().data
        if again:
            return {"violation": again[0], "created": False, "notification": None}
        raise
    violation = ins.data[0] if ins.data else row

    notification = _notify_violation(sb, violation, result.citizen_id, loc.get("name"),
                                     row.get("awareness_message")) if matched else None
    return {"violation": violation, "created": True, "notification": notification}


def _notify_violation(sb, violation: Dict[str, Any], citizen_id: str, place: Optional[str],
                      awareness: Optional[str]) -> Optional[Dict[str, Any]]:
    """The citizen's own alert for a fine (shown in their portal)."""
    try:
        vid = violation.get("id", "")
        msg = (f"A littering incident was detected involving your registered account at "
               f"{place or 'a monitored location'}. Fine: ₹{FINE_AMOUNT:.0f}. "
               f"Violation ID: VIO-{str(vid)[:6].upper()}. You can pay or dispute from your dashboard."
               + (f"\n\n{awareness}" if awareness else ""))
        note = {
            "user_id": citizen_id, "type": "VIOLATION",
            "title": "EcoWatch Violation", "message": msg,
            "violation_id": vid, "sms_status": "NOT_CONFIGURED",
        }
        return (sb.table("notifications").insert(note).execute().data or [note])[0]
    except Exception as e:
        print(f"[Identity] notification insert failed: {e}")
        return None


def reidentify(sb, violation_id: str, face_crops: List[str]) -> Dict[str, Any]:
    """
    Admin-requested retry of face identification for an UNIDENTIFIED event (e.g. the citizen
    enrolled later, or the earlier attempt failed). Same rules as live events: only a confident
    MATCH issues a fine; anything else just updates the recorded identity status.
    Blocking (CPU-bound) - call from a worker thread.
    """
    rows = sb.table("violations").select("*").eq("id", violation_id).execute().data
    if not rows:
        return {"ok": False, "error": "Violation not found."}
    v = rows[0]
    if v.get("status") != "Unidentified":
        return {"ok": False, "error": "Only unidentified events can be re-checked."}
    result = identify(sb, face_crops)
    if result.status == "ERROR":
        return {"ok": False, "error": result.reason}
    out = {"ok": True, "identity_status": result.status, "reason": result.reason,
           "similarity": result.similarity, "faces_used": result.faces_used, "notes": result.notes[:6]}
    if result.status == "MATCH" and result.citizen_id:
        awareness = pick_awareness_message(sb, result.citizen_id)
        upd = sb.table("violations").update({
            "citizen_id": result.citizen_id, "fine_amount": FINE_AMOUNT, "status": "Pending",
            "identity_status": "MATCHED", "face_similarity": round(result.similarity, 4),
            "awareness_message": awareness,
        }).eq("id", violation_id).eq("status", "Unidentified").execute().data
        if not upd:
            return {"ok": False, "error": "This event was changed by someone else meanwhile."}
        _notify_violation(sb, upd[0], result.citizen_id, v.get("location_name"), awareness)
        out.update({"fined": True, "citizen_name": result.citizen_name})
    else:
        sb.table("violations").update({
            "identity_status": result.status,
            "face_similarity": round(result.similarity, 4) if result.similarity is not None else None,
        }).eq("id", violation_id).eq("status", "Unidentified").execute()
        out["fined"] = False
    return out


async def send_violation_sms(sb, citizen_id: str, notification: Optional[dict]) -> str:
    """Real Twilio request; returns the actual status and records it on the notification."""
    if not (os.getenv("TWILIO_ACCOUNT_SID") and os.getenv("TWILIO_AUTH_TOKEN")):
        return "NOT_CONFIGURED"
    try:
        c = sb.table("citizens").select("phone").eq("id", citizen_id).execute().data
        phone = c[0]["phone"] if c else None
        if not phone or not notification:
            return "FAILED"
        ok = await send_sms(phone, notification["message"])
        status = "SENT" if ok else "FAILED"
        sb.table("notifications").update({"sms_status": status}).eq("id", notification["id"]).execute()
        return status
    except Exception as e:
        print(f"[Identity] SMS step failed: {e}")
        return "FAILED"
