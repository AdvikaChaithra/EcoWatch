"""
EcoWatch — All Pydantic Models
Shared across all routers to avoid circular imports.
"""
from typing import Optional, List
from pydantic import BaseModel, EmailStr


# ─── Auth / Registration ──────────────────────────────────────

class FaceRegisterRequest(BaseModel):
    citizen_id: str
    frames: List[str]          # list of base64-encoded JPEG frames

class FaceLoginRequest(BaseModel):
    frame: str                 # single base64-encoded JPEG frame

class WorkerLoginRequest(BaseModel):
    employee_id: str
    pin: str

class AdminLoginRequest(BaseModel):
    email: str
    password: str
    totp_code: Optional[str] = None

class OTPRequest(BaseModel):
    phone: str

class OTPVerify(BaseModel):
    phone: str
    otp: str


# ─── Violations ───────────────────────────────────────────────

class ViolationCreate(BaseModel):
    citizen_id: Optional[str] = None
    location_name: str
    lat: float
    lng: float
    snapshot_b64: Optional[str] = None   # base64 JPEG from vision engine
    confidence_score: float = 0.0
    person_bbox: Optional[List[float]] = None  # [x1,y1,x2,y2] normalized 0-1
    trash_bbox:  Optional[List[float]] = None

class ViolationUpdate(BaseModel):
    status: Optional[str] = None
    dispute_reason: Optional[str] = None
    fine_amount: Optional[float] = None

class PaymentRequest(BaseModel):
    violation_id: str
    payment_method: str      # "UPI" | "NetBanking" | "DebitCard"
    transaction_ref: Optional[str] = None


# ─── Reports ──────────────────────────────────────────────────

class ReportCreate(BaseModel):
    citizen_id: str
    category: str
    severity: str
    location_name: str
    lat: float
    lng: float
    reported_image_b64: Optional[str] = None   # base64 JPEG

class ReportStatusUpdate(BaseModel):
    status: str

class AssignWorker(BaseModel):
    worker_id: str


# ─── Workers ──────────────────────────────────────────────────

class WorkerCreate(BaseModel):
    admin_id: str
    name: str
    phone: str
    employee_id: Optional[str] = None
    pin_hash: str = "1234"
    ward: Optional[str] = None

class WorkerStatusUpdate(BaseModel):
    status: str                # "On Duty" | "Off Duty"

class WorkerLocationUpdate(BaseModel):
    lat: float
    lng: float

class BonusUpdate(BaseModel):
    worker_id: str
    amount: float


# ─── SMS ─────────────────────────────────────────────────────

class SMSWebhook(BaseModel):
    phone: str
    message: str


# ─── Vision Engine — Part 1 ──────────────────────────────────

class VisionStatus(BaseModel):
    """Boot stage event from vision_engine.py → POST /api/vision/status."""
    stage:     str            # STARTING | CAMERA_READY | YOLO_READY | SYSTEM_READY | CAMERA_ERROR | YOLO_ERROR
    message:   str
    error:     bool = False
    camera_id: Optional[str] = None


class NodeHealth(BaseModel):
    """Real telemetry from TelemetryCollector → POST /api/vision/telemetry."""
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


class LitteringEventPayload(BaseModel):
    """Part 1 confirmed littering event → POST /api/littering_event."""
    type:              str = "littering_event"
    event_id:          str
    camera_id:         str
    timestamp:         str
    location:          dict              # {name, latitude, longitude, ward}
    person_track_id:   int
    waste_track_id:    int
    person_bbox:       List[float]       # [x1,y1,x2,y2] pixel coords
    waste_bbox:        List[float]
    event_confidence:  float
    identity_status:   str = "PENDING"  # Always PENDING in Part 1
    confidence_breakdown: Optional[dict] = None
    snapshot_b64:      Optional[str] = None
