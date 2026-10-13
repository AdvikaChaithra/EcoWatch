"""
backend/routers/violations.py
Violation creation (from vision engine), status updates,
payment processing, and dispute submissions.
"""
import secrets
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from backend.models import ViolationCreate, ViolationUpdate, PaymentRequest
from backend.database import db, get_ws_manager
from backend.security import require_api_key, utcnow_iso, send_sms

router = APIRouter(prefix="/api/violations", tags=["violations"])


def _run(fn, what: str):
    """Execute a Supabase query, converting failures into a 502 instead of a bare 500."""
    try:
        return fn()
    except HTTPException:
        raise
    except Exception as e:
        print(f"[DB] {what} failed: {e}")
        raise HTTPException(status_code=502, detail=f"Database error while trying to {what}")


# ─── GET All / Citizen Violations ─────────────────────────────

@router.get("")
async def list_violations(
    citizen_id: Optional[str] = None,
    status: Optional[str] = None,
    sb: Client = Depends(db),
):
    q = sb.table("violations").select("*").order("timestamp", desc=True)
    if citizen_id:
        q = q.eq("citizen_id", citizen_id)
    if status:
        q = q.eq("status", status)
    return _run(lambda: q.execute().data, "list violations")


# ─── POST — Create Violation (from vision_engine.py) ──────────

@router.post("", dependencies=[Depends(require_api_key)])
async def create_violation(
    payload: ViolationCreate,
    sb: Client = Depends(db),
    manager=Depends(get_ws_manager),
):
    """
    Called when a litter violation is confirmed. Evidence frames are stored on disk
    by the vision engine (served via /evidence); `evidence_dir` references them.
    """
    row = {
        "citizen_id":       payload.citizen_id,
        "location_name":    payload.location_name,
        "lat":              payload.lat,
        "lng":              payload.lng,
        "fine_amount":      200,
        "status":           "Pending",
        "snapshot_url":     payload.evidence_dir,
        "confidence_score": payload.confidence_score,
        "timestamp":        utcnow_iso(),
    }
    result = _run(lambda: sb.table("violations").insert(row).execute(), "create violation")
    violation = result.data[0] if result.data else row

    citizen_name = "Unknown Citizen"
    citizen_phone = None
    if payload.citizen_id:
        try:
            cr = sb.table("citizens").select("name,phone").eq("id", payload.citizen_id).execute()
            if cr.data:
                citizen_name = cr.data[0]["name"]
                citizen_phone = cr.data[0]["phone"]
        except Exception as e:
            print(f"[DB] Citizen lookup failed for violation: {e}")

    await manager.broadcast({
        "type":             "violation",
        "id":               violation.get("id", ""),
        "location":         payload.location_name,
        "citizen_name":     citizen_name,
        "confidence_score": payload.confidence_score,
        "snapshot_url":     payload.evidence_dir,
        "timestamp":        row["timestamp"],
        "person_bbox":      payload.person_bbox,
        "trash_bbox":       payload.trash_bbox,
    })

    if citizen_phone:
        await send_sms(
            citizen_phone,
            f"EcoWatch Alert: You were detected littering at {payload.location_name}. "
            f"Fine ₹200 issued. Pay at ecowatch.gov.in/citizen",
        )

    return violation


# ─── PATCH — Update Violation Status ──────────────────────────

@router.patch("/{violation_id}", dependencies=[Depends(require_api_key)])
async def update_violation(
    violation_id: str,
    payload: ViolationUpdate,
    sb: Client = Depends(db),
):
    update_data = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = _run(
        lambda: sb.table("violations").update(update_data).eq("id", violation_id).execute(),
        "update violation",
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Violation not found")
    return result.data


# ─── POST — Pay Fine ──────────────────────────────────────────

@router.post("/{violation_id}/pay", dependencies=[Depends(require_api_key)])
async def pay_fine(
    violation_id: str,
    payload: PaymentRequest,
    sb: Client = Depends(db),
    manager=Depends(get_ws_manager),
):
    """Marks violation as Paid. The status update is conditional so a double-submit can't double-pay."""
    res = _run(lambda: sb.table("violations").select("*").eq("id", violation_id).execute(), "fetch violation")
    if not res.data:
        raise HTTPException(status_code=404, detail="Violation not found")

    violation = res.data[0]
    if violation["status"] == "Paid":
        raise HTTPException(status_code=409, detail="Fine already paid")
    if violation["status"] in ("Dismissed",):
        raise HTTPException(status_code=409, detail="This violation was dismissed; no payment is due")

    txn = payload.transaction_ref or f"TXN-{violation_id[:6].upper()}-{secrets.token_hex(3).upper()}"
    paid_at = utcnow_iso()

    # Conditional update: only succeeds if the row is still unpaid.
    upd = _run(
        lambda: sb.table("violations").update({
            "status":          "Paid",
            "payment_method":  payload.payment_method,
            "paid_at":         paid_at,
            "transaction_ref": txn,
        }).eq("id", violation_id).neq("status", "Paid").execute(),
        "record payment",
    )
    if not upd.data:
        raise HTTPException(status_code=409, detail="Fine already paid")

    await manager.broadcast({
        "type":         "payment",
        "violation_id": violation_id,
        "citizen_id":   violation.get("citizen_id"),
        "amount":       violation.get("fine_amount", 200),
    })

    return {
        "success":         True,
        "violation_id":    violation_id,
        "receipt_number":  f"MCR-{violation_id[:6].upper()}",
        "location":        violation.get("location_name"),
        "timestamp":       violation.get("timestamp"),
        "paid_at":         paid_at,
        "fine_amount":     violation.get("fine_amount", 200),
        "payment_method":  payload.payment_method,
        "transaction_ref": txn,
        "citizen_id":      violation.get("citizen_id"),
    }


# ─── POST — Dispute Violation ─────────────────────────────────

@router.post("/{violation_id}/dispute", dependencies=[Depends(require_api_key)])
async def dispute_violation(
    violation_id: str,
    body: dict,
    sb: Client = Depends(db),
):
    reason = str(body.get("dispute_reason", "")).strip()
    if not reason:
        raise HTTPException(status_code=400, detail="dispute_reason is required")
    if len(reason) > 2000:
        raise HTTPException(status_code=400, detail="dispute_reason is too long (max 2000 characters)")

    result = _run(
        lambda: sb.table("violations").update({
            "status":         "Disputed",
            "dispute_reason": reason,
            "disputed_at":    utcnow_iso(),
        }).eq("id", violation_id).eq("status", "Pending").execute(),
        "submit dispute",
    )
    if not result.data:
        raise HTTPException(status_code=409, detail="Violation not found or no longer disputable")

    return {"success": True, "message": "Dispute submitted. Admin tribunal will review within 48 hours."}
