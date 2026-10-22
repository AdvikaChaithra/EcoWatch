"""
EcoWatch — Littering Detection State Machine (v3)
=================================================
Changes from v2:
  A4-rework  Classification keeps watching for PICKUP throughout all post-association states.
             CARRY is logged explicitly (intermediate label, resolved to DROP at confirmation).
             born-in-hand uses timestamp: if waste track's first_seen is within the
             association window start and waste center was inside person bbox at birth.
             After association, if person picks waste back up → PICKUP label, not TRACK_LOST.
  A5-in-SM   ZoneChecker reference passed into the SM. In _h_departing and _h_stationary,
             if waste center falls inside a bin_zone → PLACE_IN_BIN terminal, never DROP.
  A7-fixes   Timeout resets correctly via last_change_at (unchanged from v2, confirmed good).

State sequence (unchanged):
  PERSON_NEAR_OBJECT → OBJECT_ASSOCIATED → OBJECT_SEPARATING →
  OBJECT_DROPPED → OBJECT_STATIONARY → PERSON_MOVING_AWAY → LITTERING_CONFIRMED

Action labels:
  CARRY      — intermediate (waste moves with person; recorded in audit, not broadcast)
  DROP       — only label that produces a LITTERING_CONFIRMED event
  PICKUP     — person approached existing waste, moved it, left with it
  PASS_BY    — person walked near stationary waste without interacting
  PLACE_IN_BIN — object came to rest inside a bin zone
  UNKNOWN    — timeout, track_lost, false_positive
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
from typing import TYPE_CHECKING, Any, Deque, List, Optional, Tuple

if TYPE_CHECKING:
    from backend.camera_zones import ZoneChecker


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
    CARRY        = "CARRY"    # intermediate logged state; resolves to DROP or PICKUP
    UNKNOWN      = "UNKNOWN"


_TERMINAL_STATES = {
    LitterState.LITTERING_CONFIRMED, LitterState.ASSOCIATION_LOST,
    LitterState.OBJECT_REMOVED,      LitterState.PERSON_RETURNED,
    LitterState.TRACK_LOST,          LitterState.TIMEOUT,
    LitterState.FALSE_POSITIVE,      LitterState.PASS_BY,
    LitterState.PICKUP,              LitterState.PLACE_IN_BIN,
}


# ═══════════════════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class LitteringConfig:
    # Distances as person-bbox-height multiples (A3)
    association_dist_ph:      float = 0.5
    separation_dist_ph:       float = 0.8
    departure_dist_ph:        float = 1.0
    tolerance_dist_ph:        float = 0.12
    carry_min_disp_ph:        float = 0.3

    # Time thresholds (seconds) (A2)
    association_min_s:        float = 0.5
    dwell_seconds:            float = 2.0
    timeout_seconds:          float = 60.0
    cooldown_seconds:         float = 30.0
    grace_seconds:            float = 0.7   # A1 (person tracks)
    # Objects (esp. a small bottle lying still) flicker in/out of detection far more than
    # people, so they get a longer tolerance before being treated as removed.
    waste_grace_seconds:      float = 2.5

    # Carry classification (A4)
    carry_comotion_threshold: float = 0.4
    # Born-in-hand: if waste first appeared within this many seconds of association start
    born_in_hand_window_s:    float = 1.0
    # ...and at least this share of the object's box lay inside the person's box (not merely its
    # centre: with a close camera the person box spans most of the frame, wall posters included)
    born_in_hand_min_overlap: float = 0.5
    # Per-frame centre movement below this is detector jitter, not motion (px)
    jitter_px:                float = 3.0

    # Evidence gates for a fine: a weak person<->object link or low overall confidence is
    # discarded as FALSE_POSITIVE instead of fining someone for an object they never held.
    min_association_score:    float = 0.25
    min_event_confidence:     float = 0.65

    # Audit log
    audit_log_path: str = "logs/littering_candidates.jsonl"


# ═══════════════════════════════════════════════════════════════════════════════
# Data Classes
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class FrameDetection:
    timestamp:        float
    person_present:   bool                             = False
    person_bbox:      Optional[Tuple[int,int,int,int]] = None
    person_center:    Optional[Tuple[int,int]]         = None
    person_height_px: float                            = 80.0
    waste_present:    bool                             = False
    waste_bbox:       Optional[Tuple[int,int,int,int]] = None
    waste_center:     Optional[Tuple[int,int]]         = None
    # A4: set by engine from waste track history
    waste_was_stationary_before_person: bool = False
    waste_born_in_person_bbox:          bool = False
    # Frame dimensions for zone normalisation (A5)
    frame_width:  int = 1280
    frame_height: int = 720


@dataclass
class LitteringEvent:
    event_id:         str
    camera_id:        str
    timestamp:        float
    person_track_id:  int
    waste_track_id:   int
    person_bbox:      Tuple[int,int,int,int]
    waste_bbox:       Tuple[int,int,int,int]
    event_confidence: float
    action_label:     ActionLabel = ActionLabel.DROP
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
    n1 = math.sqrt(v1[0]**2 + v1[1]**2)
    n2 = math.sqrt(v2[0]**2 + v2[1]**2)
    if n1 < 1e-6 or n2 < 1e-6:
        return 0.0
    return (v1[0]*v2[0] + v1[1]*v2[1]) / (n1 * n2)

def _center_in_bbox(c: Tuple[int,int], b: Tuple[int,int,int,int]) -> bool:
    return b[0] <= c[0] <= b[2] and b[1] <= c[1] <= b[3]


# ═══════════════════════════════════════════════════════════════════════════════
# Audit Logger
# ═══════════════════════════════════════════════════════════════════════════════

class CandidateLogger:
    MAX_BYTES = 50 * 1024 * 1024

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
            "born_in_hand":    sm._born_in_bbox,
            "was_stationary":  sm._was_stationary_before,
        }
        try:
            if self._path.exists() and self._path.stat().st_size > self.MAX_BYTES:
                self._path.rename(self._path.with_suffix(".jsonl.bak"))
            with self._path.open("a") as f:
                f.write(json.dumps(record) + "\n")
        except Exception as exc:
            print(f"[Logger] {exc}")


_logger: Optional[CandidateLogger] = None

def init_logger(path: str):
    global _logger
    _logger = CandidateLogger(path)

def _audit(sm: "LitteringStateMachine", action: ActionLabel, reason: str):
    if _logger:
        _logger.log(sm, action, reason)


# ═══════════════════════════════════════════════════════════════════════════════
# WasteTrackHistory  (for engine: A4 carry evidence & A7 stitcher input)
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class WasteTrackHistory:
    track_id:   int
    centers:    Deque[Tuple[int,int]]         = field(default_factory=lambda: deque(maxlen=120))
    timestamps: Deque[float]                  = field(default_factory=lambda: deque(maxlen=120))
    first_seen: float                         = field(default_factory=time.time)
    last_seen:  float                         = field(default_factory=time.time)
    last_bbox:  Optional[Tuple[int,int,int,int]] = None
    first_bbox: Optional[Tuple[int,int,int,int]] = None
    # Was waste inside a person bbox when it first appeared? (A4 born-in-hand)
    born_inside_person_bbox: bool = False

    def update(self, center: Tuple[int,int], bbox: Tuple[int,int,int,int], ts: float):
        if self.first_bbox is None:
            self.first_bbox = bbox
        self.centers.append(center)
        self.timestamps.append(ts)
        self.last_seen = ts
        self.last_bbox = bbox

    def was_stationary(self, window_s: float = 2.0, tol_px: float = 20.0) -> bool:
        """True only with real evidence: seen for at least `window_s` without moving.
        A brand-new track has no history, which says nothing about being there before."""
        if len(self.centers) < 2 or (self.timestamps[-1] - self.first_seen) < window_s:
            return False
        cutoff = self.timestamps[-1] - window_s
        recent = [c for c, t in zip(self.centers, self.timestamps) if t >= cutoff]
        if len(recent) < 2:
            return False
        xs = [c[0] for c in recent]
        ys = [c[1] for c in recent]
        span = math.sqrt((max(xs)-min(xs))**2 + (max(ys)-min(ys))**2)
        return span < tol_px


# ═══════════════════════════════════════════════════════════════════════════════
# State Machine
# ═══════════════════════════════════════════════════════════════════════════════

class LitteringStateMachine:
    """
    One instance per (person_track_id, waste_track_id) pair.

    Created by the engine only at first confirmed proximity (A7 lazy creation).
    Starts in PERSON_NEAR_OBJECT.

    A4-rework: classification never stops watching after association.
      - After OBJECT_ASSOCIATED, if waste re-enters person bbox → PICKUP.
      - After OBJECT_DROPPED, if waste re-enters person bbox → PICKUP.
      - CARRY is logged to audit when association is confirmed with carry evidence.
      - Only DROP produces LITTERING_CONFIRMED.

    A5-in-SM: ZoneChecker (optional) is queried in _h_stationary and _h_departing.
      If waste center is inside a bin_zone → PLACE_IN_BIN terminal (not DROP).
    """

    def __init__(
        self,
        person_track_id: int,
        waste_track_id:  int,
        camera_id:       str,
        cfg:             LitteringConfig,
        initial_det:     FrameDetection,
        zones:           Optional["ZoneChecker"] = None,  # A5
    ):
        self.person_track_id   = person_track_id
        self.waste_track_id    = waste_track_id
        self.camera_id         = camera_id
        self.cfg               = cfg
        self.zones             = zones
        self.state             = LitterState.PERSON_NEAR_OBJECT
        self._created_at       = initial_det.timestamp
        self._last_change_at   = initial_det.timestamp
        self._done             = False
        self._event_id         = str(uuid.uuid4())

        # A4 flags (set at creation from WasteTrackHistory)
        self._was_stationary_before: bool = initial_det.waste_was_stationary_before_person
        self._born_in_bbox:          bool = initial_det.waste_born_in_person_bbox

        # Scoring
        self._assoc_score:  float = 0.0
        self._sep_score:    float = 0.0
        self._stat_score:   float = 0.0
        self._depart_score: float = 0.0
        self._dwell_actual_s: float = 0.0

        # Association window tracking
        self._assoc_start:           float = initial_det.timestamp
        self._assoc_dists:           List[float] = []
        self._comotion_agreements:   int = 0
        self._comotion_checks:       int = 0
        self._carry_comotion_ratio:  float = 0.0
        self._last_person_center:    Optional[Tuple[int,int]] = initial_det.person_center
        self._last_waste_center:     Optional[Tuple[int,int]] = initial_det.waste_center
        self._waste_disp_total:      float = 0.0   # NET displacement since association began
        self._assoc_waste_origin:    Optional[Tuple[int,int]] = initial_det.waste_center

        # A4-rework: track waste displacement after association (to detect pickup)
        self._post_assoc_waste_start: Optional[Tuple[int,int]] = None
        self._pickup_detected:        bool = False   # set true when waste re-enters p_bbox

        # Separation
        self._sep_max_dist:         float = 0.0
        self._pre_sep_waste_center: Optional[Tuple[int,int]] = initial_det.waste_center

        # Drop/dwell
        self._drop_waste_center:  Optional[Tuple[int,int]] = None
        self._drop_person_center: Optional[Tuple[int,int]] = None
        self._dwell_start:        Optional[float] = None
        self._dwell_anchor:       Optional[Tuple[int,int]] = None

        # Departure
        self._max_departure_dist: float = 0.0
        self.dwell_progress:      float = 0.0  # 0.0–1.0, consumed by engine for UI

        # Evidence bboxes
        self._final_person_bbox: Optional[Tuple[int,int,int,int]] = None
        self._final_waste_bbox:  Optional[Tuple[int,int,int,int]] = None

        # Grace period (A1)
        self._person_last_seen: float = initial_det.timestamp
        self._waste_last_seen:  float = initial_det.timestamp
        self._last_known_person_center: Optional[Tuple[int,int]] = initial_det.person_center
        self._last_known_waste_center:  Optional[Tuple[int,int]] = initial_det.waste_center
        self._last_known_person_bbox:   Optional[Tuple[int,int,int,int]] = initial_det.person_bbox
        self._last_known_waste_bbox:    Optional[Tuple[int,int,int,int]] = initial_det.waste_bbox

    # ── Properties ────────────────────────────────────────────────────────────

    @property
    def is_terminal(self) -> bool:
        return self._done

    @property
    def active_action_label(self) -> ActionLabel:
        """Best current classification label, for audit/logging before terminal."""
        if self._pickup_detected:
            return ActionLabel.PICKUP
        if self._born_in_bbox or (self._waste_disp_total > 0 and
                                   self._carry_comotion_ratio >= self.cfg.carry_comotion_threshold):
            return ActionLabel.CARRY
        if self._was_stationary_before:
            return ActionLabel.PASS_BY
        return ActionLabel.UNKNOWN

    # ── Public interface ───────────────────────────────────────────────────────

    def update(self, det: FrameDetection) -> Optional[LitteringEvent]:
        if self._done:
            return None

        now = det.timestamp

        # A7: timeout from last state change
        if (now - self._last_change_at) > self.cfg.timeout_seconds:
            self._go(LitterState.TIMEOUT)
            _audit(self, ActionLabel.UNKNOWN, "timeout from last_change_at")
            return None

        self._update_grace(det)
        p_ok, w_ok, pc, wc, pb, wb, ph = self._effective(det)

        assoc_px = self._px(ph, self.cfg.association_dist_ph)
        sep_px   = self._px(ph, self.cfg.separation_dist_ph)
        dep_px   = self._px(ph, self.cfg.departure_dist_ph)
        tol_px   = self._px(ph, self.cfg.tolerance_dist_ph)
        carry_px = self._px(ph, self.cfg.carry_min_disp_ph)

        # A4-rework: check for pickup in any post-association state where waste is present
        # (waste re-enters person bbox after having been released)
        # PICKUP = after the drop, the object is back with the person AND has actually been
        # moved from where it was put down. Containment alone is not enough: with a close
        # (desk-height) camera the person box covers most of the frame, so a bottle resting on
        # the desk is "inside" it while untouched. (Return-before-drop is handled in
        # _h_separating as PERSON_RETURNED.)
        if (self.state in (LitterState.OBJECT_DROPPED, LitterState.OBJECT_STATIONARY,
                           LitterState.PERSON_MOVING_AWAY)
                and det.waste_present and wc and det.person_present and pb
                and self._drop_waste_center and not self._pickup_detected):
            moved = _dist(wc, self._drop_waste_center) > max(tol_px, 20.0)
            if _center_in_bbox(wc, pb) and moved:
                self._pickup_detected = True
                _audit(self, ActionLabel.PICKUP,
                       f"waste re-entered person bbox at state={self.state.value}")
                self._go(LitterState.PICKUP)
                return None

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

    # ── Grace period helpers (A1) ──────────────────────────────────────────────

    def _update_grace(self, det: FrameDetection):
        now = det.timestamp
        if det.person_present and det.person_center:
            self._person_last_seen         = now
            self._last_known_person_center = det.person_center
            self._last_known_person_bbox   = det.person_bbox
        if det.waste_present and det.waste_center:
            self._waste_last_seen          = now
            self._last_known_waste_center  = det.waste_center
            self._last_known_waste_bbox    = det.waste_bbox

    def _person_within_grace(self, now: float) -> bool:
        return (now - self._person_last_seen) <= self.cfg.grace_seconds

    def _waste_within_grace(self, now: float) -> bool:
        return (now - self._waste_last_seen) <= self.cfg.waste_grace_seconds

    def _effective(self, det: FrameDetection):
        now  = det.timestamp
        p_ok = det.person_present or self._person_within_grace(now)
        w_ok = det.waste_present  or self._waste_within_grace(now)
        pc   = det.person_center  if det.person_present else (self._last_known_person_center if p_ok else None)
        wc   = det.waste_center   if det.waste_present  else (self._last_known_waste_center  if w_ok else None)
        pb   = det.person_bbox    if det.person_present else (self._last_known_person_bbox   if p_ok else None)
        wb   = det.waste_bbox     if det.waste_present  else (self._last_known_waste_bbox    if w_ok else None)
        ph   = det.person_height_px if det.person_present else (
            (pb[3]-pb[1]) if pb and len(pb)==4 else det.person_height_px)
        return p_ok, w_ok, pc, wc, pb, wb, max(ph, 10.0)

    def _px(self, person_height_px: float, multiplier: float) -> float:
        return max(person_height_px * multiplier, 8.0)

    # ── A5: bin zone check ────────────────────────────────────────────────────

    def _in_bin_zone(self, wc: Tuple[int,int], fw: int, fh: int) -> bool:
        if self.zones is None:
            return False
        x_norm = wc[0] / max(fw, 1)
        y_norm = wc[1] / max(fh, 1)
        return self.zones.in_bin_zone(x_norm, y_norm)

    # ── State handlers ────────────────────────────────────────────────────────

    def _h_near(self, p, w, pc, wc, pb, wb, now,
                assoc_px, sep_px, dep_px, tol_px, carry_px, det):
        if not p or not w or not pc or not wc:
            self._go(LitterState.TRACK_LOST)
            _audit(self, ActionLabel.UNKNOWN, "track lost during proximity")
            return None

        d = _dist(pc, wc)
        if d > assoc_px:
            label = ActionLabel.PASS_BY if self._was_stationary_before else ActionLabel.UNKNOWN
            state = LitterState.PASS_BY if self._was_stationary_before else LitterState.ASSOCIATION_LOST
            self._go(state)
            _audit(self, label, f"drifted apart before association ({d:.0f}px > {assoc_px:.0f}px)")
            return None

        self._assoc_dists.append(d)
        self._accum_comotion(pc, wc)
        elapsed = now - self._assoc_start

        if elapsed >= self.cfg.association_min_s:
            action = self._classify_carry(carry_px)

            if action == ActionLabel.PASS_BY:
                self._go(LitterState.PASS_BY)
                _audit(self, ActionLabel.PASS_BY,
                       f"no carry evidence after {elapsed:.1f}s assoc (pre_stationary={self._was_stationary_before})")
                return None

            if action == ActionLabel.PICKUP:
                # Waste was stationary and moved with person → A4 PICKUP, log CARRY transition
                _audit(self, ActionLabel.CARRY,
                       f"carry confirmed: waste moved {self._waste_disp_total:.0f}px with person")
                self._go(LitterState.PICKUP)
                _audit(self, ActionLabel.PICKUP,
                       "pre-existing waste moved with person (was_stationary_before=True)")
                return None

            # CARRY → proceed to OBJECT_ASSOCIATED (may become DROP)
            _audit(self, ActionLabel.CARRY,
                   f"carry confirmed: disp={self._waste_disp_total:.0f}px ratio={self._carry_comotion_ratio:.2f}")
            avg_d = sum(self._assoc_dists) / len(self._assoc_dists)
            self._assoc_score = _clamp(1.0 - avg_d / assoc_px)
            self._pre_sep_waste_center = wc
            self._post_assoc_waste_start = wc
            self._go(LitterState.OBJECT_ASSOCIATED)
        return None

    def _h_associated(self, p, w, pc, wc, pb, wb, now,
                       assoc_px, sep_px, dep_px, tol_px, carry_px, det):
        if not w or not wc:
            if not self._waste_within_grace(now):
                self._go(LitterState.OBJECT_REMOVED)
                _audit(self, ActionLabel.UNKNOWN, "waste removed after association")
            return None
        if not p or not pc:
            self._sep_score = 0.35
            self._drop_waste_center  = wc
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
                _audit(self, ActionLabel.UNKNOWN, "waste removed after drop")
                self._go(LitterState.OBJECT_REMOVED)
            return None
        if wc is None:
            wc = self._last_known_waste_center
        if wc is None:
            return None
        if p and pc and self._drop_waste_center:
            if _dist(pc, self._drop_waste_center) < assoc_px:
                self._go(LitterState.PERSON_RETURNED)
                _audit(self, ActionLabel.UNKNOWN, "person returned after drop")
                return None
        # A5: bin zone check
        if wc and self._in_bin_zone(wc, det.frame_width, det.frame_height):
            _audit(self, ActionLabel.PLACE_IN_BIN, "waste in bin zone at dropped state")
            self._go(LitterState.PLACE_IN_BIN)
            return None
        if self._dwell_anchor and det.waste_present:
            movement = _dist(wc, self._dwell_anchor)
            if movement < tol_px:
                elapsed_dwell = now - self._dwell_start if self._dwell_start else 0.0
                self.dwell_progress = _clamp(elapsed_dwell / max(self.cfg.dwell_seconds, 0.01))
                if elapsed_dwell >= self.cfg.dwell_seconds:
                    self._dwell_actual_s = elapsed_dwell
                    self._stat_score     = _clamp(elapsed_dwell / self.cfg.dwell_seconds)
                    if wb: self._final_waste_bbox = wb
                    self._go(LitterState.OBJECT_STATIONARY)
            else:
                self._init_dwell(wc, now)
        return None

    def _h_stationary(self, p, w, pc, wc, pb, wb, now,
                       assoc_px, sep_px, dep_px, tol_px, carry_px, det):
        if not w:
            if not self._waste_within_grace(now):
                _audit(self, ActionLabel.UNKNOWN, "waste removed while stationary")
                self._go(LitterState.OBJECT_REMOVED)
            return None
        if wc is None:
            wc = self._last_known_waste_center
        if wc is None:
            return None
        # A5: bin zone — waste might have been placed in bin
        if self._in_bin_zone(wc, det.frame_width, det.frame_height):
            _audit(self, ActionLabel.PLACE_IN_BIN, "waste stationary inside bin zone")
            self._go(LitterState.PLACE_IN_BIN)
            return None
        if self._dwell_anchor and _dist(wc, self._dwell_anchor) >= tol_px:
            self._go(LitterState.FALSE_POSITIVE)
            _audit(self, ActionLabel.UNKNOWN, "waste moved again after stationary")
            return None
        if p and pc and self._drop_waste_center:
            if _dist(pc, self._drop_waste_center) < assoc_px:
                self._go(LitterState.PERSON_RETURNED)
                _audit(self, ActionLabel.UNKNOWN, "person returned near drop point")
                return None
            if _dist(pc, self._drop_waste_center) >= dep_px:
                self._max_departure_dist = _dist(pc, self._drop_waste_center)
                if pb: self._final_person_bbox = pb
                self._go(LitterState.PERSON_MOVING_AWAY)
        elif not p:
            self._max_departure_dist = dep_px * 2.0
            self._go(LitterState.PERSON_MOVING_AWAY)
        return None

    def _h_departing(self, p, w, pc, wc, pb, wb, now,
                     assoc_px, sep_px, dep_px, tol_px, carry_px,
                     det) -> Optional[LitteringEvent]:
        if not w:
            if not self._waste_within_grace(now):
                _audit(self, ActionLabel.UNKNOWN, "waste removed during departure")
                self._go(LitterState.OBJECT_REMOVED)
                return None
        wc_eff = wc or self._last_known_waste_center
        # A5: last chance bin check during departure
        if wc_eff and self._in_bin_zone(wc_eff, det.frame_width, det.frame_height):
            _audit(self, ActionLabel.PLACE_IN_BIN, "waste inside bin zone at departure")
            self._go(LitterState.PLACE_IN_BIN)
            return None
        if p and pc and self._drop_waste_center:
            if _dist(pc, self._drop_waste_center) < assoc_px:
                self._go(LitterState.PERSON_RETURNED)
                _audit(self, ActionLabel.UNKNOWN, "person returned during departure")
                return None
            self._max_departure_dist = max(self._max_departure_dist,
                                           _dist(pc, self._drop_waste_center))
            if pb: self._final_person_bbox = pb

        self._depart_score = _clamp(self._max_departure_dist / max(dep_px * 2, 1))
        confidence = (
            0.30 * self._assoc_score
            + 0.25 * self._sep_score
            + 0.25 * self._stat_score
            + 0.20 * self._depart_score
        )
        if self._assoc_score < self.cfg.min_association_score or confidence < self.cfg.min_event_confidence:
            self._go(LitterState.FALSE_POSITIVE)
            _audit(self, ActionLabel.UNKNOWN,
                   f"insufficient evidence: assoc={self._assoc_score:.2f} (min {self.cfg.min_association_score}) "
                   f"conf={confidence:.2f} (min {self.cfg.min_event_confidence})")
            return None

        p_bbox = self._final_person_bbox or pb or self._last_known_person_bbox or (0,0,1,1)
        w_bbox = self._final_waste_bbox  or wb or self._last_known_waste_bbox  or (0,0,1,1)
        if not self._final_person_bbox and self._drop_person_center:
            cx, cy = self._drop_person_center
            p_bbox = (cx-40, cy-80, cx+40, cy+80)
        if not self._final_waste_bbox and self._drop_waste_center:
            cx, cy = self._drop_waste_center
            w_bbox = (cx-20, cy-20, cx+20, cy+20)

        # Clamp bboxes to non-negative (evidence box fix, item 6)
        def _safe_bbox(b):
            x1, y1, x2, y2 = b
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = max(x1+1, x2), max(y1+1, y2)
            return (x1, y1, x2, y2)

        p_bbox = _safe_bbox(p_bbox)
        w_bbox = _safe_bbox(w_bbox)

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
               f"CONFIRMED conf={confidence:.2%} dwell={self._dwell_actual_s:.1f}s "
               f"carry_ratio={self._carry_comotion_ratio:.2f}")
        return ev

    # ── Co-motion / carry (A4) ────────────────────────────────────────────────

    def _accum_comotion(self, pc: Tuple[int,int], wc: Tuple[int,int]):
        if self._last_person_center and self._last_waste_center:
            p_vec = (pc[0] - self._last_person_center[0],
                     pc[1] - self._last_person_center[1])
            w_vec = (wc[0] - self._last_waste_center[0],
                     wc[1] - self._last_waste_center[1])
            w_disp = math.sqrt(w_vec[0]**2 + w_vec[1]**2)
            # Net movement from where the object was when the person came close. Summing every
            # frame-to-frame wobble let a still poster "move" just from detector jitter.
            if self._assoc_waste_origin:
                self._waste_disp_total = max(self._waste_disp_total, _dist(wc, self._assoc_waste_origin))
            if w_disp > self.cfg.jitter_px:
                self._comotion_checks += 1
                if _dot_sign(p_vec, w_vec) > 0.5:
                    self._comotion_agreements += 1
        self._last_person_center = pc
        self._last_waste_center  = wc
        self._carry_comotion_ratio = (
            self._comotion_agreements / max(self._comotion_checks, 1)
            if self._comotion_checks > 0 else 0.0
        )

    def _classify_carry(self, carry_px: float) -> ActionLabel:
        """
        Returns CARRY, PICKUP, or PASS_BY.
        CARRY → will become DROP at the end.
        PICKUP → waste was pre-existing; person carried it away; not littering.
        PASS_BY → no meaningful interaction.
        """
        ratio = self._carry_comotion_ratio

        # A4: born-in-hand is the strongest signal (timestamp-based in engine)
        if self._born_in_bbox:
            return ActionLabel.CARRY

        if self._was_stationary_before:
            # Person walked up to existing waste
            if self._waste_disp_total >= carry_px and ratio >= self.cfg.carry_comotion_threshold:
                return ActionLabel.PICKUP   # picked it up
            return ActionLabel.PASS_BY

        # Waste appeared while person was there
        if (self._waste_disp_total >= carry_px
                and ratio >= self.cfg.carry_comotion_threshold):
            return ActionLabel.CARRY
        return ActionLabel.PASS_BY

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _go(self, state: LitterState):
        self.state           = state
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
