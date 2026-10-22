"""
Unit tests for the identity decision and idempotent violation creation.
Run from the repo root:  python -m pytest tests -q     (or: python tests/test_identity.py)
The candidate lists / fake DB below are labelled TEST FIXTURES; no production data is simulated.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import identity as I  # noqa: E402


def cand(id_, sim, name="X"):
    return {"id": id_, "name": name, "similarity": sim}


def test_match_requires_threshold_and_margin():
    r = I.decide([cand("A", 0.72), cand("B", 0.30)])
    assert r.status == "MATCH" and r.citizen_id == "A"


def test_close_runner_up_is_uncertain_not_match():
    r = I.decide([cand("A", 0.70), cand("B", 0.66)])
    assert r.status == "UNCERTAIN" and r.citizen_id is None   # never attach identity


def test_between_thresholds_uncertain():
    r = I.decide([cand("A", (I.FACE_REVIEW_THRESHOLD + I.FACE_MATCH_THRESHOLD) / 2)])
    assert r.status == "UNCERTAIN" and r.citizen_id is None


def test_below_review_is_no_match():
    r = I.decide([cand("A", I.FACE_REVIEW_THRESHOLD - 0.05)])
    assert r.status == "NO_MATCH" and r.citizen_id is None


def test_empty_database_is_no_match():
    assert I.decide([]).status == "NO_MATCH"


def test_no_crops_is_no_face():
    assert I.identify(None, []).status == "NO_FACE"


# ── idempotency with a tiny in-memory fake of the supabase client ────────────
class _Res:
    def __init__(self, data): self.data = data


class _Table:
    def __init__(self, db, name): self.db, self.name, self._filters, self._op, self._row = db, name, [], "select", None
    def select(self, *_a, **_k): self._op = "select"; return self
    def eq(self, col, val): self._filters.append((col, val)); return self
    def insert(self, row):
        self._op, self._row = "insert", row; return self
    def update(self, row): self._op, self._row = "update", row; return self
    def execute(self):
        rows = self.db.setdefault(self.name, [])
        if self._op == "insert":
            if self.name == "violations" and any(r.get("event_id") == self._row.get("event_id") for r in rows):
                raise RuntimeError("duplicate key value violates unique constraint")
            row = dict(self._row, id=f"id{len(rows)+1}")
            rows.append(row)
            return _Res([row])
        hit = [r for r in rows if all(r.get(c) == v for c, v in self._filters)]
        if self._op == "update":
            for r in hit:
                r.update(self._row)
        return _Res(hit)


class _FakeSB:
    def __init__(self): self.db = {}
    def table(self, name): return _Table(self.db, name)


EVENT = {"event_id": "evt-1", "camera_id": "CAM_01", "timestamp": "2026-01-01T00:00:00+00:00",
         "event_confidence": 0.8, "evidence_dir": "evt-1abc",
         "location": {"name": "Test Location", "latitude": 12.97, "longitude": 77.64}}


def test_same_event_creates_one_violation_and_one_notification():
    sb = _FakeSB()
    match = I.IdentityResult(status="MATCH", citizen_id="CIT-1", citizen_name="Test User", similarity=0.8)
    a = I.record_event(sb, EVENT, match)
    b = I.record_event(sb, EVENT, match)
    assert a["created"] is True and b["created"] is False
    assert len(sb.db["violations"]) == 1 and len(sb.db["notifications"]) == 1
    assert sb.db["violations"][0]["fine_amount"] == I.FINE_AMOUNT
    assert sb.db["notifications"][0]["user_id"] == "CIT-1"


def test_unidentified_event_has_no_citizen_and_no_fine():
    sb = _FakeSB()
    I.record_event(sb, EVENT, I.IdentityResult(status="NO_MATCH", similarity=0.1))
    v = sb.db["violations"][0]
    assert v["citizen_id"] is None and v["fine_amount"] == 0 and v["status"] == "Unidentified"
    assert "notifications" not in sb.db


class _Chain:
    """Minimal fake for sb.table(...).select().eq().order().limit().execute() (TEST FIXTURE)."""
    def __init__(self, rows): self.rows = rows
    def __getattr__(self, _n): return lambda *a, **k: self
    def execute(self): return _Res(self.rows)


class _MsgSB:
    def __init__(self, used): self.used = used
    def table(self, _name): return _Chain([{"awareness_message": m} for m in self.used])


def test_awareness_message_differs_for_each_violation():
    seen = []
    for _ in range(len(I.AWARENESS_MESSAGES)):
        m = I.pick_awareness_message(_MsgSB(list(reversed(seen))), "CIT-1")
        assert m not in seen, "message repeated before all were used"
        seen.append(m)
    assert all(m.count("•") == 2 for m in I.AWARENESS_MESSAGES), "each message must be 2 short points"


if __name__ == "__main__":
    import traceback
    fails = 0
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            try:
                f(); print("PASS", n)
            except Exception:
                fails += 1; print("FAIL", n); traceback.print_exc()
    sys.exit(1 if fails else 0)


# ── admin retry of identification for an unidentified event ──────────────────
def _unidentified_sb():
    sb = _FakeSB()
    sb.db["violations"] = [{"id": "v1", "status": "Unidentified", "identity_status": "NO_MATCH",
                            "citizen_id": None, "fine_amount": 0, "location_name": "Test Location"}]
    sb.db["violations_awareness"] = []
    return sb


def test_reidentify_match_issues_fine_and_alert(monkeypatch):
    sb = _unidentified_sb()
    monkeypatch.setattr(I, "identify", lambda _sb, _c: I.IdentityResult(
        status="MATCH", reason="ok", citizen_id="CIT-9", citizen_name="A", similarity=0.71))
    monkeypatch.setattr(I, "pick_awareness_message", lambda _sb, _cid: "msg")
    out = I.reidentify(sb, "v1", ["crop"])
    v = sb.db["violations"][0]
    assert out["fined"] and v["status"] == "Pending" and v["citizen_id"] == "CIT-9" and v["fine_amount"] == I.FINE_AMOUNT
    assert sb.db["notifications"][0]["user_id"] == "CIT-9"


def test_reidentify_uncertain_never_fines(monkeypatch):
    sb = _unidentified_sb()
    monkeypatch.setattr(I, "identify", lambda _sb, _c: I.IdentityResult(status="UNCERTAIN", reason="margin", similarity=0.4))
    out = I.reidentify(sb, "v1", ["crop"])
    v = sb.db["violations"][0]
    assert out["fined"] is False and v["status"] == "Unidentified" and v["citizen_id"] is None
    assert "notifications" not in sb.db


def test_reidentify_refuses_events_that_are_not_unidentified(monkeypatch):
    sb = _unidentified_sb()
    sb.db["violations"][0]["status"] = "Paid"
    assert I.reidentify(sb, "v1", ["crop"])["ok"] is False

