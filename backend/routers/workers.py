"""
backend/routers/workers.py
Worker CRUD, shift management, location updates, bonus ledger.
"""
import secrets
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from backend.models import WorkerCreate, WorkerStatusUpdate, WorkerLocationUpdate, BonusUpdate
from backend.database import db, get_ws_manager
from backend.security import require_api_key, utcnow_iso, hash_secret

router = APIRouter(prefix="/api/workers", tags=["workers"])

# Never return credentials from list/get endpoints.
_SAFE_COLS = ("id,name,phone,ward,employee_id,status,active,lat,lng,tasks_completed,"
              "eco_points,bonus_accrued,tier,admin_id,created_at,updated_at")


def _run(fn, what: str):
    try:
        return fn()
    except HTTPException:
        raise
    except Exception as e:
        print(f"[DB] {what} failed: {e}")
        raise HTTPException(status_code=502, detail=f"Database error while trying to {what}")


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False


@router.get("")
async def list_workers(
    ward: Optional[str] = None,
    status: Optional[str] = None,
    sb: Client = Depends(db),
):
    q = sb.table("workers").select(_SAFE_COLS).order("name")
    if ward:   q = q.eq("ward", ward)
    if status: q = q.eq("status", status)
    return _run(lambda: q.execute().data, "list workers")


@router.get("/{worker_id}")
async def get_worker(worker_id: str, sb: Client = Depends(db)):
    column = "id" if _is_uuid(worker_id) else "employee_id"
    res = _run(
        lambda: sb.table("workers").select(f"{_SAFE_COLS}, admins(name, email, designation)")
        .eq(column, worker_id).execute(),
        "fetch worker",
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Worker not found")
    return res.data[0]


@router.post("", dependencies=[Depends(require_api_key)])
async def create_worker(payload: WorkerCreate, sb: Client = Depends(db)):
    def _insert(emp_id: str):
        row = {
            "admin_id":        payload.admin_id,
            "name":            payload.name,
            "phone":           payload.phone,
            "employee_id":     emp_id,
            "pin_hash":        hash_secret(payload.pin),
            "ward":            payload.ward,
            "status":          "Off Duty",
            "tasks_completed": 0,
            "eco_points":      0,
            "bonus_accrued":   0,
            "created_at":      utcnow_iso(),
        }
        return sb.table("workers").insert(row).execute()

    if payload.employee_id:
        result = _run(lambda: _insert(payload.employee_id), "create worker")
    else:
        # Generated IDs: retry on collision.
        result = None
        for _ in range(5):
            emp_id = f"EW-WRK-{secrets.token_hex(3).upper()}"
            exists = _run(lambda: sb.table("workers").select("id").eq("employee_id", emp_id).execute(), "check id")
            if exists.data:
                continue
            result = _run(lambda: _insert(emp_id), "create worker")
            break
        if result is None:
            raise HTTPException(status_code=500, detail="Could not allocate a unique employee ID")

    worker = result.data[0] if result.data else {}
    worker.pop("pin_hash", None)
    return worker


@router.patch("/{worker_id}/status", dependencies=[Depends(require_api_key)])
async def update_status(
    worker_id: str,
    payload: WorkerStatusUpdate,
    sb: Client = Depends(db),
    manager=Depends(get_ws_manager),
):
    if payload.status not in ("On Duty", "Off Duty"):
        raise HTTPException(status_code=400, detail="status must be 'On Duty' or 'Off Duty'")

    result = _run(
        lambda: sb.table("workers").update({
            "status":     payload.status,
            "updated_at": utcnow_iso(),
        }).eq("id", worker_id).execute(),
        "update worker status",
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Worker not found")

    on_duty = _run(
        lambda: sb.table("workers").select("*", count="exact", head=True).eq("status", "On Duty").execute(),
        "count on-duty workers",
    )
    count = on_duty.count or 0
    # "worker_status" is what the frontend listens for; keep legacy key for old clients.
    await manager.broadcast({"type": "worker_status", "count": count})
    await manager.broadcast({"type": "worker_status_update", "on_duty_count": count})

    return result.data


@router.patch("/{worker_id}/deactivate", dependencies=[Depends(require_api_key)])
async def deactivate_worker(worker_id: str, sb: Client = Depends(db)):
    """Hard deactivate — sets status to Off Duty and marks account inactive."""
    result = _run(
        lambda: sb.table("workers").update({
            "status":     "Off Duty",
            "active":     False,
            "updated_at": utcnow_iso(),
        }).eq("id", worker_id).execute(),
        "deactivate worker",
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Worker not found")
    return {"success": True, "message": "Worker deactivated"}


@router.patch("/{worker_id}/location", dependencies=[Depends(require_api_key)])
async def update_location(
    worker_id: str,
    payload: WorkerLocationUpdate,
    sb: Client = Depends(db),
    manager=Depends(get_ws_manager),
):
    """Real-time worker location update — broadcast to admin operations map."""
    result = _run(
        lambda: sb.table("workers").update({
            "lat": payload.lat,
            "lng": payload.lng,
        }).eq("id", worker_id).execute(),
        "update worker location",
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Worker not found")
    w = result.data[0]

    await manager.broadcast({
        "type":      "worker_location",
        "worker_id": worker_id,
        "name":      w.get("name"),
        "ward":      w.get("ward"),
        "lat":       payload.lat,
        "lng":       payload.lng,
    })
    return {"success": True}


@router.post("/{worker_id}/bonus", dependencies=[Depends(require_api_key)])
async def add_bonus(
    worker_id: str,
    payload: BonusUpdate,
    sb: Client = Depends(db),
):
    res = _run(
        lambda: sb.table("workers").select("bonus_accrued,eco_points").eq("id", worker_id).execute(),
        "fetch worker",
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Worker not found")

    current = res.data[0]
    updated = _run(
        lambda: sb.table("workers").update({
            "bonus_accrued": float(current.get("bonus_accrued") or 0) + payload.amount,
            "eco_points":    (current.get("eco_points") or 0) + int(payload.amount / 2),
        }).eq("id", worker_id).execute(),
        "add bonus",
    )
    return updated.data
