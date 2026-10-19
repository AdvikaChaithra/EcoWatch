"""
EcoWatch demo preflight — checks everything the live demo depends on and says exactly what to fix.
Usage (from repo root):  python scripts/preflight.py
"""
import os
import socket
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / "backend" / ".env")
load_dotenv(ROOT / ".env.local")

results = []


def check(name, fn, fix=""):
    try:
        detail = fn()
        results.append((True, name, detail or ""))
    except Exception as e:  # noqa: BLE001
        results.append((False, name, f"{e}  -> {fix}" if fix else str(e)))


url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL", "")
key = (os.getenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
       or os.getenv("SUPABASE_ANON_KEY", ""))
sb = None


def _env():
    if not url or not key:
        raise RuntimeError("Supabase URL/key missing")
    return urlparse(url).hostname


def _dns():
    host = urlparse(url).hostname
    try:
        return socket.gethostbyname(host)
    except socket.gaierror:
        raise RuntimeError(f"cannot resolve {host}")


def _connect():
    global sb
    from supabase import create_client
    sb = create_client(url, key)
    sb.table("citizens").select("id").limit(1).execute()
    return "connected"


def _table(name, col="id"):
    def f():
        sb.table(name).select(col).limit(1).execute()
        return "ok"
    return f


def _rpc():
    sb.rpc("match_face_candidates", {"query_embedding": [0.0] * 512, "k": 1}).execute()
    return "ok"


def _enrolled():
    r = sb.table("citizens").select("id", count="exact").not_.is_("face_embedding", "null").execute()
    n = r.count or 0
    if n == 0:
        raise RuntimeError("0 enrolled faces")
    return f"{n} enrolled"


def _face_model():
    from backend.routers.auth import _get_face_analyzer
    _get_face_analyzer()
    return "buffalo_l loaded"


def _yolo():
    p = ROOT / os.getenv("PERSON_MODEL_PATH", "yolov8n.pt")
    if not p.exists():
        raise RuntimeError(f"{p.name} not found (ultralytics will download it on first run)")
    return p.name


def _camera():
    import cv2
    src = os.getenv("CAMERA_SOURCE", "0")
    cap = cv2.VideoCapture(int(src) if src.isdigit() else src)
    ok = cap.isOpened()
    ok2, frame = cap.read() if ok else (False, None)
    cap.release()
    if not (ok and ok2):
        raise RuntimeError(f"cannot read from CAMERA_SOURCE={src}")
    return f"{frame.shape[1]}x{frame.shape[0]}"


check("Env: Supabase URL + key", _env, "fill .env.local and backend/.env")
check("DNS resolves Supabase host", _dns, "set DNS to 1.1.1.1 / 8.8.8.8 or use a VPN")
check("Supabase reachable", _connect, "check key/URL; project paused?")
if sb is not None:
    check("Migration: violations.event_id", _table("violations", "event_id,identity_status"), "run migrations/001_demo.sql")
    check("Migration: notifications table", _table("notifications"), "run migrations/001_demo.sql")
    check("Migration: sectors table", _table("sectors"), "run migrations/001_demo.sql")
    check("Migration: match_face_candidates()", _rpc, "run migrations/001_demo.sql")
    check("At least one enrolled face", _enrolled, "register a citizen with the optional face enrollment")
check("Face model (InsightFace)", _face_model, "pip install insightface onnxruntime; first run downloads ~300MB")
check("YOLO weights", _yolo)
check("Camera source readable", _camera, "plug in the webcam / fix CAMERA_SOURCE")

width = max(len(n) for _, n, _ in results)
for ok, name, detail in results:
    print(f"[{'PASS' if ok else 'FAIL'}] {name.ljust(width)}  {detail}")
sys.exit(0 if all(ok for ok, _, _ in results) else 1)
