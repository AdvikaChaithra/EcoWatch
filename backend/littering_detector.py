"""
EcoWatch — Littering Detection State Machine (Part 1)
======================================================
Pure Python. No OpenCV, no FastAPI, no database.

Critical sequence enforced:
  PERSON + OBJECT ASSOCIATION
  → OBJECT SEPARATES FROM PERSON
  → OBJECT STATIONARY for dwell_seconds
  → PERSON MOVES AWAY
  → LITTERING_CONFIRMED

Confidence formula (fully deterministic, no random):
  event_confidence =
      0.30 * association_score   (closeness when associated)
    + 0.25 * separation_score    (quality of separation trajectory)
    + 0.25 * stationary_score    (dwell duration vs threshold)
    + 0.20 * departure_score     (how far person moved from drop point)
"""

from __future__ import annotations

import math
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Deque, List, Optional, Tuple
from collections import deque


# ═══════════════════════════════════════════════════════════════════════════════
# Enums & Data Classes
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
    # Reset / terminal states
    ASSOCIATION_LOST    = "ASSOCIATION_LOST"
    OBJECT_REMOVED      = "OBJECT_REMOVED"
    PERSON_RETURNED     = "PERSON_RETURNED"
    TRACK_LOST          = "TRACK_LOST"
    TIMEOUT             = "TIMEOUT"
    FALSE_POSITIVE      = "FALSE_POSITIVE"


_TERMINAL_STATES = {
    LitterState.LITTERING_CONFIRMED,
    LitterState.ASSOCIATION_LOST,
    LitterState.OBJECT_REMOVED,
    LitterState.PERSON_RETURNED,
    LitterState.TRACK_LOST,
    LitterState.TIMEOUT,
    LitterState.FALSE_POSITIVE,
}


@dataclass
class LitteringConfig:
    """All thresholds loaded from env vars in vision_engine.py."""
    association_distance_px: float = 80.0    # person+waste must be ≤ this to start association
    separation_distance_px:  float = 120.0   # distance at which waste is considered released
    person_departure_px:     float = 150.0   # person must move this far from drop point
    position_tolerance_px:   float = 25.0    # max px movement for waste to be "stationary"
    dwell_seconds:           float = 2.0     # waste must stay still this long
    association_min_frames:  int   = 10      # frames person+waste close before "associated"
    timeout_seconds:         float = 45.0    # state machine auto-reset if stuck
    cooldown_seconds:        float = 30.0    # min seconds between events for same pair
    camera_fps:              float = 30.0    # used to convert dwell_seconds → frames


@dataclass
class FrameDetection:
    """Input to the state machine for a single frame (pixel coordinates)."""
    timestamp:      float
    person_present: bool                             = False
    person_bbox:    Optional[Tuple[int,int,int,int]] = None  # (x1,y1,x2,y2)
    person_center:  Optional[Tuple[int,int]]         = None
    waste_present:  bool                             = False
    waste_bbox:     Optional[Tuple[int,int,int,int]] = None
    waste_center:   Optional[Tuple[int,int]]         = None


@dataclass
class LitteringEvent:
    """Output when LITTERING_CONFIRMED — passed to vision_engine for WebSocket broadcast."""
    event_id:          str
    camera_id:         str
    timestamp:         float
    person_track_id:   int
    waste_track_id:    int
    person_bbox:       Tuple[int,int,int,int]
    waste_bbox:        Tuple[int,int,int,int]
    event_confidence:  float   # 0.0–1.0 deterministic
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


# ═══════════════════════════════════════════════════════════════════════════════
# State Machine
# ═══════════════════════════════════════════════════════════════════════════════

