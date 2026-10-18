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
FACE_MATCH_THRESHOLD   = float(os.getenv("FACE_MATCH_THRESHOLD", "0.50"))   # cosine similarity for MATCH
FACE_REVIEW_THRESHOLD  = float(os.getenv("FACE_REVIEW_THRESHOLD", "0.38"))  # below this: NO_MATCH, between: UNCERTAIN
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


# ── Violation creation (server-side, idempotent) ─────────────────────────────

def _nearest_sector(sb, lat: Optional[float], lng: Optional[float]) -> Optional[str]:
    if CAMERA_SECTOR_ID:
        return CAMERA_SECTOR_ID
    if lat is None or lng is None:
        return None
    try:
        rows = sb.table("sectors").select("id,lat,lng").execute().data or []
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

    notification = None
    if matched:
        try:
            vid = violation.get("id", "")
            msg = (f"A littering incident was detected involving your registered account at "
                   f"{loc.get('name') or 'a monitored location'}. Fine: ₹{FINE_AMOUNT:.0f}. "
                   f"Violation ID: VIO-{str(vid)[:6].upper()}. You can pay or dispute from your dashboard.")
            note = {
                "user_id": result.citizen_id, "type": "VIOLATION",
                "title": "EcoWatch Violation", "message": msg,
                "violation_id": vid, "sms_status": "NOT_CONFIGURED",
            }
            notification = (sb.table("notifications").insert(note).execute().data or [note])[0]
        except Exception as e:
            print(f"[Identity] notification insert failed: {e}")
    return {"violation": violation, "created": True, "notification": notification}


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
