"""
EcoWatch Vision Engine v4
=========================
Fixes applied vs v3:
  A6  Waste classes: defaults to bottle(39)+cup(41) only. WASTE_CLASS_IDS configurable.
      WASTE_MODEL_PATH supports separate fine-tuned litter detector.
      COCO stop-gap note in comments.
  A7  SM pool: lazy creation only at first association event (not every pair/frame).
      Timeout from last_state_change (handled in SM). Cooldown on any terminal state.
      WasteTrackStitcher: stitches a new ByteTrack ID onto a recently lost stationary waste.
  A8  Evidence: in-memory ring buffer (EVIDENCE_PRE_SECONDS). 3 key frames saved on confirm.
      event.json metadata alongside frames. Evidence writes on a worker thread.
  A9  MJPEG stream served at http://0.0.0.0:8001/stream.mjpg (own FastAPI/uvicorn thread).
      Browser shows <img src="http://localhost:8001/stream.mjpg">.
      WebSocket sends pipeline state at ≤5 Hz (SM active candidates, dwell, FPS).
      WebSocket does NOT carry base64 images.

COCO stop-gap note (A6):
  COCO classes 39 (bottle) and 41 (cup) are the defaults. This catches PET bottles and
  disposable cups, which are the most common litter in urban India.
  For production, a model trained on a litter-specific dataset is recommended:
    Datasets: TACO (https://tacodataset.org), OpenLitterMap, UAVVaste.
    Fine-tune YOLOv8n/s on litter classes with transfer learning (~1000 annotated images min).
    Set WASTE_MODEL_PATH=path/to/litter_yolov8.pt in .env.
  Do NOT fabricate model accuracy numbers. Measure mAP on a held-out split.

Run:
    python -m backend.vision_engine
"""

from __future__ import annotations

import io
import json
import os
import queue
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Tuple

import cv2
import httpx
import numpy as np
from dotenv import load_dotenv

from backend.camera_zones import ZoneChecker
from backend.littering_detector import (
    ActionLabel, FrameDetection, LitteringConfig, LitteringEvent,
    LitteringStateMachine, LitterState, WasteTrackHistory, init_logger,
)
from backend.telemetry import TelemetryCollector

load_dotenv()

# ── Camera config ─────────────────────────────────────────────────────────────
_SRC            = os.getenv("CAMERA_SOURCE", "0")
CAMERA_SOURCE   = int(_SRC) if _SRC.isdigit() else _SRC
CAMERA_ID       = os.getenv("CAMERA_ID", "CAM_01")
CAMERA_NAME     = os.getenv("CAMERA_NAME", "EcoWatch Test Camera")
CAMERA_LAT      = float(os.getenv("CAMERA_LATITUDE",  "12.9783"))
CAMERA_LNG      = float(os.getenv("CAMERA_LONGITUDE", "77.6408"))
CAMERA_LOCATION = os.getenv("CAMERA_LOCATION_NAME", "Test Location")
CAMERA_WARD     = os.getenv("CAMERA_WARD", "")
SHOW_WINDOW     = os.getenv("SHOW_WINDOW", "true").lower() == "true"

# ── Detection models (A6) ─────────────────────────────────────────────────────
PERSON_MODEL_PATH = os.getenv("PERSON_MODEL_PATH",  "yolov8n.pt")
WASTE_MODEL_PATH  = os.getenv("WASTE_MODEL_PATH",   "yolov8n.pt")

# A6: default bottle(39)+cup(41) only. Set WASTE_CLASS_IDS=39,41,... in .env.
_raw_ids = os.getenv("WASTE_CLASS_IDS", "39,41")
TRASH_CLASS_IDS = set(int(x.strip()) for x in _raw_ids.split(",") if x.strip().isdigit())
PERSON_CLASS_ID = 0

PERSON_CONF = float(os.getenv("PERSON_CONF_THRESHOLD", "0.55"))
TRASH_CONF  = float(os.getenv("TRASH_CONF_THRESHOLD",  "0.40"))

# ── Littering config ──────────────────────────────────────────────────────────
LITTER_CFG = LitteringConfig(
    association_dist_ph    = float(os.getenv("ASSOCIATION_DIST_PERSON_HEIGHTS", "0.5")),
    separation_dist_ph     = float(os.getenv("SEPARATION_DIST_PERSON_HEIGHTS",  "0.8")),
    departure_dist_ph      = float(os.getenv("DEPARTURE_DIST_PERSON_HEIGHTS",   "1.0")),
    tolerance_dist_ph      = float(os.getenv("TOLERANCE_DIST_PERSON_HEIGHTS",   "0.12")),
    carry_min_disp_ph      = float(os.getenv("CARRY_MIN_DISP_PERSON_HEIGHTS",   "0.3")),
    association_min_s      = float(os.getenv("ASSOCIATION_MIN_SECONDS",         "0.5")),
    dwell_seconds          = float(os.getenv("LITTER_DWELL_SECONDS",            "2.0")),
    timeout_seconds        = float(os.getenv("STATE_MACHINE_TIMEOUT_SECONDS",   "60")),
    cooldown_seconds       = float(os.getenv("VIOLATION_EVENT_COOLDOWN_SECONDS","30")),
    grace_seconds          = float(os.getenv("TRACK_LOST_GRACE_SECONDS",        "0.7")),
    carry_comotion_threshold = float(os.getenv("CARRY_COMOTION_THRESHOLD",      "0.4")),
    audit_log_path         = os.getenv("AUDIT_LOG_PATH", "logs/littering_candidates.jsonl"),
)

