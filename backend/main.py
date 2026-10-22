"""
EcoWatch FastAPI — main.py  (v5)
  - Static /evidence/ route: serves evidence frames + event.json written by EvidenceWriter (item 2)
  - /api/vision/pipeline_state endpoint (A9)
  - All ENGINE_API_KEY + SMS_API_KEY guards (A10)
  - Explicit CORS from ALLOWED_ORIGINS env var (A10)
  - No duplicate routes
"""
from pathlib import Path
import asyncio
import base64
from typing import Optional
import logging
import os
import json
import threading
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.database import get_supabase, get_ws_manager
from backend.security import safe_equal, send_sms
from backend.models import VisionStatus, NodeHealth, LitteringEventPayload
from backend.routers import auth, violations, reports, workers
from backend import identity
from backend import camera_location
from backend.security import utcnow_iso

app = FastAPI(title="EcoWatch API", version="5.0.0", docs_url="/api/docs")


class _QuietHeartbeat(logging.Filter):
    """The engine posts telemetry/pipeline state several times a second; keep those
    out of the access log so real requests (events, logins, reports) stay readable."""
    def filter(self, record: logging.LogRecord) -> bool:
        return "/api/vision/" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_QuietHeartbeat())

# Serve evidence frames + event.json written by EvidenceWriter (item 2)
_EVIDENCE_DIR = Path(os.getenv("EVIDENCE_DIR", "evidence_snapshots"))
_EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/evidence", StaticFiles(directory=str(_EVIDENCE_DIR)), name="evidence")

# A10: explicit CORS origins — never "*" in production
_raw_origins = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000",
)
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(violations.router)
app.include_router(reports.router)
app.include_router(workers.router)

# A10: Engine API key for all vision/* endpoints
_ENGINE_KEY = os.getenv("ENGINE_API_KEY", "")

def _verify_engine_key(x_engine_api_key: str = Header(default="")):
    if _ENGINE_KEY and not safe_equal(x_engine_api_key, _ENGINE_KEY):
        raise HTTPException(status_code=403, detail="Invalid ENGINE_API_KEY")


if not _ENGINE_KEY:
    print("[EcoWatch] WARNING: ENGINE_API_KEY is not set - vision endpoints are unauthenticated (dev only).")


@app.on_event("startup")
async def _preload_face_model():
    def _load():
        try:
            from backend.routers.auth import _get_face_analyzer
            _get_face_analyzer()
            print("[Face] ArcFace model ready")
        except Exception as e:
            print(f"[Face] FACE_MODEL_ERROR: {e}")
    threading.Thread(target=_load, daemon=True, name="face-preload").start()


# ─── WebSocket ────────────────────────────────────────────────────────────────

_WS_MAX_MSG = 4096


@app.websocket("/ws")
@app.websocket("/ws/alerts")
async def websocket_endpoint(ws: WebSocket):
    manager = get_ws_manager()
    await manager.connect(ws)
    try:
        while True:
            data = await ws.receive_text()
            if len(data) > _WS_MAX_MSG:
                continue
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "ping":
                await ws.send_json({"type": "pong", "connections": manager.connection_count})
            elif msg.get("type") == "worker_location":
                # Relay only whitelisted, well-typed fields — clients can't inject arbitrary payloads.
                try:
                    await manager.broadcast({
                        "type":      "worker_location",
                        "worker_id": str(msg["worker_id"])[:64],
                        "lat":       float(msg["lat"]),
                        "lng":       float(msg["lng"]),
                        "name":      str(msg.get("name", ""))[:64],
                        "ward":      str(msg.get("ward", ""))[:64],
                    })
                except (KeyError, TypeError, ValueError):
                    pass
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] connection error: {e}")
    finally:
        manager.disconnect(ws)


# ─── Vision Engine Endpoints (A10: ENGINE_API_KEY protected) ─────────────────

@app.post("/api/vision/status")
async def vision_status(payload: VisionStatus,
                         x_engine_api_key: str = Header(default="")):
    _verify_engine_key(x_engine_api_key)
    manager = get_ws_manager()
    await manager.broadcast({
        "type":      "boot_status",
        "stage":     payload.stage,
        "message":   payload.message,
        "error":     payload.error,
        "camera_id": payload.camera_id,
    })
    return {"ok": True}


@app.post("/api/vision/telemetry")
async def vision_telemetry(payload: NodeHealth,
                            x_engine_api_key: str = Header(default="")):
    _verify_engine_key(x_engine_api_key)
    manager = get_ws_manager()
    await manager.broadcast(payload.model_dump())
    return {"ok": True}


@app.post("/api/vision/pipeline_state")
async def vision_pipeline_state(body: dict,
                                  x_engine_api_key: str = Header(default="")):
    """A9: small pipeline state (<5 Hz from engine). No images. Broadcast to WS."""
    _verify_engine_key(x_engine_api_key)
    manager = get_ws_manager()
    await manager.broadcast(body)
    return {"ok": True}


_inflight_events: set = set()


