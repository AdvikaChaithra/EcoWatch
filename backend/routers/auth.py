"""
backend/routers/auth.py — Production biometric authentication router.
Endpoints:
  POST /api/auth/extract-embedding  — decode base64 frame → 512-D ArcFace embedding
  POST /api/auth/register-face      — enroll citizen biometric (multiple frames averaged)
  POST /api/auth/otp/send           — 6-digit OTP via Twilio (or logged for dev)
  POST /api/auth/otp/verify         — verify OTP, return citizen profile
  POST /api/auth/admin/login        — email + password + optional TOTP
  POST /api/auth/worker/login       — employee_id + 4-digit PIN
"""

import os
import base64
import secrets
import numpy as np
from typing import Optional
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from backend.models import (
    FaceRegisterRequest,
    WorkerLoginRequest, AdminLoginRequest,
    OTPRequest, OTPVerify,
)
from backend.database import db
from backend.security import utcnow, utcnow_iso, safe_equal, verify_secret, send_sms

router = APIRouter(prefix="/api/auth", tags=["auth"])

# In-memory OTP store (production: use Redis + TTL)
_otp_store: dict[str, dict] = {}
_OTP_MAX_ATTEMPTS = 5
_OTP_RESEND_SECONDS = 30

# ── Shared: lazy-load InsightFace (heavy model, load once) ────────────────────
_face_analyzer = None

def _get_face_analyzer():
    global _face_analyzer
    if _face_analyzer is None:
        from insightface.app import FaceAnalysis
        _face_analyzer = FaceAnalysis(
            name="buffalo_l",
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        _face_analyzer.prepare(ctx_id=0, det_size=(640, 640))
    return _face_analyzer


def _decode_b64_to_cv2(b64_string: str):
    """Decode a base64 image string (with or without data: prefix) to OpenCV BGR array."""
    import cv2
    try:
        raw = base64.b64decode(b64_string.split(",")[-1], validate=True)
    except Exception:
        raise ValueError("Image is not valid base64.")
    nparr = np.frombuffer(raw, np.uint8)
    img   = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image from base64. Check image format.")
    return img


# ─── NEW: Extract Embedding ──────────────────────────────────────────────────
# THIS is the missing endpoint called by Next.js register-face route and
# /api/auth/register-face routes.

@router.post("/extract-embedding")
async def extract_embedding(body: dict):
    """
    Accepts { "image_base64": "<data:image/jpeg;base64,...>" }
    Returns  { "success": True, "embedding": [512 floats] }

    This is the bridge between Next.js API routes and the InsightFace model.
    Called by:
      - /api/auth/register-face (Next.js route.ts)
    """
    image_b64 = body.get("image_base64", "")
    if not image_b64:
        raise HTTPException(status_code=400, detail="image_base64 field is required.")

    try:
        # Same model + quality gate as camera-time recognition (consistent enrollment/recognition).
        from backend.identity import embed_crop
        notes: list = []
        res = embed_crop(image_b64, notes)
        if res is None:
            reasons = {
                "no_face_detected": "No face detected. Face the camera in good lighting.",
            }
            first = notes[0] if notes else "no_face_detected"
            msg = reasons.get(first, f"Face quality too low ({first}). Move closer, face the camera, improve lighting and hold still.")
            raise HTTPException(status_code=422, detail=msg)
        emb, _det = res
        return {"success": True, "embedding": emb.tolist()}

    except HTTPException:
        raise
    except ImportError:
        raise HTTPException(status_code=503, detail="InsightFace not installed. Run: pip install insightface onnxruntime")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"[Auth] extract-embedding failed: {e}")
        raise HTTPException(status_code=500, detail="Face processing failed")


# ─── Citizen: Face Registration ───────────────────────────────────────────────

@router.post("/register-face")
async def register_face(
    payload: FaceRegisterRequest,
    sb: Client = Depends(db),
):
    """
    Receives up to 3 base64 webcam frames.
    Runs InsightFace ArcFace to extract 512-D embeddings,
    averages them, and stores in citizens.face_embedding (pgvector).
    """
    try:
        fa = _get_face_analyzer()

        embeddings = []
        for b64 in payload.frames[:3]:
            try:
                img   = _decode_b64_to_cv2(b64)
                faces = fa.get(img)
                if faces:
                    emb = faces[0].embedding.astype(np.float32)
                    emb = emb / (np.linalg.norm(emb) + 1e-9)
                    embeddings.append(emb)
            except Exception:
                continue  # skip bad frames

        if not embeddings:
            raise HTTPException(status_code=422, detail="No face detected in any frame. Ensure good lighting.")

        avg = np.mean(embeddings, axis=0)
        avg = avg / (np.linalg.norm(avg) + 1e-9)

        upd = sb.table("citizens").update({"face_embedding": avg.tolist()}).eq("id", payload.citizen_id).execute()
        if not upd.data:
            raise HTTPException(status_code=404, detail="Citizen not found")
        return {
            "success": True,
            "message": f"512-D ArcFace embedding enrolled ({len(embeddings)} frames averaged)",
        }

    except HTTPException:
        raise
    except ImportError:
        raise HTTPException(status_code=503, detail="InsightFace not installed on this server.")
    except Exception as e:
        print(f"[Auth] register-face failed: {e}")
        raise HTTPException(status_code=500, detail="Face enrollment failed")


# ─── Citizen: OTP ─────────────────────────────────────────────────────────────

def _prune_otps():
    now = utcnow()
    for k in [k for k, v in _otp_store.items() if v["expiry"] < now]:
        _otp_store.pop(k, None)


