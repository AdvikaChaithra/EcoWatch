"""
backend/routers/violations.py
Violation creation (from vision engine), status updates,
payment processing, and dispute submissions.
"""
import base64
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from backend.models import ViolationCreate, ViolationUpdate, PaymentRequest
from backend.database import get_supabase, get_ws_manager

router = APIRouter(prefix="/api/violations", tags=["violations"])


# ─── GET All / Citizen Violations ─────────────────────────────

@router.get("")
async def list_violations(
    citizen_id: Optional[str] = None,
    status: Optional[str] = None,
    sb: Client = Depends(get_supabase),
):
    q = sb.table("violations").select("*").order("timestamp", desc=True)
    if citizen_id:
        q = q.eq("citizen_id", citizen_id)
    if status:
        q = q.eq("status", status)
    return q.execute().data


# ─── POST — Create Violation (from vision_engine.py) ──────────

@router.post("")
async def create_violation(
    payload: ViolationCreate,
    sb: Client = Depends(get_supabase),
    manager = Depends(get_ws_manager),
):
    """
    Called by vision_engine.py when a litter violation is detected.
    Uploads snapshot to Supabase Storage, inserts violation row,
    and broadcasts real bounding box data + citizen info over WebSocket.
    """
    snapshot_url = None

    # Upload annotated snapshot to Supabase Storage
    if payload.snapshot_b64:
        try:
            img_bytes = base64.b64decode(payload.snapshot_b64.split(",")[-1])
            ts        = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
            filename  = f"violations/{ts}.jpg"
            sb.storage.from_("evidence").upload(
                filename, img_bytes, {"content-type": "image/jpeg"}
            )
            snapshot_url = sb.storage.from_("evidence").get_public_url(filename)
        except Exception as e:
            print(f"[Storage] Snapshot upload failed: {e}")

    # Insert into DB
    row = {
        "citizen_id":       payload.citizen_id,
        "location_name":    payload.location_name,
        "lat":              payload.lat,
        "lng":              payload.lng,
        "fine_amount":      200,
        "status":           "Pending",
        "snapshot_url":     snapshot_url,
        "confidence_score": payload.confidence_score,
        "timestamp":        datetime.utcnow().isoformat(),
    }
    result   = sb.table("violations").insert(row).execute()
    violation = result.data[0] if result.data else row

    # Resolve citizen metadata
    citizen_name  = "Unknown Citizen"
    citizen_phone = None
    if payload.citizen_id:
        try:
            cr = sb.table("citizens").select("name,phone").eq("id", payload.citizen_id).execute()
            if cr.data:
                citizen_name  = cr.data[0]["name"]
                citizen_phone = cr.data[0]["phone"]
        except Exception:
            pass

    # Broadcast WS event — includes REAL bounding box data from vision engine
    await manager.broadcast({
        "type":             "violation",
        "id":               violation.get("id", ""),
        "location":         payload.location_name,
        "citizen_name":     citizen_name,
        "confidence_score": payload.confidence_score,
        "snapshot_url":     snapshot_url,
        "timestamp":        datetime.utcnow().isoformat(),
        # Real bbox coordinates (normalized 0-1) from YOLOv8 — rendered in VisionOverlay
        "person_bbox":      payload.person_bbox,
        "trash_bbox":       payload.trash_bbox,
    })

    # Dispatch SMS notification
    if citizen_phone:
        await _dispatch_sms(
            citizen_phone,
            f"EcoWatch Alert: You were detected littering at {payload.location_name}. "
            f"Fine ₹200 issued. Pay at ecowatch.gov.in/citizen"
        )

    return violation


# ─── PATCH — Update Violation Status ──────────────────────────

@router.patch("/{violation_id}")
async def update_violation(
    violation_id: str,
    payload: ViolationUpdate,
    sb: Client = Depends(get_supabase),
):
    update_data = {k: v for k, v in payload.dict().items() if v is not None}
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = sb.table("violations").update(update_data).eq("id", violation_id).execute()
    return result.data


# ─── POST — Pay Fine ──────────────────────────────────────────

@router.post("/{violation_id}/pay")
async def pay_fine(
    violation_id: str,
    payload: PaymentRequest,
    sb: Client = Depends(get_supabase),
    manager = Depends(get_ws_manager),
):
    """
    Marks violation as Paid, logs payment method + transaction ref.
    Returns receipt metadata for PDF generation on the frontend.
    """
    # Fetch existing violation
    res = sb.table("violations").select("*").eq("id", violation_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Violation not found")

    violation = res.data[0]
    if violation["status"] == "Paid":
        raise HTTPException(status_code=400, detail="Fine already paid")

    # Update status
    sb.table("violations").update({
        "status":          "Paid",
        "payment_method":  payload.payment_method,
        "paid_at":         datetime.utcnow().isoformat(),
        "transaction_ref": payload.transaction_ref or f"TXN-{violation_id[:6].upper()}-{int(datetime.utcnow().timestamp())}",
    }).eq("id", violation_id).execute()

    # Broadcast payment event
    await manager.broadcast({
        "type":         "payment",
        "violation_id": violation_id,
        "citizen_id":   violation.get("citizen_id"),
        "amount":       violation.get("fine_amount", 200),
    })

    # Receipt data returned to frontend for PDF generation
    return {
        "success":          True,
        "violation_id":     violation_id,
        "receipt_number":   f"MCR-{violation_id[:6].upper()}",
        "location":         violation.get("location_name"),
        "timestamp":        violation.get("timestamp"),
        "paid_at":          datetime.utcnow().isoformat(),
        "fine_amount":      violation.get("fine_amount", 200),
        "payment_method":   payload.payment_method,
        "transaction_ref":  payload.transaction_ref or f"TXN-{violation_id[:6].upper()}",
        "citizen_id":       violation.get("citizen_id"),
    }


# ─── POST — Dispute Violation ─────────────────────────────────

@router.post("/{violation_id}/dispute")
async def dispute_violation(
    violation_id: str,
    body: dict,
    sb: Client = Depends(get_supabase),
):
    reason = body.get("dispute_reason", "")
    if not reason:
        raise HTTPException(status_code=400, detail="dispute_reason is required")

    sb.table("violations").update({
        "status":         "Disputed",
        "dispute_reason": reason,
        "disputed_at":    datetime.utcnow().isoformat(),
    }).eq("id", violation_id).execute()

    return {"success": True, "message": "Dispute submitted. Admin tribunal will review within 48 hours."}


# ─── Helper ───────────────────────────────────────────────────

async def _dispatch_sms(phone: str, message: str):
    import os
    sid   = os.getenv("TWILIO_ACCOUNT_SID", "")
    token = os.getenv("TWILIO_AUTH_TOKEN", "")
    from_ = os.getenv("TWILIO_FROM_NUMBER", "")
    if not sid:
        print(f"[SMS] Simulated → {phone}: {message}")
        return
    try:
        import httpx
        async with httpx.AsyncClient() as client:
            await client.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                auth=(sid, token),
                data={"From": from_, "To": phone, "Body": message},
            )
    except Exception as e:
        print(f"[SMS] Twilio error: {e}")