class LitteringStateMachine:
    """
    One instance per (person_track_id, waste_track_id) pair.

    Call update(detection) every frame.
    Returns a LitteringEvent only when state reaches LITTERING_CONFIRMED.
    All other frames return None.

    NEVER fires from:
      - Waste detection alone
      - Person near waste alone
      - Dwell alone (without prior association + separation)
      - A single frame
    """

    def __init__(
        self,
        person_track_id: int,
        waste_track_id:  int,
        camera_id:       str,
        cfg:             LitteringConfig,
    ):
        self.person_track_id = person_track_id
        self.waste_track_id  = waste_track_id
        self.camera_id       = camera_id
        self.cfg             = cfg
        self.state           = LitterState.NORMAL
        self.created_at      = time.time()
        self._done           = False

        # Scoring accumulators
        self._assoc_distances: List[float] = []
        self._assoc_frames:    int         = 0
        self._assoc_score:     float       = 0.0
        self._sep_score:       float       = 0.0
        self._stat_score:      float       = 0.0
        self._depart_score:    float       = 0.0

        # Separation tracking
        self._sep_max_dist:          float                       = 0.0
        self._pre_sep_waste_center:  Optional[Tuple[int,int]]   = None
        self._drop_waste_center:     Optional[Tuple[int,int]]   = None
        self._drop_person_center:    Optional[Tuple[int,int]]   = None

        # Dwell tracking
        self._dwell_start:        Optional[float]         = None
        self._dwell_anchor:       Optional[Tuple[int,int]] = None  # waste pos when dwell started
        self._dwell_frames:       int                     = 0
        self._dwell_actual_s:     float                   = 0.0

        # Public for HUD rendering
        self.dwell_progress:      float = 0.0   # 0.0–1.0

        # Departure tracking
        self._max_departure_dist: float = 0.0

        # Final bboxes for evidence
        self._final_person_bbox: Optional[Tuple[int,int,int,int]] = None
        self._final_waste_bbox:  Optional[Tuple[int,int,int,int]] = None

    @property
    def is_terminal(self) -> bool:
        return self._done

    def update(self, det: FrameDetection) -> Optional[LitteringEvent]:
        if self._done:
            return None

        now = det.timestamp

        # Timeout guard
        if (now - self.created_at) > self.cfg.timeout_seconds:
            self._go(LitterState.TIMEOUT)
            return None

        p  = det.person_present
        w  = det.waste_present
        pc = det.person_center
        wc = det.waste_center
        pb = det.person_bbox
        wb = det.waste_bbox

        # Route to correct handler
        handlers = {
            LitterState.NORMAL:             self._h_normal,
            LitterState.PERSON_NEAR_OBJECT: self._h_near,
            LitterState.OBJECT_ASSOCIATED:  self._h_associated,
            LitterState.OBJECT_SEPARATING:  self._h_separating,
            LitterState.OBJECT_DROPPED:     self._h_dropped,
            LitterState.OBJECT_STATIONARY:  self._h_stationary,
            LitterState.PERSON_MOVING_AWAY: self._h_departing,
        }
        handler = handlers.get(self.state)
        if handler:
            return handler(p, w, pc, wc, pb, wb, now)
        return None

    # ── State handlers ────────────────────────────────────────────────────────

    def _h_normal(self, p, w, pc, wc, pb, wb, now):
        if p and w and pc and wc:
            if _dist(pc, wc) <= self.cfg.association_distance_px:
                self._assoc_frames = 1
                self._assoc_distances = [_dist(pc, wc)]
                self._go(LitterState.PERSON_NEAR_OBJECT)
        return None

    def _h_near(self, p, w, pc, wc, pb, wb, now):
        if not p or not w or not pc or not wc:
            self._assoc_frames = 0
            self._go(LitterState.NORMAL)
            return None
        d = _dist(pc, wc)
        if d <= self.cfg.association_distance_px:
            self._assoc_frames += 1
            self._assoc_distances.append(d)
            if self._assoc_frames >= self.cfg.association_min_frames:
                avg_d = sum(self._assoc_distances) / len(self._assoc_distances)
                self._assoc_score = _clamp(1.0 - avg_d / self.cfg.association_distance_px)
                self._pre_sep_waste_center = wc
                self._go(LitterState.OBJECT_ASSOCIATED)
        else:
            self._assoc_frames = 0
            self._assoc_distances.clear()
            self._go(LitterState.NORMAL)
        return None

    def _h_associated(self, p, w, pc, wc, pb, wb, now):
        if not w or not wc:
            self._go(LitterState.OBJECT_REMOVED)
            return None
        if not p or not pc:
            # Person left frame — treat drop as confirmed with partial score
            self._sep_score = 0.4
            self._drop_waste_center = wc
            self._init_dwell(wc, now)
            self._go(LitterState.OBJECT_DROPPED)
            return None
        d = _dist(pc, wc)
        if d > self.cfg.association_distance_px:
            self._sep_max_dist = d
            self._go(LitterState.OBJECT_SEPARATING)
        return None

    def _h_separating(self, p, w, pc, wc, pb, wb, now):
        if not w or not wc:
            self._go(LitterState.FALSE_POSITIVE)
            return None
        if not p or not pc:
            # Person gone mid-separation → treat as dropped
            self._finalize_sep(self._sep_max_dist)
            self._drop_waste_center = wc
            self._init_dwell(wc, now)
            self._go(LitterState.OBJECT_DROPPED)
            return None
        d = _dist(pc, wc)
        self._sep_max_dist = max(self._sep_max_dist, d)
        if d >= self.cfg.separation_distance_px:
            self._finalize_sep(d)
            self._drop_waste_center = wc
            self._drop_person_center = pc
            self._init_dwell(wc, now)
            self._go(LitterState.OBJECT_DROPPED)
        elif d < self.cfg.association_distance_px:
            # Person returned to waste
            self._go(LitterState.PERSON_RETURNED)
        return None

    def _h_dropped(self, p, w, pc, wc, pb, wb, now):
        if not w or not wc:
            self._go(LitterState.OBJECT_REMOVED)
            return None
        # Person returns to pick it up?
        if p and pc and self._drop_waste_center:
            if _dist(pc, self._drop_waste_center) < self.cfg.association_distance_px:
                self._go(LitterState.PERSON_RETURNED)
                return None
        # Check stationary
        if self._dwell_anchor and wc:
            movement = _dist(wc, self._dwell_anchor)
            if movement < self.cfg.position_tolerance_px:
                self._dwell_frames += 1
                required = int(self.cfg.dwell_seconds * self.cfg.camera_fps)
                self.dwell_progress = _clamp(self._dwell_frames / max(required, 1))
                if self._dwell_frames >= required:
                    self._dwell_actual_s = now - self._dwell_start if self._dwell_start else self.cfg.dwell_seconds
                    self._stat_score = _clamp(self._dwell_frames / max(required, 1))
                    if wb: self._final_waste_bbox = wb
                    self._go(LitterState.OBJECT_STATIONARY)
            else:
                # Waste moved — reset dwell
                self._dwell_frames = 0
                self.dwell_progress = 0.0
                self._init_dwell(wc, now)
        return None

    def _h_stationary(self, p, w, pc, wc, pb, wb, now):
        if not w or not wc:
            self._go(LitterState.OBJECT_REMOVED)
            return None
        # Waste moved again?
        if self._dwell_anchor and _dist(wc, self._dwell_anchor) >= self.cfg.position_tolerance_px:
            self._go(LitterState.FALSE_POSITIVE)
            return None
        # Person returned?
        if p and pc and self._drop_waste_center:
            if _dist(pc, self._drop_waste_center) < self.cfg.association_distance_px:
                self._go(LitterState.PERSON_RETURNED)
                return None
            if _dist(pc, self._drop_waste_center) >= self.cfg.person_departure_px:
                self._max_departure_dist = _dist(pc, self._drop_waste_center)
                if pb: self._final_person_bbox = pb
                self._go(LitterState.PERSON_MOVING_AWAY)
        elif not p:
            # Person left frame entirely — full departure credit
            self._max_departure_dist = self.cfg.person_departure_px * 2.0
            self._go(LitterState.PERSON_MOVING_AWAY)
        return None

    def _h_departing(self, p, w, pc, wc, pb, wb, now) -> Optional[LitteringEvent]:
        if not w:
            self._go(LitterState.OBJECT_REMOVED)
            return None
        # Person came back?
        if p and pc and self._drop_waste_center:
            if _dist(pc, self._drop_waste_center) < self.cfg.association_distance_px:
                self._go(LitterState.PERSON_RETURNED)
                return None
            self._max_departure_dist = max(self._max_departure_dist, _dist(pc, self._drop_waste_center))
            if pb: self._final_person_bbox = pb

        self._depart_score = _clamp(self._max_departure_dist / max(self.cfg.person_departure_px * 2, 1))
        confidence = (
            0.30 * self._assoc_score
            + 0.25 * self._sep_score
            + 0.25 * self._stat_score
            + 0.20 * self._depart_score
        )

        # Build best-effort bboxes
        p_bbox = self._final_person_bbox or (pb if pb else (0, 0, 1, 1))
        w_bbox = self._final_waste_bbox  or (wb if wb else (0, 0, 1, 1))
        if not self._final_person_bbox and self._drop_person_center:
            cx, cy = self._drop_person_center
            p_bbox = (cx-40, cy-80, cx+40, cy+80)
        if not self._final_waste_bbox and self._drop_waste_center:
            cx, cy = self._drop_waste_center
            w_bbox = (cx-20, cy-20, cx+20, cy+20)

        self._go(LitterState.LITTERING_CONFIRMED)
        return LitteringEvent(
            event_id          = str(uuid.uuid4()),
            camera_id         = self.camera_id,
            timestamp         = now,
            person_track_id   = self.person_track_id,
            waste_track_id    = self.waste_track_id,
            person_bbox       = p_bbox,
            waste_bbox        = w_bbox,
            event_confidence  = round(confidence, 3),
            association_score = round(self._assoc_score, 3),
            separation_score  = round(self._sep_score, 3),
            stationary_score  = round(self._stat_score, 3),
            departure_score   = round(self._depart_score, 3),
            dwell_actual_s    = round(self._dwell_actual_s, 2),
        )

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _go(self, state: LitterState):
        self.state = state
        if state in _TERMINAL_STATES:
            self._done = True

    def _init_dwell(self, wc: Tuple[int,int], now: float):
        self._dwell_start  = now
        self._dwell_anchor = wc
        self._dwell_frames = 0
        self.dwell_progress = 0.0

    def _finalize_sep(self, d: float):
        span = max(self.cfg.separation_distance_px - self.cfg.association_distance_px, 1)
        self._sep_score = _clamp((d - self.cfg.association_distance_px) / span)