def _mask_name(name: str | None) -> str | None:
    """Global WebSocket clients only ever see a masked name (e.g. 'R*** S***')."""
    if not name:
        return None
    return " ".join(w[0] + "***" if len(w) > 1 else w for w in name.split())


async def _process_identity(event: dict, crops: list):
    """Background: face identification -> violation -> notification. Never blocks the camera."""
    manager = get_ws_manager()
    event_id = event["event_id"]
    base = {"type": "identity_result", "event_id": event_id, "camera_id": event.get("camera_id")}
    try:
        try:
            sb = get_supabase()
        except RuntimeError as e:
            print(e)
            await manager.broadcast({**base, "identity_status": "ERROR", "reason": "DATABASE_ERROR: Supabase not configured"})
            return

        result = await asyncio.to_thread(identity.identify, sb, crops)
        out = {**base, "identity_status": result.status, "reason": result.reason,
               "similarity": result.similarity, "runner_up": result.runner_up,
               "faces_used": result.faces_used, "crops_received": result.crops_received,
               "notes": result.notes, "citizen_name": _mask_name(result.citizen_name)}

        if result.status == "ERROR":
            print(f"[Identity] {event_id[:8]}: {result.reason}")
            await manager.broadcast(out)
            return

        try:
            rec = await asyncio.to_thread(identity.record_event, sb, event, result)
        except Exception as e:
            print(f"[Identity] DATABASE_ERROR recording {event_id[:8]}: {e}")
            await manager.broadcast({**out, "identity_status": "ERROR", "reason": "DATABASE_ERROR: could not save violation"})
            return

        v = rec["violation"] or {}
        out["violation_id"] = v.get("id")
        out["violation_created"] = rec["created"]
        out["fine_amount"] = v.get("fine_amount")
        if rec["created"] and result.status == "MATCH":
            out["sms_status"] = await identity.send_violation_sms(sb, result.citizen_id, rec["notification"])
        await manager.broadcast(out)
        print(f"[Identity] {event_id[:8]} -> {result.status} sim={result.similarity} "
              f"violation={v.get('id')} created={rec['created']}")
    except Exception as e:
        print(f"[Identity] unexpected error for {event_id[:8]}: {e}")
        await manager.broadcast({**base, "identity_status": "ERROR", "reason": f"FACE_MODEL_ERROR: {e}"})
    finally:
        _inflight_events.discard(event_id)


def _evidence_folder(evidence_dir) -> Optional[Path]:
    """evidence_snapshots/<id> for a bare id or a path ending in it; None if unsafe/missing."""
    if not evidence_dir:
        return None
    name = Path(str(evidence_dir).replace("\\", "/")).name
    if not name or name in (".", "..") or not all(ch.isalnum() or ch in "-_" for ch in name):
        return None
    return _EVIDENCE_DIR / name


def _save_face_crops(evidence_dir, crops: list) -> None:
    """Keep the head crops with the event's evidence so identification can be retried later."""
    folder = _evidence_folder(evidence_dir)
    if folder is None or not crops:
        return
    try:
        folder.mkdir(parents=True, exist_ok=True)
        for i, c in enumerate(crops[:8], 1):
            raw = c.split(",", 1)[1] if isinstance(c, str) and c.startswith("data:") else c
            (folder / f"face_{i}.jpg").write_bytes(base64.b64decode(raw))
    except Exception as e:
        print(f"[Evidence] could not save face crops: {e}")


def _load_identity_images(evidence_dir) -> list:
    """Saved head crops, or the event's key frames for older events recorded without crops."""
    folder = _evidence_folder(evidence_dir)
    if folder is None or not folder.is_dir():
        return []
    files = sorted(folder.glob("face_*.jpg")) or [folder / n for n in ("1_assoc.jpg", "2_drop.jpg", "3_confirmed.jpg")
                                                  if (folder / n).exists()]
    return [base64.b64encode(f.read_bytes()).decode() for f in files]


@app.post("/api/violations/{violation_id}/reidentify")
async def reidentify_violation(violation_id: str, x_engine_api_key: str = Header(default="")):
    """Admin retry (via the website's server route) of face identification for an unidentified event."""
    _verify_engine_key(x_engine_api_key)
    try:
        sb = get_supabase()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    row = (sb.table("violations").select("evidence_path").eq("id", violation_id).execute().data or [None])[0]
    if row is None:
        raise HTTPException(status_code=404, detail="Violation not found")
    images = _load_identity_images(row.get("evidence_path"))
    if not images:
        raise HTTPException(status_code=422, detail="No evidence images are stored for this event.")
    out = await asyncio.to_thread(identity.reidentify, sb, violation_id, images)
    if not out.get("ok"):
        raise HTTPException(status_code=409, detail=out.get("error", "Could not re-check this event."))
    return out


