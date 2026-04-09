import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

# =========================
# INIT
# =========================
app = FastAPI(title="Floor Plan Vision API")

model = YOLO("dataset_detect.pt")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# UTILS
# =========================
def polygon_to_bbox(polygon):
    if not polygon:
        return {"x": 0, "y": 0, "w": 0, "h": 0}

    xs = [p["x"] for p in polygon]
    ys = [p["y"] for p in polygon]

    return {
        "x": float(min(xs)),
        "y": float(min(ys)),
        "w": float(max(xs) - min(xs)),
        "h": float(max(ys) - min(ys)),
    }


def bbox_size_in_pixels(bbox, img_width, img_height):
    return bbox["w"] * img_width, bbox["h"] * img_height


# =========================
# 🔥 WALL EXTRACTION
# =========================
def extract_clean_walls(mask, width, height):
    kernel = np.ones((5, 5), np.uint8)
    clean_mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    # thinning (optional)
    if hasattr(cv2, "ximgproc"):
        skel = cv2.ximgproc.thinning(clean_mask)
    else:
        skel = clean_mask

    lines = cv2.HoughLinesP(
        skel,
        1,
        np.pi / 180,
        threshold=40,
        minLineLength=40,
        maxLineGap=20,
    )

    horizontal, vertical = [], []

    if lines is not None:
        for l in lines:
            x1, y1, x2, y2 = l[0]

            length = np.hypot(x2 - x1, y2 - y1)
            if length < 30:
                continue

            # classify orientation
            if abs(x1 - x2) < abs(y1 - y2):
                x = int((x1 + x2) / 2)
                vertical.append((min(y1, y2), max(y1, y2), x))
            else:
                y = int((y1 + y2) / 2)
                horizontal.append((min(x1, x2), max(x1, x2), y))

    def merge_lines(lines, pos_thresh=10, gap_thresh=50):
        if not lines:
            return []

        lines.sort(key=lambda x: (x[2], x[0]))
        merged = []

        for l1, l2, pos in lines:
            merged_flag = False

            for i, (ml1, ml2, mpos) in enumerate(merged):
                if abs(pos - mpos) < pos_thresh:
                    if l1 <= ml2 + gap_thresh and l2 >= ml1 - gap_thresh:
                        merged[i] = (
                            min(ml1, l1),
                            max(ml2, l2),
                            int((mpos + pos) / 2),
                        )
                        merged_flag = True
                        break

            if not merged_flag:
                merged.append((l1, l2, pos))

        return merged

    merged_h = merge_lines(horizontal)
    merged_v = merge_lines(vertical)

    walls = []

    for i, (x1, x2, y) in enumerate(merged_h):
        walls.append({
            "id": f"wall-h-{i}",
            "x1": x1 / width,
            "y1": y / height,
            "x2": x2 / width,
            "y2": y / height,
            "type": "interior",
            "thicknessRatio": 0.01,
        })

    for i, (y1, y2, x) in enumerate(merged_v):
        walls.append({
            "id": f"wall-v-{i}",
            "x1": x / width,
            "y1": y1 / height,
            "x2": x / width,
            "y2": y2 / height,
            "type": "interior",
            "thicknessRatio": 0.01,
        })

    return walls


# =========================
# DETECT
# =========================
def detect(image_bytes: bytes):
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise ValueError("Invalid image")

    height, width = img.shape[:2]

    results = model(img, imgsz=1024)[0]
    class_map = results.names

    doors, windows = [], []

    wall_mask_total = np.zeros((height, width), dtype=np.uint8)

    if results.masks is None:
        return [], [], doors, windows

    masks = results.masks.data.cpu().numpy()

    for i, (cls, score, mask) in enumerate(
        zip(results.boxes.cls, results.boxes.conf, masks)
    ):
        cls = int(cls)
        label = class_map[cls]
        conf = float(score.cpu().numpy())

        if conf < 0.4:
            continue

        mask_uint8 = (mask * 255).astype(np.uint8)
        mask_uint8 = cv2.resize(mask_uint8, (width, height))

        contours, _ = cv2.findContours(
            mask_uint8,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )

        if not contours:
            continue

        contour = max(contours, key=cv2.contourArea)

        epsilon = 0.01 * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)

        polygon = [
            {"x": pt[0][0] / width, "y": pt[0][1] / height}
            for pt in approx
        ]

        bbox = polygon_to_bbox(polygon)
        w_pix, _ = bbox_size_in_pixels(bbox, width, height)

        # DOOR
        if label == "door":
            doors.append({
                "id": f"door-{i}",
                "bbox": bbox,
                "widthPx": w_pix,
            })

        # WINDOW
        elif label == "window":
            windows.append({
                "id": f"window-{i}",
                "bbox": bbox,
                "widthPx": w_pix,
            })

        # WALL
        elif label == "wall":
            wall_mask_total = cv2.bitwise_or(wall_mask_total, mask_uint8)

    walls = extract_clean_walls(wall_mask_total, width, height)

    return [], walls, doors, windows  # 🔥 NO ROOMS


# =========================
# API
# =========================
@app.post("/api/detect-floorplan")
async def analyze(file: UploadFile = File(...)):
    try:
        image_bytes = await file.read()

        rooms, walls, doors, windows = detect(image_bytes)

        return {
            "summary": f"{len(walls)} walls",
            "rooms": [],  # 🔥 always empty
            "walls": walls,
            "doors": doors,
            "windows": windows,
        }

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}