# ── Evidence ring buffer (A8) ─────────────────────────────────────────────────
EVIDENCE_PRE_SECONDS = float(os.getenv("EVIDENCE_PRE_SECONDS", "4.0"))
EVIDENCE_DIR         = Path(os.getenv("EVIDENCE_DIR", "evidence_snapshots"))
EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
Path("logs").mkdir(exist_ok=True)

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")
ENGINE_API_KEY = os.getenv("ENGINE_API_KEY", "")

# ── MJPEG server (A9) ─────────────────────────────────────────────────────────
MJPEG_HOST = os.getenv("MJPEG_HOST", "0.0.0.0")
MJPEG_PORT = int(os.getenv("MJPEG_PORT", "8001"))
FRAME_Q_SIZE = 3

# ── Pipeline-state push to WS (A9): 5 Hz max ──────────────────────────────────
PIPELINE_STATE_INTERVAL_S = 0.2   # 5 Hz


# ═══════════════════════════════════════════════════════════════════════════════
# Frame ring buffer (A8)
# ═══════════════════════════════════════════════════════════════════════════════

class FrameRingBuffer:
    """
    Stores recent frames as JPEG bytes (not ndarray) to bound RAM.
    Access is thread-safe via a lock.
    """
    def __init__(self, max_seconds: float, jpeg_quality: int = 60):
        self._max_s    = max_seconds
        self._quality  = jpeg_quality
        self._buf: Deque[Tuple[float, bytes]] = deque()
        self._lock = threading.Lock()

    def push(self, frame: np.ndarray, ts: float):
        _, enc = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self._quality])
        data = enc.tobytes()
        with self._lock:
            self._buf.append((ts, data))
            cutoff = ts - self._max_s
            while self._buf and self._buf[0][0] < cutoff:
                self._buf.popleft()

    def get_frame_at(self, target_ts: float) -> Optional[bytes]:
        """Return the frame whose timestamp is closest to target_ts."""
        with self._lock:
            if not self._buf:
                return None
            best = min(self._buf, key=lambda item: abs(item[0] - target_ts))
            return best[1]

    def get_latest(self) -> Optional[bytes]:
        with self._lock:
            return self._buf[-1][1] if self._buf else None


# ═══════════════════════════════════════════════════════════════════════════════
# MJPEG server (A9)
# ═══════════════════════════════════════════════════════════════════════════════

class MJPEGServer:
    """
    Serves the annotated camera stream as MJPEG at /stream.mjpg.
    Runs in its own daemon thread. Browser and other clients connect here.
    The surveillance page uses <img src="http://localhost:8001/stream.mjpg">.
    This eliminates the browser camera API conflict (A9).
    """
    def __init__(self, host: str, port: int):
        self._host  = host
        self._port  = port
        self._frame: Optional[bytes] = None
        self._lock  = threading.Lock()
        self._clients: List[Any] = []

    def push_frame(self, frame: np.ndarray):
        _, enc = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        data = enc.tobytes()
        with self._lock:
            self._frame = data

    def get_frame(self) -> Optional[bytes]:
        with self._lock:
            return self._frame

    def start(self):
        t = threading.Thread(target=self._serve, daemon=True, name="mjpeg-server")
        t.start()
        print(f"[MJPEG] Streaming at http://localhost:{self._port}/stream.mjpg")

    def _serve(self):
        """Minimal HTTP server for MJPEG — no dependencies beyond stdlib."""
        import socket
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            srv.bind((self._host, self._port))
        except OSError as e:
            print(f"[MJPEG] Cannot bind {self._host}:{self._port} — {e}")
            return
        srv.listen(8)
        srv.settimeout(1.0)
        while True:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        import socket
        try:
            request = conn.recv(4096).decode("utf-8", errors="ignore")
            if "stream.mjpg" not in request and "/" not in request:
                conn.close()
                return
            header = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
                "Cache-Control: no-cache\r\n"
                "Connection: close\r\n"
                "\r\n"
            )
            conn.sendall(header.encode())
            while True:
                frame = self.get_frame()
                if frame:
                    part = (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        b"Content-Length: " + str(len(frame)).encode() + b"\r\n"
                        b"\r\n" + frame + b"\r\n"
                    )
                    conn.sendall(part)
                time.sleep(0.03)   # ~33 fps max to MJPEG clients
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass


