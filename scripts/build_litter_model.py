"""
Build EcoWatch's open-vocabulary litter detector (YOLO-World) with the litter vocabulary baked in.

Why: the standard YOLOv8 model only knows the 80 COCO classes, which have no wrapper, plastic bag,
paper, can, chips packet, cigarette pack ... YOLO-World detects objects from plain-English names.
Baking the names into the saved model means the camera engine loads it without the CLIP text
encoder at runtime (fast startup, works offline).

One-time setup (needs internet the first time: downloads yolov8s-worldv2.pt and CLIP ~340 MB):
    python scripts/build_litter_model.py
Then in backend/.env:
    WASTE_MODEL_PATH=ecowatch_litter_world.pt

Edit VOCAB below to add/remove litter types, then re-run this script.
"""
import sys
import time

OUT = sys.argv[1] if len(sys.argv) > 1 else "ecowatch_litter_world.pt"

# "person" is kept so the model can tell people apart from objects; the engine ignores it as litter.
VOCAB = [
    "person",
    "bottle", "plastic bottle", "glass bottle", "can",
    "cup", "paper cup",
    "plastic bag", "carry bag",
    "food wrapper", "chips packet", "food container", "straw",
    "paper", "newspaper", "tissue paper", "cardboard box",
    "cigarette pack",
    "banana peel", "fruit peel",
    "book", "bag",
]

if __name__ == "__main__":
    from ultralytics import YOLOWorld

    t = time.time()
    model = YOLOWorld("yolov8s-worldv2.pt")
    model.set_classes(VOCAB)
    model.save(OUT)
    print(f"Saved {OUT} with {len(VOCAB)} classes in {time.time() - t:.0f}s:")
    print(", ".join(VOCAB))
    print("\nSet WASTE_MODEL_PATH=" + OUT + " in backend/.env and restart the camera engine.")