@app.post("/api/littering_event")
async def littering_event(payload: LitteringEventPayload,
                           x_engine_api_key: str = Header(default="")):
    """
    Confirmed littering event from the vision engine.
    1) broadcast immediately (identity_status=PENDING, no images over WS)
    2) identify the person in the background (face crops -> pgvector) and create the violation.
    """
    _verify_engine_key(x_engine_api_key)
    manager = get_ws_manager()
    event_dict = payload.model_dump()
    # The incident location is the camera's registered REAL location (set from device GPS).
    loc = camera_location.get_location()
    if loc.get("latitude") is not None:
        event_dict["location"] = {"name": loc.get("name") or event_dict["location"].get("name"),
                                  "latitude": loc["latitude"], "longitude": loc["longitude"],
                                  "ward": loc.get("ward", "")}
    crops = event_dict.pop("face_crops", None) or []
    event_dict.pop("snapshot_b64", None)   # never relay images over WS (A9)
    _save_face_crops(event_dict.get("evidence_dir"), crops)
    await manager.broadcast(event_dict)

    # Engine retries / duplicates: process each event_id once.
    if payload.event_id in _inflight_events:
        return {"ok": True, "event_id": payload.event_id, "duplicate": True}
    _inflight_events.add(payload.event_id)
    asyncio.create_task(_process_identity(event_dict, crops))
    return {"ok": True, "event_id": payload.event_id}


@app.get("/api/camera/config")
async def camera_config():
    """Camera metadata for the UI. Location = registered real location (device GPS) or .env."""
    loc = camera_location.get_location()
    return {
        "camera_id":     os.getenv("CAMERA_ID", "CAM_01"),
        "camera_name":   os.getenv("CAMERA_NAME", "EcoWatch Test Camera"),
        "latitude":      "" if loc.get("latitude") is None else str(loc["latitude"]),
        "longitude":     "" if loc.get("longitude") is None else str(loc["longitude"]),
        "location_name": loc.get("name", ""),
        "ward":          loc.get("ward", ""),
        "accuracy_m":    loc.get("accuracy_m"),
        "location_source": loc.get("source"),
        "mjpeg_url":     os.getenv("MJPEG_PUBLIC_URL") or f"http://localhost:{os.getenv('MJPEG_PORT','8001')}/stream.mjpg",
    }


@app.post("/api/camera/location")
async def set_camera_location(body: dict):
    """Register the camera's real location (sent from the surveillance page using device GPS)."""
    try:
        lat = float(body["latitude"]); lng = float(body["longitude"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="latitude and longitude are required numbers")
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise HTTPException(status_code=400, detail="latitude/longitude out of range")
    name = str(body.get("name") or f"{lat:.5f}, {lng:.5f}")
    acc = body.get("accuracy_m")
    saved = camera_location.set_location(name, lat, lng, str(body.get("ward") or ""),
                                         float(acc) if acc is not None else None, utcnow_iso())
    print(f"[Camera] location registered: {saved['name']} ({lat:.6f}, {lng:.6f}) +/-{saved['accuracy_m']}m")
    return saved


# ─── Civic Index ─────────────────────────────────────────────────────────────

@app.get("/api/civic-index")
async def civic_index():
    sb = get_supabase()
    manager = get_ws_manager()
    try:
        active  = sb.table("dump_reports").select("*", count="exact", head=True).not_.eq("status", "Cleaned & Verified").execute().count or 0
        pending = sb.table("violations").select("*", count="exact", head=True).eq("status", "Pending").execute().count or 0
        cleaned = sb.table("dump_reports").select("*", count="exact", head=True).eq("status", "Cleaned & Verified").execute().count or 0
    except Exception as e:
        # Don't fabricate a score — an outage must not look like a healthy city.
        print(f"[CivicIndex] DB error: {e}")
        raise HTTPException(status_code=503, detail="Civic index unavailable: database error")
    score = max(10, min(100, 100 - active * 3 - pending * 2 + cleaned))
    await manager.broadcast({"type": "civic_index", "value": score})
    return {"civic_index": score}


# ─── SMS dispatch (A10: requires SMS_API_KEY header) ─────────────────────────

_SMS_KEY = os.getenv("SMS_API_KEY", "")

@app.post("/api/sms/dispatch")
async def manual_sms(body: dict, x_sms_api_key: str = Header(default="")):
    """A10: protected by SMS_API_KEY. Leave SMS_API_KEY blank to disable protection (dev only)."""
    if _SMS_KEY and not safe_equal(x_sms_api_key, _SMS_KEY):
        raise HTTPException(status_code=403, detail="Invalid SMS_API_KEY")
    phone   = str(body.get("phone", "")).strip()
    message = str(body.get("message", "")).strip()
    if not phone or not message:
        raise HTTPException(status_code=400, detail="phone and message are required")
    if len(message) > 640:
        raise HTTPException(status_code=400, detail="message too long (max 640 characters)")
    sent = await send_sms(phone, message)
    if not sent and os.getenv("TWILIO_ACCOUNT_SID"):
        raise HTTPException(status_code=502, detail="SMS provider rejected or failed to send the message")
    # success=False + simulated=True when Twilio isn't configured, so callers can tell nothing was sent.
    return {"success": sent, "simulated": not sent}


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    manager = get_ws_manager()
    return {
        "status":     "ok",
        "version":    app.version,
        "ws_clients": manager.connection_count,
        "supabase":   bool(os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
