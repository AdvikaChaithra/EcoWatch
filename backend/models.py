"""
EcoWatch — All Pydantic Models (v4)
"""
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field

# Request bodies for the vision engine -> backend endpoints (backend/main.py).
# (The old auth/violations/reports/workers request models were removed with those routers.)

class SMSWebhook(BaseModel):
    phone: str
    message: str


# ─── Vision Engine — Part 1 ───────────────────────────────────────────────────

class VisionStatus(BaseModel):
    """Boot stage event from vision_engine.py → POST /api/vision/status."""
    stage:     str
    message:   str
    error:     bool = False
    camera_id: Optional[str] = None


class NodeHealth(BaseModel):
    """Real telemetry from TelemetryCollector (psutil) → POST /api/vision/telemetry."""
    type:                 str = "node_health"
    camera_id:            Optional[str] = None
    camera_status:        Optional[str] = None
    camera_resolution:    Optional[str] = None
    camera_fps:           float = 0.0
    inference_fps:        float = 0.0
    inference_latency_ms: float = 0.0
    cpu_percent:          float = 0.0
    ram_mb:               float = 0.0
    gpu:                  str   = "NOT AVAILABLE"
    dropped_frames:       int   = 0
    queue_size:           int   = 0


class ConfidenceBreakdown(BaseModel):
    association:  float = 0.0
    separation:   float = 0.0
    stationary:   float = 0.0
    departure:    float = 0.0
    dwell_seconds: float = 0.0


class LitteringEventPayload(BaseModel):
    """
    Part 1 confirmed littering event → POST /api/littering_event.
    No snapshot_b64 — evidence is saved to disk by EvidenceWriter and served
    via GET /evidence/{event_id[:8]}/{filename}.
    """
    type:              str = "littering_event"
    event_id:          str
    camera_id:         str
    timestamp:         str                          # ISO-8601 UTC
    location:          Dict[str, Any]               # {name, latitude, longitude, ward}
    person_track_id:   int
    waste_track_id:    int
    person_bbox:       List[float]                  # [x1,y1,x2,y2] pixel coords
    waste_bbox:        List[float]
    event_confidence:  float
    action_label:      str = "DROP"                 # DROP | PICKUP | PASS_BY | PLACE_IN_BIN
    identity_status:   str = "PENDING"
    confidence_breakdown: Optional[ConfidenceBreakdown] = None
    evidence_dir:      Optional[str] = None         # relative path, served via /evidence/
    face_crops:        Optional[List[str]] = None   # base64 head crops of the responsible person (identity pipeline input)
    # snapshot_b64 intentionally removed — never relay images over WebSocket (A9)
