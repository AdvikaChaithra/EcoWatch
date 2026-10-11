"""
EcoWatch — Littering Detection State Machine (v2)
=================================================
Fixes applied vs v1:
  A1  Grace period: track-loss only after TRACK_LOST_GRACE_SECONDS continuous absence.
      While within grace, last known position is held — dwell does NOT tick.
  A2  All timing is timestamp-based (seconds), not frame-count.
      camera_fps removed from config entirely.
  A3  Distances expressed as multiples of person bbox-height, computed per frame.
      Pixel thresholds auto-scale with camera distance.
  A4  Carry-evidence required before OBJECT_ASSOCIATED can lead to a drop.
      Waste that was stationary before the person arrived → PASS_BY / PICKUP only.
      Co-motion check: waste must move with the person OR be born inside person bbox.
      action_label: DROP | PICKUP | PASS_BY | PLACE_IN_BIN | CARRY (internal).
      Every resolved candidate (any terminal state) is logged to a JSONL audit file.
  A7  SM only created when association criteria first met (lazy creation done in engine).
      Timeout runs from last_state_change_at, not created_at.
      Cooldown applied after ANY terminal state by engine, not just confirmed events.
      ByteTrack waste-ID stitching handled by engine (WasteTrackStitcher) before SM is called.

Confidence formula (deterministic, zero random):
  event_confidence =
      0.30 * association_score    (closeness + co-motion quality)
    + 0.25 * separation_score     (clean separation trajectory)
    + 0.25 * stationary_score     (dwell duration normalised)
    + 0.20 * departure_score      (person distance from drop point)
"""

from __future__ import annotations

import json
import math
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Deque, List, Optional, Tuple


# ═══════════════════════════════════════════════════════════════════════════════
# Enums
# ═══════════════════════════════════════════════════════════════════════════════

class LitterState(str, Enum):
    NORMAL              = "NORMAL"
    PERSON_NEAR_OBJECT  = "PERSON_NEAR_OBJECT"
    OBJECT_ASSOCIATED   = "OBJECT_ASSOCIATED"
    OBJECT_SEPARATING   = "OBJECT_SEPARATING"
    OBJECT_DROPPED      = "OBJECT_DROPPED"
    OBJECT_STATIONARY   = "OBJECT_STATIONARY"
    PERSON_MOVING_AWAY  = "PERSON_MOVING_AWAY"
    LITTERING_CONFIRMED = "LITTERING_CONFIRMED"
    ASSOCIATION_LOST    = "ASSOCIATION_LOST"
    OBJECT_REMOVED      = "OBJECT_REMOVED"
    PERSON_RETURNED     = "PERSON_RETURNED"
    TRACK_LOST          = "TRACK_LOST"
    TIMEOUT             = "TIMEOUT"
    FALSE_POSITIVE      = "FALSE_POSITIVE"
    PASS_BY             = "PASS_BY"
    PICKUP              = "PICKUP"
    PLACE_IN_BIN        = "PLACE_IN_BIN"


class ActionLabel(str, Enum):
    DROP         = "DROP"
    PICKUP       = "PICKUP"
    PASS_BY      = "PASS_BY"
    PLACE_IN_BIN = "PLACE_IN_BIN"
    CARRY        = "CARRY"       # intermediate; never a terminal label
    UNKNOWN      = "UNKNOWN"


_TERMINAL_STATES = {
    LitterState.LITTERING_CONFIRMED,
    LitterState.ASSOCIATION_LOST,
    LitterState.OBJECT_REMOVED,
    LitterState.PERSON_RETURNED,
    LitterState.TRACK_LOST,
    LitterState.TIMEOUT,
    LitterState.FALSE_POSITIVE,
    LitterState.PASS_BY,
    LitterState.PICKUP,
    LitterState.PLACE_IN_BIN,
}


