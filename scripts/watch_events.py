"""
Live console monitor for the camera pipeline (useful while rehearsing the demo).
Shows detections, littering state-machine stages, confirmed events and identity results
as they arrive on the backend WebSocket. Only prints when something changes.

Usage (from the repo root, with the backend running):  python scripts/watch_events.py
"""
import asyncio
import json
import sys
import time

import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8000/ws"


def ts() -> str:
    return time.strftime("%H:%M:%S")


async def main():
    last_dets, last_states = None, None
    while True:
        try:
            async with websockets.connect(URL, max_size=2**22) as ws:
                print(f"[{ts()}] connected to {URL} - waiting for camera data...", flush=True)
                while True:
                    m = json.loads(await ws.recv())
                    t = m.get("type")
                    if t == "pipeline_state":
                        dets = ", ".join(
                            f"{'Person' if d['kind'] == 'person' else d['label']}#{d['track_id']}"
                            f"({round((d['conf'] or 0) * 100)}%)" for d in m.get("detections", [])
                        ) or "nothing"
                        states = ", ".join(
                            f"P#{a['person_id']}<->#{a['waste_id']}:{a['state']}"
                            + (f" {round(a['dwell_progress'] * 100)}%" if a.get("dwell_progress") else "")
                            for a in m.get("active_machines", [])
                        )
                        # print only when the SET of tracked objects changes, not on confidence jitter
                        key = sorted((d["kind"], d["track_id"]) for d in m.get("detections", []))
                        if key != last_dets:
                            print(f"[{ts()}] sees: {dets}", flush=True)
                            last_dets = key
                        if states and states != last_states:
                            print(f"[{ts()}]   stage: {states}", flush=True)
                        last_states = states
                    elif t == "littering_event":
                        print(f"[{ts()}] *** LITTERING CONFIRMED  event={m['event_id'][:8]} "
                              f"P#{m['person_track_id']} W#{m['waste_track_id']} "
                              f"conf={m['event_confidence']:.0%}  evidence={m.get('evidence_dir')}", flush=True)
                    elif t == "identity_result":
                        sim = m.get("similarity")
                        print(f"[{ts()}] *** IDENTITY {m['identity_status']}  "
                              f"{m.get('citizen_name') or ''} "
                              f"sim={'%.2f' % sim if sim is not None else '-'} "
                              f"faces={m.get('faces_used')}/{m.get('crops_received')} "
                              f"violation={m.get('violation_id')} fine={m.get('fine_amount')} "
                              f"sms={m.get('sms_status', '-')}  reason={m.get('reason')}", flush=True)
                        if m.get("notes"):
                            print(f"[{ts()}]     face notes: {m['notes']}", flush=True)
                    elif t == "boot_status":
                        print(f"[{ts()}] engine: {m.get('stage')} {m.get('message')}", flush=True)
        except (OSError, websockets.ConnectionClosed) as e:
            print(f"[{ts()}] backend not reachable ({e.__class__.__name__}); retrying in 3 s", flush=True)
            await asyncio.sleep(3)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
