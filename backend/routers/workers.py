"""
backend/routers/workers.py
Worker CRUD, shift management, location updates, bonus ledger.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from backend.models import WorkerCreate, WorkerStatusUpdate, WorkerLocationUpdate, BonusUpdate
from backend.database import get_supabase, get_ws_manager

router = APIRouter(prefix="/api/workers", tags=["workers"])


@router.get("")
async def list_workers(
    ward: Optional[str] = None,
    status: Optional[str] = None,
    sb: Client = Depends(get_supabase),
):
    q = sb.table("workers").select("*").order("name")
    if ward:   q = q.eq("ward", ward)
    if status: q = q.eq("status", status)
    return q.execute().data


@router.get("/{worker_id}")
async def get_worker(worker_id: str, sb: Client = Depends(get_supabase)):
    # Try by UUID first, then by employee_id
    res = sb.table("workers").select("*, admins(name, email, designation)").eq("id", worker_id).execute()
    if not res.data:
        res = sb.table("workers").select("*, admins(name, email, designation)").eq("employee_id", worker_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Worker not found")
    return res.data[0]


@router.post("")
async def create_worker(payload: WorkerCreate, sb: Client = Depends(get_supabase)):
    emp_id = payload.employee_id or f"EW-WRK-{datetime.utcnow().strftime('%f')[:4]}"
    row = {
        "admin_id":    payload.admin_id,
        "name":        payload.name,
        "phone":       payload.phone,
        "employee_id": emp_id,
        "pin_hash":    payload.pin_hash,
        "ward":        payload.ward,
        "status":      "Off Duty",
        "tasks_completed": 0,
        "eco_points":      0,
        "bonus_accrued":   0,
        "created_at":  datetime.utcnow().isoformat(),
    }
    result = sb.table("workers").insert(row).execute()
    return result.data[0] if result.data else row


@router.patch("/{worker_id}/status")
async def update_status(
    worker_id: str,
    payload: WorkerStatusUpdate,
    sb: Client = Depends(get_supabase),
    manager = Depends(get_ws_manager),
):
    if payload.status not in ("On Duty", "Off Duty"):
        raise HTTPException(status_code=400, detail="status must be 'On Duty' or 'Off Duty'")

    result = sb.table("workers").update({
        "status":     payload.status,
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", worker_id).execute()

    # Broadcast live On-Duty worker count to admin dashboard
    on_duty = sb.table("workers").select("*", count="exact", head=True).eq("status", "On Duty").execute()
    await manager.broadcast({"type": "worker_status_update", "on_duty_count": on_duty.count or 0})

    return result.data


@router.patch("/{worker_id}/deactivate")
async def deactivate_worker(worker_id: str, sb: Client = Depends(get_supabase)):
    """Hard deactivate — sets status to Off Duty and marks account inactive."""
    result = sb.table("workers").update({
        "status":     "Off Duty",
        "active":     False,
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", worker_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Worker not found")
    return {"success": True, "message": "Worker deactivated"}


@router.patch("/{worker_id}/location")
async def update_location(
    worker_id: str,
    payload: WorkerLocationUpdate,
    sb: Client = Depends(get_supabase),
    manager = Depends(get_ws_manager),
):
    """Real-time worker location update — broadcast to admin operations map."""
    sb.table("workers").update({
        "lat": payload.lat,
        "lng": payload.lng,
    }).eq("id", worker_id).execute()

    # Broadcast to admin operations heatmap
    await manager.broadcast({
        "type":      "worker_location",
        "worker_id": worker_id,
        "lat":       payload.lat,
        "lng":       payload.lng,
    })
    return {"success": True}


@router.post("/{worker_id}/bonus")
async def add_bonus(
    worker_id: str,
    payload: BonusUpdate,
    sb: Client = Depends(get_supabase),
):
    res = sb.table("workers").select("bonus_accrued,eco_points").eq("id", worker_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Worker not found")

    current = res.data[0]
    updated = sb.table("workers").update({
        "bonus_accrued": float(current["bonus_accrued"]) + payload.amount,
        "eco_points":    current["eco_points"] + int(payload.amount / 2),
    }).eq("id", worker_id).execute()
    return updated.data