# ═══════════════════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class LitteringConfig:
    """
    All thresholds.  Distance parameters are person-bbox-height multipliers (A3).
    Time parameters are in seconds (A2).
    Load from env vars in vision_engine.py; defaults match a 720p overhead-ish view.
    """
    # -- Distance as multiples of person bbox height (A3) ---------------------
    # e.g. 0.5 means "half the person's height"
    association_dist_ph:    float = 0.5    # max person-waste distance to start association
    separation_dist_ph:     float = 0.8    # distance at which waste is "released"
    departure_dist_ph:      float = 1.0    # person must move this far from drop point
    tolerance_dist_ph:      float = 0.12   # waste "stationary" if moves less than this
    carry_min_disp_ph:      float = 0.3    # min waste displacement during assoc to be CARRY

    # -- Time thresholds in seconds (A2) --------------------------------------
    association_min_s:      float = 0.5    # person+waste must be close for this long
    dwell_seconds:          float = 2.0    # waste must be stationary this long
    timeout_seconds:        float = 60.0   # SM timeout from last_state_change
    cooldown_seconds:       float = 30.0   # after any terminal state (applied by engine)
    grace_seconds:          float = 0.7    # A1: track may be absent this long before lost

    # -- Carry evidence (A4) --------------------------------------------------
    # Minimum fraction of association window where waste moved WITH person
    carry_comotion_threshold: float = 0.4

    # -- Audit log path -------------------------------------------------------
    audit_log_path: str = "logs/littering_candidates.jsonl"


# ═══════════════════════════════════════════════════════════════════════════════
# Data Classes
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class FrameDetection:
    """Per-frame input to the state machine (pixel coordinates)."""
    timestamp:       float
    person_present:  bool                             = False
    person_bbox:     Optional[Tuple[int,int,int,int]] = None  # (x1,y1,x2,y2)
    person_center:   Optional[Tuple[int,int]]         = None
    person_height_px: float                           = 80.0  # bbox height, for A3 scaling
    waste_present:   bool                             = False
    waste_bbox:      Optional[Tuple[int,int,int,int]] = None
    waste_center:    Optional[Tuple[int,int]]         = None
    # Pre-arrival waste status (set by engine from waste track history)
    waste_was_stationary_before_person: bool          = False   # A4 key flag
    # Whether waste appeared inside person bbox (born in hand) — set by engine (A4)
    waste_born_in_person_bbox:          bool          = False


@dataclass
class LitteringEvent:
    """Emitted only when action_label == DROP and state == LITTERING_CONFIRMED."""
    event_id:          str
    camera_id:         str
    timestamp:         float
    person_track_id:   int
    waste_track_id:    int
    person_bbox:       Tuple[int,int,int,int]
    waste_bbox:        Tuple[int,int,int,int]
    event_confidence:  float
    action_label:      ActionLabel = ActionLabel.DROP
    association_score: float = 0.0
    separation_score:  float = 0.0
    stationary_score:  float = 0.0
    departure_score:   float = 0.0
    dwell_actual_s:    float = 0.0


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _dist(a: Tuple[int,int], b: Tuple[int,int]) -> float:
    return math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2)

def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))

def _dot_sign(v1: Tuple[float,float], v2: Tuple[float,float]) -> float:
    """Cosine of angle between two 2-D displacement vectors. Returns -1..+1."""
    n1 = math.sqrt(v1[0]**2 + v1[1]**2)
    n2 = math.sqrt(v2[0]**2 + v2[1]**2)
    if n1 < 1e-6 or n2 < 1e-6:
        return 0.0
    return (v1[0]*v2[0] + v1[1]*v2[1]) / (n1 * n2)


# ═══════════════════════════════════════════════════════════════════════════════
# Audit Logger
# ═══════════════════════════════════════════════════════════════════════════════

