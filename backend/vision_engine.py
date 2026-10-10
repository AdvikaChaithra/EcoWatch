"""
EcoWatch Vision Engine v3 — Part 1: Littering Detection Only
=============================================================
Part 1 stops at confirmed littering event. No face recognition.
Identity status is always "PENDING" — Part 2 handles ArcFace.

Architecture:
  CameraSource (thread) → bounded frame queue (maxsize=3)
  → InferenceLoop (main thread) → YOLO + ByteTrack
  → LitteringStateMachine pool → LitteringEvent
  → evidence snapshot + FastAPI POST /api/littering_event

ZERO mocked values. If camera fails → CAMERA_ERROR. If YOLO fails → YOLO_ERROR.

Run:
    python -m backend.vision_engine

Requires:
    pip install ultralytics opencv-python numpy httpx psutil python-dotenv
"""

from __future__ import annotations

import base64
import os
import queue
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import httpx
import numpy as np
from dotenv import load_dotenv

from backend.littering_detector import (
    FrameDetection, LitteringConfig, LitteringEvent,
    LitteringStateMachine, LitterState,
)
from backend.telemetry import TelemetryCollector

load_dotenv()

# ── Camera config ─────────────────────────────────────────────────────────────
_SRC      = os.getenv("CAMERA_SOURCE", "0")
CAMERA_SOURCE   = int(_SRC) if _SRC.isdigit() else _SRC
CAMERA_ID       = os.getenv("CAMERA_ID", "CAM_01")
CAMERA_NAME     = os.getenv("CAMERA_NAME", "EcoWatch Test Camera")
CAMERA_LAT      = float(os.getenv("CAMERA_LATITUDE",  "12.9783"))
CAMERA_LNG      = float(os.getenv("CAMERA_LONGITUDE", "77.6408"))
CAMERA_LOCATION = os.getenv("CAMERA_LOCATION_NAME", "Test Location")
CAMERA_WARD     = os.getenv("CAMERA_WARD", "")

# ── Detection thresholds ──────────────────────────────────────────────────────
PERSON_CONF = float(os.getenv("PERSON_CONF_THRESHOLD", "0.55"))
TRASH_CONF  = float(os.getenv("TRASH_CONF_THRESHOLD",  "0.45"))

# ── Littering config ──────────────────────────────────────────────────────────
LITTER_CFG = LitteringConfig(
    association_distance_px = float(os.getenv("ASSOCIATION_DISTANCE_PIXELS", "80")),
    separation_distance_px  = float(os.getenv("SEPARATION_DISTANCE_PIXELS", "120")),
    person_departure_px     = float(os.getenv("PERSON_DEPARTURE_PIXELS", "150")),
    position_tolerance_px   = float(os.getenv("WASTE_POSITION_TOLERANCE_PIXELS", "25")),
    dwell_seconds           = float(os.getenv("LITTER_DWELL_SECONDS", "2.0")),
    association_min_frames  = int(os.getenv("ASSOCIATION_MIN_FRAMES", "10")),
    timeout_seconds         = float(os.getenv("STATE_MACHINE_TIMEOUT_SECONDS", "45")),
    cooldown_seconds        = float(os.getenv("VIOLATION_EVENT_COOLDOWN_SECONDS", "30")),
    camera_fps              = 30.0,
)

BACKEND_URL    = os.getenv("BACKEND_URL", "http://localhost:8000")
FRAME_Q_SIZE   = 3       # drop old frames to stay low-latency

# YOLO COCO class IDs for litter objects:
# bottle(39), cup(41), bowl(45), backpack(26), suitcase(28), cell phone(67), book(73)
TRASH_CLASS_IDS = {39, 41, 45, 26, 28, 67, 73}
PERSON_CLASS_ID = 0

EVIDENCE_DIR = Path("evidence_snapshots")
EVIDENCE_DIR.mkdir(exist_ok=True)


# ═══════════════════════════════════════════════════════════════════════════════
# Camera Source
# ═══════════════════════════════════════════════════════════════════════════════

class CameraSource:
    """
    One physical camera. Supports webcam index (int) or RTSP URL (str).
    Runs in a background thread. Drops frames to bounded queue — never blocks.
    """

    def __init__(self, frame_queue: "queue.Queue[np.ndarray]", telemetry: TelemetryCollector):
        self.q         = frame_queue
        self.telemetry = telemetry
        self._cap: Optional[cv2.VideoCapture] = None
        self._thread: Optional[threading.Thread] = None
        self._running  = False
        self.status    = "STARTING"
        self.width     = 0
        self.height    = 0

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
        failures = 0
        while self._running:
            if not self._cap or not self._cap.isOpened():
                self.status = "CAMERA_ERROR"
                time.sleep(1.0)
                continue
            ret, frame = self._cap.read()
            if not ret:
                failures += 1
                if failures > 30:
                    self.status = "CAMERA_ERROR"
                time.sleep(0.02)
                continue
            failures = 0
            self.telemetry.record_camera_frame()
            try:
                self.q.put_nowait(frame)
            except queue.Full:
                self.telemetry.dropped_frames += 1


