"""
backend/routers/auth.py — Production biometric authentication router.
Endpoints:
  POST /api/auth/extract-embedding  — decode base64 frame → 512-D ArcFace embedding
  POST /api/auth/register-face      — enroll citizen biometric (multiple frames averaged)
  POST /api/auth/face-login         — webcam snapshot → match_citizen_face RPC
  POST /api/auth/otp/send           — 6-digit OTP via Twilio (or logged for dev)
  POST /api/auth/otp/verify         — verify OTP, return citizen profile
  POST /api/auth/admin/login        — email + password + optional TOTP
  POST /api/auth/worker/login       — employee_id + 4-digit PIN
"""

import os
import base64
import random
import hashlib
import numpy as np
from typing import Optional
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from backend.models import (
    FaceRegisterRequest, FaceLoginRequest,
    WorkerLoginRequest, AdminLoginRequest,
    OTPRequest, OTPVerify,
)
from backend.database import get_supabase

router = APIRouter(prefix="/api/auth", tags=["auth"])

# In-memory OTP store (production: use Redis + TTL)
_otp_store: dict[str, tuple[str, datetime]] = {}

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
    raw   = base64.b64decode(b64_string.split(",")[-1])
    nparr = np.frombuffer(raw, np.uint8)
    img   = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image from base64. Check image format.")
    return img


# ─── NEW: Extract Embedding ──────────────────────────────────────────────────
# THIS is the missing endpoint called by Next.js /api/auth/face-login and
# /api/auth/register-face routes.