@router.post("/otp/send")
async def send_otp(payload: OTPRequest, sb: Client = Depends(db)):
    """Generate 6-digit OTP, store temporarily, dispatch via Twilio SMS."""
    _prune_otps()
    existing = _otp_store.get(payload.phone)
    if existing and (utcnow() - existing["sent_at"]).total_seconds() < _OTP_RESEND_SECONDS:
        raise HTTPException(status_code=429, detail="Please wait before requesting another OTP")

    try:
        res = sb.table("citizens").select("id, name").eq("phone", payload.phone).execute()
    except Exception as e:
        print(f"[Auth] OTP citizen lookup failed: {e}")
        raise HTTPException(status_code=502, detail="Database error. Please try again.")
    if not res.data:
        raise HTTPException(status_code=404, detail="No citizen registered with this phone number")

    otp = f"{secrets.randbelow(900000) + 100000}"
    now = utcnow()
    _otp_store[payload.phone] = {"otp": otp, "expiry": now + timedelta(minutes=10), "sent_at": now, "attempts": 0}

    twilio_configured = bool(os.getenv("TWILIO_ACCOUNT_SID") and os.getenv("TWILIO_AUTH_TOKEN"))
    if twilio_configured:
        sent = await send_sms(payload.phone, f"EcoWatch OTP: {otp}. Valid for 10 minutes. Do not share.")
        if not sent:
            _otp_store.pop(payload.phone, None)
            raise HTTPException(status_code=502, detail="Could not send the OTP SMS. Please try again.")
    else:
        # Dev only: OTPs are never logged when Twilio is configured.
        print(f"[OTP][DEV] {payload.phone} -> {otp}  (Twilio not configured)")

    return {"success": True, "message": "OTP dispatched"}


@router.post("/otp/verify")
async def verify_otp(payload: OTPVerify, sb: Client = Depends(db)):
    entry = _otp_store.get(payload.phone)
    if not entry:
        raise HTTPException(status_code=400, detail="OTP not found or already used")
    if utcnow() > entry["expiry"]:
        _otp_store.pop(payload.phone, None)
        raise HTTPException(status_code=400, detail="OTP expired")
    entry["attempts"] += 1
    if entry["attempts"] > _OTP_MAX_ATTEMPTS:
        _otp_store.pop(payload.phone, None)
        raise HTTPException(status_code=429, detail="Too many incorrect attempts. Request a new OTP.")
    if not safe_equal(payload.otp, entry["otp"]):
        raise HTTPException(status_code=401, detail="Incorrect OTP")

    _otp_store.pop(payload.phone, None)
    try:
        res = sb.table("citizens").select("id,name,phone,email,address,ward,eco_points,tier,created_at").eq("phone", payload.phone).execute()
    except Exception as e:
        print(f"[Auth] OTP verify lookup failed: {e}")
        raise HTTPException(status_code=502, detail="Database error. Please try again.")
    if not res.data:
        raise HTTPException(status_code=404, detail="Citizen no longer exists")
    return {"success": True, "citizen": res.data[0]}


# ─── Admin: Email + TOTP ──────────────────────────────────────────────────────

@router.post("/admin/login")
async def admin_login(payload: AdminLoginRequest, sb: Client = Depends(db)):
    try:
        res = sb.table("admins").select("*").eq("email", payload.email.strip()).execute()
    except Exception as e:
        print(f"[Auth] admin lookup failed: {e}")
        raise HTTPException(status_code=502, detail="Database error. Please try again.")

    admin = res.data[0] if res.data else None
    # Same message for unknown email and wrong password (no account enumeration).
    if not admin or not verify_secret(payload.password, admin.get("password_hash")):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    secret = admin.get("totp_secret")
    if secret:
        if not payload.totp_code:
            raise HTTPException(status_code=401, detail="2FA code required")
        try:
            import pyotp
        except ImportError:
            raise HTTPException(status_code=503, detail="2FA is enabled but pyotp is not installed on the server")
        if not pyotp.TOTP(secret).verify(payload.totp_code, valid_window=1):
            raise HTTPException(status_code=401, detail="Invalid 2FA code")
    elif os.getenv("REQUIRE_2FA", "").lower() == "true":
        raise HTTPException(status_code=403, detail="2FA is required but not enrolled for this account")

    return {"success": True, "admin": {k: v for k, v in admin.items() if k not in ("password_hash", "totp_secret")}}


# ─── Worker: PIN Login ────────────────────────────────────────────────────────

@router.post("/worker/login")
async def worker_login(payload: WorkerLoginRequest, sb: Client = Depends(db)):
    try:
        res = sb.table("workers").select("*").eq("employee_id", payload.employee_id.strip()).execute()
    except Exception as e:
        print(f"[Auth] worker lookup failed: {e}")
        raise HTTPException(status_code=502, detail="Database error. Please try again.")
    worker = res.data[0] if res.data else None
    if not worker or not verify_secret(payload.pin, worker.get("pin_hash")):
        raise HTTPException(status_code=401, detail="Invalid employee ID or PIN")
    if not worker.get("active", True):
        raise HTTPException(status_code=403, detail="Worker account is deactivated")

    try:
        sb.table("workers").update({"status": "On Duty", "updated_at": utcnow_iso()}).eq("id", worker["id"]).execute()
    except Exception as e:
        print(f"[Auth] could not set worker On Duty: {e}")
        raise HTTPException(status_code=502, detail="Login succeeded but shift status could not be updated. Try again.")

    return {"success": True, "worker": {k: v for k, v in worker.items() if k != "pin_hash"}}
