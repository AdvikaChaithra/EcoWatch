"""
Regression tests for the littering state machine with a CLOSE (desk-height) camera, where the
person's box covers most of the frame. Frames are synthetic TEST FIXTURES describing box
positions over time (~6 FPS, like the CPU pipeline); they exercise the decision logic only.

Run from the repo root:  python tests/test_littering_sm.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.littering_detector import (  # noqa: E402
    ActionLabel, FrameDetection, LitterState, LitteringConfig, LitteringStateMachine,
)

DT = 1 / 6  # seconds per processed frame
PERSON = (100, 140, 590, 480)  # big box: person sitting close to the webcam (ph = 340 px)


def center(b):
    return ((b[0] + b[2]) // 2, (b[1] + b[3]) // 2)


def det(t, person=None, waste=None, born=False):
    return FrameDetection(
        timestamp=t,
        person_present=person is not None, person_bbox=person,
        person_center=center(person) if person else None,
        person_height_px=(person[3] - person[1]) if person else 80.0,
        waste_present=waste is not None, waste_bbox=waste,
        waste_center=center(waste) if waste else None,
        waste_born_in_person_bbox=born, frame_width=640, frame_height=480,
    )


def run(frames):
    cfg = LitteringConfig(audit_log_path=os.devnull)
    sm = LitteringStateMachine(1, 2, "CAM_TEST", cfg, frames[0])
    events, states = [], []
    for f in frames[1:]:
        ev = sm.update(f)
        states.append(sm.state.value)
        if ev:
            events.append(ev)
        if sm.is_terminal:
            break
    return sm, events, states


def desk_drop_frames(t0, person_returns_and_lifts=False):
    frames, t = [], t0
    # 1) holding the bottle (it appeared in the hand), moving together with the person
    for i in range(10):
        p = (PERSON[0] + 3 * i, PERSON[1], PERSON[2] + 3 * i, PERSON[3])
        w = (320 + 3 * i, 280, 350 + 3 * i, 340)
        frames.append(det(t, p, w, born=(i == 0)))
        t += DT
    # 2) bottle put down on the desk (still INSIDE the big person box), person still seated
    desk = (160, 400, 190, 460)
    for i in range(6):
        frames.append(det(t, (127, 140, 617, 480), desk))
        t += DT
    if person_returns_and_lifts:
        # person reaches for it and lifts it: the bottle moves up with the hand
        for i in range(8):
            frames.append(det(t, (127, 140, 617, 480), (160, 400 - 25 * i, 190, 460 - 25 * i)))
            t += DT
        return frames
    # 3) person leaves the frame; the bottle flickers in/out of detection (every other frame)
    for i in range(30):
        frames.append(det(t, None, desk if i % 2 == 0 else None))
        t += DT
    return frames


def test_desk_drop_then_leave_confirms_littering():
    sm, events, states = run(desk_drop_frames(time.time()))
    assert events, f"expected LITTERING_CONFIRMED, got states {states}"
    assert events[0].action_label == ActionLabel.DROP
    assert sm.state == LitterState.LITTERING_CONFIRMED


def test_bottle_resting_inside_big_person_box_is_not_pickup():
    sm, events, states = run(desk_drop_frames(time.time()))
    assert "PICKUP" not in states, states


def test_real_pickup_after_drop_is_not_littering():
    sm, events, states = run(desk_drop_frames(time.time(), person_returns_and_lifts=True))
    assert not events, "a lifted bottle must not produce a violation"


def test_existing_bottle_person_walks_past_is_not_littering():
    t, frames = time.time(), []
    desk = (160, 400, 190, 460)
    first = det(t, (100, 140, 590, 480), desk)
    first.waste_was_stationary_before_person = True
    frames.append(first)
    for i in range(12):
        t += DT
        frames.append(det(t, (100 + 10 * i, 140, 590 + 10 * i, 480), desk))
    sm, events, states = run(frames)
    assert not events and sm.state in (LitterState.PASS_BY, LitterState.ASSOCIATION_LOST), states


def test_poster_on_wall_next_to_person_is_not_littering():
    """Regression: a sticky note on the wall beside a seated person (never touched, detector
    jitter of a few px) was confirmed as littering. It never moved, so it was never carried."""
    t, frames = time.time(), []
    # Same geometry as the real event: note ~140 px from the person's centre (association score
    # ~0.13) and flagged "born in hand" by the old centre-in-box test.
    note = (330, 190, 360, 225)
    for i in range(70):                               # person sits ~6 s, then leaves
        j = (i % 3) - 1                               # +-1..3 px box jitter every frame
        person = (335, 160, 520, 480) if i < 40 else None
        frames.append(det(t, person, (note[0] + 2 * j, note[1] + j, note[2] + 2 * j, note[3] + j), born=(i == 0)))
        t += DT
    sm, events, states = run(frames)
    assert not events, f"a still background object must never become a violation; states={states}"


def test_weak_association_is_rejected_even_if_sequence_completes():
    """The fine needs real evidence: a borderline person<->object link is discarded."""
    cfg = LitteringConfig(audit_log_path=os.devnull, min_association_score=0.99)
    frames = desk_drop_frames(time.time())
    sm = LitteringStateMachine(1, 2, "CAM_TEST", cfg, frames[0])
    events = [e for e in (sm.update(f) for f in frames[1:]) if e]
    assert not events and sm.state == LitterState.FALSE_POSITIVE, sm.state


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
