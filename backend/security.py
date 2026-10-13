"""
backend/security.py
Shared helpers: API-key guard, constant-time compares, credential verification,
timezone-aware timestamps, Twilio dispatch with status checking.
"""
import hashlib
import hmac
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import Header, HTTPException


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def utcnow_iso() -> str:
    return utcnow().isoformat()


def safe_equal(a: str, b: str) -> bool:
    return hmac.compare_digest((a or "").encode(), (b or "").encode())


def require_api_key(x_api_key: str = Header(default="")):
    """
    Guards mutating REST endpoints. Set BACKEND_API_KEY to enforce.
    When unset, requests are allowed (dev only) — set it in production.
    """
    key = os.getenv("BACKEND_API_KEY", "")
    if key and not safe_equal(x_api_key, key):
        raise HTTPException(status_code=403, detail="Invalid or missing API key")


# ── Credential hashing ────────────────────────────────────────────────────────
# Stored format: "pbkdf2$<iterations>$<salt_hex>$<hash_hex>".
# Legacy plain-text values (seeded demo data) still verify, so existing rows keep
# working until they are re-saved with hash_secret().

_ITER = 120_000


def hash_secret(secret: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", secret.encode(), salt, _ITER)
    return f"pbkdf2${_ITER}${salt.hex()}${dk.hex()}"


def verify_secret(secret: str, stored: Optional[str]) -> bool:
    stored = (stored or "").strip()
    if not stored:
        return False
    if stored.startswith("pbkdf2$"):
        try:
            _, iters, salt_hex, hash_hex = stored.split("$")
            dk = hashlib.pbkdf2_hmac("sha256", secret.encode(), bytes.fromhex(salt_hex), int(iters))
            return hmac.compare_digest(dk.hex(), hash_hex)
        except (ValueError, TypeError):
            return False
    return safe_equal(secret.strip(), stored)  # legacy plain-text


# ── Twilio ────────────────────────────────────────────────────────────────────

async def send_sms(phone: str, message: str) -> bool:
    """Send an SMS via Twilio. Returns True only if Twilio accepted it.
    With no credentials configured, logs the message (dev) and returns False."""
    sid = os.getenv("TWILIO_ACCOUNT_SID", "")
    token = os.getenv("TWILIO_AUTH_TOKEN", "")
    from_ = os.getenv("TWILIO_FROM_NUMBER", "")
    if not (sid and token and from_ and phone):
        print(f"[SMS] Simulated (Twilio not configured) -> {phone}: {message}")
        return False
    try:
        import httpx
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                auth=(sid, token),
                data={"From": from_, "To": phone, "Body": message},
            )
        if r.status_code >= 300:
            print(f"[SMS] Twilio rejected message ({r.status_code}): {r.text[:200]}")
            return False
        return True
    except Exception as e:
        print(f"[SMS] Twilio error: {e}")
        return False
