"""
backend/camera_zones.py — Zone loader and point-in-polygon checker (A5)
=======================================================================
Loads bin_zones and no_litter_zones from camera_zones.json.
Coordinates in the JSON are normalized 0.0–1.0 (x/width, y/height).

Usage in vision_engine.py:
    from backend.camera_zones import ZoneChecker
    checker = ZoneChecker.load("backend/camera_zones.json", camera_id="CAM_01")
    ...
    if checker.in_bin_zone(wx_norm, wy_norm):
        # label = PLACE_IN_BIN; suppress littering event
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional, Tuple


# ── Point-in-polygon (ray-casting) ────────────────────────────────────────────

def _point_in_polygon(x: float, y: float, polygon: List[Tuple[float,float]]) -> bool:
    """Ray-casting algorithm. polygon is list of (x,y) normalized coords."""
    n = len(polygon)
    inside = False
    px, py = x, y
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


class ZoneChecker:
    """
    Checks whether a normalized point (0–1, 0–1) falls inside any
    bin_zone or no_litter_zone polygon for a given camera.
    """

    def __init__(
        self,
        bin_zones:        List[List[Tuple[float,float]]],
        no_litter_zones:  List[List[Tuple[float,float]]],
        camera_id:        str,
    ):
        self._bin_zones        = bin_zones
        self._no_litter_zones  = no_litter_zones
        self.camera_id         = camera_id

    @classmethod
    def load(cls, json_path: str, camera_id: str) -> "ZoneChecker":
        """Load zones from camera_zones.json for a specific camera_id."""
        p = Path(json_path)
        bin_zones:       List[List[Tuple[float,float]]] = []
        no_litter_zones: List[List[Tuple[float,float]]] = []

        if not p.exists():
            print(f"[ZoneChecker] {json_path} not found — no zones active.")
            return cls(bin_zones, no_litter_zones, camera_id)

        try:
            data = json.loads(p.read_text())
            for cam in data.get("cameras", []):
                if cam.get("camera_id") == camera_id:
                    bin_zones = [
                        [(pt[0], pt[1]) for pt in poly]
                        for poly in cam.get("bin_zones", [])
                    ]
                    no_litter_zones = [
                        [(pt[0], pt[1]) for pt in poly]
                        for poly in cam.get("no_litter_zones", [])
                    ]
                    break
        except Exception as e:
            print(f"[ZoneChecker] Failed to parse {json_path}: {e}")

        count = len(bin_zones) + len(no_litter_zones)
        print(f"[ZoneChecker] Camera {camera_id}: "
              f"{len(bin_zones)} bin zone(s), {len(no_litter_zones)} no-litter zone(s) loaded.")
        return cls(bin_zones, no_litter_zones, camera_id)

    def in_bin_zone(self, x_norm: float, y_norm: float) -> bool:
        """Returns True if point is inside any bin zone."""
        return any(_point_in_polygon(x_norm, y_norm, z) for z in self._bin_zones)

    def in_no_litter_zone(self, x_norm: float, y_norm: float) -> bool:
        """Returns True if point is inside any no-litter zone."""
        return any(_point_in_polygon(x_norm, y_norm, z) for z in self._no_litter_zones)

    def get_zones_for_overlay(self) -> dict:
        """Return zone polygons for UI/CV overlay rendering."""
        return {
            "bin_zones":        self._bin_zones,
            "no_litter_zones":  self._no_litter_zones,
        }
