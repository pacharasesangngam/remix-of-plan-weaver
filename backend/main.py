import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
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
# MODELS
# =========================
class Point(BaseModel):
    x: float
    y: float

class BBox(BaseModel):
    x: float
    y: float
    w: float
    h: float

class Room(BaseModel):
    id: str
    name: str
    confidence: str
    polygon: List[Point]
    bbox: BBox
    width: float
    height: float

class WallSegment(BaseModel):
    id: str
    x1: float
    y1: float
    x2: float
    y2: float
    type: str
    thicknessRatio: float

class Door(BaseModel):
    id: str
    polygon: List[Point]
    bbox: BBox

class Window(BaseModel):
    id: str
    polygon: List[Point]
    bbox: BBox

class DetectionResult(BaseModel):
    summary: str
    rooms: List[Room]
    walls: List[WallSegment]
    doors: List[Door]
    windows: List[Window]

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
        "h": float(max(ys) - min(ys))
    }
def bbox_size_in_pixels(bbox, img_width, img_height):
    """แปลงสัดส่วน bbox (0-1) เป็น pixel"""
    w = bbox["w"] * img_width
    h = bbox["h"] * img_height
    return w, h
# =========================
# CORE
# =========================

def detect(image_bytes: bytes):
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if img is None:
        raise ValueError("Invalid image")
    # 👇 เพิ่มตรงนี้
    height, width = img.shape[:2]

    results = model(img ,imgsz=1024)[0]
    class_map = results.names

    rooms, walls, doors, windows = [], [], [], []

    if results.masks is None:
        return rooms, walls, doors, windows

    masks = results.masks.data.cpu().numpy()

    for i, (cls, score, mask) in enumerate(
        zip(results.boxes.cls, results.boxes.conf, masks)
    ):
        cls = int(cls)
        label = class_map[cls]
        conf = float(score.cpu().numpy())

        # confidence label
        if conf > 0.7:
            confidence_label = "high"
        elif conf > 0.4:
            confidence_label = "manual"
        else:
            confidence_label = "low"

        # mask → contour
        mask_uint8 = (mask * 255).astype(np.uint8)
        orig_h, orig_w = img.shape[:2]
        mask_uint8 = cv2.resize(mask_uint8, (orig_w, orig_h))
        contours, _ = cv2.findContours(
            mask_uint8,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE
        )

        if not contours:
            continue

        contour = max(contours, key=cv2.contourArea)
    
        # polygon simplify
        epsilon = 0.03 * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)

        polygon = [
            {"x": pt[0][0] / orig_w, "y": pt[0][1] / orig_h}
            for pt in approx
        ]

        bbox = polygon_to_bbox(polygon)

        # =========================
        # CLASS HANDLING
        # =========================
        PIXEL_TO_METER=0.01
        if label == "room":
            w_pix, h_pix = bbox_size_in_pixels(bbox, width, height)
            w_m = w_pix * PIXEL_TO_METER
            h_m = h_pix * PIXEL_TO_METER
            area = w_m * h_m
            rooms.append({
                "id": f"r-{i}",
                "name": f"room-{i}",
                "confidence": confidence_label,
                "polygon": polygon,
                "bbox": bbox,
                "width": w_m,
                "height": h_m,
                "area": area
            })

        elif label == "door":
            cx = (bbox['x'] + bbox['w']/2) * orig_w
            cy = (bbox['y'] + bbox['h']/2) * orig_h

            # เพิ่มขนาดประตู
            door_width = orig_h * 0.1
            door_height = orig_w * 0.15

            x1 = cx - door_width / 2
            y1 = cy - door_height / 2
            x2 = cx + door_width / 2
            y2 = cy + door_height / 2

            x1 = max(0, x1)
            y1 = max(0, y1)
            x2 = min(orig_w, x2)
            y2 = min(orig_h, y2)

            poly = [
                {"x": x1 / orig_w, "y": y1 / orig_h},
                {"x": x2 / orig_w, "y": y1 / orig_h},
                {"x": x2 / orig_w, "y": y2 / orig_h},
                {"x": x1 / orig_w, "y": y2 / orig_h},
            ]

            bbox_new = polygon_to_bbox(poly)

            print(f"Door {i} center: ({cx:.1f}, {cy:.1f}), size: ({door_width:.1f}, {door_height:.1f})")
            # w_pix, h_pix = bbox_size_in_pixels(bbox, width, height)

            doors.append({
                "id": f"d-{i}",
                "polygon": poly,
                "bbox": bbox_new,
                # "width": w_pix,
                # "height": h_pix
            })

        elif label == "window":
            # w_pix, h_pix = bbox_size_in_pixels(bbox, width, height)
            windows.append({
                "id": f"win-{i}",
                "polygon": polygon,
                "bbox": bbox,
                # "width": w_pix,
                # "height": h_pix
            })

        elif label == "wall":
    
            # =========================
            # 🔥 0. CLEAN MASK ก่อน Hough
            # =========================
            kernel = np.ones((5, 5), np.uint8)
            clean_mask = cv2.morphologyEx(mask_uint8, cv2.MORPH_CLOSE, kernel)

            # =========================
            # 🔥 1. HOUGH
            # =========================
            raw_lines = cv2.HoughLinesP(
                clean_mask,
                1,
                np.pi / 180,
                threshold=20,
                minLineLength=20,
                maxLineGap=60
            )

            horizontal = []
            vertical = []

            if raw_lines is not None:
                for line in raw_lines:
                    x1, y1, x2, y2 = line[0]

                    # 🔥 filter เส้นสั้น
                    length = ((x2 - x1)**2 + (y2 - y1)**2) ** 0.5
                    if length < 25:
                        continue

                    # 🔥 snap แนว
                    if abs(x1 - x2) < abs(y1 - y2):
                        x = int((x1 + x2) / 2)
                        vertical.append((min(y1, y2), max(y1, y2), x))
                    else:
                        y = int((y1 + y2) / 2)
                        horizontal.append((min(x1, x2), max(x1, x2), y))

            # =========================
            # 🔥 2. MERGE แบบ aggressive ขึ้น
            # =========================
            def merge_lines(lines, axis='h', pos_thresh=10, gap_thresh=40):
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
                                    int((mpos + pos) / 2)
                                )
                                merged_flag = True
                                break

                    if not merged_flag:
                        merged.append((l1, l2, pos))

                return merged

            merged_h = merge_lines(horizontal, 'h')
            merged_v = merge_lines(vertical, 'v')

            # =========================
            # 🔥 3. REMOVE DUPLICATE (ดีกว่าเดิม)
            # =========================
            def remove_duplicates(lines, thresh=8):
                result = []

                for l in lines:
                    is_dup = False
                    for r in result:
                        if abs(l[2] - r[2]) < thresh and abs(l[0] - r[0]) < thresh and abs(l[1] - r[1]) < thresh:
                            is_dup = True
                            break

                    if not is_dup:
                        result.append(l)

                return result

            merged_h = remove_duplicates(merged_h)
            merged_v = remove_duplicates(merged_v)

            # =========================
            # 🔥 4. FINAL FILTER (กันเส้นสั้นอีกชั้น)
            # =========================
            def filter_short(lines, min_len=40):
                result = []
                for l1, l2, pos in lines:
                    if abs(l2 - l1) >= min_len:
                        result.append((l1, l2, pos))
                return result

            merged_h = filter_short(merged_h)
            merged_v = filter_short(merged_v)

            # =========================
            # 🔥 5. ADD WALLS
            # =========================
            for j, (x1, x2, y) in enumerate(merged_h):
                walls.append({
                    "id": f"w-h-{i}-{j}",
                    "x1": x1 / width,
                    "y1": y / height,
                    "x2": x2 / width,
                    "y2": y / height,
                    "type": "interior",
                    "thicknessRatio": 0.01,
                            "length": (x2 - x1)  # pixel

                })

            for j, (y1, y2, x) in enumerate(merged_v):
                walls.append({
                    "id": f"w-v-{i}-{j}",
                    "x1": x / width,
                    "y1": y1 / height,
                    "x2": x / width,
                    "y2": y2 / height,
                    "type": "interior",
                    "thicknessRatio": 0.01,
                            "length": (y2 - y1)  # pixel

                })

    return rooms, walls, doors, windows

# =========================
# API
# =========================
@app.post("/api/detect-floorplan", response_model=DetectionResult)
async def analyze(file: UploadFile = File(...)):
    try:
        image_bytes = await file.read()

        rooms, walls, doors, windows = detect(image_bytes)

        return DetectionResult(
            summary=f"{len(rooms)} rooms, {len(walls)} walls, {len(doors)} doors, {len(windows)} windows",
            rooms=rooms,
            walls=walls,
            doors=doors,
            windows=windows
        )

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/health")
def health():
    return {"status": "ok"}