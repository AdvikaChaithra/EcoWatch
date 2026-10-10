"""
backend/routers/reports.py
Geo-tagged dump report creation, worker assignment, status updates, cleanup verification.
"""
import base64
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from backend.models import ReportCreate, ReportStatusUpdate, AssignWorker
from backend.database import get_supabase, get_ws_manager

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("")
async def list_reports(
    citizen_id: Optional[str] = None,
    status: Optional[str] = None,
    sb: Client = Depends(get_supabase),
):
    q = sb.table("dump_reports").select("*, workers(name)").order("created_at", desc=True)
    if citizen_id: q = q.eq("citizen_id", citizen_id)
    if status:     q = q.eq("status", status)
    return q.execute().data


@router.post("")
async def create_report(
    payload: ReportCreate,
    sb: Client = Depends(get_supabase),
    manager = Depends(get_ws_manager),
):
    """
    Creates a geo-tagged dump report. Uploads photo to Supabase Storage.
    Awards +50 Eco-Points to citizen. Broadcasts to admin dashboard.
    """
    image_url = None
    if payload.reported_image_b64:
        try:
            img_bytes = base64.b64decode(payload.reported_image_b64.split(",")[-1])
            ts        = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
            filename  = f"reports/{payload.citizen_id}/{ts}.jpg"
            sb.storage.from_("evidence").upload(filename, img_bytes, {"content-type": "image/jpeg"})
            image_url = sb.storage.from_("evidence").get_public_url(filename)
        except Exception as e:
            print(f"[Storage] Report image upload failed: {e}")

    row = {
        "citizen_id":         payload.citizen_id,
        "category":           payload.category,
        "severity":           payload.severity,
        "location_name":      payload.location_name,
        "lat":                payload.lat,
        "lng":                payload.lng,
        "status":             "Submitted",
        "reported_image_url": image_url,
        "created_at":         datetime.utcnow().isoformat(),
    }
    result = sb.table("dump_reports").insert(row).execute()
    report = result.data[0] if result.data else row

    # Award Eco-Points
    try:
        cr = sb.table("citizens").select("eco_points,tier").eq("id", payload.citizen_id).execute()
        if cr.data:
            pts  = cr.data[0]["eco_points"] + 50
            tier = _calc_tier(pts)
            sb.table("citizens").update({"eco_points": pts, "tier": tier}).eq("id", payload.citizen_id).execute()
    except Exception:
        pass

    # Broadcast to admin
    await manager.broadcast({
        "type":     "report",
        "category": payload.category,
        "location": payload.location_name,
        "severity": payload.severity,
        "lat":      payload.lat,
        "lng":      payload.lng,
    })

    return report


@router.post("/{report_id}/assign")
async def assign_worker(
    report_id: str,
    payload: AssignWorker,
    sb: Client = Depends(get_supabase),
    manager = Depends(get_ws_manager),
):
    result = sb.table("dump_reports").update({
        "assigned_worker_id": payload.worker_id,
        "status":             "Worker Assigned",
        "updated_at":         datetime.utcnow().isoformat(),
    }).eq("id", report_id).execute()

    # Broadcast dispatch event to worker portal
    await manager.broadcast({
        "type":      "dispatch",
        "report_id": report_id,
        "worker_id": payload.worker_id,
    })

    return result.data


@router.patch("/{report_id}/status")
async def update_status(
    report_id: str,
    payload: ReportStatusUpdate,
    sb: Client = Depends(get_supabase),
):
    result = sb.table("dump_reports").update({
        "status":     payload.status,
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", report_id).execute()
    return result.data


@router.post("/{report_id}/complete")
async def complete_report(
    report_id: str,
    body: dict,
    sb: Client = Depends(get_supabase),
    manager = Depends(get_ws_manager),
):
    """
    Worker submits geo-stamped cleanup proof. Uploads to Storage.
    Sets status to 'Pending Verification' for admin review.
    """
    cleaned_image_url = None
    b64 = body.get("cleaned_image_b64")
    if b64:
        try:
            img_bytes = base64.b64decode(b64.split(",")[-1])
            ts        = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
            filename  = f"cleaned/{ts}.jpg"
            sb.storage.from_("evidence").upload(filename, img_bytes, {"content-type": "image/jpeg"})
            cleaned_image_url = sb.storage.from_("evidence").get_public_url(filename)
        except Exception as e:
            print(f"[Storage] Cleaned image upload failed: {e}")
            cleaned_image_url = b64  # fallback to base64 in DB

    result = sb.table("dump_reports").update({
        "status":            "Pending Verification",
        "cleaned_image_url": cleaned_image_url,
        "updated_at":        datetime.utcnow().isoformat(),
    }).eq("id", report_id).execute()

    await manager.broadcast({"type": "report_completed", "report_id": report_id})
    return result.data


@router.post("/{report_id}/verify")
async def verify_report(
    report_id: str,
    body: dict,
    sb: Client = Depends(get_supabase),
    manager = Depends(get_ws_manager),
):
    """
    Admin verifies or rejects the cleanup proof.
    If approved: award ₹200 bonus to worker.
    """
    approved = body.get("approved", False)

    # Get the report to find assigned worker
    res = sb.table("dump_reports").select("assigned_worker_id").eq("id", report_id).execute()
    worker_id = res.data[0]["assigned_worker_id"] if res.data else None

    new_status = "Cleaned & Verified" if approved else "Submitted"
    sb.table("dump_reports").update({
        "status":     new_status,
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", report_id).execute()

    if approved and worker_id:
        # Award ₹200 bonus + 100 Eco-Points to worker
        wr = sb.table("workers").select("tasks_completed,bonus_accrued,eco_points").eq("id", worker_id).execute()
        if wr.data:
            w = wr.data[0]
            sb.table("workers").update({
                "tasks_completed": w["tasks_completed"] + 1,
                "bonus_accrued":   float(w["bonus_accrued"]) + 200.0,
                "eco_points":      w["eco_points"] + 100,
            }).eq("id", worker_id).execute()

    await manager.broadcast({
        "type":      "report_verified",
        "report_id": report_id,
        "approved":  approved,
        "worker_id": worker_id,
    })

    return {"success": True, "status": new_status}


def _calc_tier(pts: int) -> str:
    if pts >= 5000: return "Eco-Champion"
    if pts >= 2000: return "Gold"
    if pts >= 500:  return "Silver"
    return "Bronze"
