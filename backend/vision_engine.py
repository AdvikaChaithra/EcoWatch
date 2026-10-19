"""
EcoWatch Vision Engine v5
=========================
Changes from v4:
  WASTE_MODEL  Actually runs a second YOLO model for waste when WASTE_MODEL_PATH ≠ PERSON_MODEL_PATH.
               Person model does tracking (persist=True + ByteTrack).
               Waste model runs per-frame inference only (no tracker) on the same frame.
               Waste track IDs for the second model are synthetic (centroid-based, lightweight).
  STITCHER     Stitcher now only maps genuinely NEW track IDs (not seen before).
               Tolerance scaled to person height (STITCH_TOL_PH = 0.3).
               Runs cleanup before resolve to avoid stale matches.
  BORN_IN_HAND Engine sets waste_born_in_person_bbox using WasteTrackHistory.first_seen
               vs association window start (timestamp-based, A4-rework).
  FRAMES       frame_width / frame_height passed into every FrameDetection so the SM
               can normalise waste center for ZoneChecker (A5-in-SM).
  ZONES        ZoneChecker instance passed into SM constructor (A5-in-SM no duplicate check).
  EVIDENCE     _draw_box now clips all coordinates to frame bounds before cv2.rectangle.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Set, Tuple

# Windows Media Foundation can take ~30 s to open a webcam with hardware transforms on;
# disabling them makes the camera open in about a second (must be set before importing cv2).
os.environ.setdefault("OPENCV_VIDEOIO_MSMF_ENABLE_HW_TRANSFORMS", "0")
# Ultralytics otherwise checks PyPI / sends usage analytics at startup (slow on some networks).
os.environ.setdefault("YOLO_OFFLINE", "1")
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

load_dotenv()                                             # cwd .env
load_dotenv(Path(__file__).resolve().parent / ".env")     # backend/.env regardless of cwd

# ── Camera ────────────────────────────────────────────────────────────────────
_SRC          = os.getenv("CAMERA_SOURCE", "0")
CAMERA_SOURCE = int(_SRC) if _SRC.isdigit() else _SRC
CAMERA_LOOP   = os.getenv("CAMERA_LOOP", "false").lower() == "true"
CAMERA_ID     = os.getenv("CAMERA_ID", "CAM_01")
CAMERA_NAME   = os.getenv("CAMERA_NAME", "EcoWatch Test Camera")
CAMERA_LAT    = float(os.getenv("CAMERA_LATITUDE",  "12.9783"))
CAMERA_LNG    = float(os.getenv("CAMERA_LONGITUDE", "77.6408"))
CAMERA_LOC    = os.getenv("CAMERA_LOCATION_NAME", "Test Location")
CAMERA_WARD   = os.getenv("CAMERA_WARD", "")
SHOW_WINDOW   = os.getenv("SHOW_WINDOW", "false").lower() == "true"   # extra OpenCV window costs CPU
# Capture size + YOLO input size. 640x480 capture and imgsz=416 run ~6-7 FPS on a laptop CPU
# (measured: imgsz 640 -> 3.4 FPS, 416 -> 6.5 FPS, 320 -> 10.6 FPS with yolov8n + ByteTrack).
CAMERA_WIDTH  = int(os.getenv("CAMERA_WIDTH", "640"))
CAMERA_HEIGHT = int(os.getenv("CAMERA_HEIGHT", "480"))
YOLO_IMGSZ    = int(os.getenv("YOLO_IMGSZ", "416"))
# Webcam driver: auto tries Media Foundation, then DirectShow, then OpenCV's default.
CAMERA_BACKEND = os.getenv("CAMERA_BACKEND", "auto").lower()
# A live camera that delivers only black frames this long is reopened (e.g. device contention).
CAMERA_BLACK_SECONDS = float(os.getenv("CAMERA_BLACK_SECONDS", "3"))
BLACK_MEAN_LEVEL = 3.0

# ── Models (A6 + dual model) ─────────────────────────────────────────────────
PERSON_MODEL_PATH = os.getenv("PERSON_MODEL_PATH", "yolov8n.pt")
WASTE_MODEL_PATH  = os.getenv("WASTE_MODEL_PATH",  "yolov8n.pt")
DUAL_MODEL        = WASTE_MODEL_PATH != PERSON_MODEL_PATH

# COCO classes treated as potential litter (yolov8n is COCO-trained; it has NO class for
# wrappers / plastic bags / loose paper - those need a litter-trained model, e.g. TACO).
#   26 handbag (closest to a dumped bag) | 39 bottle 40 wine glass 41 cup 45 bowl
#   42 fork 43 knife 44 spoon | 46 banana 47 apple 48 sandwich 49 orange 51 carrot
#   52 hot dog 53 pizza 54 donut 55 cake | 73 book (paper / notebook)
_DEFAULT_WASTE_IDS = "26,39,40,41,42,43,44,45,46,47,48,49,51,52,53,54,55,73"
_raw_ids        = os.getenv("WASTE_CLASS_IDS", _DEFAULT_WASTE_IDS)
TRASH_CLASS_IDS = set(int(x.strip()) for x in _raw_ids.split(",") if x.strip().isdigit())
PERSON_CLASS_ID = 0

PERSON_CONF = float(os.getenv("PERSON_CONF_THRESHOLD", "0.55"))
# Bottles/cups are small for yolov8n at desk distance: 0.25 keeps them tracked frame-to-frame
# (only waste classes are used, so false alarms stay low).
TRASH_CONF  = float(os.getenv("TRASH_CONF_THRESHOLD",  "0.25"))

# ── Littering config ──────────────────────────────────────────────────────────
LITTER_CFG = LitteringConfig(
    association_dist_ph      = float(os.getenv("ASSOCIATION_DIST_PERSON_HEIGHTS", "0.5")),
    separation_dist_ph       = float(os.getenv("SEPARATION_DIST_PERSON_HEIGHTS",  "0.8")),
    departure_dist_ph        = float(os.getenv("DEPARTURE_DIST_PERSON_HEIGHTS",   "1.0")),
    tolerance_dist_ph        = float(os.getenv("TOLERANCE_DIST_PERSON_HEIGHTS",   "0.12")),
    carry_min_disp_ph        = float(os.getenv("CARRY_MIN_DISP_PERSON_HEIGHTS",   "0.3")),
    association_min_s        = float(os.getenv("ASSOCIATION_MIN_SECONDS",          "0.5")),
    dwell_seconds            = float(os.getenv("LITTER_DWELL_SECONDS",             "2.0")),
    timeout_seconds          = float(os.getenv("STATE_MACHINE_TIMEOUT_SECONDS",    "60")),
    cooldown_seconds         = float(os.getenv("VIOLATION_EVENT_COOLDOWN_SECONDS", "30")),
    grace_seconds            = float(os.getenv("TRACK_LOST_GRACE_SECONDS",         "0.7")),
    waste_grace_seconds      = float(os.getenv("WASTE_LOST_GRACE_SECONDS",         "2.5")),
    carry_comotion_threshold = float(os.getenv("CARRY_COMOTION_THRESHOLD",         "0.4")),
    born_in_hand_window_s    = float(os.getenv("BORN_IN_HAND_WINDOW_S",            "1.0")),
    audit_log_path           = os.getenv("AUDIT_LOG_PATH", "logs/littering_candidates.jsonl"),
)

# 8 s so the frames where the person faced the camera while holding the item are still
# buffered when the event is confirmed (drop -> leave -> 2 s dwell happens after that).
EVIDENCE_PRE_SECONDS = float(os.getenv("EVIDENCE_PRE_SECONDS", "8.0"))
EVIDENCE_DIR         = Path(os.getenv("EVIDENCE_DIR", "evidence_snapshots"))
EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
Path("logs").mkdir(exist_ok=True)

BACKEND_URL    = os.getenv("BACKEND_URL", "http://localhost:8000")
ENGINE_API_KEY = os.getenv("ENGINE_API_KEY", "")
MJPEG_HOST     = os.getenv("MJPEG_HOST", "0.0.0.0")
MJPEG_PORT     = int(os.getenv("MJPEG_PORT", "8001"))
FRAME_Q_SIZE   = 3
FACE_CROPS_MAX = int(os.getenv("FACE_CROPS_MAX", "6"))
PIPELINE_INTERVAL_S = 0.2  # 5 Hz


# ═══════════════════════════════════════════════════════════════════════════════
# Synthetic Waste Tracker for second-model detections
# ═══════════════════════════════════════════════════════════════════════════════

class SyntheticWasteTracker:
    """
    Lightweight centroid tracker used when a separate waste model runs without ByteTrack.
    Assigns and maintains persistent IDs based on IOU / centroid proximity.
    """
    def __init__(self, max_disappeared: int = 15, max_dist_px: float = 60.0):
        self._next_id    = 1000   # start high to avoid collision with person model IDs
        self._tracks:    Dict[int, Tuple[int,int,int,int]] = {}  # id → last bbox
        self._missing:   Dict[int, int] = {}   # id → frames_missing
        self._max_miss   = max_disappeared
        self._max_dist   = max_dist_px

    def update(self, detections: List[Tuple[int,int,int,int]]) -> List[Tuple[int, Tuple[int,int,int,int]]]:
        """Returns list of (track_id, bbox) for this frame."""
        import math
        if not detections:
            for tid in list(self._tracks):
                self._missing[tid] = self._missing.get(tid, 0) + 1
                if self._missing[tid] > self._max_miss:
                    del self._tracks[tid]
                    self._missing.pop(tid, None)
            return []

        used_dets: Set[int]  = set()
        used_trks: Set[int]  = set()
        results: List[Tuple[int, Tuple[int,int,int,int]]] = []

        def _c(b): return ((b[0]+b[2])//2, (b[1]+b[3])//2)

        # Match existing tracks to new detections
        for tid, last_bbox in self._tracks.items():
            best_d, best_i = float("inf"), -1
            lc = _c(last_bbox)
            for i, det in enumerate(detections):
                if i in used_dets:
                    continue
                dc = _c(det)
                d = math.sqrt((lc[0]-dc[0])**2 + (lc[1]-dc[1])**2)
                if d < best_d:
                    best_d, best_i = d, i
            if best_i >= 0 and best_d < self._max_dist:
                self._tracks[tid] = detections[best_i]
                self._missing.pop(tid, None)
                results.append((tid, detections[best_i]))
                used_dets.add(best_i)
                used_trks.add(tid)

        # Mark unmatched tracks as missing
        for tid in list(self._tracks):
            if tid not in used_trks:
                self._missing[tid] = self._missing.get(tid, 0) + 1
                if self._missing[tid] > self._max_miss:
                    del self._tracks[tid]
                    self._missing.pop(tid, None)

        # New detections → new tracks
        for i, det in enumerate(detections):
            if i not in used_dets:
                new_id = self._next_id
                self._next_id += 1
                self._tracks[new_id] = det
                results.append((new_id, det))

        return results


# ═══════════════════════════════════════════════════════════════════════════════
# Frame ring buffer
# ═══════════════════════════════════════════════════════════════════════════════

class FrameRingBuffer:
    def __init__(self, max_seconds: float, jpeg_quality: int = 60):
        self._max_s   = max_seconds
        self._quality = jpeg_quality
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
        with self._lock:
            if not self._buf:
                return None
            return min(self._buf, key=lambda item: abs(item[0] - target_ts))[1]

    def get_latest(self) -> Optional[bytes]:
        with self._lock:
            return self._buf[-1][1] if self._buf else None

    def snapshot(self) -> List[Tuple[float, bytes]]:
        """Copy of all buffered (timestamp, jpeg) pairs, oldest first."""
        with self._lock:
            return list(self._buf)


# ═══════════════════════════════════════════════════════════════════════════════
# MJPEG server
# ═══════════════════════════════════════════════════════════════════════════════

class MJPEGServer:
    def __init__(self, host: str, port: int):
        self._host  = host
        self._port  = port
        self._frame: Optional[bytes] = None
        self._lock  = threading.Lock()

    def push_frame(self, frame: np.ndarray):
        _, enc = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        with self._lock:
            self._frame = enc.tobytes()

    def get_frame(self) -> Optional[bytes]:
        with self._lock:
            return self._frame

    def start(self):
        threading.Thread(target=self._serve, daemon=True, name="mjpeg").start()
        print(f"[MJPEG] http://localhost:{self._port}/stream.mjpg")

    def _serve(self):
        import socket
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            srv.bind((self._host, self._port))
        except OSError as e:
            print(f"[MJPEG] Bind failed: {e}")
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
        try:
            conn.recv(4096)
            conn.sendall(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
                b"Cache-Control: no-cache\r\nConnection: close\r\n\r\n"
            )
            while True:
                frame = self.get_frame()
                if frame:
                    conn.sendall(
                        b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                        str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n"
                    )
                time.sleep(0.033)
        except Exception:
            pass
        finally:
            try: conn.close()
            except Exception: pass


# ═══════════════════════════════════════════════════════════════════════════════
# Camera Source
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
        self.backend  = ""
        self._last_backend = ""
        self._is_file = False
        self._file_frame_dt = 0.0

    def _backends(self) -> List[Tuple[str, Optional[int]]]:
        if not isinstance(CAMERA_SOURCE, int):
            return [("default", None)]                     # files / RTSP: let OpenCV choose
        table = {"msmf": cv2.CAP_MSMF, "dshow": cv2.CAP_DSHOW, "default": None}
        if CAMERA_BACKEND in table:
            return [(CAMERA_BACKEND, table[CAMERA_BACKEND])]
        order = ["msmf", "dshow", "default"] if os.name == "nt" else ["default"]
        # after a failure, start from the backend after the one that failed
        if self._last_backend in order:
            i = order.index(self._last_backend)
            order = order[i + 1:] + order[:i + 1]
        return [(n, table[n]) for n in order]

    def open(self) -> bool:
        self._is_file = isinstance(CAMERA_SOURCE, str) and not CAMERA_SOURCE.lower().startswith(("rtsp://", "http://", "https://"))
        for name, api in self._backends():
            cap = cv2.VideoCapture(CAMERA_SOURCE, api) if api is not None else cv2.VideoCapture(CAMERA_SOURCE)
            if not cap.isOpened():
                cap.release()
                continue
            if not self._is_file:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH,  CAMERA_WIDTH)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
                cap.set(cv2.CAP_PROP_FPS, 30)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)        # always read the newest frame
            # Validate: a live webcam must deliver a non-black frame within ~1 s.
            ok_frame = self._is_file or not isinstance(CAMERA_SOURCE, int)
            for _ in range(20):
                ret, f = cap.read()
                if ret and f is not None and float(f.mean()) > BLACK_MEAN_LEVEL:
                    ok_frame = True
                    break
            if not ok_frame:
                print(f"[Camera] backend={name} opened but delivers black frames - trying next")
                cap.release()
                self._saw_black = True
                continue
            self.width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            self.height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            fps = cap.get(cv2.CAP_PROP_FPS)
            self._file_frame_dt = 1.0 / fps if (self._is_file and fps and fps > 1) else 0.0
            self._cap = cap
            self._last_backend = name
            self.backend = name
            self.status = "CAMERA_READY"
            print(f"[Camera] opened source={CAMERA_SOURCE!r} backend={name} {self.width}x{self.height}")
            return True
        self.status = "CAMERA_BLACK" if getattr(self, "_saw_black", False) else "CAMERA_ERROR"
        self._saw_black = False
        print("[Camera] could not get usable frames. Is another app (Zoom/Teams/browser) using the "
              "webcam, or is the privacy shutter closed?")
        return False

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
                # Keep trying to (re)acquire the camera instead of giving up after one failure.
                if self.status != "CAMERA_BLACK":
                    self.status = "CAMERA_ERROR"
                time.sleep(3.0)
                if self._running:
                    self.open()
                continue
            ret, frame = self._cap.read()
            if self._is_file:
                time.sleep(self._file_frame_dt)  # play recorded clips at real-time speed
            if not ret and self._is_file and CAMERA_LOOP:
                self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # replay the demo clip
                continue
            if not ret:
                fails += 1
                if fails > 30:
                    self.status = "CAMERA_ERROR"
                time.sleep(0.02)
                continue
            fails = 0
            # Black-frame watchdog (live cameras only): reopen instead of silently feeding black.
            if not self._is_file and float(frame.mean()) <= BLACK_MEAN_LEVEL:
                now_t = time.time()
                self._black_since = getattr(self, "_black_since", 0.0) or now_t
                if now_t - self._black_since > CAMERA_BLACK_SECONDS:
                    self.status = "CAMERA_BLACK"
                    print(f"[Camera] black frames for {CAMERA_BLACK_SECONDS:.0f}s on backend={self.backend} - reopening")
                    self._cap.release()
                    self._black_since = 0.0
                    if not self.open():
                        time.sleep(2.0)
                    continue
            else:
                self._black_since = 0.0
                if self.status == "CAMERA_BLACK":
                    self.status = "CAMERA_READY"
            self.tel.record_camera_frame()
            try:
                self.q.put_nowait(frame)
            except queue.Full:
                self.tel.dropped_frames += 1


# ═══════════════════════════════════════════════════════════════════════════════
# Evidence Writer
# ═══════════════════════════════════════════════════════════════════════════════

class EvidenceWriter:
    def __init__(self):
        self._q      = queue.Queue()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="evidence")

    def start(self):
        self._thread.start()

    def submit(self, job: dict):
        try:
            self._q.put_nowait(job)
        except queue.Full:
            pass

    def _loop(self):
        while True:
            job = self._q.get()
            try:
                self._write(job)
            except Exception as e:
                print(f"[Evidence] {e}")

    def _write(self, job: dict):
        ev:     LitteringEvent   = job["event"]
        ring:   FrameRingBuffer  = job["ring"]
        cam_w:  int              = job.get("cam_w", 1280)
        cam_h:  int              = job.get("cam_h", 720)
        t_assoc: float = job["t_assoc"]
        t_drop:  float = job["t_drop"]

        event_dir = EVIDENCE_DIR / ev.event_id[:8]
        event_dir.mkdir(parents=True, exist_ok=True)

        saved: List[str] = []
        for label, ts in [("1_assoc", t_assoc), ("2_drop", t_drop), ("3_confirmed", ev.timestamp)]:
            raw = ring.get_frame_at(ts)
            if raw is None:
                continue
            arr = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
            if arr is None:
                continue
            fh, fw = arr.shape[:2]

            def _draw_box(bbox, color, lbl):
                """Clip coords to frame bounds before drawing (evidence box fix, item 6)."""
                x1 = max(0, min(int(bbox[0]), fw-1))
                y1 = max(0, min(int(bbox[1]), fh-1))
                x2 = max(x1+1, min(int(bbox[2]), fw))
                y2 = max(y1+1, min(int(bbox[3]), fh))
                cv2.rectangle(arr, (x1,y1),(x2,y2), color, 2)
                cv2.putText(arr, lbl, (x1, max(y1-5, 12)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

            _draw_box(ev.person_bbox, (0,255,255), f"P#{ev.person_track_id}")
            _draw_box(ev.waste_bbox,  (0,0,255),   f"W#{ev.waste_track_id}")
            ts_str = datetime.fromtimestamp(ts).strftime("%H:%M:%S.%f")[:12]
            cv2.putText(arr, f"{label}  {ts_str}", (8, fh-10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0,255,80), 1)

            out = event_dir / f"{label}.jpg"
            cv2.imwrite(str(out), arr, [cv2.IMWRITE_JPEG_QUALITY, 88])
            saved.append(str(out))

        meta = {
            "event_id":        ev.event_id,
            "camera_id":       ev.camera_id,
            "timestamp":       datetime.fromtimestamp(ev.timestamp, tz=timezone.utc).isoformat(),
            "action_label":    ev.action_label.value,
            "event_confidence": ev.event_confidence,
            "person_track_id": ev.person_track_id,
            "waste_track_id":  ev.waste_track_id,
            "location": {"name": CAMERA_LOC, "latitude": CAMERA_LAT,
                         "longitude": CAMERA_LNG, "ward": CAMERA_WARD},
            "score_breakdown": {
                "association":    ev.association_score,
                "separation":     ev.separation_score,
                "stationary":     ev.stationary_score,
                "departure":      ev.departure_score,
                "dwell_actual_s": ev.dwell_actual_s,
            },
            "key_frames":      saved,
            "identity_status": "PENDING",
        }
        (event_dir / "event.json").write_text(json.dumps(meta, indent=2))
        print(f"[Evidence] {event_dir}/ ({len(saved)} frames)")


# ═══════════════════════════════════════════════════════════════════════════════
# Waste Track Stitcher (v2: new IDs only, person-height scaled tolerance)
# ═══════════════════════════════════════════════════════════════════════════════

class WasteTrackStitcher:
    """
    Maps a newly appearing ByteTrack waste ID onto a recently lost one if within
    STITCH_TOL_PH × person_height distance.

    Rules (item 5 fix):
      - Only runs if track_id has never been seen before (truly new).
      - Tolerance scales with person_height_px (not a fixed pixel value).
      - Cleans up stale lost-track records before resolving.
    """
    STITCH_GRACE_S = 3.0
    STITCH_TOL_PH  = 0.4   # fraction of person bbox height

    def __init__(self):
        self._lost:    Dict[int, Tuple[Tuple[int,int], float]] = {}  # old_id → (center, ts)
        self._alias:   Dict[int, int] = {}   # new_id → canonical old_id
        self._seen:    Set[int] = set()       # all IDs ever observed

    def mark_lost(self, track_id: int, center: Tuple[int,int], ts: float):
        self._lost[track_id] = (center, ts)

    def resolve(self, track_id: int, center: Tuple[int,int], ts: float,
                person_height_px: float = 80.0) -> int:
        """Returns canonical track ID."""
        # If already aliased, follow alias
        if track_id in self._alias:
            return self._alias[track_id]

        # Only stitch IDs that are genuinely new
        if track_id in self._seen:
            self._seen.add(track_id)
            return track_id
        self._seen.add(track_id)

        # Clean up stale lost entries first
        self._cleanup(ts)

        import math
        tol_px = max(person_height_px * self.STITCH_TOL_PH, 20.0)
        best_id, best_dist = None, float("inf")
        for old_id, (old_center, lost_ts) in self._lost.items():
            if (ts - lost_ts) > self.STITCH_GRACE_S:
                continue
            d = math.sqrt((center[0]-old_center[0])**2 + (center[1]-old_center[1])**2)
            if d < tol_px and d < best_dist:
                best_id, best_dist = old_id, d

        if best_id is not None:
            print(f"[Stitch] W#{track_id} → W#{best_id} ({best_dist:.0f}px < {tol_px:.0f}px)")
            self._alias[track_id] = best_id
            del self._lost[best_id]
            return best_id

        return track_id

    def _cleanup(self, now: float):
        stale = [k for k, (_, ts) in self._lost.items()
                 if (now - ts) > self.STITCH_GRACE_S * 2]
        for k in stale:
            del self._lost[k]


# ═══════════════════════════════════════════════════════════════════════════════
# Vision Engine v5
# ═══════════════════════════════════════════════════════════════════════════════

class VisionEngine:

    def __init__(self):
        init_logger(LITTER_CFG.audit_log_path)

        self.person_model = None
        self.waste_model  = None   # None if same as person_model

        self.telemetry = TelemetryCollector(interval_s=2.0)
        self.frame_q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=FRAME_Q_SIZE)
        self.camera   = CameraSource(self.frame_q, self.telemetry)

        self.ring     = FrameRingBuffer(EVIDENCE_PRE_SECONDS, jpeg_quality=85)
        self.mjpeg    = MJPEGServer(MJPEG_HOST, MJPEG_PORT)
        self.writer   = EvidenceWriter()
        self.zones    = ZoneChecker.load("backend/camera_zones.json", CAMERA_ID)
        self.stitcher = WasteTrackStitcher()
        self.synth_tracker = SyntheticWasteTracker()

        self._running = False
        # Per-person-track recent (timestamp, bbox) so the offender's head can be cropped
        # from earlier frames at event time (no continuous face processing).
        self._person_hist: Dict[int, Deque[Tuple[float, Tuple[int, int, int, int]]]] = {}
        self._post_fail_logged: Dict[str, float] = {}
        self._http    = httpx.Client(
            timeout=10.0,
            headers={"X-Engine-API-Key": ENGINE_API_KEY} if ENGINE_API_KEY else {},
        )

        # SM pool
        self._sm_pool:       Dict[Tuple[int,int], LitteringStateMachine] = {}
        self._terminal_time: Dict[Tuple[int,int], float] = {}

        # Waste track histories (A4 carry evidence)
        self._waste_hist: Dict[int, WasteTrackHistory] = {}

        # Key timestamps for 3-frame evidence
        self._ev_t_assoc: Dict[Tuple[int,int], float] = {}
        self._ev_t_drop:  Dict[Tuple[int,int], float] = {}

        # Pipeline state (A9)
        self._pipeline_state: Dict[str, Any] = {}
        self._pipeline_lock   = threading.Lock()

    # ── Status ────────────────────────────────────────────────────────────────

    def _safe_post(self, path: str, payload: dict, timeout: float, label: str, retries: int = 0) -> bool:
        """POST to the backend, checking the HTTP status. Failures are logged (rate-limited
        per label so a down backend doesn't flood the console); optional retries with backoff."""
        last = ""
        for attempt in range(retries + 1):
            try:
                r = self._http.post(f"{BACKEND_URL}{path}", json=payload, timeout=timeout)
                if r.status_code < 300:
                    self._post_fail_logged.pop(label, None)
                    return True
                last = f"HTTP {r.status_code}" + (" (check ENGINE_API_KEY)" if r.status_code in (401, 403) else "")
                if r.status_code < 500:
                    break  # client error: retrying won't help
            except Exception as e:
                last = str(e)
            if attempt < retries:
                time.sleep(min(2 ** attempt, 8))
        now = time.time()
        if now - self._post_fail_logged.get(label, 0) > 30:
            self._post_fail_logged[label] = now
            print(f"[Engine] {label} POST failed: {last}")
        return False

    def _post_status(self, stage: str, msg: str, error: bool = False):
        print(f"[Boot] {stage}: {msg}")
        self._safe_post("/api/vision/status", {
            "stage": stage, "message": msg, "error": error, "camera_id": CAMERA_ID,
        }, 3.0, "status")

    def _telemetry_loop(self):
        while self._running:
            time.sleep(2.0)
            snap = self.telemetry.get_snapshot()
            snap.update({"type": "node_health", "camera_id": CAMERA_ID,
                         "camera_status": self.camera.status,
                         "camera_resolution": f"{self.camera.width}x{self.camera.height}"})
            self._safe_post("/api/vision/telemetry", snap, 2.0, "telemetry")

    def _pipeline_loop(self):
        while self._running:
            time.sleep(PIPELINE_INTERVAL_S)
            with self._pipeline_lock:
                state = dict(self._pipeline_state)
            if not state:
                continue
            self._safe_post("/api/vision/pipeline_state", state, 1.0, "pipeline_state")

    # ── Model loading ─────────────────────────────────────────────────────────

    def _load_models(self) -> bool:
        self._post_status("STARTING",
            f"person={PERSON_MODEL_PATH} waste={WASTE_MODEL_PATH} dual={DUAL_MODEL}")
        try:
            from ultralytics import YOLO
            self.person_model = YOLO(PERSON_MODEL_PATH)
            if DUAL_MODEL:
                self.waste_model = YOLO(WASTE_MODEL_PATH)
                print(f"[Engine] Running DUAL model: person={PERSON_MODEL_PATH} waste={WASTE_MODEL_PATH}")
            else:
                self.waste_model = None
                print(f"[Engine] Single model for both person + waste: {PERSON_MODEL_PATH}")

            # Warm-up
            dummy = np.zeros((480, 640, 3), dtype=np.uint8)
            all_cls = [PERSON_CLASS_ID] + ([] if DUAL_MODEL else list(TRASH_CLASS_IDS))
            self.person_model.track(source=dummy, persist=True, verbose=False, imgsz=YOLO_IMGSZ,
                                    tracker="bytetrack.yaml", classes=all_cls)
            if DUAL_MODEL and self.waste_model:
                self.waste_model.predict(source=dummy, verbose=False, imgsz=YOLO_IMGSZ,
                                         classes=list(TRASH_CLASS_IDS))

            self._post_status("YOLO_READY",
                f"Ready | waste_classes={sorted(TRASH_CLASS_IDS)} | dual={DUAL_MODEL}")
            return True
        except ImportError:
            self._post_status("YOLO_ERROR", "ultralytics not installed", error=True)
            return False
        except Exception as e:
            self._post_status("YOLO_ERROR", f"Load failed: {e}", error=True)
            return False

    # ── SM pool ───────────────────────────────────────────────────────────────

    def _pair_in_cooldown(self, pid: int, wid: int, now: float) -> bool:
        return (now - self._terminal_time.get((pid, wid), 0)) < LITTER_CFG.cooldown_seconds

    def _proximity_check(self, p: dict, w: dict) -> bool:
        ph    = max(p["bbox"][3] - p["bbox"][1], 10)
        assoc = ph * LITTER_CFG.association_dist_ph
        return _eucl(p["center"], w["center"]) <= assoc

    def _create_sm(self, pid: int, wid: int, initial_det: FrameDetection) -> LitteringStateMachine:
        sm = LitteringStateMachine(
            person_track_id=pid, waste_track_id=wid,
            camera_id=CAMERA_ID, cfg=LITTER_CFG,
            initial_det=initial_det,
            zones=self.zones,          # A5-in-SM
        )
        self._sm_pool[(pid, wid)] = sm
        return sm

    def _prune_pool(self, now: float):
        for k, sm in list(self._sm_pool.items()):
            if sm.is_terminal:
                self._terminal_time[k] = now
                del self._sm_pool[k]

    # ── A4 carry evidence helpers ─────────────────────────────────────────────

    def _waste_stationary_before(self, wid: int) -> bool:
        hist = self._waste_hist.get(wid)
        if hist is None:
            return False
        ph_approx = 80.0
        tol = ph_approx * LITTER_CFG.tolerance_dist_ph
        return hist.was_stationary(window_s=LITTER_CFG.association_min_s * 3, tol_px=tol)

    def _waste_born_in_hand(self, wid: int, wc: Tuple[int,int],
                             pb: Tuple[int,int,int,int],
                             assoc_start_ts: float) -> bool:
        """
        A4-rework timestamp-based born-in-hand check.
        True if:
          - waste track is young (first_seen within born_in_hand_window_s of assoc start), AND
          - the waste center was inside the person bbox at the time it first appeared.
        """
        hist = self._waste_hist.get(wid)
        if hist is None:
            return False
        age = assoc_start_ts - hist.first_seen
        if age > LITTER_CFG.born_in_hand_window_s:
            return False
        # Use the first recorded center (most accurate for birth position)
        if hist.centers:
            birth_c = hist.centers[0]
            return (pb[0] <= birth_c[0] <= pb[2] and pb[1] <= birth_c[1] <= pb[3])
        # Fall back to current center
        return (pb[0] <= wc[0] <= pb[2] and pb[1] <= wc[1] <= pb[3])

    # ── Frame processing ──────────────────────────────────────────────────────

    def _process_frame(self, frame: np.ndarray, now: float) -> np.ndarray:
        if self.person_model is None:
            return frame

        t0      = time.perf_counter()
        display = frame.copy()
        fh, fw  = frame.shape[:2]

        # ── Person detection + tracking (always ByteTrack) ────────────────────
        person_classes = [PERSON_CLASS_ID] if DUAL_MODEL else [PERSON_CLASS_ID] + list(TRASH_CLASS_IDS)
        p_results = self.person_model.track(
            source=frame, persist=True, tracker="bytetrack.yaml", imgsz=YOLO_IMGSZ,
            verbose=False, classes=person_classes,
        )

        persons:    List[dict] = []
        raw_wastes: List[dict] = []   # waste from single-model path

        if p_results and p_results[0].boxes is not None:
            for box in p_results[0].boxes:
                cls  = int(box.cls[0])
                conf = float(box.conf[0])
                tid  = int(box.id[0]) if box.id is not None else -1
                if tid < 0:
                    continue
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                cx, cy = (x1+x2)//2, (y1+y2)//2
                if cls == PERSON_CLASS_ID and conf >= PERSON_CONF:
                    ph = max(y2-y1, 10)
                    persons.append({"id": tid, "bbox": (x1,y1,x2,y2), "center": (cx,cy), "ph": ph, "conf": conf})
                    cv2.rectangle(display, (x1,y1),(x2,y2), (0,255,255), 2)
                    cv2.putText(display, f"P#{tid} {conf:.2f}", (x1,y1-6),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0,255,255), 1)
                elif not DUAL_MODEL and cls in TRASH_CLASS_IDS and conf >= TRASH_CONF:
                    raw_wastes.append({"id": tid, "bbox": (x1,y1,x2,y2), "center": (cx,cy),
                                       "conf": conf, "label": self.person_model.names.get(cls, str(cls))})

        self._update_person_history(persons, now)

        # ── Waste detection: second model path ────────────────────────────────
        if DUAL_MODEL and self.waste_model is not None:
            w_results = self.waste_model.predict(
                source=frame, verbose=False, imgsz=YOLO_IMGSZ, classes=list(TRASH_CLASS_IDS),
            )
            waste_bboxes: List[Tuple[int,int,int,int]] = []
            if w_results and w_results[0].boxes is not None:
                for box in w_results[0].boxes:
                    if float(box.conf[0]) < TRASH_CONF:
                        continue
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    waste_bboxes.append((x1, y1, x2, y2))

            synth_tracks = self.synth_tracker.update(waste_bboxes)
            for (tid, (x1,y1,x2,y2)) in synth_tracks:
                cx, cy = (x1+x2)//2, (y1+y2)//2
                raw_wastes.append({"id": tid, "bbox": (x1,y1,x2,y2), "center": (cx,cy)})

        # ── Stitch + update waste histories ──────────────────────────────────
        person_height_avg = (sum(p["ph"] for p in persons) / len(persons)) if persons else 80.0

        wastes: List[dict] = []
        for rw in raw_wastes:
            canonical_id = self.stitcher.resolve(
                rw["id"], rw["center"], now, person_height_avg
            )
            rw["id"] = canonical_id
            if canonical_id not in self._waste_hist:
                # New track: record born_inside_person flag (A4 timestamp)
                born_inside = any(
                    p["bbox"][0] <= rw["center"][0] <= p["bbox"][2] and
                    p["bbox"][1] <= rw["center"][1] <= p["bbox"][3]
                    for p in persons
                )
                hist = WasteTrackHistory(track_id=canonical_id, first_seen=now)
                hist.born_inside_person_bbox = born_inside
                self._waste_hist[canonical_id] = hist
            self._waste_hist[canonical_id].update(rw["center"], rw["bbox"], now)
            wastes.append(rw)

            cv2.rectangle(display, rw["bbox"][:2], rw["bbox"][2:], (0,0,255), 2)
            cx, cy = rw["center"]
            cv2.putText(display, f"W#{canonical_id}", (rw["bbox"][0], rw["bbox"][1]-6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0,0,255), 1)

        # Mark lost wastes for stitcher
        observed_ids = {w["id"] for w in wastes}
        for wid, hist in self._waste_hist.items():
            if wid not in observed_ids and (now - hist.last_seen) < 6.0 and hist.last_bbox:
                cx = (hist.last_bbox[0]+hist.last_bbox[2])//2
                cy = (hist.last_bbox[1]+hist.last_bbox[3])//2
                self.stitcher.mark_lost(wid, (cx,cy), hist.last_seen)

        # ── Build FrameDetection and update SMs ──────────────────────────────
        person_ids = {p["id"] for p in persons}
        waste_ids  = {w["id"] for w in wastes}

        for person in persons:
            for waste in wastes:
                pid, wid = person["id"], waste["id"]
                key = (pid, wid)
                if self._pair_in_cooldown(pid, wid, now):
                    continue
                sm = self._sm_pool.get(key)
                if sm is None:
                    if not self._proximity_check(person, waste):
                        continue
                    # A4 rework: timestamp-based born-in-hand
                    born = self._waste_born_in_hand(
                        wid, waste["center"], person["bbox"], assoc_start_ts=now)
                    initial = FrameDetection(
                        timestamp=now,
                        person_present=True, person_bbox=person["bbox"],
                        person_center=person["center"], person_height_px=person["ph"],
                        waste_present=True, waste_bbox=waste["bbox"],
                        waste_center=waste["center"],
                        waste_was_stationary_before_person=self._waste_stationary_before(wid),
                        waste_born_in_person_bbox=born,
                        frame_width=fw, frame_height=fh,
                    )
                    self._create_sm(pid, wid, initial)
                    self._ev_t_assoc[key] = now
                    continue

                if sm.is_terminal:
                    continue

                det = FrameDetection(
                    timestamp=now,
                    person_present=True, person_bbox=person["bbox"],
                    person_center=person["center"], person_height_px=person["ph"],
                    waste_present=True, waste_bbox=waste["bbox"],
                    waste_center=waste["center"],
                    frame_width=fw, frame_height=fh,
                )
                result = sm.update(det)
                self._record_timestamps(sm, key, now)
                self._handle_event(result, key, now)
                self._render_hud(display, sm, waste, fh)

        # Update SMs where one track disappeared
        for (pid, wid), sm in list(self._sm_pool.items()):
            if sm.is_terminal:
                continue
            if pid in person_ids and wid in waste_ids:
                continue
            p_dat = next((p for p in persons if p["id"] == pid), None)
            w_dat = next((w for w in wastes  if w["id"] == wid), None)
            ph    = p_dat["ph"] if p_dat else 80.0
            det = FrameDetection(
                timestamp=now,
                person_present=p_dat is not None,
                person_bbox=p_dat["bbox"]   if p_dat else None,
                person_center=p_dat["center"] if p_dat else None,
                person_height_px=ph,
                waste_present=w_dat is not None,
                waste_bbox=w_dat["bbox"]   if w_dat else None,
                waste_center=w_dat["center"] if w_dat else None,
                frame_width=fw, frame_height=fh,
            )
            result = sm.update(det)
            self._record_timestamps(sm, (pid, wid), now)
            self._handle_event(result, (pid, wid), now)

        self._prune_pool(now)
        self._update_pipeline_state(persons, wastes, now, fw, fh)

        # Zone overlays
        for poly in self.zones.get_zones_for_overlay()["bin_zones"]:
            pts = np.array([[int(x*fw), int(y*fh)] for x,y in poly], np.int32)
            cv2.polylines(display, [pts], True, (0,200,0), 2)
        for poly in self.zones.get_zones_for_overlay().get("no_litter_zones", []):
            pts = np.array([[int(x*fw), int(y*fh)] for x,y in poly], np.int32)
            cv2.polylines(display, [pts], True, (0,0,200), 2)

        # HUD
        snap = self.telemetry.get_snapshot()
        self.telemetry.queue_size = self.frame_q.qsize()
        cv2.putText(display,
            f"EcoWatch v5 | {CAMERA_ID} | {datetime.now().strftime('%H:%M:%S')}",
            (8, fh-8), cv2.FONT_HERSHEY_SIMPLEX, 0.40, (16,185,129), 1)
        cv2.putText(display,
            f"CAM:{snap['camera_fps']}fps  AI:{snap['inference_fps']}fps  "
            f"Lat:{snap['inference_latency_ms']}ms  Drop:{snap['dropped_frames']}  SMs:{len(self._sm_pool)}",
            (8,20), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (200,200,200), 1)
        cv2.putText(display,
            f"P:{len(persons)} W:{len(wastes)}  dual={DUAL_MODEL}  cls={sorted(TRASH_CLASS_IDS)}",
            (8,36), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (200,200,200), 1)

        self.telemetry.record_inference((time.perf_counter()-t0)*1000)
        return display

    def _record_timestamps(self, sm: LitteringStateMachine, key: Tuple[int,int], now: float):
        if sm.state == LitterState.OBJECT_ASSOCIATED and key not in self._ev_t_assoc:
            self._ev_t_assoc[key] = now
        if sm.state == LitterState.OBJECT_DROPPED and key not in self._ev_t_drop:
            self._ev_t_drop[key] = now

    def _render_hud(self, display: np.ndarray, sm: LitteringStateMachine, waste: dict, fh: int):
        x1, y1, x2, y2 = waste["bbox"]
        col = (0,220,80) if sm.state == LitterState.LITTERING_CONFIRMED else (200,140,0)
        cv2.putText(display, sm.state.value, (x1, min(y2+14, fh-4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, col, 1)
        if sm.dwell_progress > 0:
            bar_w = int((x2-x1) * sm.dwell_progress)
            cv2.rectangle(display, (x1, y2+2), (x1+bar_w, min(y2+7, fh-1)), (255,140,0), -1)

    def _update_pipeline_state(self, persons, wastes, now: float, fw: int = 0, fh: int = 0):
        active = [{"person_id": pid, "waste_id": wid,
                   "state": sm.state.value, "dwell_progress": round(sm.dwell_progress, 2)}
                  for (pid, wid), sm in self._sm_pool.items()]

        def _norm(b):  # pixel bbox -> 0..1 so the UI can draw it at any size
            if not fw or not fh:
                return list(b)
            return [round(b[0] / fw, 4), round(b[1] / fh, 4), round(b[2] / fw, 4), round(b[3] / fh, 4)]

        # Live detections of THIS frame (real YOLO + ByteTrack output; no images over WS).
        detections = [
            {"kind": "person", "track_id": p["id"], "label": "person",
             "conf": round(p.get("conf", 0.0), 3), "bbox": _norm(p["bbox"])}
            for p in persons[:15]
        ] + [
            {"kind": "waste", "track_id": w["id"], "label": w.get("label", "waste"),
             "conf": round(w["conf"], 3) if w.get("conf") is not None else None, "bbox": _norm(w["bbox"])}
            for w in wastes[:15]
        ]
        with self._pipeline_lock:
            self._pipeline_state = {
                "type": "pipeline_state", "camera_id": CAMERA_ID,
                "timestamp": now, "person_count": len(persons),
                "waste_count": len(wastes), "active_machines": active,
                "detections": detections,
            }

    def _update_person_history(self, persons: List[dict], now: float):
        for p in persons:
            h = self._person_hist.setdefault(p["id"], deque())
            h.append((now, p["bbox"]))
        cutoff = now - (EVIDENCE_PRE_SECONDS + 1.0)
        for tid in list(self._person_hist):
            h = self._person_hist[tid]
            while h and h[0][0] < cutoff:
                h.popleft()
            if not h:
                del self._person_hist[tid]

    def _collect_face_crops(self, person_tid: int, max_crops: int = FACE_CROPS_MAX) -> List[str]:
        """
        Head/upper-body crops of the RESPONSIBLE person track taken from the pre-event ring
        buffer (base64 JPEG). Only runs once per confirmed event. The backend performs the
        actual face detection / quality gate / recognition.
        """
        hist = list(self._person_hist.get(person_tid, []))
        frames = self.ring.snapshot()
        if not hist or not frames:
            return []
        step = max(1, len(frames) // (max_crops * 2))
        crops: List[Tuple[float, str]] = []
        for ts, jpg in frames[::step]:
            # nearest tracked bbox in time for this person
            t_b, bbox = min(hist, key=lambda it: abs(it[0] - ts))
            if abs(t_b - ts) > 0.25:
                continue
            arr = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
            if arr is None:
                continue
            fh, fw = arr.shape[:2]
            x1, y1, x2, y2 = bbox
            bw, bh = x2 - x1, y2 - y1
            # head region: top ~45% of the person box, widened a little
            cx1 = max(0, int(x1 - 0.15 * bw)); cx2 = min(fw, int(x2 + 0.15 * bw))
            cy1 = max(0, int(y1 - 0.05 * bh)); cy2 = min(fh, int(y1 + 0.45 * bh))
            if cx2 - cx1 < 40 or cy2 - cy1 < 40:
                continue
            crop = arr[cy1:cy2, cx1:cx2]
            ok, enc = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
            if ok:
                # prefer larger crops (closer / better resolution)
                crops.append((crop.shape[0] * crop.shape[1], base64.b64encode(enc.tobytes()).decode()))
        crops.sort(key=lambda c: c[0], reverse=True)
        return [c[1] for c in crops[:max_crops]]

    def _handle_event(self, ev: Optional[LitteringEvent], key: Tuple[int,int], now: float):
        if ev is None:
            return

        # A5 bin-zone check is now inside SM; if we still get a PLACE_IN_BIN returned
        # (shouldn't, but guard):
        if ev.action_label == ActionLabel.PLACE_IN_BIN:
            print(f"[Engine] PLACE_IN_BIN event — suppressed (waste in bin zone).")
            return

        t_assoc = self._ev_t_assoc.get(key, now - LITTER_CFG.dwell_seconds - 2)
        t_drop  = self._ev_t_drop.get(key, now - LITTER_CFG.dwell_seconds)

        self.writer.submit({
            "event": ev, "ring": self.ring,
            "cam_w": self.camera.width, "cam_h": self.camera.height,
            "t_assoc": t_assoc, "t_drop": t_drop,
        })

        rel_evidence = f"{ev.event_id[:8]}"
        print(f"\n{'='*64}")
        print(f"[LITTERING CONFIRMED] {ev.event_id[:8]}")
        print(f"  P#{ev.person_track_id} + W#{ev.waste_track_id} | "
              f"conf={ev.event_confidence:.1%} | dwell={ev.dwell_actual_s:.1f}s")
        print(f"  action={ev.action_label.value} | identity=PENDING")
        print(f"  evidence_dir=evidence_snapshots/{rel_evidence}/")
        print(f"{'='*64}\n")

        payload = {
            "type":             "littering_event",
            "event_id":         ev.event_id,
            "camera_id":        ev.camera_id,
            "timestamp":        datetime.fromtimestamp(ev.timestamp, tz=timezone.utc).isoformat(),
            "location": {"name": CAMERA_LOC, "latitude": CAMERA_LAT,
                         "longitude": CAMERA_LNG, "ward": CAMERA_WARD},
            "person_track_id":  ev.person_track_id,
            "waste_track_id":   ev.waste_track_id,
            "person_bbox":      list(ev.person_bbox),
            "waste_bbox":       list(ev.waste_bbox),
            "event_confidence": ev.event_confidence,
            "action_label":     ev.action_label.value,
            "identity_status":  "PENDING",
            "confidence_breakdown": {
                "association":    ev.association_score,
                "separation":     ev.separation_score,
                "stationary":     ev.stationary_score,
                "departure":      ev.departure_score,
                "dwell_seconds":  ev.dwell_actual_s,
            },
            "evidence_dir": rel_evidence,   # served via /evidence/ route
            # Head crops of the responsible person for the backend's identity pipeline.
            "face_crops": self._collect_face_crops(ev.person_track_id),
        }
        threading.Thread(target=self._post_event, args=(payload,), daemon=True).start()

    def _post_event(self, payload: dict):
        # Confirmed violations matter: retry with backoff (evidence is already on disk regardless).
        if not self._safe_post("/api/littering_event", payload, 10.0, "littering_event", retries=4):
            print(f"[Engine] Event {payload.get('event_id')} NOT delivered; evidence kept at {payload.get('evidence_dir')}")

    # ── Run ───────────────────────────────────────────────────────────────────

    def run(self):
        print(f"\n[EcoWatch v5] dual_model={DUAL_MODEL} | SHOW_WINDOW={SHOW_WINDOW} | "
              f"capture={CAMERA_WIDTH}x{CAMERA_HEIGHT} | yolo_imgsz={YOLO_IMGSZ}")
        print(f"[EcoWatch v5] waste_classes={sorted(TRASH_CLASS_IDS)}")

        if not self._load_models():
            return

        self._post_status("CAMERA_READY", f"Opening {CAMERA_SOURCE!r}")
        if not self.camera.open():
            # Don't exit: the camera thread keeps retrying every few seconds (privacy shutter,
            # dark room, or another app holding the webcam), and the UI shows CAMERA OFFLINE.
            self._post_status("CAMERA_ERROR",
                f"Cannot get frames from {CAMERA_SOURCE!r} yet - retrying automatically "
                f"(check the lens/shutter/lighting and that no other app uses the webcam).", error=True)

        if self.camera.status == "CAMERA_READY":
            self._post_status("CAMERA_READY",
                f"{CAMERA_ID} | {self.camera.width}x{self.camera.height}")
        self._post_status("TRACKER_READY", "ByteTrack + WasteTrackStitcher v2")
        self._post_status("EVENT_ENGINE_READY",
            f"SM v3 | dwell={LITTER_CFG.dwell_seconds}s | grace={LITTER_CFG.grace_seconds}s")

        self.telemetry.start()
        self.camera.start()
        self.writer.start()
        self.mjpeg.start()
        self._running = True

        threading.Thread(target=self._telemetry_loop, daemon=True).start()
        threading.Thread(target=self._pipeline_loop,  daemon=True).start()

        self._post_status("SYSTEM_READY",
            f"MJPEG=http://localhost:{MJPEG_PORT}/stream.mjpg | "
            f"dual={DUAL_MODEL} | Identity=PENDING")

        try:
            while self._running:
                try:
                    frame = self.frame_q.get(timeout=2.0)
                    now   = time.time()
                except queue.Empty:
                    continue
                self.ring.push(frame, now)
                display = self._process_frame(frame, now)
                self.mjpeg.push_frame(display)
                if SHOW_WINDOW:
                    cv2.imshow(f"EcoWatch v5 — {CAMERA_ID}", display)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        break
        except KeyboardInterrupt:
            print("[EcoWatch v5] Ctrl+C received - shutting down cleanly.")
        finally:
            self._running = False
            self.camera.stop()
            self.telemetry.stop()
            self._http.close()
            if SHOW_WINDOW:
                cv2.destroyAllWindows()
            print("[EcoWatch v5] Stopped.")


def _eucl(a, b) -> float:
    import math
    return math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2)


if __name__ == "__main__":
    try:
        VisionEngine().run()
    except KeyboardInterrupt:
        print("[EcoWatch v5] Stopped.")