class CandidateLogger:
    """
    Appends one JSONL line per resolved (terminal) SM candidate.
    Keeps the file below MAX_BYTES by rotating on open (not mid-write).
    """
    MAX_BYTES = 50 * 1024 * 1024  # 50 MB

    def __init__(self, path: str):
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, sm: "LitteringStateMachine", action: ActionLabel, reason: str):
        record = {
            "ts":              datetime.now(tz=timezone.utc).isoformat(),
            "event_id":        sm._event_id,
            "camera_id":       sm.camera_id,
            "person_track_id": sm.person_track_id,
            "waste_track_id":  sm.waste_track_id,
            "final_state":     sm.state.value,
            "action_label":    action.value,
            "reason":          reason,
            "duration_s":      round(time.time() - sm._created_at, 2),
            "assoc_score":     round(sm._assoc_score, 3),
            "sep_score":       round(sm._sep_score, 3),
            "stat_score":      round(sm._stat_score, 3),
            "depart_score":    round(sm._depart_score, 3),
            "dwell_actual_s":  round(sm._dwell_actual_s, 2),
            "carry_ratio":     round(sm._carry_comotion_ratio, 3),
        }
        try:
            if self._path.exists() and self._path.stat().st_size > self.MAX_BYTES:
                self._path.rename(self._path.with_suffix(".jsonl.bak"))
            with self._path.open("a") as f:
                f.write(json.dumps(record) + "\n")
        except Exception as exc:
            print(f"[Logger] Failed to write audit log: {exc}")


# Module-level singleton (engine sets path from config)
_logger: Optional[CandidateLogger] = None

def init_logger(path: str):
    global _logger
    _logger = CandidateLogger(path)

def _audit(sm: "LitteringStateMachine", action: ActionLabel, reason: str):
    if _logger:
        _logger.log(sm, action, reason)


# ═══════════════════════════════════════════════════════════════════════════════
# State Machine
# ═══════════════════════════════════════════════════════════════════════════════

