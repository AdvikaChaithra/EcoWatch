"""
backend/routers/reports.py
Geo-tagged dump report creation, worker assignment, status updates, cleanup verification.
"""
import base64
import binascii
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from backend.models import ReportCreate, ReportStatusUpdate, AssignWorker
from backend.database import db, get_ws_manager
from backend.security import require_api_key, utcnow, utcnow_iso

router = APIRouter(prefix="/api/reports", tags=["reports"])

_MAX_IMAGE_BYTES = 10 * 1024 * 1024


def _run(fn, what: str):
    try:
        return fn()
    except HTTPException:
        raise
    except Exception as e:
        print(f"[DB] {what} failed: {e}")
        raise HTTPException(status_code=502, detail=f"Database error while trying to {what}")


def _decode_image(b64: str) -> bytes:
    try:
        data = base64.b64decode(b64.split(",")[-1], validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="Image is not valid base64")
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large (max 10 MB)")
    return data


def _upload(sb: Client, path: str, data: bytes) -> str:
    """Upload to the evidence bucket and return its public URL. Raises on failure."""
    sb.storage.from_("evidence").upload(path, data, {"content-type": "image/jpeg"})
    return sb.storage.from_("evidence").get_public_url(path)


@router.get("")
async def list_reports(
    citizen_id: Optional[str] = None,
    status: Optional[str] = None,
    sb: Client = Depends(db),
):
    q = sb.table("dump_reports").select("*, workers(name)").order("created_at", desc=True)
    if citizen_id: q = q.eq("citizen_id", citizen_id)
    if status:     q = q.eq("status", status)
    return _run(lambda: q.execute().data, "list reports")


@router.post("", dependencies=[Depends(require_api_key)])
async def create_report(
    payload: ReportCreate,
    sb: Client = Depends(db),
    manager=Depends(get_ws_manager),
):
    """Creates a geo-tagged dump report, uploads the photo, awards +40 Eco-Points."""
    image_url = None
    image_warning = None
    if payload.reported_image_b64:
        img_bytes = _decode_image(payload.reported_image_b64)
        filename = f"reports/{payload.citizen_id}/{utcnow().strftime('%Y%m%d_%H%M%S_%f')}.jpg"
        try:
            image_url = _upload(sb, filename, img_bytes)
        except Exception as e:
            print(f"[Storage] Report image upload failed: {e}")
            image_warning = "Photo upload failed; report saved without image."

    row = {
        "citizen_id":         payload.citizen_id,
        "category":           payload.category,
        "severity":           payload.severity,
        "location_name":      payload.location_name,
        "lat":                payload.lat,
        "lng":                payload.lng,
        "status":             "Submitted",
        "reported_image_url": image_url,
        "created_at":         utcnow_iso(),
    }
    result = _run(lambda: sb.table("dump_reports").insert(row).execute(), "create report")
    report = dict(result.data[0] if result.data else row)
    if image_warning:
        report["warning"] = image_warning

    # Award Eco-Points (non-fatal, but reported)
    try:
        cr = sb.table("citizens").select("eco_points,tier").eq("id", payload.citizen_id).execute()
        if cr.data:
            pts = (cr.data[0].get("eco_points") or 0) + 40   # same as REPORT_POINTS in lib/taskPoints.ts
            sb.table("citizens").update({"eco_points": pts, "tier": _calc_tier(pts)}).eq("id", payload.citizen_id).execute()
    except Exception as e:
        print(f"[DB] Eco-points award failed for citizen {payload.citizen_id}: {e}")
        report["warning"] = (report.get("warning", "") + " Eco-Points could not be awarded.").strip()

    await manager.broadcast({
        "type":     "report",
        "id":       report.get("id"),
        "category": payload.category,
        "location": payload.location_name,
        "severity": payload.severity,
        "lat":      payload.lat,
        "lng":      payload.lng,
    })

    return report


