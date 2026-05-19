from __future__ import annotations

import base64
import colorsys
import hashlib
import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Optional

import cv2
from django import conf
import fitz
import numpy as np
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from shapely import boundary
from shapely.geometry import GeometryCollection, LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union
from ultralytics import YOLO


BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = Path(os.getenv("MODEL_PATH", "best_v2.pt"))
if not MODEL_PATH.is_absolute():
    MODEL_PATH = BASE_DIR / MODEL_PATH

IMG_SIZE = int(os.getenv("IMG_SIZE", "960"))
MAX_SIDE = int(os.getenv("MAX_INPUT_SIDE", "1600"))
PDF_SCALE = 2.0

ROOM_CONF = 0.22
WALL_CONF = 0.18
DOOR_CONF = 0.40
WINDOW_CONF = 0.40
DOOR_MAX_AREA = 0.03
WIN_MAX_AREA = 0.05
MIN_SEG = 0.018
MIN_ROOM_AREA = 0.005  # inner polygon area threshold (was 0.008 outer)

WALL_CLR = (80, 160, 60)
DOOR_CLR = (0, 140, 255)
WIN_CLR = (220, 200, 0)

ROOM_HEURISTICS = [
    # (min_area_ratio, max_area_ratio, near_edge, has_door_nearby, name)
    # near_edge: True = ชิดขอบ boundary (likely มุมบ้าน)
    (0.18, 1.00, False, False, "Living Room"),   # ใหญ่สุด ไม่ชิดขอบ
    (0.08, 0.20, False, True,  "Bedroom"),        # กลาง มีประตู
    (0.08, 0.20, False, False, "Bedroom"),
    (0.02, 0.10, True,  True,  "Bathroom"),       # เล็ก ชิดขอบ มีประตู
    (0.02, 0.10, True,  False, "Storage"),
    (0.04, 0.15, False, True,  "Kitchen"),        # กลาง มีประตู ไม่ชิดขอบ
]


app = FastAPI(title="Floor Plan Vision API", version="4.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_model: Optional[YOLO] = None


def get_model() -> YOLO:
    global _model
    if _model is None:
        _model = YOLO(str(MODEL_PATH))
    return _model


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_PATH.name, "version": "4.0.0", "pipeline": "floorplan_v4"}


@app.post("/api/detect-floorplan")
async def analyze(file: UploadFile = File(...), debug: bool = Query(False)):
    try:
        raw = await file.read()
        return run_pipeline(raw, file.filename or "", debug=debug)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def run_pipeline(file_bytes: bytes, filename: str = "", debug: bool = False) -> dict:
    image = decode_image(file_bytes, filename)
    prep = preprocess(image)
    clean_image = prep["image"]
    yolo_result = get_model()(clean_image, imgsz=IMG_SIZE)[0]
    debug_images = {}
    if debug:
        debug_images["01_preprocessed"] = encode_preview(clean_image)
    geometry = build_geometry(clean_image, yolo_result, debug_images=debug_images if debug else None)
    geometry["rooms"] = [r for r in geometry["rooms"] if r.get("areaNorm", 0) >= MIN_ROOM_AREA]
    _estimate_widths(geometry)
    preview = encode_preview(draw_preview(clean_image, geometry))
    clean_preview = encode_preview(clean_image)  # preprocessed image without overlays

    response = {
        "meta": {
            "unit": "m",
            "scale": 1.0,
            "pipeline": "floorplan_v4",
            "resizeScale": prep["resize_scale"],
            "deskewAngle": prep["deskew_angle"],
            "cropBox": prep["crop_box"],
            "mode": geometry["meta"]["mode"],
            "roomMaskCount": geometry["meta"]["roomMaskCount"],
            "roomCount": geometry["meta"]["roomCount"],
            "wallCount": geometry["meta"]["wallCount"],
            "doorCount": geometry["meta"]["doorCount"],
            "windowCount": geometry["meta"]["windowCount"],
        },
        "rooms": geometry["rooms"],
        "walls": geometry["walls"],
        "doors": geometry["doors"],
        "windows": geometry["windows"],
        "image": preview,
        "cleanImage": clean_preview,
    }
    if debug:
        response["debug"] = debug_images
    return response


def decode_image(data: bytes, filename: str = "") -> np.ndarray:
    if filename.lower().endswith(".pdf") or data[:4] == b"%PDF":
        return _decode_pdf(data)
    return _decode_raster(data)


def _decode_pdf(data: bytes) -> np.ndarray:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        if doc.page_count == 0:
            raise ValueError("PDF has no pages")
        pix = doc.load_page(0).get_pixmap(matrix=fitz.Matrix(PDF_SCALE, PDF_SCALE), alpha=False)
        arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    finally:
        doc.close()


def _decode_raster(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Unsupported or corrupted image file")
    return img


def encode_preview(image: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        return ""
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


def _debug_wall_image(base_img, h_walls, v_walls, title, color=(0, 255, 0), thickness=3):
    image = base_img.copy()
    h, w = image.shape[:2]
    cv2.putText(image, title, (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 2, cv2.LINE_AA)
    for seg in h_walls:
        cv2.line(image, (int(seg["x1"] * w), int(seg["y"] * h)), (int(seg["x2"] * w), int(seg["y"] * h)), color, thickness)
    for seg in v_walls:
        cv2.line(image, (int(seg["x"] * w), int(seg["y1"] * h)), (int(seg["x"] * w), int(seg["y2"] * h)), color, thickness)
    return image


def _dark_line_mask(image: np.ndarray):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.GaussianBlur(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), (3, 3), 0)
    mask = ((gray < 145) & (hsv[:, :, 1] < 55)).astype(np.uint8) * 255
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))


def preprocess(image: np.ndarray) -> dict:
    resized, scale = _resize(image)
    denoised = cv2.fastNlMeansDenoisingColored(resized, None, 5, 5, 7, 21)
    cropped, crop_box = _crop_content(denoised)
    angle = _estimate_skew(cropped)
    deskewed = _rotate(cropped, -angle)
    return {"image": deskewed, "resize_scale": scale, "deskew_angle": angle, "crop_box": crop_box}


def _resize(image: np.ndarray):
    h, w = image.shape[:2]
    longest = max(w, h)
    if longest <= MAX_SIDE:
        return image, 1.0
    scale = MAX_SIDE / longest
    return cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA), scale


def _crop_content(image: np.ndarray, pad_ratio: float = 0.035):
    h, w = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Keep dark plan lines and colored markup/detections, ignore white page margin.
    content = (gray < 245) | (hsv[:, :, 1] > 28)
    content = content.astype(np.uint8) * 255
    content = cv2.morphologyEx(
        content,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9)),
        iterations=1,
    )

    coords = cv2.findNonZero(content)
    if coords is None:
        return image, {"x": 0, "y": 0, "w": w, "h": h}

    x, y, bw, bh = cv2.boundingRect(coords)
    if bw * bh < w * h * 0.08:
        return image, {"x": 0, "y": 0, "w": w, "h": h}

    pad = int(max(w, h) * pad_ratio)
    x1 = max(0, x - pad)
    y1 = max(0, y - pad)
    x2 = min(w, x + bw + pad)
    y2 = min(h, y + bh + pad)
    return image[y1:y2, x1:x2].copy(), {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}


