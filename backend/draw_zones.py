"""
backend/draw_zones.py — Interactive zone polygon editor (A5)
=============================================================
Opens a real camera frame and lets you draw bin_zones and no_litter_zones
by clicking. Saves results to backend/camera_zones.json.

Usage:
    python -m backend.draw_zones

Controls:
  Left-click   — add vertex to current polygon
  Enter        — finish current polygon and save it
  Esc          — discard current in-progress polygon
  B            — next polygon will be a bin_zone
  N            — next polygon will be a no_litter_zone
  S            — save all polygons to camera_zones.json and exit
  Q            — quit without saving
"""

import json, os, sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

try:
    import cv2
    import numpy as np
except ImportError:
    print("ERROR: opencv-python not installed. pip install opencv-python")
    sys.exit(1)

ZONES_FILE  = Path("backend/camera_zones.json")
_SRC        = os.getenv("CAMERA_SOURCE", "0")
CAMERA_SRC  = int(_SRC) if _SRC.isdigit() else _SRC
CAMERA_ID   = os.getenv("CAMERA_ID", "CAM_01")
CAMERA_NAME = os.getenv("CAMERA_NAME", "EcoWatch Test Camera")


def _grab_frame(src) -> np.ndarray:
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera source: {src!r}")
    for _ in range(5):    # skip first few frames (exposure settling)
        cap.read()
    ret, frame = cap.read()
    cap.release()
    if not ret:
        raise RuntimeError("Failed to read frame from camera.")
    return frame


def _load_existing(camera_id: str) -> dict:
    if not ZONES_FILE.exists():
        return {"bin_zones": [], "no_litter_zones": []}
    data = json.loads(ZONES_FILE.read_text())
    for cam in data.get("cameras", []):
        if cam.get("camera_id") == camera_id:
            return {
                "bin_zones":       cam.get("bin_zones", []),
                "no_litter_zones": cam.get("no_litter_zones", []),
            }
    return {"bin_zones": [], "no_litter_zones": []}


def _save(camera_id: str, camera_name: str, zones: dict):
    ZONES_FILE.parent.mkdir(parents=True, exist_ok=True)
    if ZONES_FILE.exists():
        data = json.loads(ZONES_FILE.read_text())
    else:
        data = {"cameras": [],
                "schema_note": "All coords normalized 0.0–1.0. Use draw_zones.py to edit."}
    # Update or insert this camera
    cameras = data.get("cameras", [])
    updated = False
    for cam in cameras:
        if cam.get("camera_id") == camera_id:
            cam["bin_zones"]       = zones["bin_zones"]
            cam["no_litter_zones"] = zones["no_litter_zones"]
            updated = True
            break
    if not updated:
        cameras.append({
            "camera_id":        camera_id,
            "camera_name":      camera_name,
            "bin_zones":        zones["bin_zones"],
            "no_litter_zones":  zones["no_litter_zones"],
        })
    data["cameras"] = cameras
    ZONES_FILE.write_text(json.dumps(data, indent=2))
    print(f"[SaveZones] Saved to {ZONES_FILE}")


def main():
    print("EcoWatch Zone Editor")
    print(f"  Camera: {CAMERA_ID}  source: {CAMERA_SRC!r}")
    print("Grabbing a frame from the live camera…")
    try:
        frame = _grab_frame(CAMERA_SRC)
    except RuntimeError as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    h, w = frame.shape[:2]
    zones = _load_existing(CAMERA_ID)
    current_poly: list = []    # current in-progress polygon (pixel coords)
    zone_type   = "bin"        # "bin" or "no_litter"
    all_done    = False

    COLORS = {
        "bin":       (0, 255, 0),    # green
        "no_litter": (0, 0, 255),    # red
    }

    def mouse_cb(event, x, y, flags, _):
        nonlocal current_poly
        if event == cv2.EVENT_LBUTTONDOWN:
            current_poly.append((x, y))

    cv2.namedWindow("EcoWatch Zone Editor")
    cv2.setMouseCallback("EcoWatch Zone Editor", mouse_cb)

    print("\nControls:")
    print("  Left-click → add vertex  |  Enter → finish polygon")
    print("  Esc → discard polygon    |  B → bin zone  |  N → no-litter zone")
    print("  S → save and exit        |  Q → quit without saving")
    print(f"\nCurrent zone type: BIN (green)\n")

    while True:
        display = frame.copy()

        # Draw existing zones
        for poly_norm in zones["bin_zones"]:
            pts = np.array([[int(x*w), int(y*h)] for x, y in poly_norm], np.int32)
            cv2.polylines(display, [pts], True, (0,200,0), 2)
            cv2.fillPoly(display, [pts], (0,200,0,50))
            cv2.putText(display, "BIN", tuple(pts[0]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,200,0), 1)

        for poly_norm in zones["no_litter_zones"]:
            pts = np.array([[int(x*w), int(y*h)] for x, y in poly_norm], np.int32)
            cv2.polylines(display, [pts], True, (0,0,200), 2)
            cv2.putText(display, "NO-LITTER", tuple(pts[0]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,0,200), 1)

        # Draw current in-progress polygon
        col = COLORS[zone_type]
        for i, pt in enumerate(current_poly):
            cv2.circle(display, pt, 5, col, -1)
            if i > 0:
                cv2.line(display, current_poly[i-1], pt, col, 1)
        if len(current_poly) > 2:
            cv2.line(display, current_poly[-1], current_poly[0], col, 1)

        label = f"Mode: {'BIN' if zone_type=='bin' else 'NO-LITTER'} | Vertices: {len(current_poly)}"
        cv2.putText(display, label, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
        cv2.putText(display, "S=save  Q=quit  B=bin  N=no-litter  Enter=finish  Esc=discard",
                    (10, h-10), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200,200,200), 1)

        cv2.imshow("EcoWatch Zone Editor", display)
        key = cv2.waitKey(30) & 0xFF

        if key == ord('q'):
            print("Quit without saving.")
            break
        elif key == ord('s'):
            _save(CAMERA_ID, CAMERA_NAME, zones)
            all_done = True
            break
        elif key == ord('b'):
            zone_type = "bin"
            print("→ Next polygon: BIN ZONE (green)")
        elif key == ord('n'):
            zone_type = "no_litter"
            print("→ Next polygon: NO-LITTER ZONE (red)")
        elif key == 13:  # Enter
            if len(current_poly) >= 3:
                # Normalize to 0–1
                norm = [[round(x/w, 4), round(y/h, 4)] for x, y in current_poly]
                if zone_type == "bin":
                    zones["bin_zones"].append(norm)
                    print(f"  Added bin zone ({len(norm)} vertices).")
                else:
                    zones["no_litter_zones"].append(norm)
                    print(f"  Added no-litter zone ({len(norm)} vertices).")
            else:
                print("  Polygon needs at least 3 vertices — discarded.")
            current_poly = []
        elif key == 27:  # Esc
            current_poly = []
            print("  Polygon discarded.")

    cv2.destroyAllWindows()
    if not all_done:
        print("Zones NOT saved.")


if __name__ == "__main__":
    main()
