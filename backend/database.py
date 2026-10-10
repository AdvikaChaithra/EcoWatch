"""
backend/database.py
Shared Supabase client and WebSocket manager as FastAPI dependencies.
This prevents circular imports across routers.
"""
import os
from typing import Set
from fastapi import WebSocket
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

_SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL", "")
_SUPABASE_KEY = os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY") or os.getenv("SUPABASE_ANON_KEY", "")

# Singleton Supabase client
_supabase: Client = create_client(_SUPABASE_URL, _SUPABASE_KEY)


def get_supabase() -> Client:
    """FastAPI dependency — returns the shared Supabase client."""
    return _supabase


# ─── WebSocket Manager ────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket):
        self.active.discard(ws)

    async def broadcast(self, message: dict):
        dead = set()
        for ws in self.active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.active.discard(ws)

    @property
    def connection_count(self) -> int:
        return len(self.active)


# Singleton manager instance
_manager = ConnectionManager()


def get_ws_manager() -> ConnectionManager:
    """FastAPI dependency — returns the shared WebSocket manager."""
    return _manager
