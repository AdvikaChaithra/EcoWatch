"""
backend/routers/auth.py - biometric helper used by the website.
Endpoint:
  POST /api/auth/extract-embedding  - decode base64 frame -> 512-D ArcFace embedding

Logins, face enrollment (with duplicate-face check) and credential changes live in the
Next.js server routes (app/api/auth/*), which call extract-embedding. The old backend
login/OTP/register-face routes were removed: unused, and they bypassed those checks.
"""

import os
import base64
import numpy as np

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ── Shared: lazy-load InsightFace (heavy model, load once) ────────────────────
_face_analyzer = None

def _get_face_analyzer():
    global _face_analyzer
    if _face_analyzer is None:
        from insightface.app import FaceAnalysis
        # Only the models we use: detection, ArcFace recognition, and 3D landmarks (head pose for
        # the quality gate). Skipping genderage + 2d106 landmarks roughly halves CPU time.
        _face_analyzer = FaceAnalysis(
            name="buffalo_l",
            allowed_modules=["detection", "recognition", "landmark_3d_68"],
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
