"""
backend/database.py (A10)
Shared Supabase client (lazy init) and WebSocket manager.
Fails with a clear, named error message instead of crashing at import.
"""
import os
import sys
from typing import Optional, Set
from fastapi import WebSocket, HTTPException
from dotenv import load_dotenv

from pathlib import Path
load_dotenv()  # cwd .env
load_dotenv(Path(__file__).resolve().parent / ".env")  # backend/.env regardless of cwd

_SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL", "")
_SUPABASE_KEY = (os.getenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") or os.getenv("SUPABASE_PUBLISHABLE_KEY")
                 or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY") or os.getenv("SUPABASE_ANON_KEY", ""))

# A10: lazy init — do NOT crash at import time when env vars are missing.
_supabase = None


def get_supabase():
    """
    Returns the shared Supabase client.
    Creates it on first call. Raises RuntimeError with a clear message
    if the required environment variables are missing.
    """
    global _supabase
    if _supabase is not None:
        return _supabase

    if not _SUPABASE_URL or not _SUPABASE_KEY:
        missing = []
        if not _SUPABASE_URL:
            missing.append("NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)")
        if not _SUPABASE_KEY:
            missing.append("NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)")
        raise RuntimeError(
            f"[EcoWatch] Supabase credentials are missing from the environment.\n"
            f"  Missing: {', '.join(missing)}\n"
            f"  Copy backend/.env.example to backend/.env and fill in your Supabase project details.\n"
            f"  See https://supabase.com/dashboard > Project Settings > API."
        )

    try:
        from supabase import create_client, Client  # type: ignore
        _supabase = create_client(_SUPABASE_URL, _SUPABASE_KEY)
        return _supabase
    except ImportError:
        raise RuntimeError(
            "[EcoWatch] supabase-py is not installed. Run: pip install supabase"
        )
    except Exception as exc:
        raise RuntimeError(f"[EcoWatch] Supabase client creation failed: {exc}") from exc


def db():
    """FastAPI dependency: Supabase client, or a clean 503 when misconfigured."""
    try:
        return get_supabase()
    except RuntimeError as exc:
        print(str(exc).encode("ascii", "replace").decode())
        raise HTTPException(status_code=503, detail="Database is not configured or unavailable")


# ─── WebSocket Manager ────────────────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket):
        self.active.discard(ws)

    async def broadcast(self, message: dict):
        dead: Set[WebSocket] = set()
        for ws in list(self.active):
            try:
                await ws.send_json(message)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.active.discard(ws)

    @property
    def connection_count(self) -> int:
        return len(self.active)


_manager = ConnectionManager()


def get_ws_manager() -> ConnectionManager:
    """FastAPI dependency — returns the shared WebSocket manager."""
    return _manager