@router.post("/extract-embedding")
async def extract_embedding(body: dict):
    """
    Accepts { "image_base64": "<data:image/jpeg;base64,...>" }
    Returns  { "success": True, "embedding": [512 floats] }

    This is the bridge between Next.js API routes and the InsightFace model.
    Called by:
      - /api/auth/face-login   (Next.js route.ts)
      - /api/auth/register-face (Next.js route.ts)
    """
    image_b64 = body.get("image_base64", "")
    if not image_b64:
        raise HTTPException(status_code=400, detail="image_base64 field is required.")

    try:
        fa  = _get_face_analyzer()
        img = _decode_b64_to_cv2(image_b64)

        faces = fa.get(img)
        if not faces:
            return {"success": False, "error": "No face detected. Ensure good lighting and face is centered."}

        # Normalize to unit vector (cosine similarity compatible)
        emb = faces[0].embedding.astype(np.float32)
        emb = emb / (np.linalg.norm(emb) + 1e-9)

        return {"success": True, "embedding": emb.tolist()}

    except ImportError:
        return {"success": False, "error": "InsightFace not installed. Run: pip install insightface onnxruntime"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ─── Citizen: Face Registration ───────────────────────────────────────────────

@router.post("/register-face")
async def register_face(
    payload: FaceRegisterRequest,
    sb: Client = Depends(get_supabase),
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
            return {"success": False, "message": "No face detected in any frame. Ensure good lighting."}

        avg = np.mean(embeddings, axis=0)
        avg = avg / (np.linalg.norm(avg) + 1e-9)

        sb.table("citizens").update({"face_embedding": avg.tolist()}).eq("id", payload.citizen_id).execute()
        return {
            "success": True,
            "message": f"512-D ArcFace embedding enrolled ({len(embeddings)} frames averaged)",
        }

    except ImportError:
        return {"success": False, "message": "InsightFace not installed on this server."}
    except Exception as e:
        return {"success": False, "message": str(e)}


# ─── Citizen: Face Login ──────────────────────────────────────────────────────

@router.post("/face-login")
async def face_login(
    payload: FaceLoginRequest,
    sb: Client = Depends(get_supabase),
):
    """
    Extracts 512-D embedding from a single webcam frame,
    then calls Supabase RPC `match_citizen_face` (pgvector cosine similarity).
    Returns matched citizen profile if similarity >= 0.70.
    """
    try:
        fa  = _get_face_analyzer()
        img = _decode_b64_to_cv2(payload.frame)

        faces = fa.get(img)
        if not faces:
            raise HTTPException(status_code=400, detail="No face detected in frame. Try better lighting.")

        emb = faces[0].embedding.astype(np.float32)
        emb = emb / (np.linalg.norm(emb) + 1e-9)

        # ── Call Supabase pgvector RPC ────────────────────────────────────────
        result = sb.rpc("match_citizen_face", {
            "query_embedding": emb.tolist(),
            "match_threshold": 0.70,
            "match_count":     1,
        }).execute()

        if not result.data:
            raise HTTPException(
                status_code=401,
                detail="Face not recognized (similarity < 0.70). Please register or use OTP login.",
            )

        citizen = result.data[0]
        return {
            "citizen":    citizen,
            "confidence": round(float(citizen.get("similarity", 0.9)) * 100, 2),
        }

    except HTTPException:
        raise
    except ImportError:
        raise HTTPException(status_code=503, detail="InsightFace not installed on server.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Citizen: OTP ─────────────────────────────────────────────────────────────

@router.post("/otp/send")
async def send_otp(payload: OTPRequest, sb: Client = Depends(get_supabase)):
    """Generate 6-digit OTP, store temporarily, dispatch via Twilio SMS."""
    res = sb.table("citizens").select("id, name").eq("phone", payload.phone).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="No citizen registered with this phone number")

    otp = str(random.randint(100000, 999999))
    _otp_store[payload.phone] = (otp, datetime.utcnow() + timedelta(minutes=10))

    twilio_sid   = os.getenv("TWILIO_ACCOUNT_SID", "")
    twilio_token = os.getenv("TWILIO_AUTH_TOKEN", "")
    if twilio_sid and twilio_token:
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{twilio_sid}/Messages.json",
                    auth=(twilio_sid, twilio_token),
                    data={
                        "From": os.getenv("TWILIO_FROM_NUMBER"),
                        "To":   payload.phone,
                        "Body": f"EcoWatch OTP: {otp}. Valid for 10 minutes. Do not share.",
                    },
                )
        except Exception as e:
            print(f"[Twilio] SMS failed: {e}")
    else:
        print(f"[OTP][DEV] {payload.phone} → {otp}  (Twilio not configured)")

    return {"success": True, "message": "OTP dispatched"}


@router.post("/otp/verify")
async def verify_otp(payload: OTPVerify, sb: Client = Depends(get_supabase)):
    stored = _otp_store.get(payload.phone)
    if not stored:
        raise HTTPException(status_code=400, detail="OTP not found or already used")
    code, expiry = stored
    if datetime.utcnow() > expiry:
        del _otp_store[payload.phone]
        raise HTTPException(status_code=400, detail="OTP expired")
    if payload.otp != code:
        raise HTTPException(status_code=401, detail="Incorrect OTP")

    del _otp_store[payload.phone]
    res = sb.table("citizens").select("*").eq("phone", payload.phone).execute()
    return {"success": True, "citizen": res.data[0] if res.data else None}


# ─── Admin: Email + TOTP ──────────────────────────────────────────────────────

@router.post("/admin/login")
async def admin_login(payload: AdminLoginRequest, sb: Client = Depends(get_supabase)):
    res = sb.table("admins").select("*").eq("email", payload.email).execute()
    if not res.data:
        raise HTTPException(status_code=401, detail="Admin not found")

    admin = res.data[0]
    # Plain-text for demo (schema seeds password_hash = 'admin123')
    if admin.get("password_hash", "") != payload.password:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Optional TOTP
    if admin.get("totp_secret") and payload.totp_code:
        try:
            import pyotp
            totp = pyotp.TOTP(admin["totp_secret"])
            if not totp.verify(payload.totp_code, valid_window=1):
                raise HTTPException(status_code=401, detail="Invalid 2FA code")
        except ImportError:
            pass  # pyotp not installed — skip TOTP in dev

    return {"success": True, "admin": {k: v for k, v in admin.items() if k != "password_hash"}}


# ─── Worker: PIN Login ────────────────────────────────────────────────────────

@router.post("/worker/login")
async def worker_login(payload: WorkerLoginRequest, sb: Client = Depends(get_supabase)):
    res = sb.table("workers").select("*").eq("employee_id", payload.employee_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Worker ID not found")

    worker = res.data[0]
    if not worker.get("active", True):
        raise HTTPException(status_code=403, detail="Worker account is deactivated")
    if worker.get("pin_hash", "") != payload.pin:
        raise HTTPException(status_code=401, detail="Incorrect PIN")

    sb.table("workers").update({
        "status":     "On Duty",
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", worker["id"]).execute()

    return {"success": True, "worker": {k: v for k, v in worker.items() if k != "pin_hash"}}
