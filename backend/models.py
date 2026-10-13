"""
EcoWatch — All Pydantic Models (v4)
"""
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


# ─── Auth / Registration ──────────────────────────────────────────────────────

class FaceRegisterRequest(BaseModel):
    citizen_id: str
    frames: List[str] = Field(max_length=5)

class FaceLoginRequest(BaseModel):
    frame: str = Field(max_length=8_000_000)

class WorkerLoginRequest(BaseModel):
    employee_id: str
    pin: str = Field(pattern=r"^\d{4}$")

class AdminLoginRequest(BaseModel):
    email: str
    password: str
    totp_code: Optional[str] = None

class OTPRequest(BaseModel):
    phone: str

class OTPVerify(BaseModel):
    phone: str
    otp: str = Field(pattern=r"^\d{6}$")


# ─── Violations ───────────────────────────────────────────────────────────────

class ViolationCreate(BaseModel):
    citizen_id: Optional[str] = None
    location_name: str
    lat: float
    lng: float
    # No snapshot_b64 — evidence is stored on disk, served via /evidence/{event_id}
    evidence_dir: Optional[str] = None
    confidence_score: float = 0.0
    person_bbox: Optional[List[float]] = None
    trash_bbox:  Optional[List[float]] = None

ViolationStatus = Literal["Pending", "Paid", "Disputed", "Dismissed", "Upheld"]
ReportStatus = Literal["Submitted", "Worker Assigned", "Cleaning in Progress",
                       "Pending Verification", "Cleaned & Verified"]


class ViolationUpdate(BaseModel):
    status: Optional[ViolationStatus] = None
    dispute_reason: Optional[str] = None
    fine_amount: Optional[float] = Field(default=None, ge=0, le=100000)

class PaymentRequest(BaseModel):
    violation_id: str
    payment_method: str
    transaction_ref: Optional[str] = None


# ─── Reports ──────────────────────────────────────────────────────────────────

class ReportCreate(BaseModel):
    citizen_id: str
    category: str
    severity: str
    location_name: str
    lat: float
    lng: float
    reported_image_b64: Optional[str] = Field(default=None, max_length=14_000_000)

class ReportStatusUpdate(BaseModel):
    status: ReportStatus

class AssignWorker(BaseModel):
    worker_id: str


# ─── Workers ──────────────────────────────────────────────────────────────────

class WorkerCreate(BaseModel):
    admin_id: str
    name: str
    phone: str
    employee_id: Optional[str] = None
    pin: str = Field(default="1234", pattern=r"^\d{4}$")
    ward: Optional[str] = None

class WorkerStatusUpdate(BaseModel):
    status: str

class WorkerLocationUpdate(BaseModel):
    lat: float
    lng: float

class BonusUpdate(BaseModel):
    worker_id: str
    amount: float = Field(gt=0, le=100000)


# ─── SMS ──────────────────────────────────────────────────────────────────────

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
    # snapshot_b64 intentionally removed — never relay images over WebSocket (A9)
