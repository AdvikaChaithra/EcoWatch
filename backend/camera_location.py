"""
backend/camera_location.py — the camera's REAL registered location.

The camera (not computer vision) defines where an incident happened. An admin sets it from the
surveillance page using the browser's GPS + reverse geocoding; it is stored on disk so it
survives restarts. Falls back to the CAMERA_* values in backend/.env.
"""
import json
import os
import threading
from pathlib import Path
from typing import Any, Dict, Optional

_FILE = Path(os.getenv("CAMERA_LOCATION_FILE", "logs/camera_location.json"))
_lock = threading.Lock()


def _from_env() -> Dict[str, Any]:
    def _f(v: str) -> Optional[float]:
        try:
            return float(v) if v not in (None, "") else None
        except ValueError:
            return None
    return {
        "name":       os.getenv("CAMERA_LOCATION_NAME", ""),
        "latitude":   _f(os.getenv("CAMERA_LATITUDE", "")),
        "longitude":  _f(os.getenv("CAMERA_LONGITUDE", "")),
        "ward":       os.getenv("CAMERA_WARD", ""),
        "accuracy_m": None,
        "source":     "env",
    }


def get_location() -> Dict[str, Any]:
    with _lock:
        if _FILE.exists():
            try:
                data = json.loads(_FILE.read_text(encoding="utf-8"))
                if data.get("latitude") is not None and data.get("longitude") is not None:
                    return data
            except (OSError, ValueError) as e:
                print(f"[CameraLocation] could not read {_FILE}: {e}")
    return _from_env()


def set_location(name: str, latitude: float, longitude: float, ward: str = "",
                 accuracy_m: Optional[float] = None, updated_at: str = "") -> Dict[str, Any]:
    data = {
        "name": name.strip()[:300], "latitude": round(float(latitude), 6),
        "longitude": round(float(longitude), 6), "ward": ward.strip()[:100],
        "accuracy_m": round(float(accuracy_m), 1) if accuracy_m is not None else None,
        "source": "device_gps", "updated_at": updated_at,
    }
    with _lock:
        _FILE.parent.mkdir(parents=True, exist_ok=True)
        _FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data