# ═══════════════════════════════════════════════════════════════════════════════
# Camera Source (unchanged from v3)
# ═══════════════════════════════════════════════════════════════════════════════

class CameraSource:
    def __init__(self, frame_queue: "queue.Queue[np.ndarray]", telemetry: TelemetryCollector):
        self.q        = frame_queue
        self.tel      = telemetry
        self._cap: Optional[cv2.VideoCapture] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self.status   = "STARTING"
        self.width    = 0
        self.height   = 0

    def open(self) -> bool:
        cap = cv2.VideoCapture(CAMERA_SOURCE)
        if not cap.isOpened():
            self.status = "CAMERA_ERROR"
            return False
        cap.set(cv2.CAP_PROP_FRAME_WIDTH,  1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        cap.set(cv2.CAP_PROP_FPS,          30)
        self.width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self._cap   = cap
        self.status = "CAMERA_READY"
        return True

    def start(self):
        self._running = True
        self._thread  = threading.Thread(target=self._loop, daemon=True, name="cam-thread")
        self._thread.start()

    def stop(self):
        self._running = False
        if self._cap:
            self._cap.release()

    def _loop(self):
        fails = 0
        while self._running:
            if not self._cap or not self._cap.isOpened():
                self.status = "CAMERA_ERROR"
                time.sleep(1.0)
                continue
            ret, frame = self._cap.read()
            if not ret:
                fails += 1
                if fails > 30:
                    self.status = "CAMERA_ERROR"
                time.sleep(0.02)
                continue
            fails = 0
            self.tel.record_camera_frame()
            try:
                self.q.put_nowait(frame)
            except queue.Full:
                self.tel.dropped_frames += 1


# ═══════════════════════════════════════════════════════════════════════════════
# Evidence writer (A8) — runs on worker thread
# ═══════════════════════════════════════════════════════════════════════════════

class EvidenceWriter:
    """
    Saves 3 key frames + event.json on a worker thread.
    Does not block the inference loop.
    """

    def __init__(self):
        self._q:      "queue.Queue[dict]" = queue.Queue()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="evidence-writer")

    def start(self):
        self._thread.start()

    def submit(self, job: dict):
        self._q.put_nowait(job)

    def _loop(self):
        while True:
            job = self._q.get()
            try:
                self._write(job)
            except Exception as e:
                print(f"[Evidence] Write error: {e}")

    def _write(self, job: dict):
        ev:      LitteringEvent = job["event"]
        ring:    FrameRingBuffer = job["ring"]
        t_assoc: float = job["t_assoc"]    # time when association was confirmed
        t_drop:  float = job["t_drop"]     # time of separation/drop
        t_conf:  float = ev.timestamp      # time of LITTERING_CONFIRMED

        event_dir = EVIDENCE_DIR / ev.event_id[:8]
        event_dir.mkdir(parents=True, exist_ok=True)

        frame_paths = []
        for label, target_ts in [("1_assoc", t_assoc), ("2_drop", t_drop), ("3_confirmed", t_conf)]:
            raw = ring.get_frame_at(target_ts)
            if raw is None:
                continue
            arr = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
            if arr is None:
                continue
            h, w = arr.shape[:2]

            def _box(bbox, color, lbl):
                x1, y1, x2, y2 = [max(0, int(v)) for v in bbox]
                x2, y2 = min(x2, w-1), min(y2, h-1)
                cv2.rectangle(arr, (x1,y1),(x2,y2), color, 2)
                cv2.putText(arr, lbl, (x1, max(y1-5,10)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

            _box(ev.person_bbox, (0,255,255), f"P#{ev.person_track_id}")
            _box(ev.waste_bbox,  (0,0,255),   f"W#{ev.waste_track_id}")
            ts_str = datetime.fromtimestamp(target_ts).strftime("%H:%M:%S.%f")[:12]
            cv2.putText(arr, f"{label}  {ts_str}", (8, h-10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0,255,80), 1)

            out = event_dir / f"{label}.jpg"
            cv2.imwrite(str(out), arr, [cv2.IMWRITE_JPEG_QUALITY, 88])
            frame_paths.append(str(out))

        # event.json
        meta = {
            "event_id":          ev.event_id,
            "camera_id":         ev.camera_id,
            "timestamp":         datetime.fromtimestamp(ev.timestamp, tz=timezone.utc).isoformat(),
            "action_label":      ev.action_label.value,
            "event_confidence":  ev.event_confidence,
            "person_track_id":   ev.person_track_id,
            "waste_track_id":    ev.waste_track_id,
            "location": {
                "name": CAMERA_LOCATION, "latitude": CAMERA_LAT,
                "longitude": CAMERA_LNG, "ward": CAMERA_WARD,
            },
            "score_breakdown": {
                "association":  ev.association_score,
                "separation":   ev.separation_score,
                "stationary":   ev.stationary_score,
                "departure":    ev.departure_score,
                "dwell_actual_s": ev.dwell_actual_s,
            },
            "key_frames":   frame_paths,
            "identity_status": "PENDING",
        }
        (event_dir / "event.json").write_text(json.dumps(meta, indent=2))
        print(f"[Evidence] Saved to {event_dir}/ ({len(frame_paths)} frames)")


# ═══════════════════════════════════════════════════════════════════════════════
# Waste Track Stitcher — A7
# ═══════════════════════════════════════════════════════════════════════════════

class WasteTrackStitcher:
    """
    Handles ByteTrack ID switches for stationary waste.
    If a waste track disappears and a new one appears at the same position
    within STITCH_GRACE seconds, maps the new ID back to the old ID.
    """
    STITCH_GRACE_S = 3.0
    STITCH_TOL_PX  = 30.0

    def __init__(self):
        self._lost: Dict[int, Tuple[Tuple[int,int], float]] = {}  # old_id → (center, lost_ts)
        self._alias: Dict[int, int] = {}  # new_id → canonical_id

    def mark_lost(self, track_id: int, center: Tuple[int,int], ts: float):
        self._lost[track_id] = (center, ts)

    def resolve(self, track_id: int, center: Tuple[int,int], ts: float) -> int:
        """Return canonical track ID (possibly the stitched old ID)."""
        if track_id in self._alias:
            return self._alias[track_id]

        import math
        best_id, best_dist = None, float("inf")
        for old_id, (old_center, lost_ts) in list(self._lost.items()):
            if (ts - lost_ts) > self.STITCH_GRACE_S:
                del self._lost[old_id]
                continue
            d = math.sqrt((center[0]-old_center[0])**2 + (center[1]-old_center[1])**2)
            if d < self.STITCH_TOL_PX and d < best_dist:
                best_id, best_dist = old_id, d

        if best_id is not None:
            print(f"[Stitch] Waste #{track_id} → #{best_id} (dist={best_dist:.1f}px)")
            self._alias[track_id] = best_id
            del self._lost[best_id]
            return best_id

        return track_id

    def cleanup(self, ts: float):
        for old_id, (_, lost_ts) in list(self._lost.items()):
            if (ts - lost_ts) > self.STITCH_GRACE_S * 2:
                del self._lost[old_id]


# ═══════════════════════════════════════════════════════════════════════════════
# Vision Engine v4
# ═══════════════════════════════════════════════════════════════════════════════

class VisionEngine:

    def __init__(self):
        init_logger(LITTER_CFG.audit_log_path)

        self.person_model = None
        self.waste_model  = None   # may be same object as person_model if same path

        self.telemetry = TelemetryCollector(interval_s=2.0)
        self.frame_q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=FRAME_Q_SIZE)
        self.camera   = CameraSource(self.frame_q, self.telemetry)

        self.ring   = FrameRingBuffer(EVIDENCE_PRE_SECONDS)
        self.mjpeg  = MJPEGServer(MJPEG_HOST, MJPEG_PORT)
        self.writer = EvidenceWriter()
        self.zones  = ZoneChecker.load("backend/camera_zones.json", CAMERA_ID)
        self.stitcher = WasteTrackStitcher()

        self._running = False
        self._http    = httpx.Client(
            timeout=10.0,
            headers={"X-Engine-API-Key": ENGINE_API_KEY} if ENGINE_API_KEY else {},
        )

        # A7: SM pool — keyed on canonical (person_id, waste_id)
        self._sm_pool:       Dict[Tuple[int,int], LitteringStateMachine] = {}
        # Cooldown after ANY terminal state (A7)
        self._terminal_time: Dict[Tuple[int,int], float] = {}

        # Waste track histories (A4, A7 stitching)
        self._waste_hist: Dict[int, WasteTrackHistory] = {}

        # Key timestamps for evidence (A8)
        self._ev_t_assoc: Dict[Tuple[int,int], float] = {}
        self._ev_t_drop:  Dict[Tuple[int,int], float] = {}

        # Pipeline state (A9): updated by inference, read by broadcast thread
        self._pipeline_state: Dict[str, Any] = {}
        self._pipeline_lock   = threading.Lock()
        self._last_pipeline_push = 0.0

    # ── Boot / status ─────────────────────────────────────────────────────────

    def _post_status(self, stage: str, message: str, error: bool = False):
        print(f"[Boot] {stage}: {message}")
        try:
            self._http.post(f"{BACKEND_URL}/api/vision/status", json={
                "stage": stage, "message": message,
                "error": error, "camera_id": CAMERA_ID,
            }, timeout=3.0)
        except Exception:
            pass

    def _telemetry_loop(self):
        while self._running:
            time.sleep(2.0)
            snap = self.telemetry.get_snapshot()
            snap.update({
                "type":               "node_health",
                "camera_id":          CAMERA_ID,
                "camera_status":      self.camera.status,
                "camera_resolution":  f"{self.camera.width}x{self.camera.height}",
            })
            try:
                self._http.post(f"{BACKEND_URL}/api/vision/telemetry", json=snap, timeout=2.0)
            except Exception:
                pass

    def _pipeline_broadcast_loop(self):
        """A9: push SM state at ≤5 Hz — small JSON, no images."""
        while self._running:
            time.sleep(PIPELINE_STATE_INTERVAL_S)
            with self._pipeline_lock:
                state = dict(self._pipeline_state)
            if not state:
                continue
            try:
                self._http.post(f"{BACKEND_URL}/api/vision/pipeline_state",
                                json=state, timeout=1.0)
            except Exception:
                pass

    # ── Model loading ─────────────────────────────────────────────────────────

    def _load_models(self) -> bool:
        self._post_status("STARTING", f"Loading models: person={PERSON_MODEL_PATH} waste={WASTE_MODEL_PATH}")
        try:
            from ultralytics import YOLO
            self.person_model = YOLO(PERSON_MODEL_PATH)
            if WASTE_MODEL_PATH == PERSON_MODEL_PATH:
                self.waste_model = self.person_model   # same model handles both
            else:
                self.waste_model = YOLO(WASTE_MODEL_PATH)

            # Warm-up
            dummy = np.zeros((480, 640, 3), dtype=np.uint8)
            self.person_model.track(source=dummy, persist=True, verbose=False,
                                    tracker="bytetrack.yaml",
                                    classes=[PERSON_CLASS_ID, *list(TRASH_CLASS_IDS)])
            self._post_status("YOLO_READY",
                f"YOLO ready | person={PERSON_MODEL_PATH} waste={WASTE_MODEL_PATH} | "
                f"waste classes={sorted(TRASH_CLASS_IDS)} | ByteTrack")
            return True
        except ImportError:
            self._post_status("YOLO_ERROR", "ultralytics not installed", error=True)
            return False
        except Exception as e:
            self._post_status("YOLO_ERROR", f"Load failed: {e}", error=True)
            return False

    # ── SM pool helpers (A7) ──────────────────────────────────────────────────

    def _pair_in_cooldown(self, pid: int, wid: int, now: float) -> bool:
        return (now - self._terminal_time.get((pid, wid), 0)) < LITTER_CFG.cooldown_seconds

    def _proximity_check(self, p: dict, w: dict) -> bool:
        """Only create an SM when first proximity is detected."""
        ph    = max(p["bbox"][3] - p["bbox"][1], 10)
        assoc = ph * LITTER_CFG.association_dist_ph
        from backend.littering_detector import _dist
        return _dist(p["center"], w["center"]) <= assoc

    def _get_or_none(self, pid: int, wid: int) -> Optional[LitteringStateMachine]:
        return self._sm_pool.get((pid, wid))

    def _create_sm(self, pid: int, wid: int, initial_det: FrameDetection) -> LitteringStateMachine:
        sm = LitteringStateMachine(
            person_track_id=pid, waste_track_id=wid,
            camera_id=CAMERA_ID, cfg=LITTER_CFG,
            initial_det=initial_det,
        )
        self._sm_pool[(pid, wid)] = sm
        return sm

    def _prune_pool(self, now: float):
        for k, sm in list(self._sm_pool.items()):
            if sm.is_terminal:
                self._terminal_time[k] = now
                del self._sm_pool[k]

    def _waste_stationary_before(self, wid: int, window_s: float = 2.0) -> bool:
        hist = self._waste_hist.get(wid)
        if hist is None:
            return False
        ph_approx = 80.0
        tol = ph_approx * LITTER_CFG.tolerance_dist_ph
        return hist.was_stationary(window_s=window_s, tol_px=tol)

    def _waste_born_in_bbox(self, wid: int, wc: Tuple[int,int], pb: Tuple[int,int,int,int]) -> bool:
        hist = self._waste_hist.get(wid)
        if hist is None:
            return False
        # Waste just appeared (≤3 frames old) AND center inside person bbox
        if len(hist.timestamps) > 3:
            return False
        x1, y1, x2, y2 = pb
        return x1 <= wc[0] <= x2 and y1 <= wc[1] <= y2

    # ── Frame processing ──────────────────────────────────────────────────────

    def _process_frame(self, frame: np.ndarray, now: float) -> np.ndarray:
        if self.person_model is None:
            return frame

        t0      = time.perf_counter()
        display = frame.copy()
        h, w    = frame.shape[:2]

        results = self.person_model.track(
            source=frame, persist=True,
            tracker="bytetrack.yaml", verbose=False,
            classes=[PERSON_CLASS_ID, *list(TRASH_CLASS_IDS)],
        )

        persons: List[dict] = []
        raw_wastes: List[dict] = []

        if results and results[0].boxes is not None:
            for box in results[0].boxes:
                cls  = int(box.cls[0])
                conf = float(box.conf[0])
                tid  = int(box.id[0]) if box.id is not None else -1
                if tid < 0:
                    continue
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                cx, cy = (x1+x2)//2, (y1+y2)//2

                if cls == PERSON_CLASS_ID and conf >= PERSON_CONF:
                    ph = max(y2 - y1, 10)
                    persons.append({"id": tid, "bbox": (x1,y1,x2,y2),
                                    "center": (cx,cy), "ph": ph})
                    cv2.rectangle(display, (x1,y1),(x2,y2), (0,255,255), 2)
                    cv2.putText(display, f"P#{tid} {conf:.2f}", (x1,y1-6),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0,255,255), 1)
                elif cls in TRASH_CLASS_IDS and conf >= TRASH_CONF:
                    raw_wastes.append({"id": tid, "bbox": (x1,y1,x2,y2), "center": (cx,cy)})

        # A7: stitch waste IDs and update histories
        wastes: List[dict] = []
        seen_waste_ids = set()
        for rw in raw_wastes:
            canonical_id = self.stitcher.resolve(rw["id"], rw["center"], now)
            rw["canonical_id"] = canonical_id
            seen_waste_ids.add(canonical_id)

            if canonical_id not in self._waste_hist:
                self._waste_hist[canonical_id] = WasteTrackHistory(track_id=canonical_id,
                                                                     born_timestamp=now)
            self._waste_hist[canonical_id].update(rw["center"], rw["bbox"], now)
            rw["id"] = canonical_id
            wastes.append(rw)

            cv2.rectangle(display, rw["bbox"][:2], rw["bbox"][2:], (0,0,255), 2)
            cv2.putText(display, f"W#{canonical_id} {0.0:.2f}", (rw["bbox"][0], rw["bbox"][1]-6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0,0,255), 1)

        # Mark lost wastes for stitcher
        all_seen_ids = {w["id"] for w in wastes}
        for wid, hist in self._waste_hist.items():
            if wid not in all_seen_ids and (now - hist.last_seen) < 5.0:
                if hist.last_bbox:
                    cx = (hist.last_bbox[0]+hist.last_bbox[2])//2
                    cy = (hist.last_bbox[1]+hist.last_bbox[3])//2
                    self.stitcher.mark_lost(wid, (cx,cy), hist.last_seen)

        self.stitcher.cleanup(now)

        # ── A7: Only create SM at first proximity; A4: carry evidence flags ──
        person_ids = {p["id"] for p in persons}
        waste_ids  = {w["id"] for w in wastes}

        for person in persons:
            for waste in wastes:
                pid, wid = person["id"], waste["id"]
                key = (pid, wid)

                if self._pair_in_cooldown(pid, wid, now):
                    continue

                sm = self._get_or_none(pid, wid)

                if sm is None:
                    # A7: only create if proximity threshold met
                    if not self._proximity_check(person, waste):
                        continue
                    # Build initial FrameDetection with A4 flags
                    ph = person["ph"]
                    initial = FrameDetection(
                        timestamp            = now,
                        person_present       = True,
                        person_bbox          = person["bbox"],
                        person_center        = person["center"],
                        person_height_px     = ph,
                        waste_present        = True,
                        waste_bbox           = waste["bbox"],
                        waste_center         = waste["center"],
                        waste_was_stationary_before_person=self._waste_stationary_before(wid),
                        waste_born_in_person_bbox=self._waste_born_in_bbox(
                            wid, waste["center"], person["bbox"]),
                    )
                    sm = self._create_sm(pid, wid, initial)
                    self._ev_t_assoc[key] = now
                    continue   # first frame is handled by SM constructor's PERSON_NEAR_OBJECT state

                if sm.is_terminal:
                    continue

                ph = person["ph"]
                det = FrameDetection(
                    timestamp        = now,
                    person_present   = True,
                    person_bbox      = person["bbox"],
                    person_center    = person["center"],
                    person_height_px = ph,
                    waste_present    = True,
                    waste_bbox       = waste["bbox"],
                    waste_center     = waste["center"],
                )
                result = sm.update(det)
                self._maybe_record_timestamps(sm, key, now)
                self._handle_event(result, key, now)
                self._render_sm_hud(display, sm, waste, ph, w, h)

        # Update SMs where person or waste disappeared this frame
        for (pid, wid), sm in list(self._sm_pool.items()):
            if sm.is_terminal:
                continue
            if pid in person_ids and wid in waste_ids:
                continue   # already handled above
            p_data = next((p for p in persons if p["id"] == pid), None)
            w_data = next((w for w in wastes  if w["id"] == wid), None)
            ph = p_data["ph"] if p_data else 80.0
            det = FrameDetection(
                timestamp        = now,
                person_present   = p_data is not None,
                person_bbox      = p_data["bbox"]   if p_data else None,
                person_center    = p_data["center"] if p_data else None,
                person_height_px = ph,
                waste_present    = w_data is not None,
                waste_bbox       = w_data["bbox"]   if w_data else None,
                waste_center     = w_data["center"] if w_data else None,
            )
            result = sm.update(det)
            self._maybe_record_timestamps(sm, (pid, wid), now)
            self._handle_event(result, (pid, wid), now)

        self._prune_pool(now)

        # A9: update pipeline state (no images)
        self._update_pipeline_state(persons, wastes, now)

        # Bin/no-litter zone overlays
        if self.zones:
            for poly in self.zones.get_zones_for_overlay()["bin_zones"]:
                pts = np.array([[int(x*w), int(y*h)] for x, y in poly], np.int32)
                cv2.polylines(display, [pts], True, (0,200,0), 2)

        # HUD
        snap = self.telemetry.get_snapshot()
        self.telemetry.queue_size = self.frame_q.qsize()
        cv2.putText(display,
            f"EcoWatch v4 | {CAMERA_ID} | {datetime.now().strftime('%H:%M:%S')}",
            (8, h-8), cv2.FONT_HERSHEY_SIMPLEX, 0.40, (16,185,129), 1)
        cv2.putText(display,
            f"CAM:{snap['camera_fps']}fps  AI:{snap['inference_fps']}fps  "
            f"Lat:{snap['inference_latency_ms']}ms  Drop:{snap['dropped_frames']}  SMs:{len(self._sm_pool)}",
            (8,20), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (200,200,200), 1)
        cv2.putText(display, f"P:{len(persons)} W:{len(wastes)}  WasteClasses:{sorted(TRASH_CLASS_IDS)}",
            (8,36), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (200,200,200), 1)

        self.telemetry.record_inference((time.perf_counter()-t0)*1000)
        return display

    def _maybe_record_timestamps(self, sm: LitteringStateMachine,
                                  key: Tuple[int,int], now: float):
        if sm.state == LitterState.OBJECT_ASSOCIATED and key not in self._ev_t_assoc:
            self._ev_t_assoc[key] = now
        if sm.state == LitterState.OBJECT_DROPPED and key not in self._ev_t_drop:
            self._ev_t_drop[key] = now

    def _render_sm_hud(self, display: np.ndarray, sm: LitteringStateMachine,
                        waste: dict, ph: float, W: int, H: int):
        x1, y1, x2, y2 = waste["bbox"]
        state_col = (0,220,80) if sm.state == LitterState.LITTERING_CONFIRMED else (200,140,0)
        cv2.putText(display, sm.state.value, (x1, y2+14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, state_col, 1)
        if sm.dwell_progress > 0:
            bar_w = int((x2-x1) * sm.dwell_progress)
            cv2.rectangle(display, (x1, y2+2), (x1+bar_w, y2+7), (255,140,0), -1)

    def _update_pipeline_state(self, persons, wastes, now: float):
        """A9: small JSON for WS broadcast — no images."""
        active = []
        for (pid, wid), sm in self._sm_pool.items():
            active.append({
                "person_id":     pid,
                "waste_id":      wid,
                "state":         sm.state.value,
                "dwell_progress": round(sm.dwell_progress, 2),
            })
        with self._pipeline_lock:
            self._pipeline_state = {
                "type":            "pipeline_state",
                "camera_id":       CAMERA_ID,
                "timestamp":       now,
                "person_count":    len(persons),
                "waste_count":     len(wastes),
                "active_machines": active,
            }

    def _handle_event(self, ev: Optional[LitteringEvent],
                       key: Tuple[int,int], now: float):
        if ev is None:
            return

        pid, wid = key
        # A5: check if waste ended inside a bin zone
        wc = ev.waste_bbox
        if wc:
            cx_norm = ((wc[0]+wc[2])//2) / max(self.camera.width, 1)
            cy_norm = ((wc[1]+wc[3])//2) / max(self.camera.height, 1)
            if self.zones.in_bin_zone(cx_norm, cy_norm):
                print(f"[Engine] PLACE_IN_BIN — waste #{wid} in bin zone. Not a violation.")
                return

        # Evidence (A8) — on worker thread
        t_assoc = self._ev_t_assoc.get(key, now - LITTER_CFG.dwell_seconds - 2)
        t_drop  = self._ev_t_drop.get(key, now - LITTER_CFG.dwell_seconds)
        self.writer.submit({
            "event": ev, "ring": self.ring, "t_assoc": t_assoc, "t_drop": t_drop,
        })

        print(f"\n{'='*64}")
        print(f"[LITTERING CONFIRMED] event={ev.event_id[:8]}")
        print(f"  Person#{ev.person_track_id} + Waste#{ev.waste_track_id}")
        print(f"  Confidence: {ev.event_confidence:.1%}  Dwell: {ev.dwell_actual_s:.1f}s")
        print(f"  action_label: {ev.action_label.value}  identity: PENDING")
        print(f"{'='*64}\n")

        payload = {
            "type":             "littering_event",
            "event_id":         ev.event_id,
            "camera_id":        ev.camera_id,
            "timestamp":        datetime.fromtimestamp(ev.timestamp, tz=timezone.utc).isoformat(),
            "location": {
                "name": CAMERA_LOCATION, "latitude": CAMERA_LAT,
                "longitude": CAMERA_LNG, "ward": CAMERA_WARD,
            },
            "person_track_id":  ev.person_track_id,
            "waste_track_id":   ev.waste_track_id,
            "person_bbox":      list(ev.person_bbox),
            "waste_bbox":       list(ev.waste_bbox),
            "event_confidence": ev.event_confidence,
            "action_label":     ev.action_label.value,
            "identity_status":  "PENDING",
            "confidence_breakdown": {
                "association":  ev.association_score,
                "separation":   ev.separation_score,
                "stationary":   ev.stationary_score,
                "departure":    ev.departure_score,
                "dwell_seconds": ev.dwell_actual_s,
            },
            # A9: no base64 image in WS payload; evidence_dir is the path
            "evidence_dir": str(EVIDENCE_DIR / ev.event_id[:8]),
        }
        threading.Thread(target=self._post_event, args=(payload,), daemon=True).start()

    def _post_event(self, payload: dict):
        try:
            self._http.post(f"{BACKEND_URL}/api/littering_event", json=payload, timeout=10.0)
        except Exception as e:
            print(f"[Engine] Failed to POST event: {e}")

    # ── Main run ──────────────────────────────────────────────────────────────

    def run(self):
        print(f"\n[EcoWatch v4] Starting vision engine")
        print(f"[EcoWatch v4] SHOW_WINDOW={SHOW_WINDOW} | Camera: {CAMERA_SOURCE!r}")
        print(f"[EcoWatch v4] Waste classes: {sorted(TRASH_CLASS_IDS)}")

        if not self._load_models():
            print("[EcoWatch v4] FATAL — model load failed.")
            return

        self._post_status("CAMERA_READY", f"Opening camera: {CAMERA_SOURCE!r}")
        if not self.camera.open():
            self._post_status("CAMERA_ERROR",
                f"Cannot open camera: {CAMERA_SOURCE!r}. Check CAMERA_SOURCE.", error=True)
            return

        self._post_status("CAMERA_READY",
            f"{CAMERA_ID} | {self.camera.width}x{self.camera.height} | {CAMERA_LOCATION}")
        self._post_status("TRACKER_READY", "ByteTrack + WasteTrackStitcher enabled")
        self._post_status("EVENT_ENGINE_READY",
            f"LitteringStateMachine v2 | dwell={LITTER_CFG.dwell_seconds}s | "
            f"grace={LITTER_CFG.grace_seconds}s | carry_comotion={LITTER_CFG.carry_comotion_threshold}")

        self.telemetry.start()
        self.camera.start()
        self.writer.start()
        self.mjpeg.start()
        self._running = True

        threading.Thread(target=self._telemetry_loop,        daemon=True, name="tel-bcast").start()
        threading.Thread(target=self._pipeline_broadcast_loop, daemon=True, name="pipe-bcast").start()

        self._post_status("SYSTEM_READY",
            f"All systems | YOLO: person={PERSON_MODEL_PATH} waste={WASTE_MODEL_PATH} | "
            f"MJPEG: http://localhost:{MJPEG_PORT}/stream.mjpg | Identity: PENDING")
        print(f"[EcoWatch v4] 🚀 Ready. MJPEG @ http://localhost:{MJPEG_PORT}/stream.mjpg")
        if SHOW_WINDOW:
            print("[EcoWatch v4] Press 'q' in camera window to quit.")

        try:
            while self._running:
                try:
                    frame = self.frame_q.get(timeout=2.0)
                    now   = time.time()
                except queue.Empty:
                    if self.camera.status == "CAMERA_ERROR":
                        print("[EcoWatch v4] Camera lost signal…")
                    continue

                # Push to ring buffer before inference (captures pre-event frames)
                self.ring.push(frame, now)

                display = self._process_frame(frame, now)

                # Push annotated frame to MJPEG server
                self.mjpeg.push_frame(display)

                if SHOW_WINDOW:
                    cv2.imshow(f"EcoWatch v4 — {CAMERA_ID}", display)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        break
        finally:
            self._running = False
            self.camera.stop()
            self.telemetry.stop()
            self._http.close()
            if SHOW_WINDOW:
                cv2.destroyAllWindows()
            print("[EcoWatch v4] Stopped.")


if __name__ == "__main__":
    VisionEngine().run()
