"""
EcoWatch FastAPI — main.py
All domain logic lives in routers/. This file:
  - Creates the app
  - Mounts routers
  - Handles the WebSocket /ws endpoint
  - Provides vision engine status + telemetry + littering event endpoints (Part 1)
  - Provides health + civic-index endpoints
"""
import os
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from backend.database import get_supabase, get_ws_manager
from backend.models import VisionStatus, NodeHealth, LitteringEventPayload
from backend.routers import auth, violations, reports, workers

app = FastAPI(title="EcoWatch API", version="3.0.0", docs_url="/api/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount all routers
app.include_router(auth.router)
app.include_router(violations.router)
app.include_router(reports.router)
app.include_router(workers.router)


# ─── WebSocket ────────────────────────────────────────────────

@app.websocket("/ws")
@app.websocket("/ws/alerts")
async def websocket_endpoint(ws: WebSocket):
    """
    Single WebSocket endpoint — handles all real-time events:
    - violation (from vision_engine.py) with person_bbox + trash_bbox
    - report (from citizen portal)
    - dispatch (worker task assignment)
    - worker_location (worker GPS update)
    - civic_index (periodic score update)
    """
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
                    # Re-broadcast worker location from worker portal to admin map
                    await manager.broadcast(msg)
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        manager.disconnect(ws)

# ─── Part 1: Vision Engine Boot Status ──────────────────────
# Receives actual boot stage from vision_engine.py and broadcasts via WS.
# Replaces all frontend setTimeout() fake boot sequences.

@app.post("/api/vision/status")
async def vision_status(payload: VisionStatus):
    """Receives boot/error status from vision_engine.py, broadcasts to all WS clients."""
    manager = get_ws_manager()
    await manager.broadcast({
        "type":      "boot_status",
        "stage":     payload.stage,
        "message":   payload.message,
        "error":     payload.error,
        "camera_id": payload.camera_id,
    })
    return {"ok": True}


# ─── Part 1: Real Telemetry ───────────────────────────────────
# Receives psutil metrics from TelemetryCollector, broadcasts via WS.
# Replaces all Math.random() health metrics in the frontend.

@app.post("/api/vision/telemetry")
async def vision_telemetry(payload: NodeHealth):
    """Receives real telemetry from TelemetryCollector, broadcasts to all WS clients."""
    manager = get_ws_manager()
    await manager.broadcast(payload.dict())
    return {"ok": True}


# ─── Part 1: Littering Event ──────────────────────────────────
# Part 1: Only broadcast. No DB write. identity_status = PENDING.
# Part 2 will add ArcFace identity resolution + Supabase violation insert.

@app.post("/api/littering_event")
async def littering_event(payload: LitteringEventPayload):
    """
    Receives a confirmed Part 1 littering event from vision_engine.py.
    Broadcasts over WebSocket. Does NOT create a violation in the database.
    identity_status is always PENDING — Part 2 handles citizen identification.
    """
    manager = get_ws_manager()
    event_dict = payload.dict()
    # Remove snapshot from WS broadcast if too large (send as separate message if needed)
    snapshot = event_dict.pop("snapshot_b64", None)
    await manager.broadcast(event_dict)
    # Separately broadcast a small snapshot notification if snapshot exists
    if snapshot:
        await manager.broadcast({
            "type":      "littering_snapshot",
            "event_id":  payload.event_id,
            "snapshot_b64": snapshot,
        })
    return {"ok": True, "event_id": payload.event_id}


# ─── Part 1: Camera Config ────────────────────────────────────
# Returns camera metadata so the UI can display the real camera name/location.

@app.get("/api/camera/config")
async def camera_config():
    """Returns registered camera configuration from env vars."""
    return {
        "camera_id":       os.getenv("CAMERA_ID", "CAM_01"),
        "camera_name":     os.getenv("CAMERA_NAME", "EcoWatch Test Camera"),
        "latitude":        os.getenv("CAMERA_LATITUDE", ""),
        "longitude":       os.getenv("CAMERA_LONGITUDE", ""),
        "location_name":   os.getenv("CAMERA_LOCATION_NAME", ""),
        "ward":            os.getenv("CAMERA_WARD", ""),
        "camera_source":   os.getenv("CAMERA_SOURCE", "0"),
    }


# ─── Civic Index ──────────────────────────────────────────────

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


# ─── SMS (manual dispatch) ────────────────────────────────────

@app.post("/api/sms/dispatch")
async def manual_sms(body: dict):
    phone   = body.get("phone", "")
    message = body.get("message", "")
    sid     = os.getenv("TWILIO_ACCOUNT_SID", "")
    token   = os.getenv("TWILIO_AUTH_TOKEN", "")
    from_   = os.getenv("TWILIO_FROM_NUMBER", "")
    if sid and token and phone:
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                    auth=(sid, token),
                    data={"From": from_, "To": phone, "Body": message},
                )
        except Exception as e:
            print(f"[SMS] Twilio error: {e}")
    else:
        print(f"[SMS] Simulated → {phone}: {message}")
    return {"success": True}


# ─── Health ───────────────────────────────────────────────────

@app.get("/health")
async def health():
    manager = get_ws_manager()
    return {
        "status":      "ok",
        "version":     "3.0.0",
        "ws_clients":  manager.connection_count,
        "supabase":    bool(os.getenv("NEXT_PUBLIC_SUPABASE_URL")),
    }



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


# ─── SMS (manual dispatch) ────────────────────────────────────

@app.post("/api/sms/dispatch")
async def manual_sms(body: dict):
    phone   = body.get("phone", "")
    message = body.get("message", "")
    sid     = os.getenv("TWILIO_ACCOUNT_SID", "")
    token   = os.getenv("TWILIO_AUTH_TOKEN", "")
    from_   = os.getenv("TWILIO_FROM_NUMBER", "")
    if sid and token and phone:
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                    auth=(sid, token),
                    data={"From": from_, "To": phone, "Body": message},
                )
        except Exception as e:
            print(f"[SMS] Twilio error: {e}")
    else:
        print(f"[SMS] Simulated → {phone}: {message}")
    return {"success": True}


# ─── Health ───────────────────────────────────────────────────

@app.get("/health")
async def health():
    manager = get_ws_manager()
    return {
        "status":      "ok",
        "version":     "2.0.0",
        "ws_clients":  manager.connection_count,
        "supabase":    bool(os.getenv("NEXT_PUBLIC_SUPABASE_URL")),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
