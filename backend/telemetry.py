"""
EcoWatch — Real System Telemetry Collector
==========================================
Uses psutil for actual CPU/RAM measurements.
No Math.random(). No fabricated values.
GPU status via torch.cuda if available.
"""

from __future__ import annotations

import collections
import threading
import time
from typing import Optional

try:
    import psutil
    _PSUTIL = True
except ImportError:
    _PSUTIL = False
    print("[Telemetry] WARNING: psutil not installed — CPU/RAM will read 0. pip install psutil")

try:
    import torch as _torch
    _GPU_AVAILABLE = _torch.cuda.is_available()
    _GPU_NAME      = _torch.cuda.get_device_name(0) if _GPU_AVAILABLE else "NOT AVAILABLE"
except Exception:
    _GPU_AVAILABLE = False
    _GPU_NAME      = "NOT AVAILABLE"


class TelemetryCollector:
    """
    Background-thread metrics collector.
    Thread-safe reads via get_snapshot().
    All values are measured — none are simulated.
    """

    def __init__(self, interval_s: float = 2.0):
        self._interval   = interval_s
        self._lock       = threading.Lock()
        self._running    = False
        self._thread: Optional[threading.Thread] = None

        # Computed by background loop
        self._cpu_pct: float = 0.0
        self._ram_mb:  float = 0.0

        # Updated by vision engine threads via record_* methods
        self._cam_ts:  collections.deque = collections.deque(maxlen=90)
        self._inf_ts:  collections.deque = collections.deque(maxlen=90)
        self._lat_ema: float = 0.0   # exponential moving average latency

        # Updated externally (not locked — single-writer)
        self.dropped_frames: int = 0
        self.queue_size:     int = 0

        if _PSUTIL:
            self._proc = psutil.Process()

    # ── Recording (called from camera/inference threads) ─────────────────────

    def record_camera_frame(self):
        self._cam_ts.append(time.perf_counter())

    def record_inference(self, latency_ms: float):
        now = time.perf_counter()
        self._inf_ts.append(now)
        with self._lock:
            self._lat_ema = 0.8 * self._lat_ema + 0.2 * latency_ms

    # ── Background loop ───────────────────────────────────────────────────────

    def start(self):
        if _PSUTIL:
            psutil.cpu_percent(interval=None)  # discard first dummy reading
        self._running = True
        self._thread  = threading.Thread(target=self._loop, daemon=True, name="telemetry")
        self._thread.start()

    def stop(self):
        self._running = False

    def _fps_from_deque(self, dq: collections.deque) -> float:
        if len(dq) < 2:
            return 0.0
        elapsed = dq[-1] - dq[0]
        return round((len(dq) - 1) / elapsed, 1) if elapsed > 0 else 0.0

    def _loop(self):
        while self._running:
            time.sleep(self._interval)
            cpu = psutil.cpu_percent(interval=None) if _PSUTIL else 0.0
            ram = round(self._proc.memory_info().rss / (1024 * 1024), 1) if _PSUTIL else 0.0
            with self._lock:
                self._cpu_pct = cpu
                self._ram_mb  = ram

    # ── Snapshot (called by WebSocket broadcast thread) ───────────────────────

    def get_snapshot(self) -> dict:
        with self._lock:
            return {
                "camera_fps":           self._fps_from_deque(self._cam_ts),
                "inference_fps":        self._fps_from_deque(self._inf_ts),
                "inference_latency_ms": round(self._lat_ema, 1),
                "cpu_percent":          self._cpu_pct,
                "ram_mb":               self._ram_mb,
                "gpu":                  _GPU_NAME,
                "dropped_frames":       self.dropped_frames,
                "queue_size":           self.queue_size,
            }
