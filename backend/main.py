"""
EcoWatch FastAPI — main.py  (v5)
  - Static /evidence/ route: serves evidence frames + event.json written by EvidenceWriter (item 2)
  - /api/vision/pipeline_state endpoint (A9)
  - All ENGINE_API_KEY + SMS_API_KEY guards (A10)
  - Explicit CORS from ALLOWED_ORIGINS env var (A10)
  - No duplicate routes
"""
from pathlib import Path
import os
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.database import get_supabase, get_ws_manager
from backend.models import VisionStatus, NodeHealth, LitteringEventPayload
from backend.routers import auth, violations, reports, workers

app = FastAPI(title="EcoWatch API", version="5.0.0", docs_url="/api/docs")

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
    if _ENGINE_KEY and x_engine_api_key != _ENGINE_KEY:
        raise HTTPException(status_code=403, detail="Invalid ENGINE_API_KEY")


# ─── WebSocket ────────────────────────────────────────────────────────────────

@app.websocket("/ws")
@app.websocket("/ws/alerts")
async def websocket_endpoint(ws: WebSocket):
    manager = get_ws_manager()
    await manager.connect(ws)
    try:
        while True:
            data = await ws.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await ws.send_json({"type": "pong", "connections": manager.connection_count})
                elif msg.get("type") == "worker_location":
                    await manager.broadcast(msg)
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
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
    await manager.broadcast(payload.dict())
    return {"ok": True}


@app.post("/api/vision/pipeline_state")
async def vision_pipeline_state(body: dict,
                                  x_engine_api_key: str = Header(default="")):
    """A9: small pipeline state (<5 Hz from engine). No images. Broadcast to WS."""
    _verify_engine_key(x_engine_api_key)
    manager = get_ws_manager()
    await manager.broadcast(body)
    return {"ok": True}


@app.post("/api/littering_event")
async def littering_event(payload: LitteringEventPayload,
                           x_engine_api_key: str = Header(default="")):
    """
    Part 1: broadcast only. No DB write. identity_status=PENDING.
    A9: no base64 snapshot in payload — evidence saved to disk by engine.
    """
    _verify_engine_key(x_engine_api_key)
    manager = get_ws_manager()
    event_dict = payload.dict()
    event_dict.pop("snapshot_b64", None)   # never relay images over WS (A9)
    await manager.broadcast(event_dict)
    return {"ok": True, "event_id": payload.event_id}


@app.get("/api/camera/config")
async def camera_config():
    """Returns camera metadata from env vars for the UI."""
    return {
        "camera_id":     os.getenv("CAMERA_ID", "CAM_01"),
        "camera_name":   os.getenv("CAMERA_NAME", "EcoWatch Test Camera"),
        "latitude":      os.getenv("CAMERA_LATITUDE", ""),
        "longitude":     os.getenv("CAMERA_LONGITUDE", ""),
        "location_name": os.getenv("CAMERA_LOCATION_NAME", ""),
        "ward":          os.getenv("CAMERA_WARD", ""),
        "mjpeg_url":     f"http://localhost:{os.getenv('MJPEG_PORT','8001')}/stream.mjpg",
    }


# ─── Civic Index ─────────────────────────────────────────────────────────────

@app.get("/api/civic-index")
async def civic_index():
    sb = get_supabase()
    manager = get_ws_manager()
    try:
        active  = sb.table("dump_reports").select("*", count="exact", head=True).not_.eq("status", "Cleaned & Verified").execute().count or 0
        pending = sb.table("violations").select("*", count="exact", head=True).eq("status", "Pending").execute().count or 0
        cleaned = sb.table("dump_reports").select("*", count="exact", head=True).eq("status", "Cleaned & Verified").execute().count or 0
        score   = max(10, min(100, 100 - active * 3 - pending * 2 + cleaned))
    except Exception:
        score = 72
    await manager.broadcast({"type": "civic_index", "value": score})
    return {"civic_index": score}


# ─── SMS dispatch (A10: requires SMS_API_KEY header) ─────────────────────────

_SMS_KEY = os.getenv("SMS_API_KEY", "")

@app.post("/api/sms/dispatch")
async def manual_sms(body: dict, x_sms_api_key: str = Header(default="")):
    """A10: protected by SMS_API_KEY. Leave SMS_API_KEY blank to disable protection (dev only)."""
    if _SMS_KEY and x_sms_api_key != _SMS_KEY:
        raise HTTPException(status_code=403, detail="Invalid SMS_API_KEY")
    phone   = body.get("phone", "")
    message = body.get("message", "")
    sid     = os.getenv("TWILIO_ACCOUNT_SID", "")
    token   = os.getenv("TWILIO_AUTH_TOKEN", "")
    from_   = os.getenv("TWILIO_FROM_NUMBER", "")
    if sid and token and phone:
        try:
            import httpx as _httpx
            async with _httpx.AsyncClient() as client:
                await client.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                    auth=(sid, token),
                    data={"From": from_, "To": phone, "Body": message},
                )
        except Exception as e:
            print(f"[SMS] Twilio error: {e}")
    else:
        print(f"[SMS] Simulated (no Twilio creds) → {phone}: {message}")
    return {"success": True}


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    manager = get_ws_manager()
    return {
        "status":     "ok",
        "version":    "4.0.0",
        "ws_clients": manager.connection_count,
        "supabase":   bool(os.getenv("NEXT_PUBLIC_SUPABASE_URL")),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