class LitteringStateMachine:
    """
    One instance per (person_track_id, waste_track_id) pair.

    Creation policy (A7): engine creates SM only when the pair first satisfies
    the proximity test — NOT for every person×waste pair in every frame.

    Timeout runs from last_state_change_at (A7).

    Grace period (A1): a missing track does not immediately kill the SM.
    Last known position is held for up to cfg.grace_seconds.

    Carry evidence (A4): if waste_was_stationary_before_person is True,
    the pair is classified as PASS_BY or PICKUP — never DROP.

    NEVER fires LITTERING_CONFIRMED from:
      - Waste detection alone
      - A single frame
      - Dwell alone (without association → separation → departure)
      - A pair where the waste was already on the ground before the person arrived
    """

    def __init__(
        self,
        person_track_id: int,
        waste_track_id:  int,
        camera_id:       str,
        cfg:             LitteringConfig,
        initial_det:     FrameDetection,   # A7: created at first association
    ):
        self.person_track_id   = person_track_id
        self.waste_track_id    = waste_track_id
        self.camera_id         = camera_id
        self.cfg               = cfg
        self.state             = LitterState.PERSON_NEAR_OBJECT   # starts here
        self._created_at       = initial_det.timestamp
        self._last_change_at   = initial_det.timestamp
        self._done             = False
        self._event_id         = str(uuid.uuid4())

        # A4: carry evidence flags set at creation from first detection
        self._was_stationary_before = initial_det.waste_was_stationary_before_person
        self._born_in_bbox          = initial_det.waste_born_in_person_bbox

        # Scoring
        self._assoc_score:  float = 0.0
        self._sep_score:    float = 0.0
        self._stat_score:   float = 0.0
        self._depart_score: float = 0.0
        self._dwell_actual_s: float = 0.0

        # Association window tracking (A2: time-based, A4: co-motion)
        self._assoc_start:   float                    = initial_det.timestamp
        self._assoc_dists:   List[float]              = []
        # Co-motion: list of (person_disp_vec, waste_disp_vec) per consecutive pair
        self._comotion_agreements: int = 0
        self._comotion_checks:     int = 0
        self._carry_comotion_ratio: float = 0.0
        self._last_person_center: Optional[Tuple[int,int]] = initial_det.person_center
        self._last_waste_center:  Optional[Tuple[int,int]] = initial_det.waste_center
        self._waste_disp_total:   float = 0.0  # total displacement of waste during assoc

        # Separation
        self._sep_max_dist:         float                     = 0.0
        self._pre_sep_waste_center: Optional[Tuple[int,int]] = initial_det.waste_center

        # Drop/dwell
        self._drop_waste_center:  Optional[Tuple[int,int]] = None
        self._drop_person_center: Optional[Tuple[int,int]] = None
        self._dwell_start:        Optional[float]          = None
        self._dwell_anchor:       Optional[Tuple[int,int]] = None

        # Departure
        self._max_departure_dist: float = 0.0
        self.dwell_progress:      float = 0.0   # 0.0–1.0, for UI

        # Best-effort evidence bboxes
        self._final_person_bbox: Optional[Tuple[int,int,int,int]] = None
        self._final_waste_bbox:  Optional[Tuple[int,int,int,int]] = None

        # Grace period (A1): last seen timestamps
        self._person_last_seen: float = initial_det.timestamp
        self._waste_last_seen:  float = initial_det.timestamp
        self._last_known_person_center: Optional[Tuple[int,int]] = initial_det.person_center
        self._last_known_waste_center:  Optional[Tuple[int,int]] = initial_det.waste_center
        self._last_known_person_bbox:   Optional[Tuple[int,int,int,int]] = initial_det.person_bbox
        self._last_known_waste_bbox:    Optional[Tuple[int,int,int,int]] = initial_det.waste_bbox

    @property
    def is_terminal(self) -> bool:
        return self._done

    def _px(self, person_height_px: float, multiplier: float) -> float:
        """Convert a person-height multiplier to pixels (A3)."""
        return max(person_height_px * multiplier, 10.0)

    def _update_grace(self, det: FrameDetection):
        """A1: update last-seen timestamps and last-known positions."""
        now = det.timestamp
        if det.person_present and det.person_center:
            self._person_last_seen          = now
            self._last_known_person_center  = det.person_center
            self._last_known_person_bbox    = det.person_bbox
        if det.waste_present and det.waste_center:
            self._waste_last_seen           = now
            self._last_known_waste_center   = det.waste_center
            self._last_known_waste_bbox     = det.waste_bbox

    def _person_within_grace(self, now: float) -> bool:
        return (now - self._person_last_seen) <= self.cfg.grace_seconds

    def _waste_within_grace(self, now: float) -> bool:
        return (now - self._waste_last_seen) <= self.cfg.grace_seconds

    def _effective(self, det: FrameDetection):
        """
        Returns effective (person_present, waste_present, pc, wc, pb, wb, p_height).
        Within grace period, substitutes last known position.
        """
        now = det.timestamp
        p_ok = det.person_present or self._person_within_grace(now)
        w_ok = det.waste_present  or self._waste_within_grace(now)
        pc   = det.person_center  if det.person_present else (self._last_known_person_center if p_ok else None)
        wc   = det.waste_center   if det.waste_present  else (self._last_known_waste_center  if w_ok else None)
        pb   = det.person_bbox    if det.person_present else (self._last_known_person_bbox   if p_ok else None)
        wb   = det.waste_bbox     if det.waste_present  else (self._last_known_waste_bbox    if w_ok else None)
        ph   = det.person_height_px if det.person_present else (
            (pb[3]-pb[1]) if pb and len(pb)==4 else det.person_height_px
        )
        return p_ok, w_ok, pc, wc, pb, wb, ph

    def update(self, det: FrameDetection) -> Optional[LitteringEvent]:
        if self._done:
            return None

        now = det.timestamp

        # A7: timeout from last state change
        if (now - self._last_change_at) > self.cfg.timeout_seconds:
            self._go(LitterState.TIMEOUT)
            _audit(self, ActionLabel.UNKNOWN, "timeout")
            return None

        self._update_grace(det)
        p_ok, w_ok, pc, wc, pb, wb, ph = self._effective(det)

        # Adjust distances for current person-bbox height (A3)
        assoc_px  = self._px(ph, self.cfg.association_dist_ph)
        sep_px    = self._px(ph, self.cfg.separation_dist_ph)
        dep_px    = self._px(ph, self.cfg.departure_dist_ph)
        tol_px    = self._px(ph, self.cfg.tolerance_dist_ph)
        carry_px  = self._px(ph, self.cfg.carry_min_disp_ph)

        # Dispatch to handler; within-grace substitution already applied
        handlers = {
            LitterState.PERSON_NEAR_OBJECT: self._h_near,
            LitterState.OBJECT_ASSOCIATED:  self._h_associated,
            LitterState.OBJECT_SEPARATING:  self._h_separating,
            LitterState.OBJECT_DROPPED:     self._h_dropped,
            LitterState.OBJECT_STATIONARY:  self._h_stationary,
            LitterState.PERSON_MOVING_AWAY: self._h_departing,
        }
        handler = handlers.get(self.state)
        if handler:
            return handler(p_ok, w_ok, pc, wc, pb, wb, now,
                           assoc_px, sep_px, dep_px, tol_px, carry_px, det)
        return None

    # ── State handlers ────────────────────────────────────────────────────────

    def _h_near(self, p, w, pc, wc, pb, wb, now,
                assoc_px, sep_px, dep_px, tol_px, carry_px, det):
        """A4: build association evidence while in PERSON_NEAR_OBJECT."""
        if not p or not w or not pc or not wc:
            # Grace exhausted on one track
            self._go(LitterState.TRACK_LOST)
            _audit(self, ActionLabel.UNKNOWN, "track lost during proximity")
            return None

        d = _dist(pc, wc)
        if d > assoc_px:
            # Drifted apart before association confirmed — PASS_BY if waste was pre-existing
            label = ActionLabel.PASS_BY if self._was_stationary_before else ActionLabel.UNKNOWN
            self._go(LitterState.PASS_BY if self._was_stationary_before else LitterState.ASSOCIATION_LOST)
            _audit(self, label, f"distance {d:.0f}px exceeded assoc {assoc_px:.0f}px before association")
            return None

        # Accumulate association evidence
        self._assoc_dists.append(d)
        self._accum_comotion(pc, wc)
        elapsed = now - self._assoc_start

        if elapsed >= self.cfg.association_min_s:
            # A4: check carry evidence
            action = self._classify_action(carry_px)
            if action != ActionLabel.CARRY and action != ActionLabel.DROP:
                # Not a carry → PASS_BY or PICKUP; cannot become littering
                state = LitterState.PASS_BY if action == ActionLabel.PASS_BY else LitterState.PICKUP
                self._go(state)
                _audit(self, action, f"action classified as {action.value} after {elapsed:.1f}s association")
                return None

            # Association confirmed, carry evidence present
            avg_d = sum(self._assoc_dists) / len(self._assoc_dists)
            self._assoc_score = _clamp(1.0 - avg_d / assoc_px)
            self._pre_sep_waste_center = wc
            self._go(LitterState.OBJECT_ASSOCIATED)
        return None

    def _h_associated(self, p, w, pc, wc, pb, wb, now,
                       assoc_px, sep_px, dep_px, tol_px, carry_px, det):
        if not w or not wc:
            if not self._waste_within_grace(now):
                self._go(LitterState.OBJECT_REMOVED)
                _audit(self, ActionLabel.UNKNOWN, "waste disappeared after association")
            return None
        if not p or not pc:
            # Person left frame — treat as drop start with partial sep score
            self._sep_score = 0.35
            self._drop_waste_center = wc
            self._drop_person_center = self._last_known_person_center
            self._init_dwell(wc, now)
            self._go(LitterState.OBJECT_DROPPED)
            return None
        d = _dist(pc, wc)
        if d > assoc_px:
            self._sep_max_dist = d
            self._go(LitterState.OBJECT_SEPARATING)
        return None

    def _h_separating(self, p, w, pc, wc, pb, wb, now,
                       assoc_px, sep_px, dep_px, tol_px, carry_px, det):
        if not w:
            if not self._waste_within_grace(now):
                self._go(LitterState.FALSE_POSITIVE)
                _audit(self, ActionLabel.UNKNOWN, "waste disappeared during separation")
            return None
        if not p:
            # Person left during separation — proceed to dropped
            if pc is None:
                pc = self._last_known_person_center
            self._finalize_sep(self._sep_max_dist, assoc_px, sep_px)
            self._drop_waste_center  = wc
            self._drop_person_center = self._last_known_person_center
            self._init_dwell(wc, now)
            self._go(LitterState.OBJECT_DROPPED)
            return None
        d = _dist(pc, wc)
        self._sep_max_dist = max(self._sep_max_dist, d)
        if d >= sep_px:
            self._finalize_sep(d, assoc_px, sep_px)
            self._drop_waste_center  = wc
            self._drop_person_center = pc
            self._init_dwell(wc, now)
            self._go(LitterState.OBJECT_DROPPED)
        elif d < assoc_px:
            self._go(LitterState.PERSON_RETURNED)
            _audit(self, ActionLabel.UNKNOWN, "person returned during separation")
        return None

    def _h_dropped(self, p, w, pc, wc, pb, wb, now,
                   assoc_px, sep_px, dep_px, tol_px, carry_px, det):
        if not w:
            if not self._waste_within_grace(now):
                self._go(LitterState.OBJECT_REMOVED)
                _audit(self, ActionLabel.UNKNOWN, "waste removed after drop")
            return None
        if wc is None:
            wc = self._last_known_waste_center
        if wc is None:
            return None
        # Person returned?
        if p and pc and self._drop_waste_center:
            if _dist(pc, self._drop_waste_center) < assoc_px:
                self._go(LitterState.PERSON_RETURNED)
                _audit(self, ActionLabel.UNKNOWN, "person returned after drop")
                return None
        # Stationary check (A2: timestamp-based)
        if self._dwell_anchor:
            movement = _dist(wc, self._dwell_anchor)
            if movement < tol_px:
                # A1: don't advance dwell if within grace (position held — uncertain)
                if det.waste_present:  # only count real detections for dwell
                    elapsed_dwell = now - self._dwell_start if self._dwell_start else 0.0
                    self.dwell_progress = _clamp(elapsed_dwell / max(self.cfg.dwell_seconds, 0.01))
                    if elapsed_dwell >= self.cfg.dwell_seconds:
                        self._dwell_actual_s = elapsed_dwell
                        self._stat_score = _clamp(elapsed_dwell / self.cfg.dwell_seconds)
                        if wb: self._final_waste_bbox = wb
                        self._go(LitterState.OBJECT_STATIONARY)
            else:
                # Waste moved — reset dwell
                self._init_dwell(wc, now)
        return None

    def _h_stationary(self, p, w, pc, wc, pb, wb, now,
                       assoc_px, sep_px, dep_px, tol_px, carry_px, det):
        if not w:
            if not self._waste_within_grace(now):
                self._go(LitterState.OBJECT_REMOVED)
                _audit(self, ActionLabel.UNKNOWN, "waste removed while stationary")
            return None
        if wc is None:
            wc = self._last_known_waste_center
        if wc is None:
            return None
        if self._dwell_anchor and _dist(wc, self._dwell_anchor) >= tol_px:
            self._go(LitterState.FALSE_POSITIVE)
            _audit(self, ActionLabel.UNKNOWN, "waste moved again after stationary confirmed")
            return None
        if p and pc and self._drop_waste_center:
            if _dist(pc, self._drop_waste_center) < assoc_px:
                self._go(LitterState.PERSON_RETURNED)
                _audit(self, ActionLabel.PICKUP if self._was_stationary_before else ActionLabel.UNKNOWN,
                       "person returned while waste stationary")
                return None
            if _dist(pc, self._drop_waste_center) >= dep_px:
                self._max_departure_dist = _dist(pc, self._drop_waste_center)
                if pb: self._final_person_bbox = pb
                self._go(LitterState.PERSON_MOVING_AWAY)
        elif not p:
            # Person left frame — full departure credit
            self._max_departure_dist = dep_px * 2.0
            self._go(LitterState.PERSON_MOVING_AWAY)
        return None

    def _h_departing(self, p, w, pc, wc, pb, wb, now,
                     assoc_px, sep_px, dep_px, tol_px, carry_px,
                     det) -> Optional[LitteringEvent]:
        if not w:
            if not self._waste_within_grace(now):
                self._go(LitterState.OBJECT_REMOVED)
                _audit(self, ActionLabel.UNKNOWN, "waste removed during departure")
                return None
        if p and pc and self._drop_waste_center:
            if _dist(pc, self._drop_waste_center) < assoc_px:
                self._go(LitterState.PERSON_RETURNED)
                _audit(self, ActionLabel.UNKNOWN, "person returned during departure")
                return None
            self._max_departure_dist = max(self._max_departure_dist, _dist(pc, self._drop_waste_center))
            if pb: self._final_person_bbox = pb

        self._depart_score = _clamp(self._max_departure_dist / max(dep_px * 2, 1))
        confidence = (
            0.30 * self._assoc_score
            + 0.25 * self._sep_score
            + 0.25 * self._stat_score
            + 0.20 * self._depart_score
        )

        p_bbox = self._final_person_bbox or (pb or self._last_known_person_bbox or (0,0,1,1))
        w_bbox = self._final_waste_bbox  or (wb or self._last_known_waste_bbox  or (0,0,1,1))
        if not self._final_person_bbox and self._drop_person_center:
            cx, cy = self._drop_person_center
            p_bbox = (cx-40, cy-80, cx+40, cy+80)
        if not self._final_waste_bbox and self._drop_waste_center:
            cx, cy = self._drop_waste_center
            w_bbox = (cx-20, cy-20, cx+20, cy+20)

        self._go(LitterState.LITTERING_CONFIRMED)
        ev = LitteringEvent(
            event_id          = self._event_id,
            camera_id         = self.camera_id,
            timestamp         = now,
            person_track_id   = self.person_track_id,
            waste_track_id    = self.waste_track_id,
            person_bbox       = p_bbox,
            waste_bbox        = w_bbox,
            event_confidence  = round(confidence, 3),
            action_label      = ActionLabel.DROP,
            association_score = round(self._assoc_score, 3),
            separation_score  = round(self._sep_score, 3),
            stationary_score  = round(self._stat_score, 3),
            departure_score   = round(self._depart_score, 3),
            dwell_actual_s    = round(self._dwell_actual_s, 2),
        )
        _audit(self, ActionLabel.DROP,
               f"CONFIRMED conf={confidence:.2%} dwell={self._dwell_actual_s:.1f}s")
        return ev

    # ── Co-motion / carry classification (A4) ────────────────────────────────

    def _accum_comotion(self, pc: Tuple[int,int], wc: Tuple[int,int]):
        """Track displacement vectors each frame to evaluate carry evidence."""
        if self._last_person_center and self._last_waste_center:
            p_vec = (pc[0] - self._last_person_center[0],
                     pc[1] - self._last_person_center[1])
            w_vec = (wc[0] - self._last_waste_center[0],
                     wc[1] - self._last_waste_center[1])
            w_disp = math.sqrt(w_vec[0]**2 + w_vec[1]**2)
            self._waste_disp_total += w_disp

            if w_disp > 1.0:   # ignore sub-pixel jitter
                self._comotion_checks += 1
                if _dot_sign(p_vec, w_vec) > 0.5:
                    self._comotion_agreements += 1

        self._last_person_center = pc
        self._last_waste_center  = wc

    def _classify_action(self, carry_px: float) -> ActionLabel:
        """
        A4: classify the association.
        Returns CARRY (→ will become DROP), PICKUP, or PASS_BY.

        Rules (in order):
        1. Waste was born inside person bbox → CARRY regardless of displacement
        2. Waste was stationary before person arrived → PICKUP or PASS_BY
        3. Waste moved enough AND co-motion confirmed → CARRY
        4. Otherwise → PASS_BY
        """
        ratio = (self._comotion_agreements / max(self._comotion_checks, 1)
                 if self._comotion_checks > 0 else 0.0)
        self._carry_comotion_ratio = ratio

        if self._born_in_bbox:
            return ActionLabel.CARRY

        if self._was_stationary_before:
            # Person walked up to existing waste
            if self._waste_disp_total > carry_px and ratio >= self.cfg.carry_comotion_threshold:
                return ActionLabel.PICKUP   # person picked it up (waste moved with person)
            return ActionLabel.PASS_BY      # person just walked past it

        # Waste appeared while person was there (or simultaneously)
        if (self._waste_disp_total >= carry_px
                and ratio >= self.cfg.carry_comotion_threshold):
            return ActionLabel.CARRY
        return ActionLabel.PASS_BY

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _go(self, state: LitterState):
        self.state          = state
        self._last_change_at = time.time()
        if state in _TERMINAL_STATES:
            self._done = True

    def _init_dwell(self, wc: Tuple[int,int], now: float):
        self._dwell_start  = now
        self._dwell_anchor = wc
        self.dwell_progress = 0.0

    def _finalize_sep(self, d: float, assoc_px: float, sep_px: float):
        span = max(sep_px - assoc_px, 1)
        self._sep_score = _clamp((d - assoc_px) / span)