def _estimate_skew(image: np.ndarray) -> float:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    binary = cv2.adaptiveThreshold(
        cv2.GaussianBlur(gray, (3, 3), 0),
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        35,
        11,
    )
    h, w = image.shape[:2]
    lines = cv2.HoughLinesP(binary, 1, np.pi / 180, threshold=80, minLineLength=max(40, min(w, h) // 8), maxLineGap=8)
    if lines is None:
        return 0.0
    angles = []
    for x1, y1, x2, y2 in lines[:, 0]:
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        while angle <= -45:
            angle += 90
        while angle > 45:
            angle -= 90
        if abs(angle) <= 15:
            angles.append(angle)
    return float(np.median(angles)) if angles else 0.0


def _rotate(image: np.ndarray, angle: float) -> np.ndarray:
    if abs(angle) < 0.25:
        return image
    h, w = image.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(
        image,
        matrix,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )

def _build_outer_walls_from_rooms(room_masks, h_walls, v_walls, cfg):
    if not room_masks:
        return h_walls, v_walls

    snap = cfg["snap"]

    try:
        room_union = unary_union([m["polygon"] for m in room_masks])
        outer = room_union.buffer(0.01).simplify(0.008, preserve_topology=True)
        outer = _largest_poly(outer)
        if outer is None:
            return h_walls, v_walls
    except Exception:
        return h_walls, v_walls

    coords = list(outer.exterior.coords)
    new_h, new_v = [], []

    for i in range(len(coords) - 1):
        x1, y1 = coords[i]
        x2, y2 = coords[i + 1]
        dx = abs(x2 - x1)
        dy = abs(y2 - y1)

        if dx < 1e-4 and dy < 1e-4:
            continue

        if dx >= dy and dy <= 0.03:  # ✅ ขยาย threshold รับ edge ที่เอียงเล็กน้อย
            ex1, ex2 = min(x1, x2), max(x1, x2)
            ey = (y1 + y2) / 2

            # ✅ covered = มี YOLO wall ที่ overlap บางส่วน ไม่ต้องครอบทั้งหมด
            covered = any(
                abs(w.get("y", 999) - ey) <= snap * 2
                and w.get("x2", -999) >= ex1 - snap   # overlap ซ้าย
                and w.get("x1", 999) <= ex2 + snap    # overlap ขวา
                for w in h_walls
                if w.get("source") == "yolo"
            )

            if not covered:
                new_h.append({
                    "x1": float(ex1), "x2": float(ex2),
                    "y": float(ey),
                    "t": cfg["thickness"],
                    "source": "room_shell",
                    "synthetic": True,
                })
            else:
                # ✅ มี YOLO wall แล้วแต่อาจขาดช่วง — bridge ส่วนที่ขาด
                yolo_on_axis = sorted(
                    [w for w in h_walls
                     if w.get("source") == "yolo"
                     and abs(w.get("y", 999) - ey) <= snap * 2
                     and w.get("x2", -999) >= ex1 - snap
                     and w.get("x1", 999) <= ex2 + snap],
                    key=lambda w: w.get("x1", 0)
                )
                # เติม gap ระหว่าง YOLO walls บน axis เดียวกัน
                prev_x2 = ex1
                for w in yolo_on_axis:
                    wx1 = w.get("x1", ex2)
                    if wx1 - prev_x2 > snap:
                        new_h.append({
                            "x1": float(prev_x2), "x2": float(wx1),
                            "y": float(ey),
                            "t": cfg["thickness"],
                            "source": "room_shell",
                            "synthetic": True,
                        })
                    prev_x2 = max(prev_x2, w.get("x2", prev_x2))
                # เติม gap หลัง YOLO wall สุดท้าย
                if ex2 - prev_x2 > snap:
                    new_h.append({
                        "x1": float(prev_x2), "x2": float(ex2),
                        "y": float(ey),
                        "t": cfg["thickness"],
                        "source": "room_shell",
                        "synthetic": True,
                    })

        elif dy > dx and dx <= 0.03:  # ✅ ขยาย threshold เช่นกัน
            ey1, ey2 = min(y1, y2), max(y1, y2)
            ex = (x1 + x2) / 2

            covered = any(
                abs(w.get("x", 999) - ex) <= snap * 2
                and w.get("y2", -999) >= ey1 - snap
                and w.get("y1", 999) <= ey2 + snap
                for w in v_walls
                if w.get("source") == "yolo"
            )

            if not covered:
                new_v.append({
                    "x": float(ex),
                    "y1": float(ey1), "y2": float(ey2),
                    "t": cfg["thickness"],
                    "source": "room_shell",
                    "synthetic": True,
                })
            else:
                # bridge ส่วนที่ขาดใน vertical axis
                yolo_on_axis = sorted(
                    [w for w in v_walls
                     if w.get("source") == "yolo"
                     and abs(w.get("x", 999) - ex) <= snap * 2
                     and w.get("y2", -999) >= ey1 - snap
                     and w.get("y1", 999) <= ey2 + snap],
                    key=lambda w: w.get("y1", 0)
                )
                prev_y2 = ey1
                for w in yolo_on_axis:
                    wy1 = w.get("y1", ey2)
                    if wy1 - prev_y2 > snap:
                        new_v.append({
                            "x": float(ex),
                            "y1": float(prev_y2), "y2": float(wy1),
                            "t": cfg["thickness"],
                            "source": "room_shell",
                            "synthetic": True,
                        })
                    prev_y2 = max(prev_y2, w.get("y2", prev_y2))
                if ey2 - prev_y2 > snap:
                    new_v.append({
                        "x": float(ex),
                        "y1": float(prev_y2), "y2": float(ey2),
                        "t": cfg["thickness"],
                        "source": "room_shell",
                        "synthetic": True,
                    })

    return h_walls + new_h, v_walls + new_v

def _find_uncovered_gaps(ex1, ex2, h_walls, ey, snap):
    """หาช่วง x ที่ยังไม่มี wall cover บน axis y=ey"""
    walls_on_axis = sorted(
        [w for w in h_walls
         if abs(w["y"] - ey) <= snap * 2
         and w["x2"] > ex1 and w["x1"] < ex2],
        key=lambda w: w["x1"]
    )
    gaps = []
    cursor = ex1
    for w in walls_on_axis:
        if w["x1"] - cursor > snap:
            gaps.append((cursor, w["x1"]))
        cursor = max(cursor, w["x2"])
    if ex2 - cursor > snap:
        gaps.append((cursor, ex2))
    return gaps


def _find_uncovered_gaps_v(ey1, ey2, v_walls, ex, snap):
    """หาช่วง y ที่ยังไม่มี wall cover บน axis x=ex"""
    walls_on_axis = sorted(
        [w for w in v_walls
         if abs(w["x"] - ex) <= snap * 2
         and w["y2"] > ey1 and w["y1"] < ey2],
        key=lambda w: w["y1"]
    )
    gaps = []
    cursor = ey1
    for w in walls_on_axis:
        if w["y1"] - cursor > snap:
            gaps.append((cursor, w["y1"]))
        cursor = max(cursor, w["y2"])
    if ey2 - cursor > snap:
        gaps.append((cursor, ey2))
    return gaps


def _close_all_gaps(
    h_walls: list,
    v_walls: list,
    cfg: dict,
    room_masks=None,
    doors=None,
    windows=None,
    image=None,
) -> tuple:

    snap = cfg["snap"]
    max_bridge = cfg.get("connect_gap", 0.028)

    room_union = None

    if room_masks:
        try:
            polys = []

            for m in room_masks:
                poly = m.get("polygon")

                if poly is not None and not poly.is_empty:
                    polys.append(poly)

            if polys:
                room_union = unary_union(polys).buffer(snap * 2)

        except Exception:
            room_union = None

    def _inside_room(x: float, y: float) -> bool:
        if room_union is None:
            return True

        try:
            return room_union.contains(Point(x, y))
        except Exception:
            return True

    def _crosses_opening(x1, y1, x2, y2) -> bool:

        objs = []

        if doors:
            objs.extend(doors)

        if windows:
            objs.extend(windows)

        mx = (x1 + x2) / 2
        my = (y1 + y2) / 2

        for obj in objs:

            if not isinstance(obj, dict):
                continue

            if "bbox" in obj and isinstance(obj["bbox"], dict):

                bbox = obj["bbox"]

                ox1 = bbox.get("x", 0)
                oy1 = bbox.get("y", 0)

                ox2 = ox1 + bbox.get("w", 0)
                oy2 = oy1 + bbox.get("h", 0)

            else:

                ox1 = obj.get("x", 0)
                oy1 = obj.get("y", 0)

                ox2 = ox1 + obj.get("w", 0)
                oy2 = oy1 + obj.get("h", 0)

            if ox1 <= mx <= ox2 and oy1 <= my <= oy2:
                return True

        return False

    def _has_dark_connection(
        x1,
        y1,
        x2,
        y2,
        samples=12,
        dark_thresh=90,
        min_ratio=0.65,
    ):

        if image is None:
            return True

        try:

            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

            h, w = gray.shape[:2]

            dark = 0

            for i in range(samples):

                t = i / max(samples - 1, 1)

                x = x1 + (x2 - x1) * t
                y = y1 + (y2 - y1) * t

                px = int(np.clip(x * w, 0, w - 1))
                py = int(np.clip(y * h, 0, h - 1))

                if gray[py, px] <= dark_thresh:
                    dark += 1

            return (dark / samples) >= min_ratio

        except Exception:
            return True

    new_h = []
    seen_h = set()

    for i, a in enumerate(h_walls):

        for j, b in enumerate(h_walls):

            if i >= j:
                continue

            y_delta = abs(a["y"] - b["y"])

            if y_delta > min(
                a.get("t", 0.012),
                b.get("t", 0.012),
            ) * 1.5:
                continue

            left = None
            right = None

            if a["x2"] <= b["x1"]:
                left, right = a, b

            elif b["x2"] <= a["x1"]:
                left, right = b, a

            if left is None:
                continue

            gap = right["x1"] - left["x2"]

            if gap <= 0 or gap > max_bridge:
                continue

            mid_x = (left["x2"] + right["x1"]) / 2
            mid_y = (left["y"] + right["y"]) / 2

            if not _inside_room(mid_x, mid_y):
                continue

            if _crosses_opening(
                left["x2"],
                mid_y,
                right["x1"],
                mid_y,
            ):
                continue

            if not _has_dark_connection(
                left["x2"],
                mid_y,
                right["x1"],
                mid_y,
            ):
                continue

            key = (
                round(left["x2"], 4),
                round(right["x1"], 4),
                round(mid_y, 4),
            )

            if key in seen_h:
                continue

            seen_h.add(key)

            new_h.append({
                "x1": float(left["x2"]),
                "x2": float(right["x1"]),
                "y": float(mid_y),
                "t": max(
                    left.get("t", 0.012),
                    right.get("t", 0.012),
                ),
                "source": "gap_bridge",
                "synthetic": True,
            })

    new_v = []
    seen_v = set()

    for i, a in enumerate(v_walls):

        for j, b in enumerate(v_walls):

            if i >= j:
                continue

            x_delta = abs(a["x"] - b["x"])

            if x_delta > min(
                a.get("t", 0.012),
                b.get("t", 0.012),
            ) * 1.5:
                continue

            top = None
            bot = None

            if a["y2"] <= b["y1"]:
                top, bot = a, b

            elif b["y2"] <= a["y1"]:
                top, bot = b, a

            if top is None:
                continue

            gap = bot["y1"] - top["y2"]

            if gap <= 0 or gap > max_bridge:
                continue

            mid_x = (top["x"] + bot["x"]) / 2
            mid_y = (top["y2"] + bot["y1"]) / 2

            if not _inside_room(mid_x, mid_y):
                continue

            if _crosses_opening(
                mid_x,
                top["y2"],
                mid_x,
                bot["y1"],
            ):
                continue

            if not _has_dark_connection(
                mid_x,
                top["y2"],
                mid_x,
                bot["y1"],
            ):
                continue

            key = (
                round(mid_x, 4),
                round(top["y2"], 4),
                round(bot["y1"], 4),
            )

            if key in seen_v:
                continue

            seen_v.add(key)

            new_v.append({
                "x": float(mid_x),
                "y1": float(top["y2"]),
                "y2": float(bot["y1"]),
                "t": max(
                    top.get("t", 0.012),
                    bot.get("t", 0.012),
                ),
                "source": "gap_bridge",
                "synthetic": True,
            })

    all_h, all_v = _snap_merge(
        h_walls + new_h,
        v_walls + new_v,
        cfg,
    )

    return all_h, all_v

def _graceful_fallback(
    boundary: Polygon,
    h_walls: list,
    v_walls: list,
    doors: list,
    cfg: dict,
) -> list:
    """
    Fallback 3 ระดับ:
    1. ลอง polygonize บน boundary + walls อีกรอบหลัง dilate walls
    2. Split boundary เป็นครึ่งๆ ตาม longest axis แล้ว name แต่ละซีก
    3. Floor เดียว (last resort)
    """
    used_names: dict = {}

    # --- Level 1: dilate walls แล้ว polygonize ใหม่ ---
    try:
        lines = [_seg_line(s, "h") for s in h_walls if s["x2"] - s["x1"] > 1e-5]
        lines += [_seg_line(s, "v") for s in v_walls if s["y2"] - s["y1"] > 1e-5]
        bline = boundary.boundary
        lines += list(bline.geoms) if hasattr(bline, "geoms") else [bline]
        # dilate ผนังเล็กน้อยเพื่อปิดช่องรั่ว
        union = unary_union(lines).buffer(cfg["snap"] * 0.5)
        raw = list(polygonize(union))
        cells = [
            _largest_poly(c.intersection(boundary))
            for c in raw
            if c.area >= boundary.area * 0.05
        ]
        cells = [c for c in cells if c is not None]
        if len(cells) >= 2:
            cells_sorted = sorted(cells, key=lambda c: -c.area)
            rooms = []
            for cell in cells_sorted:
                label = _name_room_heuristic(
                    cell, boundary, doors, used_names, cells_sorted
                )
                room = _make_room(label, 1, cell)
                if room:
                    rooms.append(room)
            if rooms:
                return _deoverlap(rooms, boundary)
    except Exception:
        pass

    # --- Level 2: split ตาม longest axis ---
    try:
        minx, miny, maxx, maxy = boundary.bounds
        is_wide = (maxx - minx) >= (maxy - miny)
        if is_wide:
            mid = (minx + maxx) / 2
            left = _largest_poly(boundary.intersection(
                Polygon([(minx-0.01, miny-0.01), (mid, miny-0.01),
                         (mid, maxy+0.01), (minx-0.01, maxy+0.01)])
            ))
            right = _largest_poly(boundary.intersection(
                Polygon([(mid, miny-0.01), (maxx+0.01, miny-0.01),
                         (maxx+0.01, maxy+0.01), (mid, maxy+0.01)])
            ))
            halves = [p for p in [left, right] if p and p.area >= boundary.area * 0.1]
        else:
            mid = (miny + maxy) / 2
            top = _largest_poly(boundary.intersection(
                Polygon([(minx-0.01, miny-0.01), (maxx+0.01, miny-0.01),
                         (maxx+0.01, mid), (minx-0.01, mid)])
            ))
            bot = _largest_poly(boundary.intersection(
                Polygon([(minx-0.01, mid), (maxx+0.01, mid),
                         (maxx+0.01, maxy+0.01), (minx-0.01, maxy+0.01)])
            ))
            halves = [p for p in [top, bot] if p and p.area >= boundary.area * 0.1]

        if halves:
            halves_sorted = sorted(halves, key=lambda p: -p.area)
            rooms = []
            for half in halves_sorted:
                label = _name_room_heuristic(
                    half, boundary, doors, used_names, halves_sorted
                )
                room = _make_room(label, 1, half)
                if room:
                    rooms.append(room)
            return _deoverlap(rooms, boundary)
    except Exception:
        pass

    # --- Level 3: Floor เดียว ---
    room = _make_room("Floor", 1, boundary)
    return [room] if room else []

def build_geometry(image: np.ndarray, yolo_results, debug_images=None) -> dict:
    h, w = image.shape[:2]

    room_masks = _extract_room_masks(yolo_results, w, h)

    if debug_images is not None:
        dbg_raw = image.copy()
        dbg_fixed = image.copy()
        for m in room_masks:
            poly = m["polygon"]
            polys = [poly] if isinstance(poly, Polygon) else list(poly.geoms)
            for p in polys:
                pts = np.array([[int(x * w), int(y * h)] for x, y in p.exterior.coords], np.int32)
                cv2.fillPoly(dbg_raw, [pts], (0, 255, 0))
                repaired = _largest_poly(
                    p.buffer(0.005, join_style=2)
                    .buffer(-0.003, join_style=2)
                    .buffer(0)
                    .simplify(0.0015, preserve_topology=True)
                )
                if repaired is None:
                    continue
                pts_fixed = np.array([[int(x * w), int(y * h)] for x, y in repaired.exterior.coords], np.int32)
                cv2.fillPoly(dbg_fixed, [pts_fixed], (255, 0, 0))
        debug_images["room_masks"] = encode_preview(dbg_raw)
        debug_images["room_masks_fixed"] = encode_preview(dbg_fixed)

    doors = _extract_openings(yolo_results, w, h, "door")
    windows = _extract_openings(yolo_results, w, h, "window")
    openings = doors + windows

    yolo_h, yolo_v = _extract_walls_yolo(
        yolo_results,
        w,
        h,
    )

    cfg = _wall_config(
        yolo_h,
        yolo_v,
    )

    all_h = list(yolo_h)
    all_v = list(yolo_v)

    all_h, all_v = _opening_requires_wall(
        all_h,
        all_v,
        openings,
        cfg,
    )

    all_h, all_v = _build_outer_walls_from_rooms(
        room_masks,
        all_h,
        all_v,
        cfg,
    )

    boundary = _build_boundary(
        room_masks,
        all_h,
        all_v,
    )

    all_h, all_v = _close_all_gaps(
        all_h,
        all_v,
        cfg,
        room_masks=room_masks,
        doors=doors,
        windows=windows,
        image=image,
    )

    h_walls, v_walls = _process_wall_graph(
        all_h,
        all_v,
        doors + windows,
        boundary,
        cfg,
    )

    h_walls, v_walls = _filter_walls_by_rooms(
        h_walls,
        v_walls,
        room_masks,
        cfg,
    )

    if debug_images is not None:
        debug_images["03_yolo_walls"] = encode_preview(
            _debug_wall_image(image, yolo_h, yolo_v, "YOLO walls", (255, 100, 0), 4)
        )
        debug_images["05_final_walls"] = encode_preview(
            _debug_wall_image(image, h_walls, v_walls, "Final walls", (0, 255, 0), 4)
        )

    mode = "mask_direct"
    rooms = []

    # Primary: polygonize แล้ว assign label จาก YOLO mask
    cells = _polygonize_cells(
        h_walls,
        v_walls,
        boundary,
        room_masks,
    )

    cells = _cleanup_cells(
        cells,
        boundary,
        cfg,
    )

    cells = _merge_fragmented_cells(
        cells,
        cfg,
    )

    if cells and _cells_valid(cells, room_masks, boundary):

        rooms = _assign_rooms(
            cells,
            room_masks,
            boundary,
            cfg,
            doors=doors,
        )

        rooms = _filter_room_area_outliers(
            rooms,
            boundary,
        )

    mode = "polygonize"

    # Fallback: ใช้ YOLO mask โดยตรง
    if not rooms:
        rooms = _rooms_from_masks(room_masks, boundary, h_walls, v_walls, cfg)
        mode = "mask_direct"

    # Last resort
    if not rooms:
        rooms = _graceful_fallback(boundary, h_walls, v_walls, doors, cfg)
        mode = "graceful_fallback"

    walls = _wall_output(h_walls, v_walls, boundary)

    if debug_images is not None:
        dbg_rooms = image.copy()
        h_img, w_img = dbg_rooms.shape[:2]
        colors = [
            (220, 80,  80),
            (80,  180, 80),
            (80,  120, 220),
            (200, 140, 40),
            (160, 60,  200),
            (40,  180, 180),
            (220, 100, 160),
            (100, 200, 80),
        ]
        for i, room in enumerate(rooms):
            pts_src = room.get("wallPolygon") or room.get("polygon") or []
            if len(pts_src) < 3:
                continue
            arr = np.array([[int(p["x"] * w_img), int(p["y"] * h_img)] for p in pts_src], np.int32)
            color = colors[i % len(colors)]
            overlay = dbg_rooms.copy()
            cv2.fillPoly(overlay, [arr], color)
            cv2.addWeighted(overlay, 0.35, dbg_rooms, 0.65, 0, dbg_rooms)
            cv2.polylines(dbg_rooms, [arr], True, color, 2)
            cx = int(room["center"]["x"] * w_img)
            cy = int(room["center"]["y"] * h_img)
            label = room.get("name", "Room")
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            cv2.rectangle(dbg_rooms, (cx - tw // 2 - 3, cy - th - 4), (cx + tw // 2 + 3, cy + 4), (255, 255, 255), -1)
            cv2.putText(dbg_rooms, label, (cx - tw // 2, cy), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (20, 20, 20), 1, cv2.LINE_AA)
        cv2.putText(dbg_rooms, f"Final rooms ({mode}): {len(rooms)}", (12, 28),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 200), 2, cv2.LINE_AA)
        debug_images["06_final_rooms"] = encode_preview(dbg_rooms)

    return {
        "rooms": rooms,
        "walls": walls,
        "doors": doors,
        "windows": windows,
        "meta": {
            "mode": mode,
            "roomMaskCount": len(room_masks),
            "roomCount": len(rooms),
            "wallCount": len(walls),
            "doorCount": len(doors),
            "windowCount": len(windows),
        },
    }



def _filter_walls_by_rooms(h_walls, v_walls, room_masks, cfg) -> tuple:
    if not room_masks:
        return h_walls, v_walls

    try:
        room_union = unary_union([m["polygon"] for m in room_masks])
        room_area = room_union.buffer(cfg["snap"] * 3)
    except Exception:
        return h_walls, v_walls

    # source เหล่านี้เก็บไว้เสมอ ไม่กรองออก
    KEEP_SOURCES = {"yolo", "room_shell", "opening_inferred"}

    def wall_near_room(line: LineString) -> bool:
        try:
            # ใช้ room_area.distance(line) — ถูกต้องกว่า line.distance(room_area)
            # เมื่อ line อยู่ภายใน room_area → distance = 0 → ผ่านเสมอ
            return room_area.distance(line) <= cfg["snap"] * 2
        except Exception:
            return True

    out_h = [
        seg for seg in h_walls
        if seg.get("source") in KEEP_SOURCES
        or wall_near_room(LineString([(seg["x1"], seg["y"]), (seg["x2"], seg["y"])]))
    ]
    out_v = [
        seg for seg in v_walls
        if seg.get("source") in KEEP_SOURCES
        or wall_near_room(LineString([(seg["x"], seg["y1"]), (seg["x"], seg["y2"])]))
    ]

    return out_h, out_v

def _clip(v: float) -> float:
    return float(np.clip(v, 0.0, 1.0))


def _extract_room_masks(results, w, h) -> list[dict]:

    out = []

    if results.masks is None or results.boxes is None:
        return out

    count = min(
        len(results.masks.xy),
        len(results.boxes.cls),
    )

    for i in range(count):

        label = results.names[int(results.boxes.cls[i])]
        conf = float(results.boxes.conf[i])

        if "room" not in label.lower() or conf < ROOM_CONF:
            continue

        pts = results.masks.xy[i]

        if pts is None or len(pts) < 3:
            continue

        mask_img = np.zeros((h, w), dtype=np.uint8)

        cv2.fillPoly(
            mask_img,
            [pts.astype(np.int32)],
            255,
        )

        close_px = max(
            5,
            int(min(w, h) * 0.010),
        )

        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (close_px, close_px),
        )

        mask_img = cv2.morphologyEx(
            mask_img,
            cv2.MORPH_CLOSE,
            kernel,
            iterations=1,
        )

        cnts, _ = cv2.findContours(
            mask_img,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )

        if not cnts:
            continue

        cnt = max(cnts, key=cv2.contourArea)

        norm = [
            (_clip(x / w), _clip(y / h))
            for x, y in cnt[:, 0]
        ]

        poly = _clean_poly(Polygon(norm))

        if poly is None:
            continue

        gap_fill = 0.006

        poly = poly.buffer(
            gap_fill,
            join_style=2,
        )

        shrink = min(
            gap_fill * 0.6,
            0.0025,
        )

        poly = poly.buffer(
            -shrink,
            join_style=2,
        )

        poly = poly.buffer(0)

        poly = poly.simplify(
            0.0012,
            preserve_topology=True,
        )

        poly = _largest_poly(poly)

        if poly is None:
            continue

        if poly.area < 0.0002:
            continue

        c = poly.centroid

        out.append({
            "label": label,
            "conf": conf,
            "polygon": poly,
            "centroid": (
                float(c.x),
                float(c.y),
            ),
        })

    return out


def _extract_openings(results, w, h, kind: str) -> list[dict]:
    out = []
    max_area = DOOR_MAX_AREA if kind == "door" else WIN_MAX_AREA
    conf_thr = DOOR_CONF if kind == "door" else WINDOW_CONF
    if results.boxes is None:
        return out
    for i, (cls, conf, box) in enumerate(zip(results.boxes.cls, results.boxes.conf, results.boxes.xyxy)):
        if results.names[int(cls)] != kind or float(conf) < conf_thr:
            continue
        x1, y1, x2, y2 = box.cpu().numpy()
        bw = float((x2 - x1) / w)
        bh = float((y2 - y1) / h)
        if bw > 0.30 or bh > 0.30 or bw * bh > max_area:
            continue
        bbox = {"x": _clip(x1 / w), "y": _clip(y1 / h), "w": bw, "h": bh}
        polygon = None
        if results.masks is not None and i < len(results.masks.xy):
            pts = results.masks.xy[i]
            if pts is not None and len(pts) >= 3:
                polygon = [{"x": _clip(x / w), "y": _clip(y / h)} for x, y in pts]
                arr = np.array(pts, dtype=np.float32)
                bbox = {
                    "x": _clip(float(arr[:, 0].min()) / w),
                    "y": _clip(float(arr[:, 1].min()) / h),
                    "w": _clip(float(np.ptp(arr[:, 0])) / w),
                    "h": _clip(float(np.ptp(arr[:, 1])) / h),
                }
        out.append({"id": f"{kind}-{i}", "bbox": bbox, "polygon": polygon, "widthPx": float(max(bbox["w"] * w, bbox["h"] * h)), "widthM": None, "confidence": float(conf)})
    return out


def _extract_walls_yolo(results, w, h):
    h_walls, v_walls = [], []
    if results.masks is None or results.boxes is None:
        return h_walls, v_walls
    count = min(len(results.masks.xy), len(results.boxes.cls))
    for i in range(count):
        label = results.names[int(results.boxes.cls[i])]
        conf = float(results.boxes.conf[i])
        if label != "wall" or conf < WALL_CONF:
            continue
        pts = results.masks.xy[i]
        if pts is None or len(pts) < 3:
            continue
        arr = np.array(pts, dtype=np.float32)
        (cx, cy), (rw, rh), angle = cv2.minAreaRect(arr)
        if rw < 2 or rh < 2:
            continue
        if rw >= rh:
            length, thick, theta = rw, rh, np.deg2rad(angle)
        else:
            length, thick, theta = rh, rw, np.deg2rad(angle + 90)
        t = float(np.clip(thick / max(w, h), 0.005, 0.035))
        if abs(np.cos(theta)) >= abs(np.sin(theta)):
            h_walls.append({
                "x1": _clip((cx - length / 2) / w),
                "x2": _clip((cx + length / 2) / w),
                "y": _clip(cy / h),
                "t": t,
                "source": "yolo",
                "conf": conf
            })        
        else:
            v_walls.append({
                "x": _clip(cx / w),
                "y1": _clip((cy - length / 2) / h),
                "y2": _clip((cy + length / 2) / h),
                "t": t,
                "source": "yolo",
                "conf": conf
            })    
    for seg in h_walls:
        if seg["x1"] > seg["x2"]:
            seg["x1"], seg["x2"] = seg["x2"], seg["x1"]
    for seg in v_walls:
        if seg["y1"] > seg["y2"]:
            seg["y1"], seg["y2"] = seg["y2"], seg["y1"]
    return h_walls, v_walls

def _filter_staircase_walls(h_walls, v_walls):
    """Remove interior rungs from dense parallel line groups (staircase pattern)."""
    gap_thr = 0.022
    overlap_thr = 0.50

    def overlaps(a, b, k1, k2):
        span = max(a[k2] - a[k1], b[k2] - b[k1])
        return (min(a[k2], b[k2]) - max(a[k1], b[k1])) / span if span > 1e-6 else 0

    def filter_dense(walls, coord, k1, k2):
        if len(walls) < 4:
            return walls
        srt = sorted(walls, key=lambda s: s[coord])
        remove = set()
        for i in range(1, len(srt) - 1):
            p, c, n = srt[i - 1], srt[i], srt[i + 1]
            if (abs(c[coord] - p[coord]) < gap_thr
                    and abs(n[coord] - c[coord]) < gap_thr
                    and overlaps(c, p, k1, k2) > overlap_thr
                    and overlaps(c, n, k1, k2) > overlap_thr):
                remove.add(id(c))
        return [s for s in walls if id(s) not in remove]

    return filter_dense(h_walls, "y", "x1", "x2"), filter_dense(v_walls, "x", "y1", "y2")




def _wall_config(h_walls, v_walls) -> dict:
    thicknesses = [seg.get("t", 0.012) for seg in h_walls + v_walls if seg.get("t", 0) > 0]
    median = float(np.median(thicknesses)) if thicknesses else 0.012
    snap = float(np.clip(median * 1.8, 0.008, 0.025))
    return {
        "thickness": median,
        "snap": snap,
        "merge_gap": float(np.clip(snap * 1.6, 0.018, 0.045)),
        "connect_gap": float(np.clip(snap * 2.0, 0.020, 0.055)), 
        "min_real_door": 12,"bnd_pad": float(np.clip(snap * 1.5, 0.012, 0.04)),
    }

def _debug_wall_connectivity(h_walls, v_walls, cfg):

    snap = cfg["snap"]

    broken_h = []
    broken_v = []

    for seg in h_walls:

        left_ok = any(
            abs(v["x"] - seg["x1"]) <= snap and
            v["y1"] - snap <= seg["y"] <= v["y2"] + snap
            for v in v_walls
        )

        right_ok = any(
            abs(v["x"] - seg["x2"]) <= snap and
            v["y1"] - snap <= seg["y"] <= v["y2"] + snap
            for v in v_walls
        )

        if not left_ok or not right_ok:
            broken_h.append(seg)

    for seg in v_walls:

        top_ok = any(
            abs(h["y"] - seg["y1"]) <= snap and
            h["x1"] - snap <= seg["x"] <= h["x2"] + snap
            for h in h_walls
        )

        bottom_ok = any(
            abs(h["y"] - seg["y2"]) <= snap and
            h["x1"] - snap <= seg["x"] <= h["x2"] + snap
            for h in h_walls
        )

        if not top_ok or not bottom_ok:
            broken_v.append(seg)

    print("\n========== WALL GRAPH ==========")
    print(f"h walls: {len(h_walls)}")
    print(f"v walls: {len(v_walls)}")
    print(f"broken h: {len(broken_h)}")
    print(f"broken v: {len(broken_v)}")

    return broken_h, broken_v

def _process_wall_graph(h_raw, v_raw, openings, boundary, cfg):
    h_walls, v_walls = [dict(seg) for seg in h_raw], [dict(seg) for seg in v_raw]
    h_walls, v_walls = _snap_merge(h_walls, v_walls, cfg)
    h_walls, v_walls = _filter_staircase_walls(h_walls, v_walls)
    _heal(h_walls, v_walls, cfg)
    _infer_walls_from_openings(
        h_walls,
        v_walls,
        openings,
        cfg
    )
    _bridge_openings(h_walls, v_walls, openings, cfg)
    _snap_anchors(h_walls, v_walls, cfg)
    h_walls, v_walls = _snap_merge(h_walls, v_walls, cfg)
    broken_h, broken_v = _debug_wall_connectivity(
        h_walls,
        v_walls,
        cfg
    )
    h_walls, v_walls = _clip_to_boundary(h_walls, v_walls, boundary, cfg)
    h_walls, v_walls = _filter_structural(h_walls, v_walls, boundary, cfg)
    # h_walls, v_walls = _ensure_outer_edges(h_walls, v_walls, boundary, cfg)
    _snap_anchors(h_walls, v_walls, cfg)
    h_walls, v_walls = _split_at_junctions(h_walls, v_walls)
    return h_walls, v_walls


def _cluster(values: list, tol: float) -> list:
    clusters = []
    for value in sorted(values):
        if clusters and abs(clusters[-1]["avg"] - value) <= tol:
            clusters[-1]["items"].append(value)
            clusters[-1]["avg"] = sum(clusters[-1]["items"]) / len(clusters[-1]["items"])
        else:
            clusters.append({"avg": value, "items": [value]})
    return [cluster["avg"] for cluster in clusters]


def _nearest(value: float, axes: list) -> float:
    return min(axes, key=lambda axis: abs(axis - value)) if axes else value


def _snap_merge(h_walls: list, v_walls: list, cfg: dict):
    snap, merge_gap = cfg["snap"], cfg["merge_gap"]
    x_axes = _cluster([seg["x"] for seg in v_walls], snap)
    y_axes = _cluster([seg["y"] for seg in h_walls], snap)
    for seg in h_walls:
        seg["y"] = _nearest(seg["y"], y_axes)
        for axis in x_axes:
            if abs(seg["x1"] - axis) <= snap:
                seg["x1"] = axis
            if abs(seg["x2"] - axis) <= snap:
                seg["x2"] = axis
        if seg["x1"] > seg["x2"]:
            seg["x1"], seg["x2"] = seg["x2"], seg["x1"]
    for seg in v_walls:
        seg["x"] = _nearest(seg["x"], x_axes)
        for axis in y_axes:
            if abs(seg["y1"] - axis) <= snap:
                seg["y1"] = axis
            if abs(seg["y2"] - axis) <= snap:
                seg["y2"] = axis
        if seg["y1"] > seg["y2"]:
            seg["y1"], seg["y2"] = seg["y2"], seg["y1"]

    merged_h = []
    for axis in y_axes:
        same = sorted([seg for seg in h_walls if abs(seg["y"] - axis) <= snap], key=lambda seg: seg["x1"])
        for seg in same:
            if seg["x2"] - seg["x1"] < MIN_SEG:
                continue
            if merged_h and abs(merged_h[-1]["y"] - axis) <= snap and seg["x1"] - merged_h[-1]["x2"] <= merge_gap:
                merged_h[-1]["x2"] = max(merged_h[-1]["x2"], seg["x2"])
                merged_h[-1]["t"] = max(merged_h[-1]["t"], seg["t"])
            else:
                merged_h.append({**seg, "y": axis})

    merged_v = []
    for axis in x_axes:
        same = sorted([seg for seg in v_walls if abs(seg["x"] - axis) <= snap], key=lambda seg: seg["y1"])
        for seg in same:
            if seg["y2"] - seg["y1"] < MIN_SEG:
                continue
            if merged_v and abs(merged_v[-1]["x"] - axis) <= snap and seg["y1"] - merged_v[-1]["y2"] <= merge_gap:
                merged_v[-1]["y2"] = max(merged_v[-1]["y2"], seg["y2"])
                merged_v[-1]["t"] = max(merged_v[-1]["t"], seg["t"])
            else:
                merged_v.append({**seg, "x": axis})
    return merged_h, merged_v


def _h_anchored(x, y, v_walls, tol):
    return any(abs(seg["x"] - x) <= tol and seg["y1"] - tol <= y <= seg["y2"] + tol for seg in v_walls)


def _v_anchored(x, y, h_walls, tol):
    return any(abs(seg["y"] - y) <= tol and seg["x1"] - tol <= x <= seg["x2"] + tol for seg in h_walls)


def _heal(h_walls, v_walls, cfg):
    snap, connect = cfg["snap"], cfg["connect_gap"]
    for _ in range(2):
        for seg in h_walls:
            y = seg["y"]
            if not _h_anchored(seg["x1"], y, v_walls, snap):
                candidates = [v for v in v_walls if v["x"] < seg["x1"] and v["y1"] - snap <= y <= v["y2"] + snap]
                if candidates:
                    hit = max(candidates, key=lambda v: v["x"])
                    if seg["x1"] - hit["x"] <= connect:
                        seg["x1"] = hit["x"]
                        hit["y1"] = min(hit["y1"], y)
                        hit["y2"] = max(hit["y2"], y)
            if not _h_anchored(seg["x2"], y, v_walls, snap):
                candidates = [v for v in v_walls if v["x"] > seg["x2"] and v["y1"] - snap <= y <= v["y2"] + snap]
                if candidates:
                    hit = min(candidates, key=lambda v: v["x"])
                    if hit["x"] - seg["x2"] <= connect:
                        seg["x2"] = hit["x"]
                        hit["y1"] = min(hit["y1"], y)
                        hit["y2"] = max(hit["y2"], y)
        for seg in v_walls:
            x = seg["x"]
            if not _v_anchored(x, seg["y1"], h_walls, snap):
                candidates = [h for h in h_walls if h["y"] < seg["y1"] and h["x1"] - snap <= x <= h["x2"] + snap]
                if candidates:
                    hit = max(candidates, key=lambda h: h["y"])
                    if seg["y1"] - hit["y"] <= connect:
                        seg["y1"] = hit["y"]
                        hit["x1"] = min(hit["x1"], x)
                        hit["x2"] = max(hit["x2"], x)
            if not _v_anchored(x, seg["y2"], h_walls, snap):
                candidates = [h for h in h_walls if h["y"] > seg["y2"] and h["x1"] - snap <= x <= h["x2"] + snap]
                if candidates:
                    hit = min(candidates, key=lambda h: h["y"])
                    if hit["y"] - seg["y2"] <= connect:
                        seg["y2"] = hit["y"]
                        hit["x1"] = min(hit["x1"], x)
                        hit["x2"] = max(hit["x2"], x)

def _is_real_door_gap(gap, opening_size):
    """
    Prevent bridging actual room door openings.
    Only repair tiny segmentation gaps.
    """
    return gap >= opening_size * 0.65


def _bridge_openings(h_walls, v_walls, openings, cfg):

    snap = cfg["snap"]
    connect = cfg["connect_gap"]

    # ---------------------------------------------------------
    # IMPORTANT:
    # bridge เฉพาะ micro-gap เท่านั้น
    # ---------------------------------------------------------

    min_real_door = cfg.get("min_real_door", 0.012)

    for opening in openings:

        bbox = opening.get("bbox", {})

        ox = float(bbox.get("x", 0)) + float(bbox.get("w", 0)) / 2
        oy = float(bbox.get("y", 0)) + float(bbox.get("h", 0)) / 2

        ow = float(bbox.get("w", 0))
        oh = float(bbox.get("h", 0))

        if ow <= 0 or oh <= 0:
            continue

        # =====================================================
        # HORIZONTAL OPENING
        # =====================================================

        if ow >= oh:

            candidates = [
                seg for seg in h_walls
                if abs(seg["y"] - oy) <= connect
            ]

            if not candidates:
                continue

            y = min(
                candidates,
                key=lambda seg: abs(seg["y"] - oy)
            )["y"]

            left = [
                seg for seg in candidates
                if (
                    abs(seg["y"] - y) <= snap
                    and seg["x2"] <= ox
                )
            ]

            right = [
                seg for seg in candidates
                if (
                    abs(seg["y"] - y) <= snap
                    and seg["x1"] >= ox
                )
            ]

            if not left or not right:
                continue

            lw = max(left, key=lambda seg: seg["x2"])
            rw = min(right, key=lambda seg: seg["x1"])

            gap = rw["x1"] - lw["x2"]

            # -------------------------------------------------
            # invalid gap
            # -------------------------------------------------

            if gap <= 0:
                continue

            # -------------------------------------------------
            # real door/window opening
            # DON'T BRIDGE
            # -------------------------------------------------

            if gap >= min_real_door:
                continue

            # -------------------------------------------------
            # too large for repair
            # -------------------------------------------------

            max_bridge = min(connect * 0.55, ow * 0.7)

            if gap > max_bridge:
                continue

            # -------------------------------------------------
            # opening size matches gap
            # probably intentional opening
            # -------------------------------------------------

            if abs(gap - ow) <= max(0.004, ow * 0.25):
                continue

            h_walls.append({
                "x1": lw["x2"],
                "x2": rw["x1"],
                "y": y,
                "t": max(lw["t"], rw["t"]),
                "source": "bridge",
                "synthetic": True
            })

        # =====================================================
        # VERTICAL OPENING
        # =====================================================

        else:

            candidates = [
                seg for seg in v_walls
                if abs(seg["x"] - ox) <= connect
            ]

            if not candidates:
                continue

            x = min(
                candidates,
                key=lambda seg: abs(seg["x"] - ox)
            )["x"]

            top = [
                seg for seg in candidates
                if (
                    abs(seg["x"] - x) <= snap
                    and seg["y2"] <= oy
                )
            ]

            bottom = [
                seg for seg in candidates
                if (
                    abs(seg["x"] - x) <= snap
                    and seg["y1"] >= oy
                )
            ]

            if not top or not bottom:
                continue

            tw = max(top, key=lambda seg: seg["y2"])
            bw = min(bottom, key=lambda seg: seg["y1"])

            gap = bw["y1"] - tw["y2"]

            # -------------------------------------------------
            # invalid gap
            # -------------------------------------------------

            if gap <= 0:
                continue

            # -------------------------------------------------
            # real opening
            # DON'T BRIDGE
            # -------------------------------------------------

            if gap >= min_real_door:
                continue

            # -------------------------------------------------
            # only tiny repair allowed
            # -------------------------------------------------

            max_bridge = min(connect * 0.55, oh * 0.7)

            if gap > max_bridge:
                continue

            # -------------------------------------------------
            # likely intentional opening
            # -------------------------------------------------

            if abs(gap - oh) <= max(0.004, oh * 0.25):
                continue

            v_walls.append({
                "x": x,
                "y1": tw["y2"],
                "y2": bw["y1"],
                "t": max(tw["t"], bw["t"]),
                "source": "bridge",
                "synthetic": True
            })
            
def _opening_requires_wall(h_walls, v_walls, openings, cfg):

    snap = cfg["snap"]

    for op in openings:

        bbox = op.get("bbox", {})

        x = float(bbox.get("x", 0))
        y = float(bbox.get("y", 0))
        w = float(bbox.get("w", 0))
        h = float(bbox.get("h", 0))

        conf = float(op.get("confidence", 1.0))

        # high confidence opening only
        if conf < 0.55:
            continue

        cx = x + w / 2
        cy = y + h / 2

        # -----------------------------------------------------
        # HORIZONTAL OPENING
        # -----------------------------------------------------

        if w >= h:

            nearby = [
                seg for seg in h_walls
                if abs(seg["y"] - cy) <= snap * 2
            ]

            if nearby:
                continue

            h_walls.append({
                "x1": x,
                "x2": x + w,
                "y": cy,
                "t": 1,
                "source": "opening_inferred",
                "synthetic": True
            })

        # -----------------------------------------------------
        # VERTICAL OPENING
        # -----------------------------------------------------

        else:

            nearby = [
                seg for seg in v_walls
                if abs(seg["x"] - cx) <= snap * 2
            ]

            if nearby:
                continue

            v_walls.append({
                "x": cx,
                "y1": y,
                "y2": y + h,
                "t": 1,
                "source": "opening_inferred",
                "synthetic": True
            })

    return h_walls, v_walls


def _infer_walls_from_openings(
    h_walls,
    v_walls,
    openings,
    cfg
):
    snap = cfg["snap"]

    for op in openings:

        bbox = op.get("bbox", {})

        ox = float(bbox.get("x", 0)) + float(bbox.get("w", 0)) / 2
        oy = float(bbox.get("y", 0)) + float(bbox.get("h", 0)) / 2

        ow = float(bbox.get("w", 0))
        oh = float(bbox.get("h", 0))

        if ow <= 0 or oh <= 0:
            continue

        # horizontal opening
        if ow >= oh:

            nearby = [
                s for s in h_walls
                if abs(s["y"] - oy) <= snap * 2
            ]

            if nearby:
                continue

            h_walls.append({
                "x1": max(0.0, ox - ow * 0.9),
                "x2": min(1.0, ox + ow * 0.9),
                "y": oy,
                "t": cfg["thickness"],
                "source": "opening_inferred",
                "synthetic": True,
                "conf": 1.0
            })

        else:

            nearby = [
                s for s in v_walls
                if abs(s["x"] - ox) <= snap * 2
            ]

            if nearby:
                continue

            v_walls.append({
                "x": ox,
                "y1": max(0.0, oy - oh * 0.9),
                "y2": min(1.0, oy + oh * 0.9),
                "t": cfg["thickness"],
                "source": "opening_inferred",
                "synthetic": True,
                "conf": 1.0
            })
    
def _snap_anchors(h_walls, v_walls, cfg):
    snap = cfg["snap"]
    for _ in range(2):
        anchors = [
            (v["x"], h["y"])
            for h in h_walls
            for v in v_walls
            if h["x1"] - snap <= v["x"] <= h["x2"] + snap and v["y1"] - snap <= h["y"] <= v["y2"] + snap
        ]
        for x, y in anchors:
            for seg in h_walls:
                if abs(seg["y"] - y) <= snap:
                    seg["y"] = y
                    if abs(seg["x1"] - x) <= snap:
                        seg["x1"] = x
                    if abs(seg["x2"] - x) <= snap:
                        seg["x2"] = x
            for seg in v_walls:
                if abs(seg["x"] - x) <= snap:
                    seg["x"] = x
                    if abs(seg["y1"] - y) <= snap:
                        seg["y1"] = y
                    if abs(seg["y2"] - y) <= snap:
                        seg["y2"] = y


def _seg_line(seg, axis):
    if axis == "h":
        return LineString([(seg["x1"], seg["y"]), (seg["x2"], seg["y"])])
    return LineString([(seg["x"], seg["y1"]), (seg["x"], seg["y2"])])


def _line_parts(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    return [item for item in getattr(geom, "geoms", []) if isinstance(item, LineString)]


def _clip_to_boundary(h_walls, v_walls, boundary, cfg):
    allowed = boundary.buffer(cfg["bnd_pad"], join_style=2)
    out_h, out_v = [], []
    for seg in h_walls:
        try:
            intersection = _seg_line(seg, "h").intersection(allowed)
        except Exception:
            continue
        for line in _line_parts(intersection):
            coords = list(line.coords)
            x1, x2 = min(coords[0][0], coords[-1][0]), max(coords[0][0], coords[-1][0])
            if x2 - x1 >= MIN_SEG:
                out_h.append({**seg, "x1": float(x1), "x2": float(x2), "y": float(coords[0][1])})
    for seg in v_walls:
        try:
            intersection = _seg_line(seg, "v").intersection(allowed)
        except Exception:
            continue
        for line in _line_parts(intersection):
            coords = list(line.coords)
            y1, y2 = min(coords[0][1], coords[-1][1]), max(coords[0][1], coords[-1][1])
            if y2 - y1 >= MIN_SEG:
                out_v.append({**seg, "x": float(coords[0][0]), "y1": float(y1), "y2": float(y2)})
    return out_h, out_v


def _filter_structural(h_walls, v_walls, boundary, cfg):
    snap = cfg["snap"]
    minx, miny, maxx, maxy = boundary.bounds
    min_keep = max(0.045, snap * 2.2)
    interior_keep = max(0.05, snap * 2.2)

    def on_h(seg):
        
        # ชิดขอบ AND มาจาก YOLO จริงๆ (ไม่ใช่ shell/boundary-derived)
        if seg.get("source") in ("shell", "boundary"):
            return False
        return (
            abs(seg["y"] - miny) <= snap * 1.5
            or abs(seg["y"] - maxy) <= snap * 1.5
        )

    def on_v(seg):
        if seg.get("source") in ("shell", "boundary"):
            return False
        return (
            abs(seg["x"] - minx) <= snap * 1.5
            or abs(seg["x"] - maxx) <= snap * 1.5
        )

    def h_conn(seg):
        y = seg["y"]
        return sum(
            1 for v in v_walls
            if "x" in v and "y1" in v and "y2" in v  # guard
            and seg["x1"] - snap <= v["x"] <= seg["x2"] + snap
            and v["y1"] - snap <= y <= v["y2"] + snap
        )

    def v_conn(seg):
        x = seg["x"]
        return sum(
            1 for h in h_walls
            if "y" in h and "x1" in h and "x2" in h  # guard
            and seg["y1"] - snap <= h["y"] <= seg["y2"] + snap
            and h["x1"] - snap <= x <= h["x2"] + snap
        )

    out_h = []
    for seg in h_walls:
        seg_len = seg["x2"] - seg["x1"]

        # ตัด shell wall ออกก่อนเลย ไม่ต้องผ่าน logic อื่น
        if seg.get("source") == "shell":
            continue

        if seg.get("source") == "yolo" and seg.get("conf", 0) >= 0.40:
            out_h.append(seg)
            continue

        if seg.get("source") == "cv_bridge":
            supported = any(
                abs(w["y"] - seg["y"]) <= snap * 2
                for w in h_walls
                if w.get("source") != "cv_bridge"
            )
            if not supported:
                continue

        keep = (
        seg.get("source") in ("opening_inferred", "room_shell")  # เพิ่ม room_shell
        or on_h(seg)
        or seg_len >= interior_keep
        or (seg_len >= min_keep and h_conn(seg) >= 1)
        )
        if keep:
            out_h.append(seg)

    out_v = []
    for seg in v_walls:
        seg_len = seg["y2"] - seg["y1"]

        if seg.get("source") == "shell":
            continue

        if seg.get("source") == "yolo" and seg.get("conf", 0) >= 0.40:
            out_v.append(seg)
            continue

        if seg.get("source") == "cv_bridge":
            supported = any(
                abs(w["x"] - seg["x"]) <= snap * 2
                for w in v_walls
                if w.get("source") != "cv_bridge"
            )
            if not supported:
                continue

        keep = (
            seg.get("synthetic")
            or seg.get("source") in ("opening_inferred", "room_shell")
            or on_v(seg)  
            or seg_len >= interior_keep
            or (seg_len >= min_keep and v_conn(seg) >= 1)  # ✅ v_conn ไม่ใช่ h_conn
        )
        if keep:
            out_v.append(seg)

    return out_h, out_v


# def _ensure_outer_edges(h_walls, v_walls, boundary, cfg , room_masks=None):
    
#     if room_masks:
#         minx, miny, maxx, maxy = boundary.bounds
#         edge_tol = cfg["snap"] * 4
        
#         rooms_near_top = any(
#             m["polygon"].bounds[1] <= miny + edge_tol 
#             for m in room_masks
#         )
#         rooms_near_bottom = any(
#             m["polygon"].bounds[3] >= maxy - edge_tol 
#             for m in room_masks
#         )
#         # ถ้าไม่มี room ชิดขอบ ไม่ต้องเพิ่มผนัง
#         if not rooms_near_top and not rooms_near_bottom:
#             return h_walls, v_walls
        
#     minx, miny, maxx, maxy = boundary.bounds
#     snap, thickness = cfg["snap"], cfg["thickness"]

#     def h_cover(y):
#         span = maxx - minx
#         if span <= 0:
#             return 1.0
#         return sum(max(0, min(seg["x2"], maxx) - max(seg["x1"], minx)) for seg in h_walls if abs(seg["y"] - y) <= snap) / span

#     def v_cover(x):
#         span = maxy - miny
#         if span <= 0:
#             return 1.0
#         return sum(max(0, min(seg["y2"], maxy) - max(seg["y1"], miny)) for seg in v_walls if abs(seg["x"] - x) <= snap) / span

#     for y in [miny, maxy]:
#         if h_cover(y) < 0.75:
#             h_walls.append({"x1": float(minx), "x2": float(maxx), "y": float(y), "t": thickness, "synthetic": True, "source": "shell"})
#     for x in [minx, maxx]:
#         if v_cover(x) < 0.75:
#             v_walls.append({"x": float(x), "y1": float(miny), "y2": float(maxy), "t": thickness, "synthetic": True, "source": "shell"})
#     return h_walls, v_walls


def _split_at_junctions(h_walls, v_walls):
    snap = MIN_SEG * 0.5
    split_h = []
    for seg in h_walls:
        cuts = [v["x"] for v in v_walls if seg["x1"] < v["x"] < seg["x2"] and v["y1"] - snap <= seg["y"] <= v["y2"] + snap]
        xs = sorted([seg["x1"], *cuts, seg["x2"]])
        for i in range(len(xs) - 1):
            if xs[i + 1] - xs[i] >= MIN_SEG / 2:
                split_h.append({**seg, "x1": xs[i], "x2": xs[i + 1]})
    split_v = []
    for seg in v_walls:
        cuts = [h["y"] for h in split_h if seg["y1"] < h["y"] < seg["y2"] and h["x1"] - snap <= seg["x"] <= h["x2"] + snap]
        ys = sorted([seg["y1"], *cuts, seg["y2"]])
        for i in range(len(ys) - 1):
            if ys[i + 1] - ys[i] >= MIN_SEG / 2:
                split_v.append({**seg, "y1": ys[i], "y2": ys[i + 1]})
    return split_h, split_v


def _build_boundary(room_masks, h_walls, v_walls) -> Polygon:
    """
    Build house boundary mainly from room masks.
    Avoid using page border / drawing frame.
    """

    if room_masks:
        try:
            room_union = unary_union([m["polygon"] for m in room_masks])

            # Expand slightly to include walls around rooms
            shell = room_union.buffer(0.025, join_style=2)

            # Smooth small artifacts
            shell = shell.simplify(0.004, preserve_topology=True)

            shell = _largest_poly(shell)

            if shell and shell.area > 0.001:
                return shell

        except Exception:
            pass

    # fallback only
    return Polygon([
        (0.02, 0.02),
        (0.98, 0.02),
        (0.98, 0.98),
        (0.02, 0.98),
    ])


def _polygonize_cells(h_walls, v_walls, boundary, room_masks=None) -> list:

    lines = [_seg_line(seg, "h") for seg in h_walls if seg["x2"] - seg["x1"] > 1e-5]

    lines += [_seg_line(seg, "v") for seg in v_walls if seg["y2"] - seg["y1"] > 1e-5]

    boundary_line = boundary.boundary

    lines += list(boundary_line.geoms) if hasattr(boundary_line, "geoms") else [boundary_line]

    try:
        raw = list(polygonize(unary_union(lines)))
    except Exception:
        return []

    room_union = None

    if room_masks:
        try:
            room_union = unary_union([m["polygon"] for m in room_masks])
        except Exception:
            room_union = None

    min_area = max(boundary.area * 0.018, 0.0008)

    cells = []

    occupied = GeometryCollection()

    for cell in sorted(raw, key=lambda item: -item.area):

        clipped = _largest_poly(cell.intersection(boundary))

        if not clipped:
            continue

        if clipped.area < min_area:
            continue

        # IMPORTANT FILTER
        if room_union is not None:

            overlap = clipped.intersection(room_union).area

            ratio = overlap / max(clipped.area, 1e-6)

            min_overlap = 0.12

            if ratio < min_overlap:
                continue

        if not occupied.is_empty:

            clipped = _largest_poly(
                clipped.difference(occupied.buffer(1e-5))
            )

            if not clipped:
                continue

            if clipped.area < min_area:
                continue

        clipped = _largest_poly(
            clipped.buffer(0.002)
            .buffer(-0.002)
        )

        if not clipped:
            continue

        cells.append(clipped)

        occupied = unary_union([occupied, clipped]) \
            if not occupied.is_empty else clipped

    return cells

def _cleanup_cells(
    cells,
    boundary,
    cfg,
):

    min_area = max(
        boundary.area * 0.015,
        0.0006,
    )

    cleaned = []

    for cell in cells:

        if cell is None:
            continue

        if cell.is_empty:
            continue

        if not cell.is_valid:
            try:
                cell = cell.buffer(0)
            except Exception:
                continue

        if cell.area < min_area:
            continue

        try:
            cell = _largest_poly(cell)
        except Exception:
            continue

        if cell is None:
            continue

        if cell.area < min_area:
            continue

        compactness = (
            4 * np.pi * cell.area
        ) / max(
            cell.length * cell.length,
            1e-6,
        )

        if compactness < 0.015:
            continue

        cleaned.append(cell)

    final_cells = []

    for cell in sorted(
        cleaned,
        key=lambda c: -c.area
    ):

        duplicated = False

        for prev in final_cells:

            overlap = (
                cell.intersection(prev).area
                / max(cell.area, 1e-6)
            )

            if overlap > 0.90:
                duplicated = True
                break

        if not duplicated:
            final_cells.append(cell)

    return final_cells

def _filter_room_area_outliers(
    rooms,
    boundary,
):

    if not rooms:
        return rooms

    boundary_area = max(
        boundary.area,
        1e-6,
    )

    filtered = []

    for room in rooms:

        try:

            poly = Polygon([
                (p["x"], p["y"])
                for p in room["polygon"]
            ])

        except Exception:
            continue

        ratio = poly.area / boundary_area

        if ratio < 0.01:
            continue

        if ratio > 0.92:
            continue

        filtered.append(room)

    return filtered

def _merge_fragmented_cells(cells, cfg):
    """
    รวม cell ที่แตะกันหรือห่างกันน้อยมาก
    แก้ปัญหาห้องแตกเป็นชิ้น
    """

    if len(cells) <= 1:
        return cells

    merged = []
    used = set()

    merge_gap = cfg["snap"] * 2.5

    for i, cell in enumerate(cells):

        if i in used:
            continue

        current = cell

        changed = True

        while changed:
            changed = False

            for j, other in enumerate(cells):

                if j == i or j in used:
                    continue

                try:
                    should_merge = (
                        current.touches(other)
                        or current.distance(other) <= merge_gap
                    )

                    if should_merge:
                        current = unary_union([current, other]).buffer(0)
                        used.add(j)
                        changed = True

                except Exception:
                    pass

        merged.append(current)

    return merged

def _cells_valid(cells, room_masks, boundary) -> bool:
    if not cells:
        return False
    if not room_masks:
        return len(cells) > 0

    count = len(room_masks)
    min_area = max(boundary.area * 0.018, 0.0008)
    large_cells = [c for c in cells if c.area >= min_area]

    if len(large_cells) < max(1, int(count * 0.45)):
        return False
    if len(large_cells) > max(count * 3 + 4, 14):
        return False

    # --- guard ใหม่: cell ใหญ่สุดต้องไม่เกิน 60% ของ boundary ---
    # ถ้าใหญ่กว่านี้ = ผนังรั่ว ห้องทะลุกัน
    max_cell_area = max(c.area for c in large_cells)
    if max_cell_area > boundary.area * 0.60:
        print(f"❌ FAIL: largest cell too big ({max_cell_area:.4f} > {boundary.area * 0.60:.4f})")
        return False

    cell_area = sum(c.area for c in large_cells)
    mask_area = unary_union([m["polygon"] for m in room_masks]).intersection(boundary).area
    if mask_area <= 0:
        return False

    ratio = cell_area / mask_area
    if not (0.45 <= ratio <= 1.55):
        print(f"❌ FAIL: area mismatch ratio={ratio:.2f}")
        return False

    hits = sum(
        1 for mask in room_masks
        if any(
            c.contains(Point(mask["centroid"])) or c.distance(Point(mask["centroid"])) <= 0.025
            for c in large_cells
        )
    )
    ok = hits >= max(1, int(count * 0.60))
    if not ok:
        print(f"❌ FAIL: mask hits {hits}/{count}")
    return ok


def _name_room_heuristic(
    cell: Polygon,
    boundary: Polygon,
    doors: list,
    used_names: dict,
    all_cells_sorted: list,
) -> str:

    area_ratio = cell.area / max(boundary.area, 1e-6)

    bx, by, bx2, by2 = boundary.bounds
    cx, cy, cx2, cy2 = cell.bounds

    edge_tol = max(
        (bx2 - bx) * 0.08,
        (by2 - by) * 0.08,
    )

    near_edge = (
        cx <= bx + edge_tol
        or cx2 >= bx2 - edge_tol
        or cy <= by + edge_tol
        or cy2 >= by2 - edge_tol
    )

    has_door = False

    for door in doors or []:

        if not isinstance(door, dict):
            continue

        if "bbox" in door and isinstance(door["bbox"], dict):

            bbox = door["bbox"]

            dx = bbox.get("x", 0) + bbox.get("w", 0) / 2
            dy = bbox.get("y", 0) + bbox.get("h", 0) / 2

        else:

            dx = door.get("x", 0) + door.get("w", 0) / 2
            dy = door.get("y", 0) + door.get("h", 0) / 2

        try:
            if cell.distance(Point(dx, dy)) <= 0.04:
                has_door = True
                break
        except Exception:
            continue

    rank = next(
        (
            i
            for i, c in enumerate(all_cells_sorted)
            if c.equals(cell)
        ),
        999,
    )

    if rank == 0 and area_ratio >= 0.15:
        name = "Living Room"

    elif area_ratio >= 0.20:
        name = "Living Room"

    elif area_ratio <= 0.055 and near_edge and has_door:
        name = "Bathroom"

    elif area_ratio <= 0.05 and near_edge:
        name = "Storage"

    elif 0.05 <= area_ratio <= 0.12 and has_door and not near_edge:
        name = "Kitchen"

    elif has_door:
        name = "Bedroom"

    else:
        name = "Room"

    used_names[name] = used_names.get(name, 0) + 1

    count = used_names[name]

    if count > 1:
        return f"{name} {count}"

    return name

def _assign_rooms(
    cells,
    room_masks,
    boundary,
    cfg,
    doors=None,
) -> list:

    doors = doors or []

    used = set()
    rooms = []
    counters = defaultdict(int)

    used_heuristic_names = {}

    snap = cfg["snap"]

    min_area = max(boundary.area * 0.018, 0.0008)

    viable = [
        (i, c)
        for i, c in enumerate(cells)
        if c is not None
        and not c.is_empty
        and c.area >= min_area
    ]

    cells_sorted_by_size = [
        c
        for _, c in sorted(
            viable,
            key=lambda x: -x[1].area
        )
    ]

    # ---------------------------------------------------
    # Assign from masks
    # ---------------------------------------------------

    for mask in room_masks:

        point = Point(mask["centroid"])

        choices = [
            (i, cell)
            for i, cell in viable
            if i not in used
            and (
                cell.contains(point)
                or cell.distance(point) <= snap
            )
        ]

        if not choices:

            choices = [
                (i, cell)
                for i, cell in viable
                if i not in used
            ]

        if not choices:
            continue

        index, cell = min(
            choices,
            key=lambda item: (
                item[1].centroid.distance(point)
            )
        )

        used.add(index)

        raw_label = (
            mask.get("label", "")
            .strip()
        )

        # generic label → heuristic naming
        if raw_label.lower() in (
            "",
            "room",
            "space",
            "area",
        ):

            label = _name_room_heuristic(
                cell,
                boundary,
                doors,
                used_heuristic_names,
                cells_sorted_by_size,
            )

        else:

            counters[raw_label] += 1

            if counters[raw_label] == 1:
                label = raw_label
            else:
                label = f"{raw_label} {counters[raw_label]}"

        room = _make_room(
            label,
            counters.get(label, 1),
            cell,
        )

        if room:
            rooms.append(room)

    # ---------------------------------------------------
    # Unassigned large cells
    # ---------------------------------------------------

    unnamed_min = max(
        boundary.area * 0.06,
        0.003,
    )

    for i, cell in viable:

        if i in used:
            continue

        if cell.area < unnamed_min:
            continue

        label = _name_room_heuristic(
            cell,
            boundary,
            doors,
            used_heuristic_names,
            cells_sorted_by_size,
        )

        room = _make_room(
            label,
            1,
            cell,
        )

        if room:
            rooms.append(room)

    # ---------------------------------------------------
    # Geometry overlap dedup
    # ---------------------------------------------------

    filtered = []
    seen_polys = []

    for room in rooms:

        try:

            poly = Polygon([
                (p["x"], p["y"])
                for p in room["polygon"]
            ])

        except Exception:
            filtered.append(room)
            continue

        duplicated = False

        for prev in seen_polys:

            try:

                overlap = (
                    poly.intersection(prev).area
                    / max(poly.area, 1e-6)
                )

                if overlap > 0.85:
                    duplicated = True
                    break

            except Exception:
                pass

        if duplicated:
            continue

        seen_polys.append(poly)
        filtered.append(room)

    return _deoverlap(filtered, boundary)


def _rooms_from_masks(
    room_masks,
    boundary,
    h_walls=None,
    v_walls=None,
    cfg=None,
):

    rooms = []
    counters = defaultdict(int)

    clipped = []

    for mask in sorted(
        room_masks,
        key=lambda m: -m["polygon"].area,
    ):

        poly = mask["polygon"]

        gap_fill = 0.005

        poly = poly.buffer(
            gap_fill,
            join_style=2,
        )

        poly = poly.buffer(
            -gap_fill * 0.7,
            join_style=2,
        )

        poly = poly.buffer(0)

        poly = poly.simplify(
            0.0012,
            preserve_topology=True,
        )

        poly = _largest_poly(
            poly.intersection(boundary)
        )

        if poly is None:
            continue

        if poly.area < MIN_ROOM_AREA:
            continue

        clipped.append((mask, poly))

    if not clipped:
        return []

    occupied = GeometryCollection()

    for mask, poly in clipped:

        if not occupied.is_empty:

            try:

                diff = _largest_poly(
                    poly.difference(
                        occupied.buffer(0.0005)
                    )
                )

            except Exception:

                diff = None

            if diff is None:
                continue

            if diff.area < poly.area * 0.20:
                continue

            poly = diff

        label = mask["label"]

        counters[label] += 1

        room = _make_room(
            label,
            counters[label],
            poly,
        )

        if room:

            rooms.append(room)

            occupied = (
                unary_union([occupied, poly])
                if not occupied.is_empty
                else poly
            )

    return rooms


def _make_room(label, index, poly) -> Optional[dict]:
    pts = _poly_pts(poly)
    if not pts:
        return None
    center = poly.centroid
    slug = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_") or "room"
    return {
        "id": f"room_{slug}_{index}",
        "name": label,
        "label": label,
        "polygon": pts,
        "wallPolygon": pts,
        "center": {"x": float(center.x), "y": float(center.y)},
        "bbox": _bbox(poly),
        "areaNorm": float(poly.area),
    }


def _deoverlap(rooms, boundary) -> list:
    cleaned, occupied = [], GeometryCollection()
    for room in sorted(rooms, key=lambda item: -item.get("areaNorm", 0)):
        outer_pts = room.get("wallPolygon") or room.get("polygon") or []
        outer_poly = _largest_poly(
            Polygon([(p["x"], p["y"]) for p in outer_pts]).intersection(boundary)
        )
        if not outer_poly:
            continue
        if not occupied.is_empty:
            outer_poly = _largest_poly(outer_poly.difference(occupied.buffer(1e-6)))
            if not outer_poly:
                continue
        outer_new_pts = _poly_pts(outer_poly)
        if not outer_new_pts:
            continue

        # ปิด inner buffer ไว้ก่อน — ใช้ outer polygon ตรงๆ
        center = outer_poly.centroid
        room.update({
            "polygon": outer_new_pts,
            "wallPolygon": outer_new_pts,
            "center": {"x": float(center.x), "y": float(center.y)},
            "bbox": _bbox(outer_poly),
            "areaNorm": float(outer_poly.area),
        })
        cleaned.append(room)
        occupied = unary_union([occupied, outer_poly]) if not occupied.is_empty else outer_poly
    return cleaned


def _wall_output(h_walls, v_walls, boundary) -> list:

    walls = []

    index = 1

    for seg in h_walls:

        if seg["x2"] - seg["x1"] <= 1e-5:
            continue

        walls.append({
            "id": f"w{index}",
            "type": "wall",
            "x1": float(seg["x1"]),
            "y1": float(seg["y"]),
            "x2": float(seg["x2"]),
            "y2": float(seg["y"]),
            "thicknessRatio": float(seg.get("t", 0.012))
        })

        index += 1

    for seg in v_walls:

        if seg["y2"] - seg["y1"] <= 1e-5:
            continue

        walls.append({
            "id": f"w{index}",
            "type": "wall",
            "x1": float(seg["x"]),
            "y1": float(seg["y1"]),
            "x2": float(seg["x"]),
            "y2": float(seg["y2"]),
            "thicknessRatio": float(seg.get("t", 0.012))
        })

        index += 1

    return walls


def _clean_poly(geom) -> Optional[Polygon]:
    if geom is None or geom.is_empty:
        return None
    try:
        fixed = geom.buffer(0)
    except Exception:
        return None
    return fixed if not fixed.is_empty else None


def _largest_poly(geom) -> Optional[Polygon]:
    geom = _clean_poly(geom)
    if geom is None:
        return None
    if isinstance(geom, Polygon):
        return geom
    if isinstance(geom, MultiPolygon):
        return max(geom.geoms, key=lambda item: item.area)
    if isinstance(geom, GeometryCollection):
        polygons = [item for item in geom.geoms if isinstance(item, Polygon)]
        return max(polygons, key=lambda item: item.area) if polygons else None
    return None


def _poly_pts(poly) -> Optional[list]:
    poly = _largest_poly(poly)
    if poly is None:
        return None
    coords = list(poly.exterior.coords)[:-1]
    return [{"x": float(x), "y": float(y)} for x, y in coords] if len(coords) >= 3 else None


def _bbox(poly) -> dict:
    minx, miny, maxx, maxy = poly.bounds
    return {"x": float(minx), "y": float(miny), "w": float(maxx - minx), "h": float(maxy - miny)}


def _estimate_widths(geometry: dict) -> None:
    """ประมาณ widthM ของ door/window โดยใช้ค่า median wall thickness เป็น reference
    สมมติ interior wall ≈ 0.12 m เป็น reference scale"""
    walls = geometry.get("walls", [])
    if not walls:
        return
    thicknesses = [w["thicknessRatio"] for w in walls if w.get("thicknessRatio", 0) > 0]
    if not thicknesses:
        return
    wall_t = float(np.median(thicknesses))
    if wall_t <= 0:
        return
    m_per_unit = 0.12 / wall_t
    for item in geometry.get("doors", []) + geometry.get("windows", []):
        bbox = item.get("bbox", {})
        width_norm = max(bbox.get("w", 0), bbox.get("h", 0))
        if width_norm > 0:
            item["widthM"] = round(width_norm * m_per_unit, 2)


def draw_preview(image: np.ndarray, geometry: dict) -> np.ndarray:
    white = np.full_like(image, 255)
    out = cv2.addWeighted(image, 0.22, white, 0.78, 0)
    h, w = out.shape[:2]

    def px(nx, ny):
        return int(nx * w), int(ny * h)

    overlay = out.copy()
    for room in geometry.get("rooms", []):
        # Use outer boundary (wallPolygon) for visual fills; fall back to inner polygon.
        pts = room.get("wallPolygon") or room.get("polygon", [])
        if len(pts) < 3:
            continue
        arr = np.array([[px(point["x"], point["y"])] for point in pts], dtype=np.int32)
        cv2.fillPoly(overlay, [arr], _room_color(room.get("label", "Room")))
    cv2.addWeighted(overlay, 0.25, out, 0.75, 0, out)

    for room in geometry.get("rooms", []):
        pts = room.get("wallPolygon") or room.get("polygon", [])
        if len(pts) < 3:
            continue
        arr = np.array([[px(point["x"], point["y"])] for point in pts], dtype=np.int32)
        cx, cy = px(room["center"]["x"], room["center"]["y"])
        _put_label(out, room.get("label", ""), cx, cy)

    for wall in geometry.get("walls", []):
        x1, y1 = px(wall["x1"], wall["y1"])
        x2, y2 = px(wall["x2"], wall["y2"])
        color = WALL_CLR
        thick = max(1, int(wall.get("thicknessRatio", 0.012) * min(w, h) * 0.8))
        cv2.line(out, (x1, y1), (x2, y2), color, thick)

    for door in geometry.get("doors", []):
        _draw_box(out, door["bbox"], w, h, DOOR_CLR, "door")
    for window in geometry.get("windows", []):
        _draw_box(out, window["bbox"], w, h, WIN_CLR, "window")
    _draw_legend(out)
    return out


def _room_color(label: str):
    hue = int(hashlib.md5(label.encode()).hexdigest(), 16) % 360
    r, g, b = colorsys.hsv_to_rgb(hue / 360, 0.35, 0.92)
    return int(b * 255), int(g * 255), int(r * 255)


def _put_label(img, text, cx, cy, scale=0.45):
    if not text:
        return
    font = cv2.FONT_HERSHEY_SIMPLEX
    (tw, th), _ = cv2.getTextSize(text, font, scale, 1)
    x, y = max(2, cx - tw // 2), max(th + 2, cy + th // 2)
    cv2.rectangle(img, (x - 2, y - th - 2), (x + tw + 2, y + 2), (255, 255, 255), -1)
    cv2.putText(img, text, (x, y), font, scale, (30, 30, 30), 1, cv2.LINE_AA)


def _draw_box(img, bbox, w, h, color, label=""):
    x = int(bbox["x"] * w)
    y = int(bbox["y"] * h)
    x2 = int((bbox["x"] + bbox["w"]) * w)
    y2 = int((bbox["y"] + bbox["h"]) * h)
    cv2.rectangle(img, (x, y), (x2, y2), color, 2)
    if label:
        cv2.putText(img, label, (x + 2, max(y - 3, 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.38, color, 1, cv2.LINE_AA)


def _draw_legend(img):
    for i, (color, text) in enumerate([
        (WALL_CLR, "wall"),
        (DOOR_CLR, "door"),
        (WIN_CLR, "window"),
    ]):
        y = 10 + i * 18
        cv2.rectangle(img, (10, y), (22, y + 12), color, -1)
        cv2.putText(img, text, (26, y + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (30, 30, 30), 1, cv2.LINE_AA)