@router.post("/{report_id}/assign", dependencies=[Depends(require_api_key)])
async def assign_worker(
    report_id: str,
    payload: AssignWorker,
    sb: Client = Depends(db),
    manager=Depends(get_ws_manager),
):
    result = _run(
        lambda: sb.table("dump_reports").update({
            "assigned_worker_id": payload.worker_id,
            "status":             "Worker Assigned",
            "updated_at":         utcnow_iso(),
        }).eq("id", report_id).execute(),
        "assign worker",
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Report not found")

    await manager.broadcast({
        "type":      "dispatch",
        "report_id": report_id,
        "worker_id": payload.worker_id,
    })
    return result.data


@router.patch("/{report_id}/status", dependencies=[Depends(require_api_key)])
async def update_status(
    report_id: str,
    payload: ReportStatusUpdate,
    sb: Client = Depends(db),
):
    result = _run(
        lambda: sb.table("dump_reports").update({
            "status":     payload.status,
            "updated_at": utcnow_iso(),
        }).eq("id", report_id).execute(),
        "update report status",
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Report not found")
    return result.data


@router.post("/{report_id}/complete", dependencies=[Depends(require_api_key)])
async def complete_report(
    report_id: str,
    body: dict,
    sb: Client = Depends(db),
    manager=Depends(get_ws_manager),
):
    """Worker submits cleanup proof; status becomes 'Pending Verification'."""
    b64 = body.get("cleaned_image_b64")
    if not b64:
        raise HTTPException(status_code=400, detail="cleaned_image_b64 is required")
    img_bytes = _decode_image(b64)
    filename = f"cleaned/{utcnow().strftime('%Y%m%d_%H%M%S_%f')}.jpg"
    try:
        cleaned_image_url = _upload(sb, filename, img_bytes)
    except Exception as e:
        # Don't stuff megabytes of base64 into a DB column; let the worker retry.
        print(f"[Storage] Cleaned image upload failed: {e}")
        raise HTTPException(status_code=502, detail="Could not store cleanup proof. Please retry.")

    result = _run(
        lambda: sb.table("dump_reports").update({
            "status":            "Pending Verification",
            "cleaned_image_url": cleaned_image_url,
            "updated_at":        utcnow_iso(),
        }).eq("id", report_id).execute(),
        "complete report",
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Report not found")

    await manager.broadcast({"type": "report_completed", "report_id": report_id})
    return result.data


@router.post("/{report_id}/verify", dependencies=[Depends(require_api_key)])
async def verify_report(
    report_id: str,
    body: dict,
    sb: Client = Depends(db),
    manager=Depends(get_ws_manager),
):
    """Admin verifies or rejects the cleanup proof. Approval awards the worker ₹200 + 100 points (once)."""
    approved = bool(body.get("approved", False))

    res = _run(
        lambda: sb.table("dump_reports").select("assigned_worker_id,status").eq("id", report_id).execute(),
        "fetch report",
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Report not found")
    prev_status = res.data[0].get("status")
    worker_id = res.data[0].get("assigned_worker_id")
    if prev_status == "Cleaned & Verified":
        raise HTTPException(status_code=409, detail="Report already verified")

    new_status = "Cleaned & Verified" if approved else "Submitted"
    _run(
        lambda: sb.table("dump_reports").update({
            "status":     new_status,
            "updated_at": utcnow_iso(),
        }).eq("id", report_id).execute(),
        "update report",
    )

    if approved and worker_id:
        try:
            wr = sb.table("workers").select("tasks_completed,bonus_accrued,eco_points").eq("id", worker_id).execute()
            if wr.data:
                w = wr.data[0]
                sb.table("workers").update({
                    "tasks_completed": (w.get("tasks_completed") or 0) + 1,
                    "bonus_accrued":   float(w.get("bonus_accrued") or 0) + 200.0,
                    "eco_points":      (w.get("eco_points") or 0) + 100,
                }).eq("id", worker_id).execute()
        except Exception as e:
            print(f"[DB] Worker bonus award failed for {worker_id}: {e}")
            raise HTTPException(status_code=502, detail="Report verified, but the worker bonus could not be recorded.")

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