# ═══════════════════════════════════════════════════════════════════════════════
# Vision Engine
# ═══════════════════════════════════════════════════════════════════════════════

class VisionEngine:

    def __init__(self):
        self.yolo      = None
        self.telemetry = TelemetryCollector(interval_s=2.0)
        self.frame_q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=FRAME_Q_SIZE)
        self.camera    = CameraSource(self.frame_q, self.telemetry)
        self._running  = False
        self._http     = httpx.Client(timeout=10.0)

        # SM pool: (person_id, waste_id) → LitteringStateMachine
        self._sm_pool:          Dict[Tuple[int,int], LitteringStateMachine] = {}
        self._last_event_time:  Dict[Tuple[int,int], float]                 = {}

    # ── Status / telemetry broadcasting ──────────────────────────────────────

    def _post_status(self, stage: str, message: str, error: bool = False):
        print(f"[Boot] {stage}: {message}")
        try:
            self._http.post(f"{BACKEND_URL}/api/vision/status", json={
                "stage": stage, "message": message, "error": error, "camera_id": CAMERA_ID,
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

    # ── Model loading ─────────────────────────────────────────────────────────

    def _load_models(self) -> bool:
        self._post_status("STARTING", "Loading YOLOv8n + ByteTrack…")
        try:
            from ultralytics import YOLO
            self.yolo = YOLO("yolov8n.pt")
            # Warm-up pass to force model onto GPU/CPU and load ByteTrack
            dummy = np.zeros((480, 640, 3), dtype=np.uint8)
            self.yolo.track(source=dummy, persist=True, verbose=False,
                            tracker="bytetrack.yaml",
                            classes=[PERSON_CLASS_ID, *list(TRASH_CLASS_IDS)])
            self._post_status("YOLO_READY",
                f"YOLOv8n loaded | ByteTrack enabled | "
                f"Tracking: person + {len(TRASH_CLASS_IDS)} waste classes")
            return True
        except ImportError:
            self._post_status("YOLO_ERROR",
                "ultralytics not installed — pip install ultralytics", error=True)
            return False
        except Exception as e:
            self._post_status("YOLO_ERROR", f"Load failed: {e}", error=True)
            return False

    # ── Evidence capture ──────────────────────────────────────────────────────

    def _save_evidence(self, frame: np.ndarray, ev: LitteringEvent) -> Tuple[str, str]:
        annotated = frame.copy()
        h, w = frame.shape[:2]

        def _draw_box(bbox, color, label):
            x1, y1, x2, y2 = [max(0, int(v)) for v in bbox]
            x2, y2 = min(x2, w-1), min(y2, h-1)
            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
            cv2.putText(annotated, label, (x1, max(y1-5, 10)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)

        _draw_box(ev.person_bbox, (0, 255, 255), f"Person #{ev.person_track_id}")
        _draw_box(ev.waste_bbox,  (0,   0, 255), f"Waste #{ev.waste_track_id}")

        # Confidence text
        label = (f"LITTER CONFIRMED | conf={ev.event_confidence:.1%} | "
                 f"dwell={ev.dwell_actual_s:.1f}s | identity=PENDING")
        cv2.putText(annotated, label, (8, h-10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 80), 1)

        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        path = EVIDENCE_DIR / f"LITTER_{ev.event_id[:8]}_{ts}.jpg"
        cv2.imwrite(str(path), annotated)

        _, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])
        b64 = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()
        return str(path), b64

    # ── State machine pool management ─────────────────────────────────────────

    def _get_sm(self, pid: int, wid: int) -> LitteringStateMachine:
        key = (pid, wid)
        if key not in self._sm_pool:
            self._sm_pool[key] = LitteringStateMachine(
                person_track_id=pid, waste_track_id=wid,
                camera_id=CAMERA_ID, cfg=LITTER_CFG,
            )
        return self._sm_pool[key]

    def _prune_pool(self):
        dead = [k for k, sm in self._sm_pool.items() if sm.is_terminal]
        for k in dead:
            del self._sm_pool[k]

    # ── Main inference frame processor ───────────────────────────────────────

    def _process_frame(self, frame: np.ndarray) -> np.ndarray:
        if self.yolo is None:
            return frame

        t0 = time.perf_counter()
        display = frame.copy()
        h, w    = frame.shape[:2]

        results = self.yolo.track(
            source=frame, persist=True,
            tracker="bytetrack.yaml", verbose=False,
            classes=[PERSON_CLASS_ID, *list(TRASH_CLASS_IDS)],
        )

        persons: List[dict] = []
        wastes:  List[dict] = []

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
                    persons.append({"id": tid, "bbox": (x1,y1,x2,y2), "center": (cx,cy)})
                    cv2.rectangle(display, (x1,y1), (x2,y2), (0,255,255), 2)
                    cv2.putText(display, f"P#{tid} {conf:.2f}", (x1, y1-6),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0,255,255), 1)
                elif cls in TRASH_CLASS_IDS and conf >= TRASH_CONF:
                    wastes.append({"id": tid, "bbox": (x1,y1,x2,y2), "center": (cx,cy)})
                    cv2.rectangle(display, (x1,y1), (x2,y2), (0,0,255), 2)
                    cv2.putText(display, f"W#{tid} {conf:.2f}", (x1, y1-6),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0,0,255), 1)

        now = time.time()
        person_ids = {p["id"] for p in persons}
        waste_ids  = {w["id"] for w in wastes}

        # ── Update all active state machines ─────────────────────────────────
        # First: pairs seen this frame (both present)
        for person in persons:
            for waste in wastes:
                key = (person["id"], waste["id"])
                if (now - self._last_event_time.get(key, 0)) < LITTER_CFG.cooldown_seconds:
                    continue
                sm = self._get_sm(person["id"], waste["id"])
                if sm.is_terminal:
                    continue
                det = FrameDetection(
                    timestamp=now,
                    person_present=True, person_bbox=person["bbox"], person_center=person["center"],
                    waste_present=True,  waste_bbox=waste["bbox"],   waste_center=waste["center"],
                )
                result = sm.update(det)
                self._handle_event(result, frame, key, now)
                self._render_sm_hud(display, sm, waste)

        # Second: active SMs where person OR waste disappeared this frame
        for (pid, wid), sm in list(self._sm_pool.items()):
            if sm.is_terminal:
                continue
            if pid not in person_ids or wid not in waste_ids:
                p_data = next((p for p in persons if p["id"] == pid), None)
                w_data = next((w for w in wastes  if w["id"] == wid), None)
                det = FrameDetection(
                    timestamp=now,
                    person_present=p_data is not None,
                    person_bbox=p_data["bbox"]   if p_data else None,
                    person_center=p_data["center"] if p_data else None,
                    waste_present=w_data is not None,
                    waste_bbox=w_data["bbox"]   if w_data else None,
                    waste_center=w_data["center"] if w_data else None,
                )
                result = sm.update(det)
                self._handle_event(result, frame, (pid, wid), now)

        self._prune_pool()

        # ── HUD overlay ───────────────────────────────────────────────────────
        snap = self.telemetry.get_snapshot()
        self.telemetry.queue_size = self.frame_q.qsize()
        cv2.putText(display,
            f"EcoWatch v3 | {CAMERA_ID} | {datetime.now().strftime('%H:%M:%S')}",
            (8, h-8), cv2.FONT_HERSHEY_SIMPLEX, 0.40, (16,185,129), 1)
        cv2.putText(display,
            f"CAM:{snap['camera_fps']}fps  AI:{snap['inference_fps']}fps  "
            f"Lat:{snap['inference_latency_ms']}ms  Drop:{snap['dropped_frames']}  "
            f"SMs:{len(self._sm_pool)}",
            (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (200,200,200), 1)
        cv2.putText(display, f"Persons:{len(persons)}  Waste:{len(wastes)}",
            (8, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (200,200,200), 1)

        self.telemetry.record_inference((time.perf_counter() - t0) * 1000)
        return display

    def _render_sm_hud(self, display: np.ndarray, sm: LitteringStateMachine, waste: dict):
        bx1, by1, bx2, by2 = waste["bbox"]
        state_col = (0,220,80) if sm.state == LitterState.LITTERING_CONFIRMED else (200,140,0)
        cv2.putText(display, sm.state.value, (bx1, by2+14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, state_col, 1)
        if sm.dwell_progress > 0:
            bar_w = int((bx2 - bx1) * sm.dwell_progress)
            cv2.rectangle(display, (bx1, by2+2), (bx1+bar_w, by2+7), (255,140,0), -1)
            cv2.putText(display, f"dwell:{sm.dwell_progress*100:.0f}%",
                        (bx1, by2+20), cv2.FONT_HERSHEY_SIMPLEX, 0.32, (255,140,0), 1)

    def _handle_event(self, result: Optional[LitteringEvent], frame: np.ndarray,
                      key: Tuple[int,int], now: float):
        if result is None:
            return
        self._last_event_time[key] = now
        evidence_path, b64 = self._save_evidence(frame, result)
        print(f"\n{'='*64}")
        print(f"[LITTERING CONFIRMED] event={result.event_id[:8]}")
        print(f"  Person#{result.person_track_id} + Waste#{result.waste_track_id}")
        print(f"  Confidence: {result.event_confidence:.1%}  Dwell: {result.dwell_actual_s:.1f}s")
        print(f"  assoc={result.association_score:.2f}  sep={result.separation_score:.2f}  "
              f"stat={result.stationary_score:.2f}  dep={result.departure_score:.2f}")
        print(f"  Evidence: {evidence_path}")
        print(f"  identity_status: PENDING (Part 2)")
        print(f"{'='*64}\n")

        payload = {
            "type":             "littering_event",
            "event_id":         result.event_id,
            "camera_id":        result.camera_id,
            "timestamp":        datetime.fromtimestamp(result.timestamp, tz=timezone.utc).isoformat(),
            "location": {
                "name":      CAMERA_LOCATION,
                "latitude":  CAMERA_LAT,
                "longitude": CAMERA_LNG,
                "ward":      CAMERA_WARD,
            },
            "person_track_id":    result.person_track_id,
            "waste_track_id":     result.waste_track_id,
            "person_bbox":        list(result.person_bbox),
            "waste_bbox":         list(result.waste_bbox),
            "event_confidence":   result.event_confidence,
            "identity_status":    "PENDING",
            "confidence_breakdown": {
                "association": result.association_score,
                "separation":  result.separation_score,
                "stationary":  result.stationary_score,
                "departure":   result.departure_score,
                "dwell_seconds": result.dwell_actual_s,
            },
            "snapshot_b64": b64,
        }
        threading.Thread(
            target=self._post_event, args=(payload,), daemon=True
        ).start()

    def _post_event(self, payload: dict):
        try:
            self._http.post(f"{BACKEND_URL}/api/littering_event", json=payload, timeout=10.0)
        except Exception as e:
            print(f"[Engine] Failed to POST event: {e}")

    # ── Main run ──────────────────────────────────────────────────────────────

    def run(self):
        print(f"\n[EcoWatch v3] Starting vision engine")
        print(f"[EcoWatch v3] Camera source: {CAMERA_SOURCE!r} | ID: {CAMERA_ID}")

        if not self._load_models():
            print("[EcoWatch v3] FATAL — YOLO failed. Exiting.")
            return

        self._post_status("CAMERA_READY", f"Opening camera: {CAMERA_SOURCE!r}")
        if not self.camera.open():
            self._post_status("CAMERA_ERROR",
                f"Cannot open camera source: {CAMERA_SOURCE!r}. "
                "Check CAMERA_SOURCE in backend/.env", error=True)
            print(f"[EcoWatch v3] FATAL — Camera cannot open. Exiting.")
            return

        self._post_status("CAMERA_READY",
            f"{CAMERA_ID} | {self.camera.width}x{self.camera.height} | {CAMERA_LOCATION}")
        self._post_status("TRACKER_READY", "ByteTrack persistent tracking enabled")
        self._post_status("EVENT_ENGINE_READY",
            f"LitteringStateMachine | dwell={LITTER_CFG.dwell_seconds}s | "
            f"assoc={LITTER_CFG.association_distance_px}px | "
            f"dep={LITTER_CFG.person_departure_px}px")

        self.telemetry.start()
        self.camera.start()
        self._running = True

        threading.Thread(target=self._telemetry_loop, daemon=True, name="tel-broadcast").start()

        self._post_status("SYSTEM_READY",
            f"All systems operational | "
            f"YOLO: YOLOv8n | Tracker: ByteTrack | Identity: PENDING (Part 2)")
        print("[EcoWatch v3] 🚀 System ready. Press 'q' in camera window to quit.\n")

        try:
            while self._running:
                try:
                    frame = self.frame_q.get(timeout=2.0)
                except queue.Empty:
                    if self.camera.status == "CAMERA_ERROR":
                        print("[EcoWatch v3] Camera lost signal…")
                    continue

                display = self._process_frame(frame)
                cv2.imshow(f"EcoWatch — {CAMERA_ID}", display)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
        finally:
            self._running = False
            self.camera.stop()
            self.telemetry.stop()
            self._http.close()
            cv2.destroyAllWindows()
            print("[EcoWatch v3] Stopped.")


if __name__ == "__main__":
    VisionEngine().run()