# ═══════════════════════════════════════════════════════════════════════════════
# Waste Track History  (for engine to compute waste_was_stationary_before_person)
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class WasteTrackHistory:
    """
    Per waste track_id: short history used to answer two questions:
      1. Was the waste stationary before any person came near? (A4 flag)
      2. Did the waste appear inside a person's bbox? (A4 born-in-bbox)
    Also handles ByteTrack ID stitching for stationary waste (A7).
    """
    track_id:     int
    centers:      Deque[Tuple[int,int]]  = field(default_factory=lambda: deque(maxlen=90))
    timestamps:   Deque[float]           = field(default_factory=lambda: deque(maxlen=90))
    first_seen:   float                  = field(default_factory=time.time)
    last_seen:    float                  = field(default_factory=time.time)
    last_bbox:    Optional[Tuple[int,int,int,int]] = None

    # Populated by engine on first frame
    born_timestamp: float   = 0.0
    born_inside_person: bool = False

    def update(self, center: Tuple[int, int], bbox: Tuple[int,int,int,int], ts: float):
        self.centers.append(center)
        self.timestamps.append(ts)
        self.last_seen = ts
        self.last_bbox = bbox

    def was_stationary(self, window_s: float = 2.0, tol_px: float = 20.0) -> bool:
        """
        Returns True if the waste barely moved in the last `window_s` seconds.
        Used to detect pre-existing waste (A4).
        """
        if len(self.centers) < 2:
            return True  # not enough data; conservative: assume stationary
        cutoff = time.time() - window_s
        recent = [c for c, t in zip(self.centers, self.timestamps) if t >= cutoff]
        if len(recent) < 2:
            return True
        xs = [c[0] for c in recent]
        ys = [c[1] for c in recent]
        span = math.sqrt((max(xs)-min(xs))**2 + (max(ys)-min(ys))**2)
        return span < tol_px
