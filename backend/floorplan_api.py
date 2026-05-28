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
import fitz
import numpy as np
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from shapely import boundary
from shapely.geometry import GeometryCollection, LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union
from ultralytics import YOLO
from fastapi import Form


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
MIN_ROOM_AREA = 0.003  

WALL_CLR = (80, 160, 60)
DOOR_CLR = (0, 140, 255)
WIN_CLR = (220, 200, 0)


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
async def analyze(
    file:               UploadFile = File(...),
    debug:              bool       = Query(False),
    scale_px:           float      = Form(0),
    scale_m:            float      = Form(0),
    img_display_w:      float      = Form(0),
    img_display_h:      float      = Form(0),
    wall_height_meter:  float      = Form(2.8),
):
    try:
        raw = await file.read()
        return run_pipeline(
            raw, file.filename or "", debug=debug,
            scale_px=scale_px, scale_m=scale_m,
            img_display_w=img_display_w, img_display_h=img_display_h,
            wall_height_meter=wall_height_meter,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def run_pipeline(
    file_bytes: bytes,
    filename: str = "",
    debug: bool = False,
    scale_px: float = 0,
    scale_m: float = 0,
    img_display_w: float = 0,
    img_display_h: float = 0,
    wall_height_meter: float = 2.8,
) -> dict:
    image = decode_image(file_bytes, filename)
    prep = preprocess(image)
    clean_image = prep["image"]
    H, W    = clean_image.shape[:2]
    ppm = _resolve_ppm(scale_px, scale_m, img_display_w, W)
    
    yolo_result = get_model()(clean_image, imgsz=IMG_SIZE)[0]
    debug_images = {}
    if debug:
        debug_images["01_preprocessed"] = encode_preview(clean_image)
    geometry = build_geometry(
        clean_image, yolo_result, ppm=ppm,
        debug_images=debug_images if debug else None,
        wall_height_meter=wall_height_meter,
    )
    all_rooms = geometry["rooms"]
    geometry["rooms"] = [r for r in all_rooms if r.get("areaNorm", 0) >= MIN_ROOM_AREA]
    # แนบ wallHeight ทุกห้องให้ frontend ดึงไป Extrude ผนัง 3D ได้ทันที
    for room in geometry["rooms"]:
        room.setdefault("wallHeight", wall_height_meter)
    for wall in geometry["walls"]:
        wall.setdefault("wallHeight", wall_height_meter)
    dropped = [r for r in all_rooms if r.get("areaNorm", 0) < MIN_ROOM_AREA]
    if dropped:
        print(f"[post-filter] dropped {len(dropped)} room(s) with areaNorm < {MIN_ROOM_AREA}: "
              + ", ".join(f"{r['name']}={r.get('areaNorm',0):.5f}" for r in dropped))
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

def _resolve_ppm(
    scale_px: float,
    scale_m: float,
    img_display_w: float,
    preprocess_w: int,        # ความกว้างภาพหลัง preprocess (pixel จริง)
) -> float | None:
    if scale_px <= 0 or scale_m <= 0:
        return None

    screen_ppm = scale_px / scale_m

    if img_display_w > 0 and preprocess_w > 0:
        display_ratio = preprocess_w / img_display_w
        return screen_ppm * display_ratio

    return screen_ppm

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

# def _build_outer_walls_from_rooms(room_masks, h_walls, v_walls, cfg):
#     if not room_masks:
#         return h_walls, v_walls

#     snap = cfg["snap"]

#     try:
#         room_union = unary_union([m["polygon"] for m in room_masks])
#         outer = room_union.buffer(0.01).simplify(0.008, preserve_topology=True)
#         outer = _largest_poly(outer)
#         if outer is None:
#             return h_walls, v_walls
#     except Exception:
#         return h_walls, v_walls

#     coords = list(outer.exterior.coords)
#     new_h, new_v = [], []

#     for i in range(len(coords) - 1):
#         x1, y1 = coords[i]
#         x2, y2 = coords[i + 1]
#         dx = abs(x2 - x1)
#         dy = abs(y2 - y1)

#         if dx < 1e-4 and dy < 1e-4:
#             continue

#         if dx >= dy and dy <= 0.03:  # ✅ ขยาย threshold รับ edge ที่เอียงเล็กน้อย
#             ex1, ex2 = min(x1, x2), max(x1, x2)
#             ey = (y1 + y2) / 2

#             # ✅ covered = มี YOLO wall ที่ overlap บางส่วน ไม่ต้องครอบทั้งหมด
#             covered = any(
#                 abs(w.get("y", 999) - ey) <= snap * 2
#                 and w.get("x2", -999) >= ex1 - snap   # overlap ซ้าย
#                 and w.get("x1", 999) <= ex2 + snap    # overlap ขวา
#                 for w in h_walls
#                 if w.get("source") == "yolo"
#             )

#             if not covered:
#                 new_h.append({
#                     "x1": float(ex1), "x2": float(ex2),
#                     "y": float(ey),
#                     "t": cfg["thickness"],
#                     "source": "room_shell",
#                     "synthetic": True,
#                 })
#             else:
#                 # ✅ มี YOLO wall แล้วแต่อาจขาดช่วง — bridge ส่วนที่ขาด
#                 yolo_on_axis = sorted(
#                     [w for w in h_walls
#                      if w.get("source") == "yolo"
#                      and abs(w.get("y", 999) - ey) <= snap * 2
#                      and w.get("x2", -999) >= ex1 - snap
#                      and w.get("x1", 999) <= ex2 + snap],
#                     key=lambda w: w.get("x1", 0)
#                 )
#                 # เติม gap ระหว่าง YOLO walls บน axis เดียวกัน
#                 prev_x2 = ex1
#                 for w in yolo_on_axis:
#                     wx1 = w.get("x1", ex2)
#                     if wx1 - prev_x2 > snap:
#                         new_h.append({
#                             "x1": float(prev_x2), "x2": float(wx1),
#                             "y": float(ey),
#                             "t": cfg["thickness"],
#                             "source": "room_shell",
#                             "synthetic": True,
#                         })
#                     prev_x2 = max(prev_x2, w.get("x2", prev_x2))
#                 # เติม gap หลัง YOLO wall สุดท้าย
#                 if ex2 - prev_x2 > snap:
#                     new_h.append({
#                         "x1": float(prev_x2), "x2": float(ex2),
#                         "y": float(ey),
#                         "t": cfg["thickness"],
#                         "source": "room_shell",
#                         "synthetic": True,
#                     })

#         elif dy > dx and dx <= 0.03:  # ✅ ขยาย threshold เช่นกัน
#             ey1, ey2 = min(y1, y2), max(y1, y2)
#             ex = (x1 + x2) / 2

#             covered = any(
#                 abs(w.get("x", 999) - ex) <= snap * 2
#                 and w.get("y2", -999) >= ey1 - snap
#                 and w.get("y1", 999) <= ey2 + snap
#                 for w in v_walls
#                 if w.get("source") == "yolo"
#             )

#             if not covered:
#                 new_v.append({
#                     "x": float(ex),
#                     "y1": float(ey1), "y2": float(ey2),
#                     "t": cfg["thickness"],
#                     "source": "room_shell",
#                     "synthetic": True,
#                 })
#             else:
#                 # bridge ส่วนที่ขาดใน vertical axis
#                 yolo_on_axis = sorted(
#                     [w for w in v_walls
#                      if w.get("source") == "yolo"
#                      and abs(w.get("x", 999) - ex) <= snap * 2
#                      and w.get("y2", -999) >= ey1 - snap
#                      and w.get("y1", 999) <= ey2 + snap],
#                     key=lambda w: w.get("y1", 0)
#                 )
#                 prev_y2 = ey1
#                 for w in yolo_on_axis:
#                     wy1 = w.get("y1", ey2)
#                     if wy1 - prev_y2 > snap:
#                         new_v.append({
#                             "x": float(ex),
#                             "y1": float(prev_y2), "y2": float(wy1),
#                             "t": cfg["thickness"],
#                             "source": "room_shell",
#                             "synthetic": True,
#                         })
#                     prev_y2 = max(prev_y2, w.get("y2", prev_y2))
#                 if ey2 - prev_y2 > snap:
#                     new_v.append({
#                         "x": float(ex),
#                         "y1": float(prev_y2), "y2": float(ey2),
#                         "t": cfg["thickness"],
#                         "source": "room_shell",
#                         "synthetic": True,
#                     })

#     return h_walls + new_h, v_walls + new_v

def _classify_structural_walls(
    h_walls: list,
    v_walls: list,
    cfg: dict,
) -> None:
    """
    ติด flag  is_structural=True  บนผนังที่เป็น "ผนังโครงบ้าน"
    นิยาม: ผนังที่อยู่ชิดขอบนอกสุดของพื้นที่บ้าน ในแต่ละทิศ
 
    วิธีหา:
    - รวบรวมพิกัดทุกจุดปลายของผนังทั้งหมด
    - หาขอบนอกสุด (min/max) ของแต่ละทิศ
    - ผนังที่อยู่ภายในระยะ structural_tol จากขอบนั้น = โครงบ้าน
 
    ทำไมไม่ใช้ boundary polygon แทน?
    เพราะ boundary ถูกสร้างจาก room mask ซึ่งอาจคลาดเคลื่อน
    การวัดจากพิกัดผนังจริงในภาพตรงกว่า
    """
    snap = cfg["snap"]
    # ยอมให้คลาดเคลื่อนได้ 3x snap รอบขอบนอก
    structural_tol = snap * 3.0
 
    # หาขอบนอกสุดจากพิกัดผนังทั้งหมด
    all_x, all_y = [], []
    for seg in h_walls:
        all_x += [seg["x1"], seg["x2"]]
        all_y += [seg["y"]]
    for seg in v_walls:
        all_x += [seg["x"]]
        all_y += [seg["y1"], seg["y2"]]
 
    if not all_x:
        return
 
    min_x = min(all_x)
    max_x = max(all_x)
    min_y = min(all_y)
    max_y = max(all_y)
 
    # แต่ละผนัง: ถ้าอยู่ใกล้ขอบใดขอบหนึ่ง → โครงบ้าน
    for seg in h_walls:
        near_top    = abs(seg["y"] - min_y) <= structural_tol
        near_bottom = abs(seg["y"] - max_y) <= structural_tol
        # ผนังนอนที่ยาว + อยู่ชิดขอบบน/ล่าง
        is_long = (seg["x2"] - seg["x1"]) >= (max_x - min_x) * 0.25
        seg["is_structural"] = bool((near_top or near_bottom) and is_long)
 
    for seg in v_walls:
        near_left  = abs(seg["x"] - min_x) <= structural_tol
        near_right = abs(seg["x"] - max_x) <= structural_tol
        # ผนังตั้งที่ยาว + อยู่ชิดขอบซ้าย/ขวา
        is_long = (seg["y2"] - seg["y1"]) >= (max_y - min_y) * 0.25
        seg["is_structural"] = bool((near_left or near_right) and is_long)


def _seal_wall_gaps(
    h_walls: list,
    v_walls: list,
    cfg: dict,
    image=None,
) -> tuple:
    """
    เชื่อมช่องว่างขนาดใหญ่ระหว่างผนังโครงบ้าน (Structural Walls) โดยใช้ภาพจริงเป็นหลัก
    ทำงานก่อน _close_all_gaps เพื่อปิดช่องใหญ่ที่ _close_all_gaps ยังเอื้อมไม่ถึง

    กฎหลัก:
    - ผนัง structural (outer): รับ gap ได้สูงสุด 0.22 (≈ 22% ของภาพ) — ปิดช่องโครงบ้านได้แม้กว้างมาก
    - ผนังทั่วไป (internal): รับ gap ได้สูงสุด 0.020 เท่านั้น — ป้องกันดูดเส้นบันได/เฟอร์นิเจอร์
    - ตรวจ pixel 15 จุดตลอดช่องว่าง — ต้องมีหมึกมืด ≥ 30% (structural) / 55% (ทั่วไป)
    - ไม่ตรวจ room mask เลย — pixel ในภาพเป็นหลักฐานเดียว
    """
    MAX_SEAL_STRUCTURAL = cfg.get("seal_gap", 0.22)   # ขยายเพื่อรองรับช่องโครงบ้านกว้าง
    MAX_SEAL_NORMAL     = 0.020                        # ผนังภายใน: เชื่อมได้ไม่เกิน 2%
    N_SAMPLES = 15
    DARK_THRESH = 100
    MIN_RATIO_STRUCTURAL = 0.30   # ผ่อนปรนสำหรับ gap กว้างของโครงบ้าน
    MIN_RATIO_NORMAL     = 0.55

    gray = None
    if image is not None:
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        except Exception:
            gray = None

    def _dark_ratio(x1n, y1n, x2n, y2n) -> float:
        if gray is None:
            return 1.0
        h_img, w_img = gray.shape[:2]
        dark = 0
        for i in range(N_SAMPLES):
            t = i / max(N_SAMPLES - 1, 1)
            px = int(np.clip((x1n + (x2n - x1n) * t) * w_img, 0, w_img - 1))
            py = int(np.clip((y1n + (y2n - y1n) * t) * h_img, 0, h_img - 1))
            if gray[py, px] <= DARK_THRESH:
                dark += 1
        return dark / N_SAMPLES

    new_h, seen_h = [], set()

    for i, a in enumerate(h_walls):
        for j, b in enumerate(h_walls):
            if i >= j:
                continue
            y_delta = abs(a["y"] - b["y"])
            if y_delta > min(a.get("t", 0.012), b.get("t", 0.012)) * 1.5:
                continue
            if a["x2"] <= b["x1"]:
                left, right = a, b
            elif b["x2"] <= a["x1"]:
                left, right = b, a
            else:
                continue
            gap = right["x1"] - left["x2"]
            if gap <= 0:
                continue
            is_struct = left.get("is_structural") or right.get("is_structural")
            max_gap = MAX_SEAL_STRUCTURAL if is_struct else MAX_SEAL_NORMAL
            min_ratio = MIN_RATIO_STRUCTURAL if is_struct else MIN_RATIO_NORMAL
            if gap > max_gap:
                continue
            mid_y = (left["y"] + right["y"]) / 2
            if _dark_ratio(left["x2"], mid_y, right["x1"], mid_y) < min_ratio:
                continue
            key = (round(left["x2"], 4), round(right["x1"], 4), round(mid_y, 4))
            if key in seen_h:
                continue
            seen_h.add(key)
            new_h.append({
                "x1": float(left["x2"]),
                "x2": float(right["x1"]),
                "y":  float(mid_y),
                "t":  max(left.get("t", 0.012), right.get("t", 0.012)),
                "source": "gap_bridge",
                "synthetic": True,
                "is_structural": bool(is_struct),
            })

    new_v, seen_v = [], set()

    for i, a in enumerate(v_walls):
        for j, b in enumerate(v_walls):
            if i >= j:
                continue
            x_delta = abs(a["x"] - b["x"])
            if x_delta > min(a.get("t", 0.012), b.get("t", 0.012)) * 1.5:
                continue
            if a["y2"] <= b["y1"]:
                top, bot = a, b
            elif b["y2"] <= a["y1"]:
                top, bot = b, a
            else:
                continue
            gap = bot["y1"] - top["y2"]
            if gap <= 0:
                continue
            is_struct = top.get("is_structural") or bot.get("is_structural")
            max_gap = MAX_SEAL_STRUCTURAL if is_struct else MAX_SEAL_NORMAL
            min_ratio = MIN_RATIO_STRUCTURAL if is_struct else MIN_RATIO_NORMAL
            if gap > max_gap:
                continue
            mid_x = (top["x"] + bot["x"]) / 2
            if _dark_ratio(mid_x, top["y2"], mid_x, bot["y1"]) < min_ratio:
                continue
            key = (round(mid_x, 4), round(top["y2"], 4), round(bot["y1"], 4))
            if key in seen_v:
                continue
            seen_v.add(key)
            new_v.append({
                "x":  float(mid_x),
                "y1": float(top["y2"]),
                "y2": float(bot["y1"]),
                "t":  max(top.get("t", 0.012), bot.get("t", 0.012)),
                "source": "gap_bridge",
                "synthetic": True,
                "is_structural": bool(is_struct),
            })

    if new_h or new_v:
        print(f"[seal_gaps] Sealed {len(new_h)} H + {len(new_v)} V large-gap bridges")
        return _snap_merge(h_walls + new_h, v_walls + new_v, cfg)

    return h_walls, v_walls


def _close_all_gaps(
    h_walls: list,
    v_walls: list,
    cfg: dict,
    room_masks=None,
    doors=None,
    windows=None,
    image=None,
) -> tuple:
    """
    เชื่อมช่องว่างระหว่างผนังที่ควรต่อกัน
 
    ความแตกต่างจากเดิม
    ──────────────────
    ผนังโครงบ้าน (is_structural=True):
      • max_bridge ใหญ่กว่า 3x  →  เชื่อมได้แม้ช่องว่างกว้าง
      • ไม่บังคับ _inside_room  →  เพราะโครงบ้านอยู่ขอบนอก room mask พอดี
      • ยังตรวจ _crosses_opening และ _has_dark_connection อยู่
 
    ผนังทั่วไป (is_structural=False):
      • logic เดิมทุกอย่าง ไม่มีอะไรเปลี่ยน
    """
    snap = cfg["snap"]
    # ผนังภายใน: เชื่อมได้น้อย (≤ 2%) — ป้องกันดูดเส้นบันได/เฟอร์นิเจอร์
    # ผนังโครงบ้าน: เชื่อมได้ไกลถึง 20% ของภาพ — บังคับปิดช่องโครงสร้างหลัก
    max_bridge_normal     = min(cfg.get("connect_gap", 0.022), 0.020)
    max_bridge_structural = 0.20
 
    # ─── สร้าง room union สำหรับตรวจผนังทั่วไป ───────────────────────────
    room_union = None
    if room_masks:
        try:
            polys = [
                m["polygon"]
                for m in room_masks
                if m.get("polygon") is not None and not m["polygon"].is_empty
            ]
            if polys:
                room_union = unary_union(polys).buffer(snap * 2)
        except Exception:
            room_union = None
 
    # ─── helper functions ─────────────────────────────────────────────────
 
    def _inside_room(x: float, y: float) -> bool:
        if room_union is None:
            return True
        try:
            return room_union.contains(Point(x, y))
        except Exception:
            return True
 
    def _crosses_opening(x1, y1, x2, y2) -> bool:
        """จุดกึ่งกลางของช่องว่างตกอยู่บน bbox ของประตู/หน้าต่างไหม"""
        objs = list(doors or []) + list(windows or [])
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        for obj in objs:
            if not isinstance(obj, dict):
                continue
            bbox = obj.get("bbox", obj)
            if isinstance(bbox, dict):
                ox1 = bbox.get("x", 0)
                oy1 = bbox.get("y", 0)
                ox2 = ox1 + bbox.get("w", 0)
                oy2 = oy1 + bbox.get("h", 0)
            else:
                continue
            if ox1 <= mx <= ox2 and oy1 <= my <= oy2:
                return True
        return False
 
    def _has_dark_connection(x1, y1, x2, y2,
                              samples=12, dark_thresh=90, min_ratio=0.65) -> bool:
        """
        สุ่มจุดตลอดช่องว่าง แล้วดูว่ามีเส้นมืดในภาพจริงไหม
        ถ้าไม่มีภาพ → ถือว่าผ่าน (True)
        """
        if image is None:
            return True
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            h_img, w_img = gray.shape[:2]
            dark = 0
            for i in range(samples):
                t = i / max(samples - 1, 1)
                px = int(np.clip((x1 + (x2 - x1) * t) * w_img, 0, w_img - 1))
                py = int(np.clip((y1 + (y2 - y1) * t) * h_img, 0, h_img - 1))
                if gray[py, px] <= dark_thresh:
                    dark += 1
            return (dark / samples) >= min_ratio
        except Exception:
            return True
 
    # ─── เชื่อมผนังนอน (horizontal) ─────────────────────────────────────
    new_h, seen_h = [], set()
 
    for i, a in enumerate(h_walls):
        for j, b in enumerate(h_walls):
            if i >= j:
                continue
 
            # ต้องอยู่บนแนวเดียวกัน (y ใกล้กัน)
            y_delta = abs(a["y"] - b["y"])
            if y_delta > min(a.get("t", 0.012), b.get("t", 0.012)) * 1.5:
                continue
 
            # จัดซ้าย-ขวา
            if a["x2"] <= b["x1"]:
                left, right = a, b
            elif b["x2"] <= a["x1"]:
                left, right = b, a
            else:
                continue  # ทับกัน ไม่ใช่ช่องว่าง
 
            gap = right["x1"] - left["x2"]
            if gap <= 0:
                continue
 
            # ─── กำหนด max_bridge และเงื่อนไขตามประเภทผนัง ────────────
            is_struct = left.get("is_structural") or right.get("is_structural")
 
            if is_struct:
                # ผนังโครงบ้าน: เชื่อมได้ไกลกว่า ไม่ต้องอยู่ใน room
                if gap > max_bridge_structural:
                    continue
                # ยังตรวจว่าไม่ใช่ช่องประตู/หน้าต่าง
                mid_x = (left["x2"] + right["x1"]) / 2
                mid_y = (left["y"] + right["y"]) / 2
                if _crosses_opening(left["x2"], mid_y, right["x1"], mid_y):
                    continue
                # ตรวจ pixel จริงในภาพ (ผ่อนปรน: ลด min_ratio เพราะขอบบ้านอาจสว่างกว่าใน)
                if not _has_dark_connection(
                    left["x2"], mid_y, right["x1"], mid_y,
                    min_ratio=0.45,  # ผ่อนปรนกว่าผนังทั่วไป (0.65)
                ):
                    continue
            else:
                # ผนังทั่วไป: เงื่อนไขเดิมทุกอย่าง
                if gap > max_bridge_normal:
                    continue
                mid_x = (left["x2"] + right["x1"]) / 2
                mid_y = (left["y"] + right["y"]) / 2
                if not _inside_room(mid_x, mid_y):
                    continue
                if _crosses_opening(left["x2"], mid_y, right["x1"], mid_y):
                    continue
                if not _has_dark_connection(left["x2"], mid_y, right["x1"], mid_y):
                    continue
 
            key = (round(left["x2"], 4), round(right["x1"], 4), round(mid_y, 4))
            if key in seen_h:
                continue
            seen_h.add(key)
 
            new_h.append({
                "x1": float(left["x2"]),
                "x2": float(right["x1"]),
                "y":  float(mid_y),
                "t":  max(left.get("t", 0.012), right.get("t", 0.012)),
                "source": "gap_bridge",
                "synthetic": True,
                "is_structural": bool(is_struct),
            })
 
    # ─── เชื่อมผนังตั้ง (vertical) ───────────────────────────────────────
    new_v, seen_v = [], set()
 
    for i, a in enumerate(v_walls):
        for j, b in enumerate(v_walls):
            if i >= j:
                continue
 
            x_delta = abs(a["x"] - b["x"])
            if x_delta > min(a.get("t", 0.012), b.get("t", 0.012)) * 1.5:
                continue
 
            if a["y2"] <= b["y1"]:
                top, bot = a, b
            elif b["y2"] <= a["y1"]:
                top, bot = b, a
            else:
                continue
 
            gap = bot["y1"] - top["y2"]
            if gap <= 0:
                continue
 
            is_struct = top.get("is_structural") or bot.get("is_structural")
 
            if is_struct:
                if gap > max_bridge_structural:
                    continue
                mid_x = (top["x"] + bot["x"]) / 2
                mid_y = (top["y2"] + bot["y1"]) / 2
                if _crosses_opening(mid_x, top["y2"], mid_x, bot["y1"]):
                    continue
                if not _has_dark_connection(
                    mid_x, top["y2"], mid_x, bot["y1"],
                    min_ratio=0.45,
                ):
                    continue
            else:
                if gap > max_bridge_normal:
                    continue
                mid_x = (top["x"] + bot["x"]) / 2
                mid_y = (top["y2"] + bot["y1"]) / 2
                if not _inside_room(mid_x, mid_y):
                    continue
                if _crosses_opening(mid_x, top["y2"], mid_x, bot["y1"]):
                    continue
                if not _has_dark_connection(mid_x, top["y2"], mid_x, bot["y1"]):
                    continue
 
            key = (round(mid_x, 4), round(top["y2"], 4), round(bot["y1"], 4))
            if key in seen_v:
                continue
            seen_v.add(key)
 
            new_v.append({
                "x":  float(mid_x),
                "y1": float(top["y2"]),
                "y2": float(bot["y1"]),
                "t":  max(top.get("t", 0.012), bot.get("t", 0.012)),
                "source": "gap_bridge",
                "synthetic": True,
                "is_structural": bool(is_struct),
            })
 
    from shapely.ops import unary_union  # import ซ้ำเพื่อความชัดเจน (ไม่กระทบ)
    all_h, all_v = _snap_merge(h_walls + new_h, v_walls + new_v, cfg)
    return all_h, all_v

def _graceful_fallback(boundary, h_walls, v_walls, doors, cfg,
                       ppm=None, img_shape=None) -> list:
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
                room = _make_room(label, 1, cell, ppm=ppm, img_shape=img_shape,
                                  wall_thickness=cfg.get("thickness", 0.0))
                if room:
                    rooms.append(room)
            if rooms:
                return _deoverlap(rooms, boundary, wall_thickness=cfg.get("thickness", 0.0))
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
                room = _make_room(label, 1, half, ppm=ppm, img_shape=img_shape,
                                  wall_thickness=cfg.get("thickness", 0.0))
                if room:
                    rooms.append(room)
            return _deoverlap(rooms, boundary, wall_thickness=cfg.get("thickness", 0.0))
    except Exception:
        pass

    # --- Level 3: Floor เดียว ---
    room = _make_room("Floor", 1, boundary, ppm=ppm, img_shape=img_shape,
                      wall_thickness=cfg.get("thickness", 0.0))
    return [room] if room else []

def _is_ghost_room(
    mask: dict,
    h_walls: list,
    v_walls: list,
    cfg: dict,
    image: np.ndarray = None,
) -> bool:
    poly = mask["polygon"]
    snap = cfg.get("snap", 0.01)
    conf = mask.get("conf", 0.0)

    # ─── ด่านที่ 1: ตรวจสอบการสัมผัสกำแพง (Anchor-Wall Check) ─────────────────
    # ห้องจริงที่ถูกต้องตามหลักสถาปัตยกรรม "ต้องมีส่วนใดส่วนหนึ่งสัมผัสหรือซ้อนทับกับผนังจริงในระบบ"
    # หากห้องใดลอยอยู่โดดๆ หรืออยู่ติดแค่เส้นขอบกระดาษ โดยไม่มีผนังจริง (YOLO source) แตะอยู่เลย ให้เตะทิ้งทันที
    search_zone = poly.buffer(snap * 1.5)
    has_wall_touch = False
    
    # รวมการเช็คทั้ง h_walls และ v_walls ที่มาจาก yolo
    for seg in h_walls + v_walls:
        if seg.get("source") != "yolo":
            continue
        if seg.get("is_structural", False) is False and seg.get("source") != "yolo": 
            continue # สนใจเฉพาะผนังจริง
        
        if "x" in seg: # V-Wall
            line = LineString([(seg["x"], seg["y1"]), (seg["x"], seg["y2"])])
        else: # H-Wall
            line = LineString([(seg["x1"], seg["y"]), (seg["x2"], seg["y"])])
            
        if search_zone.intersects(line):
            has_wall_touch = True
            break
            
    if not has_wall_touch:
        print(f"[ghost_filter] ❌ Drop (No wall touch - Floating Room Outside): conf={conf:.2f}")
        return True

    # ─── ด่านที่ 2: สแกนความหนาแน่นหมึกแบบซอยย่อย (Grid Density Check) ────────
    # ป้องกันกรณีห้องผีหลอกขนาดใหญ่ที่กินเส้นกรอบกระดาษเข้าไปจนค่าเฉลี่ยหมึกรวมผ่านเกณฑ์
    if image is not None:
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            h_img, w_img = gray.shape[:2]
            
            # บิตแมสเฉพาะพื้นที่ห้อง
            mask_img = np.zeros((h_img, w_img), dtype=np.uint8)
            pts = np.array([[int(x * w_img), int(y * h_img)] for x, y in poly.exterior.coords], np.int32)
            cv2.fillPoly(mask_img, [pts], 255)
            
            # คำนวณภาพ Ink
            _, binary_ink = cv2.threshold(gray, 210, 255, cv2.THRESH_BINARY_INV)
            ink_in_mask = cv2.bitwise_and(binary_ink, mask_img)
            
            # ตรวจสอบ Bounding Box ของตัวห้อง เพื่อแบ่งตารางสแกน 3x3 ช่อง
            x_min, y_min, x_max, y_max = poly.bounds
            px_min_x, px_max_x = int(x_min * w_img), int(x_max * w_img)
            px_min_y, px_max_y = int(y_min * h_img), int(y_max * h_img)
            
            empty_sub_boxes = 0
            steps = 3
            x_step = (px_max_x - px_min_x) // steps
            y_step = (px_max_y - px_min_y) // steps
            
            if x_step > 5 and y_step > 5:
                for i in range(steps):
                    for j in range(steps):
                        bx1 = px_min_x + i * x_step
                        by1 = px_min_y + j * y_step
                        bx2 = bx1 + x_step
                        by2 = by1 + y_step
                        
                        sub_mask = mask_img[by1:by2, bx1:bx2]
                        sub_ink = ink_in_mask[by1:by2, bx1:bx2]
                        
                        if np.sum(sub_mask > 0) > 0:
                            sub_density = np.sum(sub_ink > 0) / np.sum(sub_mask > 0)
                            if sub_density < 0.001: 
                                empty_sub_boxes += 1
                                
                if empty_sub_boxes >= 5:
                    print(f"[ghost_filter] ❌ Drop (White Space Overload {empty_sub_boxes}/9 empty boxes): conf={conf:.2f}")
                    return True
                    
        except Exception as e:
            print(f"[ghost_filter] Grid check failed ({e})")

    return False
def _find_unclosed_rooms(h_walls, v_walls, room_masks, cfg):
    """
    ตรวจหา room mask ที่ boundary ยังเปิดอยู่
    (ผนังรอบห้องไม่ครบ → polygonize รวมกับห้องข้างๆ)
    """
    snap = cfg["snap"]
    
    for mask in room_masks:
        poly = mask["polygon"]
        coords = list(poly.exterior.coords)
        
        uncovered_edges = []
        for i in range(len(coords) - 1):
            x1, y1 = coords[i]
            x2, y2 = coords[i + 1]
            dx, dy = abs(x2 - x1), abs(y2 - y1)
            
            # เฉพาะ edge แนวตั้งฉาก
            if dx >= dy and dy <= 0.02:  # H-edge
                mid_x = (x1 + x2) / 2
                mid_y = (y1 + y2) / 2
                covered = any(
                    abs(h["y"] - mid_y) <= snap * 2
                    and h["x1"] <= mid_x <= h["x2"]
                    for h in h_walls
                )
                if not covered and (x2 - x1) > snap * 3:
                    uncovered_edges.append(("H", x1, y1, x2, y2))
                    
            elif dy > dx and dx <= 0.02:  # V-edge
                mid_x = (x1 + x2) / 2
                mid_y = (y1 + y2) / 2
                covered = any(
                    abs(v["x"] - mid_x) <= snap * 2
                    and v["y1"] <= mid_y <= v["y2"]
                    for v in v_walls
                )
                if not covered and (y2 - y1) > snap * 3:
                    uncovered_edges.append(("V", x1, y1, x2, y2))
        
        if uncovered_edges:
            print(f"[unclosed_room] {mask['label']} "
                  f"centroid=({mask['centroid'][0]:.3f},{mask['centroid'][1]:.3f}) "
                  f"→ {len(uncovered_edges)} uncovered edges:")
            for edge in uncovered_edges:
                print(f"  {edge[0]}: ({edge[1]:.3f},{edge[2]:.3f}) → "
                      f"({edge[3]:.3f},{edge[4]:.3f})")
                
def build_geometry(image: np.ndarray, yolo_results, ppm=None, debug_images=None,
                   wall_height_meter: float = 2.8) -> dict:
    h, w = image.shape[:2]

    room_masks = _extract_room_masks(yolo_results, w, h)
    
    yolo_h, yolo_v = _extract_walls_yolo(yolo_results, w, h)
    
    if yolo_h or yolo_v:
        cfg_for_ghost = _wall_config(yolo_h, yolo_v)
        before = len(room_masks)
        room_masks = [
            m for m in room_masks
            if not _is_ghost_room(m, yolo_h, yolo_v, cfg_for_ghost, image=image)
        ]
        after = len(room_masks)
        if before != after:
            print(f"[ghost_filter] Removed {before - after} ghost room(s), "
                  f"{after} remaining")

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
    
    # ─── กรองประตู/หน้าต่างที่ใหญ่ผิดปกติ (Giant Door/Window Filter) ──────────
    # ประตูปกติในแปลน: กว้าง/ยาวไม่เกิน ~10% ของภาพ, พื้นที่ไม่เกิน 1.5% ของภาพ
    DOOR_MAX_AREA = 0.015   # > 1.5% ของภาพ = ใหญ่เท่าห้อง ให้ตัดทิ้ง
    DOOR_MAX_DIM  = 0.12    # มิติด้านใดด้านหนึ่งเกิน 12% = ผิดปกติ

    clean_doors = []
    for d in doors:
        bbox = d.get("bbox", {})
        bw, bh = bbox.get("w", 0), bbox.get("h", 0)
        door_area = bw * bh
        if door_area > DOOR_MAX_AREA:
            print(f"[Anti-Ghost-Door] Drop area={door_area:.4f} > {DOOR_MAX_AREA} id={d.get('id')}")
            continue
        if bw > DOOR_MAX_DIM or bh > DOOR_MAX_DIM:
            print(f"[Anti-Ghost-Door] Drop dim={bw:.3f}x{bh:.3f} > {DOOR_MAX_DIM} id={d.get('id')}")
            continue
        clean_doors.append(d)
    doors = clean_doors

    WIN_MAX_AREA = 0.020
    WIN_MAX_DIM  = 0.14

    clean_windows = []
    for win in windows:
        bbox = win.get("bbox", {})
        bw, bh = bbox.get("w", 0), bbox.get("h", 0)
        win_area = bw * bh
        if win_area > WIN_MAX_AREA:
            print(f"[Anti-Ghost-Window] Drop area={win_area:.4f} > {WIN_MAX_AREA} id={win.get('id')}")
            continue
        if bw > WIN_MAX_DIM or bh > WIN_MAX_DIM:
            print(f"[Anti-Ghost-Window] Drop dim={bw:.3f}x{bh:.3f} > {WIN_MAX_DIM} id={win.get('id')}")
            continue
        clean_windows.append(win)
    windows = clean_windows
    
    openings = doors + windows

    yolo_h, yolo_v = _extract_walls_yolo(
        yolo_results,
        w,
        h,
    )

    # บันทึก snapshot ก่อน pipeline แก้ไข coord ใน-place (snap_merge ฯลฯ)
    yolo_h_snapshot = [dict(s) for s in yolo_h]
    yolo_v_snapshot = [dict(s) for s in yolo_v]

    cfg_rough = _wall_config(yolo_h, yolo_v, ppm=None)
    _classify_structural_walls(yolo_h, yolo_v, cfg_rough)
    cfg = _wall_config(yolo_h, yolo_v, ppm=ppm)

    if ppm and ppm > 0:
        max_side = max(w, h)
        median_m = cfg["thickness"] * max_side / ppm
        if not (0.08 <= median_m <= 0.35):
            clamped_m    = float(np.clip(median_m, 0.08, 0.35))
            clamped_norm = clamped_m * ppm / max_side
            cfg["thickness"]   = clamped_norm
            cfg["snap"]        = float(np.clip(clamped_norm * 1.8, 0.008, 0.025))
            cfg["merge_gap"]   = float(np.clip(cfg["snap"] * 1.6, 0.018, 0.045))
            cfg["connect_gap"] = float(np.clip(cfg["snap"] * 2.8, 0.028, 0.075))
            print(f"[wall_config] thickness clamped: {median_m:.3f}m → {clamped_m:.3f}m")
    
    all_h = list(yolo_h)
    all_v = list(yolo_v)

    all_h, all_v = _opening_requires_wall(
        all_h,
        all_v,
        openings,
        cfg,
    )
    _classify_structural_walls(all_h, all_v, cfg)

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
    # ปิดช่องว่างขนาดใหญ่ในผนังโครงบ้าน (ทำหลัง _close_all_gaps เพื่อไม่ override การตรวจ room)
    all_h, all_v = _seal_wall_gaps(all_h, all_v, cfg, image=image)
    # [ด่าน 1] รวมผนังซ้อนทับบนแกนเดียวกันให้เป็นเส้นเดียวก่อนเข้า Step 2
    all_h, all_v = _merge_collinear_walls(all_h, all_v, cfg)

    # ─── ขั้น 2: ซ่อมรอยต่อผนัง (Wall Joint Repair) ────────────────────────
    all_h, all_v = _patch_wall_holes(all_h, all_v, room_masks, cfg)
    all_h, all_v = _close_topology_gaps(all_h, all_v, cfg, room_masks)
    h_walls, v_walls = _process_wall_graph(
        all_h,
        all_v,
        doors + windows,
        boundary,
        cfg,
    )
    h_walls, v_walls = _filter_walls_by_rooms(h_walls, v_walls, room_masks, cfg)
    # ซ่อมมุม L/T-Corner ให้ปลายผนังชนกันสนิท
    h_walls, v_walls = _heal_wall_corners(h_walls, v_walls, cfg, image=image)
    # ยืดผนังมาปิดกรอบประตู/หน้าต่างที่ลอยอยู่
    h_walls, v_walls = _connect_openings_to_walls(h_walls, v_walls, doors, windows, cfg, image=image)
    h_walls, v_walls = _force_connect_broken(h_walls, v_walls, cfg, image=image)
    # ยืดผนังที่มีอยู่ให้ครอบ endpoint ที่ YOLO ตรวจไม่ครบ (pixel-verified)
    h_walls, v_walls = _extend_walls_at_junctions(h_walls, v_walls, cfg, image=image)
    # snap มุมที่เพิ่งถูก extend ให้ชนสนิทรอบสุดท้าย
    h_walls, v_walls = _heal_wall_corners(h_walls, v_walls, cfg, image=image)
    # คืน YOLO walls ที่หายไปแต่มีเส้นมืดยืนยันในภาพจริง
    h_walls, v_walls = _restore_verified_yolo_walls(
        h_walls, v_walls,
        yolo_h_snapshot, yolo_v_snapshot,
        image, cfg,
    )
    # เติมผนังตาม boundary polygon ที่ยังขาด (รองรับกรณีไม่มี room mask เช่น Sunroom)
    h_walls, v_walls = _fill_boundary_gaps(h_walls, v_walls, boundary, image, cfg)
    # [ด่าน 1] รอบสุดท้าย: รวมผนังซ้อนทับที่เกิดจาก bridge/heal functions ทั้งหมด
    # 1. merge ก่อน
    h_walls, v_walls = _merge_collinear_walls(h_walls, v_walls, cfg)

    # 2. split จุดตัด
    h_walls, v_walls = _split_at_junctions(h_walls, v_walls)

    # 3. weld endpoint ให้ชน grid เดียวกัน
    h_walls, v_walls = _weld_near_endpoints(
        h_walls,
        v_walls,
        tol=cfg["snap"]
    )

    # 4. bridge ช่องเล็ก "หลัง split แล้วเท่านั้น"
    h_walls, v_walls = _bridge_small_wall_gaps(
        h_walls,
        v_walls,
        gap_tol=min(cfg["snap"] * 1.5, 0.025)
    )

    # 5. merge อีกรอบหลัง bridge
    h_walls, v_walls = _merge_collinear_walls(
        h_walls,
        v_walls,
        cfg
    )

    # 6. quantize รอบสุดท้าย
    h_walls, v_walls = _quantize_wall_graph(
        h_walls,
        v_walls,
        precision=4
    )

    _find_unclosed_rooms(
        h_walls,
        v_walls,
        room_masks,
        cfg
    )

    broken_h, broken_v = _debug_wall_connectivity(
        h_walls,
        v_walls,
        cfg
    )
    print(f"[wall_repair] done — h={len(h_walls)} v={len(v_walls)} "
          f"broken_h={len(broken_h)} broken_v={len(broken_v)})")

    if debug_images is not None:
        debug_images["03_yolo_walls"] = encode_preview(
            _debug_wall_image(image, yolo_h, yolo_v, "YOLO walls", (255, 100, 0), 4)
        )
        debug_images["05_final_walls"] = encode_preview(
            _debug_wall_image(image, h_walls, v_walls, "Final walls", (0, 255, 0), 4)
        )

    mode = "mask_direct"
    rooms = []

    # ─── ขั้น 3: สร้างห้องและหดขอบ NIA ─────────────────────────────────────
    # [ด่าน 3] Layer 1 (หลัก): Vector Polygonize — ทำงานเสมอเมื่อมีผนัง
    # ไม่ต้องรอ room_masks จาก YOLO — ผนังที่ล้อมพื้นที่ปิดสนิทก็สร้างห้องได้
    if h_walls or v_walls:
        try:
            print(f"[pipeline] Layer 1/3: Vector Polygonize "
                  f"(masks={len(room_masks)}, h={len(h_walls)}, v={len(v_walls)})")
            cells = _polygonize_cells(h_walls, v_walls, boundary, room_masks)
            cells = _cleanup_cells(cells, boundary, cfg)
            cells = _merge_fragmented_cells(cells, cfg, room_masks=room_masks)

            if cells and _cells_valid(cells, room_masks, boundary):
                rooms = _assign_rooms(cells, room_masks, boundary, cfg, doors=doors, ppm=ppm, img_shape=image.shape)

                rooms = _filter_room_area_outliers(rooms, boundary)
                rooms = _filter_room_area_outliers(rooms, boundary)

                rooms = _ensure_full_coverage(rooms, boundary, doors, cfg)

                # ลบห้องที่ครอบทั้งบ้าน
                filtered = []
                boundary_area = boundary.area

                for r in rooms:
                    try:
                        poly = Polygon([(p["x"], p["y"]) for p in r["polygon"]])

                        ratio = poly.area / max(boundary_area, 1e-6)

                        # ถ้าห้องกินพื้นที่เกือบทั้งบ้าน → ข้าม
                        if ratio > 0.80:
                            print(f"[post-filter] drop giant room: {r.get('name')} ratio={ratio:.2f}")
                            continue

                        filtered.append(r)

                    except Exception:
                        filtered.append(r)

                rooms = filtered

                mode = "polygonize"
                print(f"✅ Layer 1 Success: Polygonize parsed {len(rooms)} rooms.")
            else:
                print("[pipeline] Layer 1 Bypass: Cell structures are invalid.")
        except Exception as e:
            print(f"[pipeline] Layer 1 Error: {str(e)}")

    # Layer 2: Mask Direct (fallback เมื่อ polygonize ล้มเหลว)
    if not rooms:
        try:
            print("[pipeline] Layer 2/3: Mask Direct Subtract...")
            rooms = _rooms_from_masks(room_masks, boundary, h_walls, v_walls, cfg, ppm=ppm, img_shape=image.shape)
            mode = "mask_direct"
            if rooms:
                print(f"✅ Layer 2 Success: Mask Direct parsed {len(rooms)} rooms.")
        except Exception as e:
            print(f"[pipeline] Layer 2 Error: {str(e)}")

    # Layer 3: Graceful Fallback
    if not rooms:
        print("[pipeline] Layer 3/3: Critical! All paths failed. Invoking Graceful Fallback.")
        rooms = _graceful_fallback(boundary, h_walls, v_walls, doors, cfg, ppm=ppm, img_shape=image.shape)
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
        # buffer ปกติสำหรับผนังทั่วไป
        room_area_normal     = room_union.buffer(cfg["snap"] * 8)
        # buffer ใหญ่กว่าสำหรับผนังโครงบ้าน (อาจอยู่ห่างจาก mask มากกว่า)
        room_area_structural = room_union.buffer(cfg["snap"] * 16)
    except Exception:
        return h_walls, v_walls
 
    KEEP_SOURCES = {
        "yolo", "room_shell", "opening_inferred",
        "gap_bridge", "force_connect", "hole_patch", "topo_bridge", "boundary_fill"
    }
 
    def wall_near_room(line, is_structural: bool) -> bool:
        try:
            zone = room_area_structural if is_structural else room_area_normal
            return zone.distance(line) <= cfg["snap"] * 2
        except Exception:
            return True
 
    out_h = [
        seg for seg in h_walls
        if seg.get("source") in KEEP_SOURCES
        or seg.get("source") == "yolo"   # ← YOLO เก็บไว้เสมอ ไม่ตรวจระยะ
        or wall_near_room(
            LineString([(seg["x1"], seg["y"]), (seg["x2"], seg["y"])]),
            is_structural=bool(seg.get("is_structural"))
        )
    ]
    out_v = [
        seg for seg in v_walls
        if seg.get("source") in KEEP_SOURCES
        or seg.get("source") == "yolo"   # ← YOLO เก็บไว้เสมอ ไม่ตรวจระยะ
        or wall_near_room(
            LineString([(seg["x"], seg["y1"]), (seg["x"], seg["y2"])]),
            is_structural=bool(seg.get("is_structural"))
        )
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
            if c.get("source") == "yolo":  # ป้องกัน YOLO walls จาก staircase filter
                continue
            if (abs(c[coord] - p[coord]) < gap_thr
                    and abs(n[coord] - c[coord]) < gap_thr
                    and overlaps(c, p, k1, k2) > overlap_thr
                    and overlaps(c, n, k1, k2) > overlap_thr):
                remove.add(id(c))
        return [s for s in walls if id(s) not in remove]

    out_h = filter_dense(h_walls, "y", "x1", "x2")
    out_v = filter_dense(v_walls, "x", "y1", "y2")
    dh = len(h_walls) - len(out_h)
    dv = len(v_walls) - len(out_v)
    if dh or dv:
        print(f"[staircase_filter] removed h={dh}, v={dv} non-YOLO walls")
    return out_h, out_v

def _wall_config(h_walls, v_walls, ppm: float = None) -> dict:
    all_walls = h_walls + v_walls

    structural = [s for s in all_walls if s.get("is_structural") and s.get("t", 0) > 0]
    interior   = [s for s in all_walls if not s.get("is_structural") and s.get("t", 0) > 0]
    
    if interior:
        thickness_src = [s["t"] for s in interior]
    elif structural:
        thickness_src = [s["t"] for s in structural]
    else:
        thickness_src = [s.get("t", 0.012) for s in all_walls]
    
    median = float(np.median(thickness_src)) if thickness_src else 0.012
    snap   = float(np.clip(median * 1.8, 0.008, 0.025))
    
    return {
        "thickness":   median,
        "snap":        snap,
        "merge_gap":   float(np.clip(snap * 1.6, 0.018, 0.045)),
        "connect_gap": float(np.clip(snap * 2.0, 0.020, 0.055)),
        "min_real_door": 12,
        "bnd_pad":     float(np.clip(snap * 1.5, 0.012, 0.04)),
        "ppm":         ppm,
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
    print(f"h walls: {len(h_walls)}, v walls: {len(v_walls)}")
    print(f"broken h: {len(broken_h)}, broken v: {len(broken_v)}")

    # เพิ่ม: พิมพ์รายละเอียดผนังที่ broken
    for seg in broken_h:
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
        missing = []
        if not left_ok:
            missing.append(f"left(x={seg['x1']:.3f})")
        if not right_ok:
            missing.append(f"right(x={seg['x2']:.3f})")
        print(f"  broken H: y={seg['y']:.3f} x=[{seg['x1']:.3f},{seg['x2']:.3f}] src={seg.get('source')} miss={missing}")

    for seg in broken_v:
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
        missing = []
        if not top_ok:
            missing.append(f"top(y={seg['y1']:.3f})")
        if not bottom_ok:
            missing.append(f"bottom(y={seg['y2']:.3f})")
        print(f"  broken V: x={seg['x']:.3f} y=[{seg['y1']:.3f},{seg['y2']:.3f}] src={seg.get('source')} miss={missing}")

    return broken_h, broken_v
def _quantize_wall_graph(h_walls, v_walls, precision=4):
    for h in h_walls:
        h["x1"] = round(h["x1"], precision)
        h["x2"] = round(h["x2"], precision)
        h["y"]  = round(h["y"], precision)

    for v in v_walls:
        v["x"]  = round(v["x"], precision)
        v["y1"] = round(v["y1"], precision)
        v["y2"] = round(v["y2"], precision)

    return h_walls, v_walls
def _process_wall_graph(h_raw, v_raw, openings, boundary, cfg):
    h_walls, v_walls = [dict(seg) for seg in h_raw], [dict(seg) for seg in v_raw]
    h_walls, v_walls = _snap_merge(h_walls, v_walls, cfg)
    h_walls, v_walls = _filter_staircase_walls(h_walls, v_walls)
    _heal(h_walls, v_walls, cfg)
    _snap_to_structural(h_walls, v_walls, cfg) 
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
    _snap_anchors(h_walls, v_walls, cfg)
    h_walls, v_walls = _split_at_junctions(
        h_walls,
        v_walls
    )


   
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


def _merge_collinear_walls(h_walls: list, v_walls: list, cfg: dict) -> tuple:
    """
    รวมผนังที่อยู่บนแกนเดียวกันและมีส่วนซ้อนทับหรือแตะกัน (gap ≤ 0) ให้เป็นเส้นเดียว

    ทำงาน 2 รอบ: H-walls (group by y) และ V-walls (group by x)
    รักษา is_structural=True, source="yolo", conf สูงสุดไว้
    """
    snap = cfg["snap"]

    def _merge_group_h(segs: list) -> list:
        segs = sorted(segs, key=lambda s: s["x1"])
        result = []
        cur = dict(segs[0])
        for seg in segs[1:]:
            if (
                seg["x1"] <= cur["x2"] + 1e-6
                and seg.get("source") != "gap_bridge"
                and cur.get("source") != "gap_bridge"
            ):        # overlap หรือแตะ
                cur["x2"] = max(cur["x2"], seg["x2"])
                cur["t"]   = max(cur.get("t", 0.012), seg.get("t", 0.012))
                cur["conf"] = max(cur.get("conf", 0), seg.get("conf", 0))
                if seg.get("is_structural"):
                    cur["is_structural"] = True
                if seg.get("source") == "yolo" and cur.get("source") != "yolo":
                    cur["source"] = "yolo"
            else:
                if cur["x2"] - cur["x1"] >= MIN_SEG / 2:
                    result.append(cur)
                cur = dict(seg)
        if cur["x2"] - cur["x1"] >= MIN_SEG / 2:
            result.append(cur)
        return result

    def _merge_group_v(segs: list) -> list:
        segs = sorted(segs, key=lambda s: s["y1"])
        result = []
        cur = dict(segs[0])
        for seg in segs[1:]:
            if seg["y1"] <= cur["y2"] + 1e-6:
                cur["y2"] = max(cur["y2"], seg["y2"])
                cur["t"]   = max(cur.get("t", 0.012), seg.get("t", 0.012))
                cur["conf"] = max(cur.get("conf", 0), seg.get("conf", 0))
                if seg.get("is_structural"):
                    cur["is_structural"] = True
                if seg.get("source") == "yolo" and cur.get("source") != "yolo":
                    cur["source"] = "yolo"
            else:
                if cur["y2"] - cur["y1"] >= MIN_SEG / 2:
                    result.append(cur)
                cur = dict(seg)
        if cur["y2"] - cur["y1"] >= MIN_SEG / 2:
            result.append(cur)
        return result

    # Group H-walls by quantized y-axis
    from collections import defaultdict as _dd
    h_buckets: dict = _dd(list)
    for seg in h_walls:
        key = round(seg["y"] / snap)
        h_buckets[key].append(seg)

    merged_h: list = []
    for segs in h_buckets.values():
        merged_h.extend(_merge_group_h(segs))

    # Group V-walls by quantized x-axis
    v_buckets: dict = _dd(list)
    for seg in v_walls:
        key = round(seg["x"] / snap)
        v_buckets[key].append(seg)

    merged_v: list = []
    for segs in v_buckets.values():
        merged_v.extend(_merge_group_v(segs))

    removed_h = len(h_walls) - len(merged_h)
    removed_v = len(v_walls) - len(merged_v)
    if removed_h or removed_v:
        print(f"[merge_collinear] merged {removed_h} H + {removed_v} V duplicate/overlap segments")

    return merged_h, merged_v


def _split_walls_at_junctions(h_walls: list, v_walls: list, cfg: dict) -> tuple:
    """
    สับเส้นผนังยาวออกเป็นท่อนย่อยทุกจุดที่มีเส้นผนังตั้งฉากมาตัดผ่าน (Shared Node)

    หลักการ (Node-Segment Topology):
    - H-wall ยาว x=[x1,x2] จะถูกสับที่ทุก V.x ที่อยู่ระหว่างกลาง (ห่างจาก endpoint)
    - V-wall ยาว y=[y1,y2] จะถูกสับที่ทุก H.y ที่อยู่ระหว่างกลาง
    - ทำให้ทุก segment ปลายชนกันที่พิกัดเดียวกันพอดี ไม่มีรอยรั่ว
    - ช่วย polygonize ล้อมพื้นที่ปิดได้ถูกต้อง
    - ใน 3D: ผู้ใช้คลิกเลือกผนังรายห้องได้ ไม่โดนยาวทะลุทั้งบ้าน
    """
    snap = cfg["snap"]
    # จุดตัดต้องอยู่ห่างจาก endpoint อย่างน้อย ENDPOINT_TOL
    # (ถ้าใกล้ endpoint = เชื่อมกันอยู่แล้ว ไม่ต้องสับ)
    ENDPOINT_TOL = snap * 0.5

    def _split_h(h_list: list, v_list: list) -> list:
        out = []
        for h in h_list:
            y, x1, x2 = h["y"], h["x1"], h["x2"]
            split_xs: set = set()
            for v in v_list:
                vx = v["x"]
                # vx ต้องอยู่ "ในตัว" H (ไม่ใช่ที่ปลาย)
                if x1 + ENDPOINT_TOL < vx < x2 - ENDPOINT_TOL:
                    # V ต้องผ่าน (span) y ของ H
                    if v["y1"] - snap <= y <= v["y2"] + snap:
                        split_xs.add(vx)
            if not split_xs:
                out.append(h)
                continue
            xs = sorted([x1] + list(split_xs) + [x2])
            for i in range(len(xs) - 1):
                sx1, sx2 = xs[i], xs[i + 1]
                if sx2 - sx1 < snap * 0.5:
                    continue
                seg = dict(h)
                seg["x1"] = sx1
                seg["x2"] = sx2
                out.append(seg)
        return out

    def _split_v(h_list: list, v_list: list) -> list:
        out = []
        for v in v_list:
            x, y1, y2 = v["x"], v["y1"], v["y2"]
            split_ys: set = set()
            for h in h_list:
                hy = h["y"]
                if y1 + ENDPOINT_TOL < hy < y2 - ENDPOINT_TOL:
                    if h["x1"] - snap <= x <= h["x2"] + snap:
                        split_ys.add(hy)
            if not split_ys:
                out.append(v)
                continue
            ys = sorted([y1] + list(split_ys) + [y2])
            for i in range(len(ys) - 1):
                sy1, sy2 = ys[i], ys[i + 1]
                if sy2 - sy1 < snap * 0.5:
                    continue
                seg = dict(v)
                seg["y1"] = sy1
                seg["y2"] = sy2
                out.append(seg)
        return out

    # สับ H ก่อน (ใช้ v_walls ที่ยังไม่สับเพื่อหาจุดตัด), แล้วค่อยสับ V
    new_h = _split_h(h_walls, v_walls)
    new_v = _split_v(new_h, v_walls)

    added_h = len(new_h) - len(h_walls)
    added_v = len(new_v) - len(v_walls)
    if added_h or added_v:
        print(f"[split_junctions] +{added_h} H, +{added_v} V sub-segments at junctions "
              f"(h: {len(h_walls)}→{len(new_h)}, v: {len(v_walls)}→{len(new_v)})")
    return new_h, new_v


def _snap_merge(h_walls: list, v_walls: list, cfg: dict):
    snap, merge_gap = cfg["snap"], cfg["merge_gap"]
    x_axes = _cluster([seg["x"] for seg in v_walls], snap)
    y_axes = _cluster([seg["y"] for seg in h_walls], snap)
 
    for seg in h_walls:
        orig_x1, orig_x2 = seg["x1"], seg["x2"]
        seg["y"] = _nearest(seg["y"], y_axes)
        for axis in x_axes:
            if abs(seg["x1"] - axis) <= snap:
                seg["x1"] = axis
            if abs(seg["x2"] - axis) <= snap:
                seg["x2"] = axis
        if seg["x1"] > seg["x2"]:
            seg["x1"], seg["x2"] = seg["x2"], seg["x1"]
        # ป้องกัน YOLO wall สั้นกลายเป็น degenerate หลัง snap
        if seg.get("source") == "yolo" and seg["x2"] - seg["x1"] < MIN_SEG / 2:
            if abs(orig_x2 - orig_x1) >= MIN_SEG / 2:
                seg["x1"] = min(orig_x1, orig_x2)
                seg["x2"] = max(orig_x1, orig_x2)

    for seg in v_walls:
        orig_y1, orig_y2 = seg["y1"], seg["y2"]
        seg["x"] = _nearest(seg["x"], x_axes)
        for axis in y_axes:
            if abs(seg["y1"] - axis) <= snap:
                seg["y1"] = axis
            if abs(seg["y2"] - axis) <= snap:
                seg["y2"] = axis
        if seg["y1"] > seg["y2"]:
            seg["y1"], seg["y2"] = seg["y2"], seg["y1"]
        # ป้องกัน YOLO wall สั้นกลายเป็น degenerate หลัง snap
        if seg.get("source") == "yolo" and seg["y2"] - seg["y1"] < MIN_SEG / 2:
            if abs(orig_y2 - orig_y1) >= MIN_SEG / 2:
                seg["y1"] = min(orig_y1, orig_y2)
                seg["y2"] = max(orig_y1, orig_y2)
 
    merged_h = []
    for axis in y_axes:
        same = sorted(
            [seg for seg in h_walls if abs(seg["y"] - axis) <= snap],
            key=lambda seg: seg["x1"]
        )
        for seg in same:
            if seg["x2"] - seg["x1"] < MIN_SEG:
                if seg.get("source") != "yolo" or seg["x2"] - seg["x1"] < 1e-4:
                    continue
            if (merged_h
                    and abs(merged_h[-1]["y"] - axis) <= snap
                    and seg["x1"] - merged_h[-1]["x2"] <= merge_gap):
                # ── merge: รักษา conf สูงสุด และ is_structural ──────────
                prev = merged_h[-1]
                prev["x2"] = max(prev["x2"], seg["x2"])
                prev["t"]  = max(prev["t"],  seg.get("t", 0.012))
                prev["conf"] = max(prev.get("conf", 0), seg.get("conf", 0))
                if seg.get("is_structural"):
                    prev["is_structural"] = True
                if seg.get("source") == "yolo" and prev.get("source") != "yolo":
                    prev["source"] = "yolo"
            else:
                merged_h.append({**seg, "y": axis})
 
    merged_v = []
    for axis in x_axes:
        same = sorted(
            [seg for seg in v_walls if abs(seg["x"] - axis) <= snap],
            key=lambda seg: seg["y1"]
        )
        for seg in same:
            if seg["y2"] - seg["y1"] < MIN_SEG:
                if seg.get("source") != "yolo" or seg["y2"] - seg["y1"] < 1e-4:
                    continue
            if (merged_v
                    and abs(merged_v[-1]["x"] - axis) <= snap
                    and seg["y1"] - merged_v[-1]["y2"] <= merge_gap):
                prev = merged_v[-1]
                prev["y2"] = max(prev["y2"], seg["y2"])
                prev["t"]  = max(prev["t"],  seg.get("t", 0.012))
                prev["conf"] = max(
                    prev.get("conf", 0),
                    seg.get("conf", 0)
                )
                if seg.get("is_structural"):
                    prev["is_structural"] = True
                if seg.get("source") == "yolo" and prev.get("source") != "yolo":
                    prev["source"] = "yolo"
            else:
                merged_v.append({**seg, "x": axis})
 
    return merged_h, merged_v


def _h_anchored(x, y, v_walls, tol):
    return any(abs(seg["x"] - x) <= tol and seg["y1"] - tol <= y <= seg["y2"] + tol for seg in v_walls)


def _v_anchored(x, y, h_walls, tol):
    return any(abs(seg["y"] - y) <= tol and seg["x1"] - tol <= x <= seg["x2"] + tol for seg in h_walls)


def _heal(h_walls, v_walls, cfg):
    snap = cfg["snap"]
    # ผนังโครงบ้าน: ยืดได้ไกลพอสมควร  ผนังภายใน: ยืดได้น้อยมาก (ป้องกันดูดเส้นภายใน)
    structural_reach = snap * 4.0
    internal_reach   = snap * 1.2   # ≈ 0.014 — เฉพาะ micro-gap

    def _pull_v_endpoint(v: dict, y: float) -> None:
        """ดึง endpoint V เข้าหา y เฉพาะเมื่อ y อยู่นอก body ของ V (L-corner เท่านั้น)"""
        if y < v["y1"] - 1e-6 and abs(y - v["y1"]) <= snap * 2:
            v["y1"] = y
        elif y > v["y2"] + 1e-6 and abs(y - v["y2"]) <= snap * 2:
            v["y2"] = y

    def _pull_h_endpoint(h: dict, x: float) -> None:
        """ดึง endpoint H เข้าหา x เฉพาะเมื่อ x อยู่นอก body ของ H (L-corner เท่านั้น)"""
        if x < h["x1"] - 1e-6 and abs(x - h["x1"]) <= snap * 2:
            h["x1"] = x
        elif x > h["x2"] + 1e-6 and abs(x - h["x2"]) <= snap * 2:
            h["x2"] = x

    for _ in range(2):
        # ── ผนังนอน: ยืดปลายซ้าย-ขวา ──────────────────────────────────
        for seg in h_walls:
            y = seg["y"]
            reach = structural_reach if seg.get("is_structural") else internal_reach

            # ปลายซ้าย
            if not _h_anchored(seg["x1"], y, v_walls, snap):
                candidates = [
                    v for v in v_walls
                    if v["x"] < seg["x1"]
                    and seg["x1"] - v["x"] <= reach
                    and v["y1"] - snap <= y <= v["y2"] + snap
                ]
                if candidates:
                    hit = max(candidates, key=lambda v: v["x"])
                    seg["x1"] = hit["x"]
                    _pull_v_endpoint(hit, y)

            # ปลายขวา
            if not _h_anchored(seg["x2"], y, v_walls, snap):
                candidates = [
                    v for v in v_walls
                    if v["x"] > seg["x2"]
                    and v["x"] - seg["x2"] <= reach
                    and v["y1"] - snap <= y <= v["y2"] + snap
                ]
                if candidates:
                    hit = min(candidates, key=lambda v: v["x"])
                    seg["x2"] = hit["x"]
                    _pull_v_endpoint(hit, y)

        # ── ผนังตั้ง: ยืดปลายบน-ล่าง ────────────────────────────────────
        for seg in v_walls:
            x = seg["x"]
            reach = structural_reach if seg.get("is_structural") else internal_reach

            # ปลายบน
            if not _v_anchored(x, seg["y1"], h_walls, snap):
                candidates = [
                    h for h in h_walls
                    if h["y"] < seg["y1"]
                    and seg["y1"] - h["y"] <= reach
                    and h["x1"] - snap <= x <= h["x2"] + snap
                ]
                if candidates:
                    hit = max(candidates, key=lambda h: h["y"])
                    seg["y1"] = hit["y"]
                    _pull_h_endpoint(hit, x)

            # ปลายล่าง
            if not _v_anchored(x, seg["y2"], h_walls, snap):
                candidates = [
                    h for h in h_walls
                    if h["y"] > seg["y2"]
                    and h["y"] - seg["y2"] <= reach
                    and h["x1"] - snap <= x <= h["x2"] + snap
                ]
                if candidates:
                    hit = min(candidates, key=lambda h: h["y"])
                    seg["y2"] = hit["y"]
                    _pull_h_endpoint(hit, x)

def _snap_to_structural(h_walls: list, v_walls: list, cfg: dict) -> None:
    snap      = cfg["snap"]
    max_force = snap * 4.0  # บังคับได้ถ้าเหลือช่องว่างน้อยกว่านี้
 
    # ── ผนังนอน: ปลายขวา → ดึงให้ชนผนังตั้งทางขวา ──────────────────────
    for h in h_walls:
        if not h.get("is_structural"):
            continue
        y = h["y"]
 
        # ปลายซ้าย
        candidates_l = [
            v for v in v_walls
            if v.get("is_structural")
            and v["x"] <= h["x1"]
            and v["y1"] - snap <= y <= v["y2"] + snap
            and h["x1"] - v["x"] <= max_force
        ]
        if candidates_l:
            best = max(candidates_l, key=lambda v: v["x"])
            h["x1"] = best["x"]
            if y < best["y1"] - 1e-6:
                best["y1"] = y
            elif y > best["y2"] + 1e-6:
                best["y2"] = y
 
        # ปลายขวา
        candidates_r = [
            v for v in v_walls
            if v.get("is_structural")
            and v["x"] >= h["x2"]
            and v["y1"] - snap <= y <= v["y2"] + snap
            and v["x"] - h["x2"] <= max_force
        ]
        if candidates_r:
            best = min(candidates_r, key=lambda v: v["x"])
            h["x2"] = best["x"]
            if y < best["y1"] - 1e-6:
                best["y1"] = y
            elif y > best["y2"] + 1e-6:
                best["y2"] = y
 
    # ── ผนังตั้ง: ปลายบน/ล่าง → ดึงให้ชนผนังนอน ─────────────────────────
    for v in v_walls:
        if not v.get("is_structural"):
            continue
        x = v["x"]
 
        # ปลายบน
        candidates_t = [
            h for h in h_walls
            if h.get("is_structural")
            and h["y"] <= v["y1"]
            and h["x1"] - snap <= x <= h["x2"] + snap
            and v["y1"] - h["y"] <= max_force
        ]
        if candidates_t:
            best = max(candidates_t, key=lambda h: h["y"])
            v["y1"] = best["y"]
            if x < best["x1"] - 1e-6:
                best["x1"] = x
            elif x > best["x2"] + 1e-6:
                best["x2"] = x
 
        # ปลายล่าง
        candidates_b = [
            h for h in h_walls
            if h.get("is_structural")
            and h["y"] >= v["y2"]
            and h["x1"] - snap <= x <= h["x2"] + snap
            and h["y"] - v["y2"] <= max_force
        ]
        if candidates_b:
            best = min(candidates_b, key=lambda h: h["y"])
            v["y2"] = best["y"]
            if x < best["x1"] - 1e-6:
                best["x1"] = x
            elif x > best["x2"] + 1e-6:
                best["x2"] = x
            
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
    yolo_in_h  = sum(1 for s in h_walls if s.get("source") == "yolo")
    yolo_in_v  = sum(1 for s in v_walls if s.get("source") == "yolo")
    
    allowed = boundary.buffer(cfg["bnd_pad"], join_style=2)
    out_h, out_v = [], []
    
    for seg in h_walls:
        try:
            intersection = _seg_line(seg, "h").intersection(allowed)
        except Exception:
            if seg.get("source") == "yolo":
                print(f"[clip] YOLO H dropped by exception: y={seg['y']:.3f}")
            continue
        parts = _line_parts(intersection)
        if not parts and seg.get("source") == "yolo":
            print(f"[clip] YOLO H dropped (no intersection): "
                  f"y={seg['y']:.3f} x=[{seg['x1']:.3f},{seg['x2']:.3f}]")
        for line in parts:
            coords = list(line.coords)
            x1, x2 = min(coords[0][0], coords[-1][0]), max(coords[0][0], coords[-1][0])
            if x2 - x1 >= MIN_SEG:
                out_h.append({**seg, "x1": float(x1), "x2": float(x2), 
                               "y": float(coords[0][1])})
            elif seg.get("source") == "yolo":
                print(f"[clip] YOLO H dropped (too short after clip): "
                      f"len={x2-x1:.4f} y={seg['y']:.3f}")

    for seg in v_walls:
        try:
            intersection = _seg_line(seg, "v").intersection(allowed)
        except Exception:
            if seg.get("source") == "yolo":
                print(f"[clip] YOLO V dropped by exception: x={seg['x']:.3f}")
            continue
        parts = _line_parts(intersection)
        if not parts and seg.get("source") == "yolo":
            print(f"[clip] YOLO V dropped (no intersection): "
                  f"x={seg['x']:.3f} y=[{seg['y1']:.3f},{seg['y2']:.3f}]")
        for line in parts:
            coords = list(line.coords)
            y1, y2 = min(coords[0][1], coords[-1][1]), max(coords[0][1], coords[-1][1])
            if y2 - y1 >= MIN_SEG:
                out_v.append({**seg, "x": float(coords[0][0]), 
                               "y1": float(y1), "y2": float(y2)})
            elif seg.get("source") == "yolo":
                print(f"[clip] YOLO V dropped (too short after clip): "
                      f"len={y2-y1:.4f} x={seg['x']:.3f}")

    yolo_out_h = sum(1 for s in out_h if s.get("source") == "yolo")
    yolo_out_v = sum(1 for s in out_v if s.get("source") == "yolo")
    print(f"[clip_to_boundary] YOLO h: {yolo_in_h}→{yolo_out_h}, "
          f"v: {yolo_in_v}→{yolo_out_v}")

    return out_h, out_v


def _filter_structural(h_walls, v_walls, boundary, cfg):
    # เพิ่มตรง debug ต้นฟังก์ชัน
    yolo_in_h = sum(1 for s in h_walls if s.get("source") == "yolo")
    yolo_in_v = sum(1 for s in v_walls if s.get("source") == "yolo")

    snap = cfg["snap"]
    minx, miny, maxx, maxy = boundary.bounds
    min_keep      = max(0.045, snap * 2.2)
    interior_keep = max(0.05,  snap * 2.2)

    def on_h(seg):
        if seg.get("source") in ("shell", "boundary"):
            return False
        return (abs(seg["y"] - miny) <= snap * 1.5
                or abs(seg["y"] - maxy) <= snap * 1.5)

    def on_v(seg):
        if seg.get("source") in ("shell", "boundary"):
            return False
        return (abs(seg["x"] - minx) <= snap * 1.5
                or abs(seg["x"] - maxx) <= snap * 1.5)

    def h_conn(seg):
        y = seg["y"]
        return sum(1 for v in v_walls
                   if seg["x1"] - snap <= v["x"] <= seg["x2"] + snap
                   and v["y1"] - snap <= y <= v["y2"] + snap)

    def v_conn(seg):
        x = seg["x"]
        return sum(1 for h in h_walls
                   if seg["y1"] - snap <= h["y"] <= seg["y2"] + snap
                   and h["x1"] - snap <= x <= h["x2"] + snap)

    out_h = []
    for seg in h_walls:
        seg_len = seg["x2"] - seg["x1"]
        if seg.get("source") == "shell":
            continue

        # ── YOLO: เก็บทุกเส้น ไม่ตรวจอะไรเพิ่ม ──
        if seg.get("source") == "yolo":
            out_h.append(seg)
            continue

        if seg.get("source") == "cv_bridge":
            supported = any(abs(w["y"] - seg["y"]) <= snap * 2
                            for w in h_walls if w.get("source") != "cv_bridge")
            if not supported:
                continue

        keep = (
            seg.get("source") in ("opening_inferred", "room_shell", "hole_patch",
                                   "topo_bridge", "force_connect")
            or seg.get("is_structural")
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

        # ── YOLO: เก็บทุกเส้น ──
        if seg.get("source") == "yolo":
            out_v.append(seg)
            continue

        if seg.get("source") == "cv_bridge":
            supported = any(abs(w["x"] - seg["x"]) <= snap * 2
                            for w in v_walls if w.get("source") != "cv_bridge")
            if not supported:
                continue

        keep = (
            seg.get("synthetic")
            or seg.get("source") in ("opening_inferred", "room_shell")
            or seg.get("is_structural")
            or on_v(seg)
            or seg_len >= interior_keep
            or (seg_len >= min_keep and v_conn(seg) >= 1)
        )
        if keep:
            out_v.append(seg)

    yolo_out_h = sum(1 for s in out_h if s.get("source") == "yolo")
    yolo_out_v = sum(1 for s in out_v if s.get("source") == "yolo")
    print(f"[filter_structural] YOLO h: {yolo_in_h}→{yolo_out_h}, "
          f"v: {yolo_in_v}→{yolo_out_v}")

    return out_h, out_v


def _split_at_junctions(h_walls, v_walls):
    
    snap = MIN_SEG * 0.5

    split_h = []

    for seg in h_walls:

        cuts = [
            v["x"] for v in v_walls
            if seg["x1"] < v["x"] < seg["x2"]
            and v["y1"] - snap <= seg["y"] <= v["y2"] + snap
        ]

        xs = sorted([seg["x1"], *cuts, seg["x2"]])

        for i in range(len(xs) - 1):

            if xs[i + 1] - xs[i] > 1e-5:

                split_h.append({
                    **seg,
                    "x1": xs[i],
                    "x2": xs[i + 1]
                })

    split_v = []

    for seg in v_walls:

        cuts = [
            h["y"] for h in split_h
            if seg["y1"] < h["y"] < seg["y2"]
            and h["x1"] - snap <= seg["x"] <= h["x2"] + snap
        ]

        ys = sorted([seg["y1"], *cuts, seg["y2"]])

        for i in range(len(ys) - 1):

            if ys[i + 1] - ys[i] >= MIN_SEG / 2:

                split_v.append({
                    **seg,
                    "y1": ys[i],
                    "y2": ys[i + 1]
                })

    return split_h, split_v

def _weld_near_endpoints(h_walls, v_walls, tol=0.01):
    
    xs = []
    ys = []

    for h in h_walls:
        xs.extend([h["x1"], h["x2"]])
        ys.append(h["y"])

    for v in v_walls:
        xs.append(v["x"])
        ys.extend([v["y1"], v["y2"]])

    def snap(val, pool):
    
        best = val
        best_dist = tol

        for p in pool:

            d = abs(val - p)

            if d < best_dist:
                best = p
                best_dist = d

        return best

    # snap H
    for h in h_walls:
        if h.get("source") == "gap_bridge":
            continue
        h["x1"] = snap(h["x1"], xs)
        h["x2"] = snap(h["x2"], xs)
        h["y"] = snap(h["y"], ys)

    # snap V
    for v in v_walls:
    
        if v.get("source") == "gap_bridge":
            continue
        v["x"] = snap(v["x"], xs)
        v["y1"] = snap(v["y1"], ys)
        v["y2"] = snap(v["y2"], ys)

    return h_walls, v_walls

def _build_boundary(room_masks, h_walls, v_walls) -> Polygon:
    polys = []

    # 1. room masks
    if room_masks:
        try:
            room_union = unary_union([m["polygon"] for m in room_masks])
            shell = room_union.buffer(0.025, join_style=2)
            shell = _largest_poly(shell.simplify(0.004, preserve_topology=True))
            if shell and shell.area > 0.001:
                polys.append(shell)
        except Exception:
            pass

    # 2. YOLO wall extent — ครอบจุดปลายทุกเส้น
    if h_walls or v_walls:
        try:
            all_pts = []
            for seg in h_walls:
                if seg.get("source") == "yolo":
                    all_pts += [(seg["x1"], seg["y"]), (seg["x2"], seg["y"])]
            for seg in v_walls:
                if seg.get("source") == "yolo":
                    all_pts += [(seg["x"], seg["y1"]), (seg["x"], seg["y2"])]
            if len(all_pts) >= 3:
                from shapely.geometry import MultiPoint
                wall_hull = MultiPoint(all_pts).convex_hull.buffer(0.02)
                wall_hull = _largest_poly(wall_hull)
                if wall_hull:
                    polys.append(wall_hull)
        except Exception:
            pass

    if polys:
        try:
            combined = _largest_poly(unary_union(polys).simplify(0.004, preserve_topology=True))
            if combined and combined.area > 0.001:
                return combined
        except Exception:
            pass

    return Polygon([(0.02, 0.02), (0.98, 0.02), (0.98, 0.98), (0.02, 0.98)])

def _patch_wall_holes(h_walls: list, v_walls: list, room_masks: list, cfg: dict) -> tuple:
    """
    ตรวจหา gap บน boundary ของ room mask แล้วเติม synthetic wall
    เฉพาะ gap ที่สั้นกว่า door threshold (ไม่ใช่ช่องประตูจริง)
    """
    if not room_masks:
        return h_walls, v_walls

    snap = cfg["snap"]
    # gap ที่ถือว่าเป็น "รู" ไม่ใช่ประตู = สั้นกว่า min_real_door
    max_hole = cfg.get("min_real_door", 0.012) * 0.8

    try:
        room_union = unary_union([m["polygon"] for m in room_masks])
        outer = room_union.buffer(0.008).simplify(0.005, preserve_topology=True)
        outer = _largest_poly(outer)
        if outer is None:
            return h_walls, v_walls
    except Exception:
        return h_walls, v_walls

    # สร้าง set ของ wall axes ที่มีอยู่แล้ว
    h_axes = {}  # y → [(x1, x2)]
    for seg in h_walls:
        y = round(seg["y"], 4)
        h_axes.setdefault(y, []).append((seg["x1"], seg["x2"]))

    v_axes = {}  # x → [(y1, y2)]
    for seg in v_walls:
        x = round(seg["x"], 4)
        v_axes.setdefault(x, []).append((seg["y1"], seg["y2"]))

    def covered_h(x1, x2, y):
        """ตรวจว่าช่วง [x1,x2] บน y ถูก cover หรือยัง"""
        for ay, segs in h_axes.items():
            if abs(ay - y) > snap * 2:
                continue
            for sx1, sx2 in segs:
                if sx1 <= x1 + snap and sx2 >= x2 - snap:
                    return True
        return False

    def covered_v(y1, y2, x):
        for ax, segs in v_axes.items():
            if abs(ax - x) > snap * 2:
                continue
            for sy1, sy2 in segs:
                if sy1 <= y1 + snap and sy2 >= y2 - snap:
                    return True
        return False

    new_h, new_v = [], []
    coords = list(outer.exterior.coords)

    for i in range(len(coords) - 1):
        x1, y1 = coords[i]
        x2, y2 = coords[i + 1]
        dx, dy = abs(x2 - x1), abs(y2 - y1)

        if dx < 1e-4 and dy < 1e-4:
            continue

        # horizontal edge
        if dx >= dy and dy <= 0.025:
            ex1, ex2 = min(x1, x2), max(x1, x2)
            ey = (y1 + y2) / 2
            seg_len = ex2 - ex1

            if seg_len < MIN_SEG or seg_len > max_hole:
                continue
            if covered_h(ex1, ex2, ey):
                continue

            new_h.append({
                "x1": float(ex1), "x2": float(ex2),
                "y": float(ey),
                "t": cfg["thickness"],
                "source": "hole_patch",
                "synthetic": True,
            })

        # vertical edge
        elif dy > dx and dx <= 0.025:
            ey1, ey2 = min(y1, y2), max(y1, y2)
            ex = (x1 + x2) / 2
            seg_len = ey2 - ey1

            if seg_len < MIN_SEG or seg_len > max_hole:
                continue
            if covered_v(ey1, ey2, ex):
                continue

            new_v.append({
                "x": float(ex),
                "y1": float(ey1), "y2": float(ey2),
                "t": cfg["thickness"],
                "source": "hole_patch",
                "synthetic": True,
            })

    return h_walls + new_h, v_walls + new_v

def _close_topology_gaps(
    h_walls: list,
    v_walls: list,
    cfg: dict,
    room_masks=None,
) -> tuple:
    """
    รอบที่ 2: ปิด gap โดย geometry เท่านั้น (ไม่ sample pixel)
    ใช้ room mask union เป็น guide — ปิดเฉพาะ gap ที่อยู่ใน room area
    max_bridge ใหญ่กว่า _close_all_gaps เพื่อจับ gap ที่หลุดรอด
    """
    snap = cfg["snap"]
    max_bridge = cfg.get("connect_gap", 0.028) * 2.5  # ใหญ่กว่าปกติ

    room_union = None
    if room_masks:
        try:
            polys = [m["polygon"] for m in room_masks if not m["polygon"].is_empty]
            if polys:
                room_union = unary_union(polys).buffer(snap * 3)
        except Exception:
            pass

    def inside(x, y):
        if room_union is None:
            return True
        try:
            return room_union.contains(Point(x, y))
        except Exception:
            return True

    new_h, seen_h = [], set()
    for i, a in enumerate(h_walls):
        for j, b in enumerate(h_walls):
            if i >= j:
                continue
            if abs(a["y"] - b["y"]) > snap * 2:
                continue
            left, right = (a, b) if a["x2"] <= b["x1"] else (b, a) if b["x2"] <= a["x1"] else (None, None)
            if left is None:
                continue
            gap = right["x1"] - left["x2"]
            if gap <= 0 or gap > max_bridge:
                continue
            mid_x = (left["x2"] + right["x1"]) / 2
            mid_y = (left["y"] + right["y"]) / 2
            if not inside(mid_x, mid_y):
                continue
            key = (round(left["x2"], 4), round(right["x1"], 4), round(mid_y, 4))
            if key in seen_h:
                continue
            seen_h.add(key)
            new_h.append({
                "x1": float(left["x2"]), "x2": float(right["x1"]),
                "y": float(mid_y),
                "t": max(left.get("t", 0.012), right.get("t", 0.012)),
                "source": "topo_bridge", "synthetic": True,
            })

    new_v, seen_v = [], set()
    for i, a in enumerate(v_walls):
        for j, b in enumerate(v_walls):
            if i >= j:
                continue
            if abs(a["x"] - b["x"]) > snap * 2:
                continue
            top, bot = (a, b) if a["y2"] <= b["y1"] else (b, a) if b["y2"] <= a["y1"] else (None, None)
            if top is None:
                continue
            gap = bot["y1"] - top["y2"]
            if gap <= 0 or gap > max_bridge:
                continue
            mid_x = (top["x"] + bot["x"]) / 2
            mid_y = (top["y2"] + bot["y1"]) / 2
            if not inside(mid_x, mid_y):
                continue
            key = (round(mid_x, 4), round(top["y2"], 4), round(bot["y1"], 4))
            if key in seen_v:
                continue
            seen_v.add(key)
            new_v.append({
                "x": float(mid_x),
                "y1": float(top["y2"]), "y2": float(bot["y1"]),
                "t": max(top.get("t", 0.012), bot.get("t", 0.012)),
                "source": "topo_bridge", "synthetic": True,
            })

    if not new_h and not new_v:
        return h_walls, v_walls

    all_h, all_v = _snap_merge(h_walls + new_h, v_walls + new_v, cfg)
    return all_h, all_v

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

def _merge_fragmented_cells(cells, cfg, room_masks=None):
    """
    รวม cell ที่แตะกันหรือห่างกันน้อยมาก
    แก้ปัญหาห้องแตกเป็นชิ้น
    """
    if len(cells) <= 1:
        return cells

    merged = []
    used = set()
    merge_gap = cfg["snap"] * 3.5

    def _masks_in_cell(cell):
        """หา centroid ของ room mask ที่อยู่ใน cell นี้"""
        if not room_masks:
            return set()
        result = set()
        for i, mask in enumerate(room_masks):
            pt = Point(mask["centroid"])
            if cell.contains(pt) or cell.distance(pt) <= 0.01:
                result.add(i)
        return result

    for i, cell in enumerate(cells):
        if i in used:
            continue

        current = cell
        current_masks = _masks_in_cell(current)
        changed = True

        while changed:
            changed = False
            for j, other in enumerate(cells):
                if j == i or j in used:
                    continue

                try:
                    # ✅ ตรวจก่อนว่า other มี mask ของห้องอื่นไหม
                    other_masks = _masks_in_cell(other)
                    
                    # ถ้าทั้งคู่มี mask และเป็นคนละห้อง → ห้าม merge
                    if current_masks and other_masks:
                        if not current_masks.intersection(other_masks):
                            continue  # ✅ คนละห้อง ข้ามไป

                    should_merge = (
                        current.touches(other)
                        or current.distance(other) <= merge_gap
                    )

                    if should_merge:
                        current = unary_union([current, other]).buffer(0)
                        current_masks = current_masks.union(other_masks)
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

    min_large = max(1, int(count * 0.45))
    if len(large_cells) < min_large:
        print(f"❌ FAIL: too few large cells ({len(large_cells)} < {min_large})")
        return False

    max_large = max(count * 3 + 4, 14)
    if len(large_cells) > max_large:
        print(f"❌ FAIL: too many large cells")
        return False

    # เพิ่ม: ตรวจว่า cell เดียวกันมี mask หลายอันตกอยู่
    # ถ้าใช่ = cell นั้น merge หลายห้องเข้าด้วยกัน
    cell_to_masks = defaultdict(list)
    for mask in room_masks:
        point = Point(mask["centroid"])
        for idx, cell in enumerate(large_cells):
            if cell.contains(point) or cell.distance(point) <= 0.02:
                cell_to_masks[idx].append(mask["label"])
                break

    overloaded = {
        idx: labels 
        for idx, labels in cell_to_masks.items() 
        if len(labels) > 1
    }
    
    if overloaded:
        for idx, labels in overloaded.items():
            print(
                f"⚠ WARN: cell[{idx}] contains "
                f"{len(labels)} masks: {labels}"
            )  # ✅ บังคับ fallback ไป Layer 2

    # ส่วนที่เหลือเหมือนเดิม
    max_cell_area = max(c.area for c in large_cells)
    if max_cell_area > boundary.area * 0.60:
        print(f"❌ FAIL: largest cell too big")
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
            c.contains(Point(mask["centroid"])) 
            or c.distance(Point(mask["centroid"])) <= 0.025
            for c in large_cells
        )
    )
    min_hits = max(1, int(count * 0.60))
    return hits >= min_hits


def _name_room_heuristic(
    cell: Polygon,
    boundary: Polygon,
    doors: list,
    used_names: dict,
    all_cells_sorted: list,
) -> str:
    # ไม่ตั้งชื่อตาม heuristic — ใช้ Room N เรียงตามลำดับ
    used_names["Room"] = used_names.get("Room", 0) + 1
    n = used_names["Room"]
    return f"Room {n}"

def _assign_rooms(cells, room_masks, boundary, cfg,
                  doors=None, ppm=None, img_shape=None) -> list:
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

        label = _name_room_heuristic(cell, boundary, doors, used_heuristic_names, cells_sorted_by_size)

        room = _make_room(
            label,
            counters.get(label, 1),
            cell,
            ppm=ppm,
            img_shape=img_shape,
            wall_thickness=cfg.get("thickness", 0.0),
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
            ppm=ppm,
            img_shape=img_shape,
            wall_thickness=cfg.get("thickness", 0.0),
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

    return _deoverlap(filtered, boundary, wall_thickness=cfg.get("thickness", 0.0))

def _ensure_full_coverage(rooms: list, boundary: Polygon, doors: list, cfg: dict) -> list:
    """
    หลัง assign rooms แล้ว ตรวจว่า boundary ทั้งหมดถูก cover หรือยัง
    ส่วนที่ยังขาด → เพิ่มเป็น room ใหม่ (ไม่ให้พื้นที่หาย)
    """
    if not rooms:
        return rooms

    try:
        assigned = unary_union([
            Polygon([(p["x"], p["y"]) for p in r["polygon"]])
            for r in rooms
            if len(r.get("polygon", [])) >= 3
        ])
        uncovered = _largest_poly(boundary.difference(assigned.buffer(0.003)))
    except Exception:
        return rooms

    if uncovered is None or uncovered.area < boundary.area * 0.015:
        return rooms

    # ถ้าชิ้นใหญ่พอ → เพิ่มเป็น room
    min_frag = boundary.area * 0.015
    polys_to_add = []

    if isinstance(uncovered, Polygon):
        if uncovered.area >= min_frag:
            polys_to_add.append(uncovered)
    else:
        for geom in getattr(uncovered, "geoms", []):
            if isinstance(geom, Polygon) and geom.area >= min_frag:
                polys_to_add.append(geom)

    used_names = {r.get("name", ""): 1 for r in rooms}
    cells_sorted = sorted(polys_to_add, key=lambda p: -p.area)

    for poly in cells_sorted:
        label = _name_room_heuristic(poly, boundary, doors, used_names, cells_sorted)
        room = _make_room(label, used_names.get(label, 1), poly,
                          wall_thickness=cfg.get("thickness", 0.0))
        if room:
            rooms.append(room)

    return rooms

def _restore_verified_yolo_walls(
    h_walls: list,
    v_walls: list,
    yolo_h_orig: list,
    yolo_v_orig: list,
    image,
    cfg: dict,
    dark_thresh: int = 110,
    min_hit_ratio: float = 0.50,
    samples: int = 16,
) -> tuple:
    if image is None:
        return h_walls, v_walls

    snap = cfg["snap"]
    try:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    except Exception:
        return h_walls, v_walls

    h_img, w_img = gray.shape[:2]
    wall_t_px = max(2, int(cfg.get("thickness", 0.012) * min(h_img, w_img) * 1.5))

    def _hit_ratio_h(seg):
        """fraction of sample-points along H wall ที่มี dark pixel ในแนวตั้งฉาก"""
        x1 = int(seg["x1"] * w_img)
        x2 = int(seg["x2"] * w_img)
        y_c = int(seg["y"] * h_img)
        if x2 <= x1:
            return 0.0
        xs = np.linspace(x1, x2, max(samples, (x2 - x1) // 6), dtype=int)
        hits = 0
        for x in xs:
            if not (0 <= x < w_img):
                continue
            for dy in range(-wall_t_px, wall_t_px + 1):
                ys = y_c + dy
                if 0 <= ys < h_img and gray[ys, x] < dark_thresh:
                    hits += 1
                    break  # พบ dark pixel ที่จุดนี้แล้ว → นับ 1 hit แล้วไปจุดถัดไป
        return hits / max(len(xs), 1)

    def _hit_ratio_v(seg):
        """fraction of sample-points along V wall ที่มี dark pixel ในแนวตั้งฉาก"""
        y1 = int(seg["y1"] * h_img)
        y2 = int(seg["y2"] * h_img)
        x_c = int(seg["x"] * w_img)
        if y2 <= y1:
            return 0.0
        ys = np.linspace(y1, y2, max(samples, (y2 - y1) // 6), dtype=int)
        hits = 0
        for y in ys:
            if not (0 <= y < h_img):
                continue
            for dx in range(-wall_t_px, wall_t_px + 1):
                xs = x_c + dx
                if 0 <= xs < w_img and gray[y, xs] < dark_thresh:
                    hits += 1
                    break
        return hits / max(len(ys), 1)

    def _coverage_h(seg):
        """fraction of YOLO H-wall already covered by final h_walls (strict tolerance)"""
        seg_len = seg["x2"] - seg["x1"]
        if seg_len < 1e-6:
            return 1.0
        covered = 0.0
        for w in h_walls:
            if abs(w["y"] - seg["y"]) > snap:   # snap เดียว (ไม่ใช่ snap*2)
                continue
            overlap = min(w["x2"], seg["x2"]) - max(w["x1"], seg["x1"])
            covered += max(0.0, overlap)
        return min(covered / seg_len, 1.0)

    def _coverage_v(seg):
        """fraction of YOLO V-wall already covered by final v_walls (strict tolerance)"""
        seg_len = seg["y2"] - seg["y1"]
        if seg_len < 1e-6:
            return 1.0
        covered = 0.0
        for w in v_walls:
            if abs(w["x"] - seg["x"]) > snap:   # snap เดียว (ไม่ใช่ snap*2)
                continue
            overlap = min(w["y2"], seg["y2"]) - max(w["y1"], seg["y1"])
            covered += max(0.0, overlap)
        return min(covered / seg_len, 1.0)

    restored_h = restored_v = 0

    for seg in yolo_h_orig:
        cov = _coverage_h(seg)
        if cov >= 0.75:   # ถ้า cover 75%+ แปลว่ามีอยู่จริงแล้ว ห้าม restore ซ้ำ
            continue
        ratio = _hit_ratio_h(seg)
        print(f"[restore_yolo?] H y={seg['y']:.3f} x=[{seg['x1']:.3f},{seg['x2']:.3f}] "
              f"cov={cov:.2f} hit={ratio:.2f}")
        if ratio >= min_hit_ratio:
            h_walls.append({**seg, "source": "yolo"})
            restored_h += 1
            print(f"[restore_yolo] ✅ restored H wall above")

    for seg in yolo_v_orig:
        cov = _coverage_v(seg)
        if cov >= 0.75:   # ถ้า cover 75%+ แปลว่ามีอยู่จริงแล้ว ห้าม restore ซ้ำ
            continue
        ratio = _hit_ratio_v(seg)
        print(f"[restore_yolo?] V x={seg['x']:.3f} y=[{seg['y1']:.3f},{seg['y2']:.3f}] "
              f"cov={cov:.2f} hit={ratio:.2f}")
        if ratio >= min_hit_ratio:
            v_walls.append({**seg, "source": "yolo"})
            restored_v += 1
            print(f"[restore_yolo] ✅ restored V wall above")

    if restored_h or restored_v:
        print(f"[restore_yolo] total restored h={restored_h} v={restored_v}")

    return h_walls, v_walls


def _fill_boundary_gaps(
    h_walls: list, v_walls: list,
    boundary: "Polygon",
    image,
    cfg: dict,
) -> tuple:
    """
    สุดท้ายหลัง restore YOLO — ตรวจขอบ boundary polygon
    ถ้าขอบไหนไม่มีผนังรองรับ (coverage < 60%) AND มีเส้นมืดในภาพ (≥ 35%)
    → สร้าง structural wall เติม (เฉพาะ edge แนวตั้งฉาก)

    ครอบคลุมกรณี: wall ที่ YOLO ไม่ได้จับและไม่มี room mask (เช่น Sunroom boundary)
    """
    if boundary is None or boundary.is_empty:
        return h_walls, v_walls

    snap = cfg["snap"]
    min_edge = snap * 2.0   # ความยาวขั้นต่ำของ boundary edge ที่จะสร้างผนัง

    gray = None
    if image is not None:
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        except Exception:
            pass

    def _dark_frac(x1n, y1n, x2n, y2n, n=8, thresh=145) -> float:
        if gray is None:
            return 0.5
        hi, wi = gray.shape[:2]
        dark = 0
        for i in range(n):
            t = i / max(n - 1, 1)
            px = int(np.clip((x1n + (x2n - x1n) * t) * wi, 0, wi - 1))
            py = int(np.clip((y1n + (y2n - y1n) * t) * hi, 0, hi - 1))
            if gray[py, px] < thresh:
                dark += 1
        return dark / n

    def _h_coverage(ex1, ex2, ey) -> float:
        length = max(ex2 - ex1, 1e-9)
        covered = 0.0
        for w in h_walls:
            if abs(w["y"] - ey) > snap * 2:
                continue
            covered += max(0.0, min(w["x2"], ex2) - max(w["x1"], ex1))
        return min(covered / length, 1.0)

    def _v_coverage(ey1, ey2, ex) -> float:
        length = max(ey2 - ey1, 1e-9)
        covered = 0.0
        for w in v_walls:
            if abs(w["x"] - ex) > snap * 2:
                continue
            covered += max(0.0, min(w["y2"], ey2) - max(w["y1"], ey1))
        return min(covered / length, 1.0)

    new_h, new_v = [], []
    coords = list(boundary.exterior.coords)

    for i in range(len(coords) - 1):
        x1, y1 = coords[i]
        x2, y2 = coords[i + 1]
        dx = abs(x2 - x1)
        dy = abs(y2 - y1)

        if dx >= dy and dy <= 0.025:          # H-edge
            ex1, ex2 = min(x1, x2), max(x1, x2)
            ey = (y1 + y2) / 2
            if ex2 - ex1 < min_edge:
                continue
            if _h_coverage(ex1, ex2, ey) >= 0.60:
                continue
            if _dark_frac(ex1, ey, ex2, ey) < 0.35:
                continue
            new_h.append({
                "x1": float(ex1), "x2": float(ex2), "y": float(ey),
                "t": cfg["thickness"],
                "source": "boundary_fill",
                "is_structural": True,
                "synthetic": True,
            })

        elif dy > dx and dx <= 0.025:         # V-edge
            ey1, ey2 = min(y1, y2), max(y1, y2)
            ex = (x1 + x2) / 2
            if ey2 - ey1 < min_edge:
                continue
            if _v_coverage(ey1, ey2, ex) >= 0.60:
                continue
            if _dark_frac(ex, ey1, ex, ey2) < 0.35:
                continue
            new_v.append({
                "x": float(ex), "y1": float(ey1), "y2": float(ey2),
                "t": cfg["thickness"],
                "source": "boundary_fill",
                "is_structural": True,
                "synthetic": True,
            })

    if new_h or new_v:
        print(f"[boundary_fill] added h={len(new_h)} v={len(new_v)} missing boundary walls")
        h_walls = h_walls + new_h
        v_walls = v_walls + new_v

    return h_walls, v_walls


def _heal_wall_corners(h_walls: list, v_walls: list, cfg: dict, image=None) -> tuple:
    """
    ปิดมุม L-Corner และ T-Corner ระหว่างผนังแนวนอน/แนวตั้ง

    หลักการ: ปลายผนังสองเส้นที่อยู่ในระยะ corner_snap จะถูกบังคับให้ชนกันที่ "จุดตัดสมมติ"
    พอดีเป๊ะ — ไม่มีการยืดเลยหรือเหลื่อม (no overshoot / no overlap stub)

    L-Corner: ปลายของ H อยู่ใกล้ปลายของ V → ทั้งสองวิ่งมาหากันที่ (V.x, H.y)
    T-Corner: ปลายของ H อยู่ติดกับตัวของ V → H เท่านั้นที่ขยับ, V ไม่ถูกแตะ
    """
    snap = cfg["snap"]
    corner_snap = snap * 2.5      # ขยายจาก 1.8x เพื่อจับ gap ที่มุมห้องได้กว้างขึ้น
    zero_tol    = snap * 1.5      # ระยะ "แทบจะชนกันแล้ว" → force-snap ไม่ตรวจ pixel

    gray = None
    if image is not None:
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        except Exception:
            pass

    def _pixel_dark(nx: float, ny: float, thresh: int = 150) -> bool:
        if gray is None:
            return True
        hi, wi = gray.shape[:2]
        px = int(np.clip(nx * wi, 0, wi - 1))
        py = int(np.clip(ny * hi, 0, hi - 1))
        return int(gray[py, px]) < thresh

    def _ok_to_snap(dist: float, check_x: float, check_y: float) -> bool:
        """Zero-tolerance: gap เล็กมากให้ force-snap เสมอ; gap ปานกลางตรวจ pixel ก่อน"""
        if dist <= zero_tol:
            return True   # แทบแตะกันแล้ว — ดูดสนิทไม่ต้องถามภาพ
        return _pixel_dark(check_x, check_y)

    def _snap_v_endpoint(v: dict, y: float) -> None:
        """ดึง endpoint ของ V-wall เข้าหา y เฉพาะเมื่อ y อยู่นอก body ของ V (L-Corner)
        ถ้า y อยู่ใน body แล้ว (T-Corner) ไม่แตะ V เลย"""
        if y < v["y1"] - 1e-6:
            if abs(y - v["y1"]) <= corner_snap:
                v["y1"] = y
        elif y > v["y2"] + 1e-6:
            if abs(y - v["y2"]) <= corner_snap:
                v["y2"] = y

    def _snap_h_endpoint(h: dict, x: float) -> None:
        """ดึง endpoint ของ H-wall เข้าหา x เฉพาะเมื่อ x อยู่นอก body ของ H (L-Corner)"""
        if x < h["x1"] - 1e-6:
            if abs(x - h["x1"]) <= corner_snap:
                h["x1"] = x
        elif x > h["x2"] + 1e-6:
            if abs(x - h["x2"]) <= corner_snap:
                h["x2"] = x

    changed = True
    rounds = 0
    while changed and rounds < 5:
        changed = False
        rounds += 1

        # ── H-wall endpoint → ค้นหา V-wall ที่ปลายทั้งสองฝั่ง ────────────
        for h in h_walls:
            y = h["y"]

            # ปลายซ้าย (x1) — V ต้องอยู่ทางซ้าย
            best, best_dist = None, corner_snap
            for v in v_walls:
                if v["x"] >= h["x1"]:
                    continue
                dist = h["x1"] - v["x"]
                if dist > corner_snap:
                    continue
                near_top = abs(y - v["y1"]) <= corner_snap
                near_bot = abs(y - v["y2"]) <= corner_snap
                in_body  = v["y1"] - snap <= y <= v["y2"] + snap
                if not (in_body or near_top or near_bot):
                    continue
                if dist < best_dist and _ok_to_snap(dist, v["x"], y):
                    best_dist, best = dist, v
            if best is not None:
                h["x1"] = best["x"]
                _snap_v_endpoint(best, y)
                changed = True

            # ปลายขวา (x2) — V ต้องอยู่ทางขวา
            best, best_dist = None, corner_snap
            for v in v_walls:
                if v["x"] <= h["x2"]:
                    continue
                dist = v["x"] - h["x2"]
                if dist > corner_snap:
                    continue
                near_top = abs(y - v["y1"]) <= corner_snap
                near_bot = abs(y - v["y2"]) <= corner_snap
                in_body  = v["y1"] - snap <= y <= v["y2"] + snap
                if not (in_body or near_top or near_bot):
                    continue
                if dist < best_dist and _ok_to_snap(dist, v["x"], y):
                    best_dist, best = dist, v
            if best is not None:
                h["x2"] = best["x"]
                _snap_v_endpoint(best, y)
                changed = True

        # ── V-wall endpoint → ค้นหา H-wall ที่ปลายทั้งสองฝั่ง ────────────
        for v in v_walls:
            x = v["x"]

            # ปลายบน (y1) — H ต้องอยู่เหนือ
            best, best_dist = None, corner_snap
            for h in h_walls:
                if h["y"] >= v["y1"]:
                    continue
                dist = v["y1"] - h["y"]
                if dist > corner_snap:
                    continue
                near_left  = abs(x - h["x1"]) <= corner_snap
                near_right = abs(x - h["x2"]) <= corner_snap
                in_body    = h["x1"] - snap <= x <= h["x2"] + snap
                if not (in_body or near_left or near_right):
                    continue
                if dist < best_dist and _ok_to_snap(dist, x, h["y"]):
                    best_dist, best = dist, h
            if best is not None:
                v["y1"] = best["y"]
                _snap_h_endpoint(best, x)
                changed = True

            # ปลายล่าง (y2) — H ต้องอยู่ใต้
            best, best_dist = None, corner_snap
            for h in h_walls:
                if h["y"] <= v["y2"]:
                    continue
                dist = h["y"] - v["y2"]
                if dist > corner_snap:
                    continue
                near_left  = abs(x - h["x1"]) <= corner_snap
                near_right = abs(x - h["x2"]) <= corner_snap
                in_body    = h["x1"] - snap <= x <= h["x2"] + snap
                if not (in_body or near_left or near_right):
                    continue
                if dist < best_dist and _ok_to_snap(dist, x, h["y"]):
                    best_dist, best = dist, h
            if best is not None:
                v["y2"] = best["y"]
                _snap_h_endpoint(best, x)
                changed = True

    if rounds > 1:
        print(f"[corner_heal] done in {rounds} round(s)")
    return h_walls, v_walls


def _connect_openings_to_walls(
    h_walls: list, v_walls: list,
    doors: list, windows: list,
    cfg: dict,
    image=None,
) -> tuple:
    snap = cfg["snap"]
    reach = snap * 5.0

    openings = list(doors or []) + list(windows or [])

    gray = None
    if image is not None:
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        except Exception:
            gray = None

    def _dark(nx: float, ny: float, thresh: int = 120) -> bool:
        if gray is None:
            return True
        hi, wi = gray.shape[:2]
        px = int(np.clip(nx * wi, 0, wi - 1))
        py = int(np.clip(ny * hi, 0, hi - 1))
        return int(gray[py, px]) < thresh

    def _h_present(y_val: float, x_lo: float, x_hi: float) -> bool:
        for h in h_walls:
            if abs(h["y"] - y_val) > snap * 2:
                continue
            if h["x2"] >= x_lo - snap and h["x1"] <= x_hi + snap:
                return True
        return False

    def _v_present(x_val: float, y_lo: float, y_hi: float) -> bool:
        for v in v_walls:
            if abs(v["x"] - x_val) > snap * 2:
                continue
            if v["y2"] >= y_lo - snap and v["y1"] <= y_hi + snap:
                return True
        return False

    # Conservative extension: only extend existing wall endpoints when very close
    for obj in openings:
        if not isinstance(obj, dict):
            continue
        bbox = obj.get("bbox", obj)
        if not isinstance(bbox, dict):
            continue
        bx = float(bbox.get("x", 0.0))
        by = float(bbox.get("y", 0.0))
        bw = float(bbox.get("w", 0.0))
        bh = float(bbox.get("h", 0.0))
        if bw <= 0 or bh <= 0:
            continue
        bx2 = bx + bw
        by2 = by + bh

        # tolerances scaled to opening size (conservative)
        wall_x_tol = max(snap * 1.0, bw * 0.15)
        wall_y_tol = max(snap * 1.0, bh * 0.15)
        max_ext_x = min(reach, bw * 0.6, snap * 1.5)
        max_ext_y = min(reach, bh * 0.6, snap * 1.5)

        # TOP edge: try extend H-wall endpoint from left or right into opening edge
        if not _h_present(by, bx, bx2):
            candidates = []
            for h in h_walls:
                if abs(h["y"] - by) > snap * 3:
                    continue
                # right endpoint left of opening
                if h["x2"] < bx:
                    d = bx - h["x2"]
                    if 0 < d <= max_ext_x and h["x2"] >= bx - wall_x_tol and _dark(h["x2"], h["y"]):
                        candidates.append((d, "x2", h))
                # left endpoint right of opening
                if h["x1"] > bx2:
                    d = h["x1"] - bx2
                    if 0 < d <= max_ext_x and h["x1"] <= bx2 + wall_x_tol and _dark(h["x1"], h["y"]):
                        candidates.append((d, "x1", h))
            if candidates:
                candidates.sort(key=lambda x: x[0])
                d, kind, h = candidates[0]
                if kind == "x2":
                    if _segment_overlaps_opening(h["x2"], h["y"], bx, h["y"], openings) or _segment_crosses_opening_interior(h["x2"], h["y"], bx, h["y"], openings):
                        print(f"[connect_openings] SKIP TOP extend H from x2 due overlap/crossing: {h['x2']:.3f}->{bx:.3f} y={h['y']:.3f}")
                    else:
                        print(f"[connect_openings] EXTEND TOP H x2 {h['x2']:.3f}->{bx:.3f} y={h['y']:.3f}")
                        h["x2"] = bx
                else:
                    if _segment_overlaps_opening(h["x1"], h["y"], bx2, h["y"], openings) or _segment_crosses_opening_interior(h["x1"], h["y"], bx2, h["y"], openings):
                        print(f"[connect_openings] SKIP TOP extend H from x1 due overlap/crossing: {h['x1']:.3f}->{bx2:.3f} y={h['y']:.3f}")
                    else:
                        print(f"[connect_openings] EXTEND TOP H x1 {h['x1']:.3f}->{bx2:.3f} y={h['y']:.3f}")
                        h["x1"] = bx2

        # BOTTOM edge
        if not _h_present(by2, bx, bx2):
            candidates = []
            for h in h_walls:
                if abs(h["y"] - by2) > snap * 3:
                    continue
                if h["x2"] < bx:
                    d = bx - h["x2"]
                    if 0 < d <= max_ext_x and h["x2"] >= bx - wall_x_tol and _dark(h["x2"], h["y"]):
                        candidates.append((d, "x2", h))
                if h["x1"] > bx2:
                    d = h["x1"] - bx2
                    if 0 < d <= max_ext_x and h["x1"] <= bx2 + wall_x_tol and _dark(h["x1"], h["y"]):
                        candidates.append((d, "x1", h))
            if candidates:
                candidates.sort(key=lambda x: x[0])
                d, kind, h = candidates[0]
                if kind == "x2":
                    if _segment_overlaps_opening(h["x2"], h["y"], bx, h["y"], openings) or _segment_crosses_opening_interior(h["x2"], h["y"], bx, h["y"], openings):
                        print(f"[connect_openings] SKIP BOTTOM extend H from x2 due overlap/crossing: {h['x2']:.3f}->{bx:.3f} y={h['y']:.3f}")
                    else:
                        print(f"[connect_openings] EXTEND BOTTOM H x2 {h['x2']:.3f}->{bx:.3f} y={h['y']:.3f}")
                        h["x2"] = bx
                else:
                    if _segment_overlaps_opening(h["x1"], h["y"], bx2, h["y"], openings) or _segment_crosses_opening_interior(h["x1"], h["y"], bx2, h["y"], openings):
                        print(f"[connect_openings] SKIP BOTTOM extend H from x1 due overlap/crossing: {h['x1']:.3f}->{bx2:.3f} y={h['y']:.3f}")
                    else:
                        print(f"[connect_openings] EXTEND BOTTOM H x1 {h['x1']:.3f}->{bx2:.3f} y={h['y']:.3f}")
                        h["x1"] = bx2

        # LEFT edge: V walls
        if not _v_present(bx, by, by2):
            candidates = []
            for v in v_walls:
                if abs(v["x"] - bx) > snap * 3:
                    continue
                if v["y2"] < by:
                    d = by - v["y2"]
                    if 0 < d <= max_ext_y and v["y2"] >= by - wall_y_tol and _dark(v["x"], v["y2"]):
                        candidates.append((d, "y2", v))
                if v["y1"] > by2:
                    d = v["y1"] - by2
                    if 0 < d <= max_ext_y and v["y1"] <= by2 + wall_y_tol and _dark(v["x"], v["y1"]):
                        candidates.append((d, "y1", v))
            if candidates:
                candidates.sort(key=lambda x: x[0])
                d, kind, v = candidates[0]
                if kind == "y2":
                    if _segment_overlaps_opening(v["x"], v["y2"], v["x"], by, openings) or _segment_crosses_opening_interior(v["x"], v["y2"], v["x"], by, openings):
                        print(f"[connect_openings] SKIP LEFT extend V from y2 due overlap/crossing: x={v['x']:.3f} {v['y2']:.3f}->{by:.3f}")
                    else:
                        print(f"[connect_openings] EXTEND LEFT V y2 {v['y2']:.3f}->{by:.3f} x={v['x']:.3f}")
                        v["y2"] = by
                else:
                    if _segment_overlaps_opening(v["x"], v["y1"], v["x"], by2, openings) or _segment_crosses_opening_interior(v["x"], v["y1"], v["x"], by2, openings):
                        print(f"[connect_openings] SKIP LEFT extend V from y1 due overlap/crossing: x={v['x']:.3f} {v['y1']:.3f}->{by2:.3f}")
                    else:
                        print(f"[connect_openings] EXTEND LEFT V y1 {v['y1']:.3f}->{by2:.3f} x={v['x']:.3f}")
                        v["y1"] = by2

        # RIGHT edge: V walls
        if not _v_present(bx2, by, by2):
            candidates = []
            for v in v_walls:
                if abs(v["x"] - bx2) > snap * 3:
                    continue
                if v["y2"] < by:
                    d = by - v["y2"]
                    if 0 < d <= max_ext_y and v["y2"] >= by - wall_y_tol and _dark(v["x"], v["y2"]):
                        candidates.append((d, "y2", v))
                if v["y1"] > by2:
                    d = v["y1"] - by2
                    if 0 < d <= max_ext_y and v["y1"] <= by2 + wall_y_tol and _dark(v["x"], v["y1"]):
                        candidates.append((d, "y1", v))
            if candidates:
                candidates.sort(key=lambda x: x[0])
                d, kind, v = candidates[0]
                if kind == "y2":
                    if _segment_overlaps_opening(v["x"], v["y2"], v["x"], by, openings) or _segment_crosses_opening_interior(v["x"], v["y2"], v["x"], by, openings):
                        print(f"[connect_openings] SKIP RIGHT extend V from y2 due overlap/crossing: x={v['x']:.3f} {v['y2']:.3f}->{by:.3f}")
                    else:
                        print(f"[connect_openings] EXTEND RIGHT V y2 {v['y2']:.3f}->{by:.3f} x={v['x']:.3f}")
                        v["y2"] = by
                else:
                    if _segment_overlaps_opening(v["x"], v["y1"], v["x"], by2, openings) or _segment_crosses_opening_interior(v["x"], v["y1"], v["x"], by2, openings):
                        print(f"[connect_openings] SKIP RIGHT extend V from y1 due overlap/crossing: x={v['x']:.3f} {v['y1']:.3f}->{by2:.3f}")
                    else:
                        print(f"[connect_openings] EXTEND RIGHT V y1 {v['y1']:.3f}->{by2:.3f} x={v['x']:.3f}")
                        v["y1"] = by2

    return h_walls, v_walls

def _bridge_small_wall_gaps(h_walls, v_walls, gap_tol=0.08):
    
    print("[bridge_small_wall_gaps] RUN")
    print(f"h={len(h_walls)} v={len(v_walls)}")

    new_h = list(h_walls)
    new_v = list(v_walls)

    # ---------- HORIZONTAL ----------
    added_h = 0

    for i in range(len(h_walls)):
        a = h_walls[i]

        for j in range(i + 1, len(h_walls)):
            b = h_walls[j]

            # y ต้องตรงกันจริง
            if abs(a["y"] - b["y"]) > 1e-4:
                continue

            left, right = sorted([a, b], key=lambda s: s["x1"])
            print(
                f"[PAIR] "
                f"yA={a['y']:.6f} "
                f"yB={b['y']:.6f} "
                f"L={left['x2']:.3f} "
                f"R={right['x1']:.3f}"
            )
            # ต้องไม่ overlap
            if right["x1"] <= left["x2"]:
                continue

            gap = right["x1"] - left["x2"]

            # gap เล็ก
            if gap > gap_tol:
                continue

            # กันเติม doorway / closet opening
            # opening จริงมักกว้างเกิน 0.045
            if gap > 0.045:
                continue

            # ต้องมี vertical wall รองรับปลายทั้งสอง
            has_left_support = any(
                abs(v["x"] - left["x2"]) < 0.01
                and v["y1"] <= a["y"] <= v["y2"]
                for v in v_walls
            )

            has_right_support = any(
                abs(v["x"] - right["x1"]) < 0.01
                and v["y1"] <= a["y"] <= v["y2"]
                for v in v_walls
            )

            if not (has_left_support and has_right_support):
                continue
            # ห้าม bridge ถ้าปลายทั้งสองมาจาก room shell/open edge
            if (
                left.get("source") in ("room_shell", "boundary_fill")
                or right.get("source") in ("room_shell", "boundary_fill")
            ):
                continue
            bridge = {
                "x1": left["x2"],
                "x2": right["x1"],
                "y": a["y"],
                "t": max(a.get("t", 0.012), b.get("t", 0.012)),
                "conf": max(a.get("conf", 0.5), b.get("conf", 0.5)),
                "is_structural": True,
                "source": "gap_bridge"
            }

            new_h.append(bridge)
            added_h += 1

            print(
                f"[bridge_gap] H "
                f"{left['x2']:.3f}->{right['x1']:.3f} "
                f"gap={gap:.3f}"
            )

    # ---------- VERTICAL ----------
    added_v = 0

    for i in range(len(v_walls)):
        a = v_walls[i]

        for j in range(i + 1, len(v_walls)):
            b = v_walls[j]

            if abs(a["x"] - b["x"]) > 0.01:
                continue

            top, bottom = sorted([a, b], key=lambda s: s["y1"])

            gap = bottom["y1"] - top["y2"]

            if 0 < gap < gap_tol:

                bridge = {
                    "x": a["x"],
                    "y1": top["y2"],
                    "y2": bottom["y1"],
                    "t": max(a.get("t", 0.012), b.get("t", 0.012)),
                    "conf": max(a.get("conf", 0.5), b.get("conf", 0.5)),
                    "is_structural": True,
                    "source": "gap_bridge"
                }

                new_v.append(bridge)
                added_v += 1

                print(
                    f"[bridge_gap] V "
                    f"{top['y2']:.3f}->{bottom['y1']:.3f} "
                    f"gap={gap:.3f}"
                )

    print(
        f"[bridge_small_wall_gaps] "
        f"added_h={added_h} added_v={added_v}"
    )

    print(
        f"[bridge_small_wall_gaps] OUT "
        f"h={len(new_h)} v={len(new_v)}"
    )
    for h in h_walls:
        if h.get("source") == "gap_bridge":
            print("[KEEP_BRIDGE]", h)
    return new_h, new_v

def _force_connect_broken(h_walls: list, v_walls: list, cfg: dict, image=None) -> tuple:
    snap       = cfg["snap"]
    force_snap = snap * 2.0  

    gray_img = None
    if image is not None:
        try:
            gray_img = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        except Exception:
            gray_img = None

    def _gap_has_dark(
        x1n: float, y1n: float, x2n: float, y2n: float,
        n_samples: int = 9,
        thresh: int = 120,  
        min_ratio: float = 0.6,
    ) -> bool:
        if gray_img is None:
            return True  
        hi, wi = gray_img.shape[:2]
        dark = 0
        for i in range(n_samples):
            t = i / max(n_samples - 1, 1)
            cx = int(np.clip((x1n + (x2n - x1n) * t) * wi, 0, wi - 1))
            cy = int(np.clip((y1n + (y2n - y1n) * t) * hi, 0, hi - 1))
            hit = False
            for dy in range(-1, 2):
                for dx in range(-1, 2):
                    px_ = int(np.clip(cx + dx, 0, wi - 1))
                    py_ = int(np.clip(cy + dy, 0, hi - 1))
                    if int(gray_img[py_, px_]) < thresh:
                        hit = True
                        break
                if hit:
                    break
            if hit:
                dark += 1
        return (dark / n_samples) >= min_ratio


    changed = True
    rounds  = 0
    while changed and rounds < 3:
        changed = False
        rounds += 1

        for seg in h_walls:
            y = seg["y"]

            if not _h_anchored(seg["x1"], y, v_walls, snap):
                candidates = [
                    v for v in v_walls
                    if v["x"] < seg["x1"]        
                    and seg["x1"] - v["x"] <= force_snap        
                    and v["y1"] - snap <= y <= v["y2"] + snap   
                ]
                if candidates:
                    hit = max(candidates, key=lambda v: v["x"]) 
                    gap_dist = seg["x1"] - hit["x"]
                    if 0 <= gap_dist <= snap * 0.5:
                        seg["x1"] = hit["x"]
                        if y < hit["y1"] - 1e-6:
                            hit["y1"] = y
                        elif y > hit["y2"] + 1e-6:
                            hit["y2"] = y
                        changed = True
                    elif gap_dist > 0 and _gap_has_dark(hit["x"], y, seg["x1"], y):
                        seg["x1"] = hit["x"]
                        if y < hit["y1"] - 1e-6:
                            hit["y1"] = y
                        elif y > hit["y2"] + 1e-6:
                            hit["y2"] = y
                        changed = True

            if not _h_anchored(seg["x2"], y, v_walls, snap):
                candidates = [
                    v for v in v_walls
                    if v["x"] > seg["x2"]
                    and v["x"] - seg["x2"] <= force_snap
                    and v["y1"] - snap <= y <= v["y2"] + snap
                ]
                if candidates:
                    hit = min(candidates, key=lambda v: v["x"])
                    gap_dist = hit["x"] - seg["x2"]
                    if 0 <= gap_dist <= snap * 0.5:
                        seg["x2"] = hit["x"]
                        if y < hit["y1"] - 1e-6:
                            hit["y1"] = y
                        elif y > hit["y2"] + 1e-6:
                            hit["y2"] = y
                        changed = True
                    elif gap_dist > 0 and _gap_has_dark(seg["x2"], y, hit["x"], y):
                        seg["x2"] = hit["x"]
                        if y < hit["y1"] - 1e-6:
                            hit["y1"] = y
                        elif y > hit["y2"] + 1e-6:
                            hit["y2"] = y
                        changed = True

        for seg in v_walls:
            x = seg["x"]

            if not _v_anchored(x, seg["y1"], h_walls, snap):
                candidates = [
                    h for h in h_walls
                    if h["y"] < seg["y1"]
                    and seg["y1"] - h["y"] <= force_snap
                    and h["x1"] - snap <= x <= h["x2"] + snap
                ]
                if candidates:
                    hit = max(candidates, key=lambda h: h["y"])
                    gap_dist = seg["y1"] - hit["y"]
                    if 0 <= gap_dist <= snap * 0.5:
                        seg["y1"] = hit["y"]
                        if x < hit["x1"] - 1e-6:
                            hit["x1"] = x
                        elif x > hit["x2"] + 1e-6:
                            hit["x2"] = x
                        changed = True
                    elif gap_dist > 0 and _gap_has_dark(x, hit["y"], x, seg["y1"]):
                        seg["y1"] = hit["y"]
                        if x < hit["x1"] - 1e-6:
                            hit["x1"] = x
                        elif x > hit["x2"] + 1e-6:
                            hit["x2"] = x
                        changed = True

            if not _v_anchored(x, seg["y2"], h_walls, snap):
                candidates = [
                    h for h in h_walls
                    if h["y"] > seg["y2"]
                    and h["y"] - seg["y2"] <= force_snap
                    and h["x1"] - snap <= x <= h["x2"] + snap
                ]
                if candidates:
                    hit = min(candidates, key=lambda h: h["y"])
                    gap_dist = hit["y"] - seg["y2"]
                    if 0 <= gap_dist <= snap * 0.5:
                        seg["y2"] = hit["y"]
                        if x < hit["x1"] - 1e-6:
                            hit["x1"] = x
                        elif x > hit["x2"] + 1e-6:
                            hit["x2"] = x
                        changed = True
                    elif gap_dist > 0 and _gap_has_dark(x, seg["y2"], x, hit["y"]):
                        seg["y2"] = hit["y"]
                        if x < hit["x1"] - 1e-6:
                            hit["x1"] = x
                        elif x > hit["x2"] + 1e-6:
                            hit["x2"] = x
                        changed = True
    new_h, new_v = [], []

    for seg in v_walls:
        x = seg["x"]

        if not _v_anchored(x, seg["y1"], h_walls, snap * 2):
            above = [
                h for h in h_walls
                if h["y"] < seg["y1"]
                and seg["y1"] - h["y"] <= force_snap
                and h["x1"] - snap <= x <= h["x2"] + snap\
            ]
            if above:
                hit = max(above, key=lambda h: h["y"])
                gap = seg["y1"] - hit["y"]
                is_struct = seg.get("is_structural") or hit.get("is_structural")
                if 0 < gap <= force_snap and (is_struct or gap <= 0.018) and _gap_has_dark(x, hit["y"], x, seg["y1"]):
                    new_v.append({
                        "x": float(x),
                        "y1": float(hit["y"]),
                        "y2": float(seg["y1"]),
                        "t": seg.get("t", cfg["thickness"]),
                        "source": "force_connect",
                        "synthetic": True,
                    })

        if not _v_anchored(x, seg["y2"], h_walls, snap * 2):
            below = [
                h for h in h_walls
                if h["y"] > seg["y2"]
                and h["y"] - seg["y2"] <= force_snap
                and h["x1"] - snap <= x <= h["x2"] + snap
            ]
            if below:
                hit = min(below, key=lambda h: h["y"])
                gap = hit["y"] - seg["y2"]
                is_struct = seg.get("is_structural") or hit.get("is_structural")
                if 0 < gap <= force_snap and (is_struct or gap <= 0.018) and _gap_has_dark(x, seg["y2"], x, hit["y"]):
                    new_v.append({
                        "x": float(x),
                        "y1": float(seg["y2"]),
                        "y2": float(hit["y"]),
                        "t": seg.get("t", cfg["thickness"]),
                        "source": "force_connect",
                        "synthetic": True,
                    })

    for seg in h_walls:
        y = seg["y"]

        if not _h_anchored(seg["x1"], y, v_walls, snap * 2):
            left_v = [
                v for v in v_walls
                if v["x"] < seg["x1"]
                and seg["x1"] - v["x"] <= force_snap
                and v["y1"] - snap <= y <= v["y2"] + snap 
            ]
            if left_v:
                hit = max(left_v, key=lambda v: v["x"])
                gap = seg["x1"] - hit["x"]
                is_struct = seg.get("is_structural") or hit.get("is_structural")
                if 0 < gap <= force_snap and (is_struct or gap <= 0.018) and _gap_has_dark(hit["x"], y, seg["x1"], y):
                    new_h.append({
                        "x1": float(hit["x"]),
                        "x2": float(seg["x1"]),
                        "y": float(y),
                        "t": seg.get("t", cfg["thickness"]),
                        "source": "force_connect",
                        "synthetic": True,
                    })

        if not _h_anchored(seg["x2"], y, v_walls, snap * 2):
            right_v = [
                v for v in v_walls
                if v["x"] > seg["x2"]
                and v["x"] - seg["x2"] <= force_snap
                and v["y1"] - snap <= y <= v["y2"] + snap
            ]
            if right_v:
                hit = min(right_v, key=lambda v: v["x"])
                gap = hit["x"] - seg["x2"]
                is_struct = seg.get("is_structural") or hit.get("is_structural")
                if 0 < gap <= force_snap and (is_struct or gap <= 0.018) and _gap_has_dark(seg["x2"], y, hit["x"], y):
                    new_h.append({
                        "x1": float(seg["x2"]),
                        "x2": float(hit["x"]),
                        "y": float(y),
                        "t": seg.get("t", cfg["thickness"]),
                        "source": "force_connect",
                        "synthetic": True,
                    })

    if new_h or new_v:
        added_h = len(new_h)
        added_v = len(new_v)
        h_walls = h_walls + new_h
        v_walls = v_walls + new_v
        h_walls, v_walls = _snap_merge(h_walls, v_walls, cfg)
        print(f"[force_connect] added h={added_h} v={added_v} "
              f"(thresh=120, min_ratio=0.6, force_snap={force_snap:.3f})")

    return h_walls, v_walls


def _extend_walls_at_junctions(
    h_walls: list, v_walls: list, cfg: dict, image=None
) -> tuple:
    snap = cfg["snap"]
    EXT_STRUCTURAL = 0.20
    EXT_INTERNAL   = 0.16
    DARK_THRESH    = 115
    MIN_RATIO      = 0.45
    N_SAMPLES      = 12

    gray = None
    if image is not None:
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        except Exception:
            pass

    def _line_dark(x1n: float, y1n: float, x2n: float, y2n: float) -> bool:
        if gray is None:
            return True
        hi, wi = gray.shape[:2]
        dark = 0
        for i in range(N_SAMPLES):
            t = i / max(N_SAMPLES - 1, 1)
            px = int(np.clip((x1n + (x2n - x1n) * t) * wi, 0, wi - 1))
            py = int(np.clip((y1n + (y2n - y1n) * t) * hi, 0, hi - 1))
            hit = False
            for dy in range(-1, 2):
                for dx in range(-1, 2):
                    ppx = int(np.clip(px + dx, 0, wi - 1))
                    ppy = int(np.clip(py + dy, 0, hi - 1))
                    if gray[ppy, ppx] < DARK_THRESH:
                        hit = True
                        break
                if hit:
                    break
            if hit:
                dark += 1
        return (dark / N_SAMPLES) >= MIN_RATIO

    changed = True
    rounds   = 0
    total_ext = 0

    while changed and rounds < 4:
        changed = False
        rounds += 1

        for v in v_walls:
            x          = v["x"]
            is_v_struct = v.get("is_structural", False)
            for ep_idx, y in enumerate([v["y1"], v["y2"]]):
                if _v_anchored(x, y, h_walls, snap):
                    continue
                # หา H-wall ที่ y ใกล้กัน (เรียงจากใกล้สุด)
                near_h = sorted(
                    [h for h in h_walls if abs(h["y"] - y) <= snap],
                    key=lambda h: abs(h["y"] - y),
                )
                for h in near_h:
                    is_struct = is_v_struct or h.get("is_structural", False)
                    max_ext   = EXT_STRUCTURAL if is_struct else EXT_INTERNAL
                    if x < h["x1"] - snap:
                        gap = h["x1"] - x
                        if gap <= max_ext and _line_dark(x, h["y"], h["x1"], h["y"]):
                            print(f"[extend_junc] H y={h['y']:.3f} x1 {h['x1']:.3f}→{x:.3f} (gap={gap:.3f})")
                            h["x1"] = x
                            if ep_idx == 0:
                                v["y1"] = h["y"]
                            else:
                                v["y2"] = h["y"]
                            changed   = True
                            total_ext += 1
                            break
                    elif x > h["x2"] + snap:
                        gap = x - h["x2"]
                        if gap <= max_ext and _line_dark(h["x2"], h["y"], x, h["y"]):
                            print(f"[extend_junc] H y={h['y']:.3f} x2 {h['x2']:.3f}→{x:.3f} (gap={gap:.3f})")
                            h["x2"] = x
                            if ep_idx == 0:
                                v["y1"] = h["y"]
                            else:
                                v["y2"] = h["y"]
                            changed   = True
                            total_ext += 1
                            break

        for h in h_walls:
            y          = h["y"]
            is_h_struct = h.get("is_structural", False)
            for ep_idx, x in enumerate([h["x1"], h["x2"]]):
                if _h_anchored(x, y, v_walls, snap):
                    continue
                near_v = sorted(
                    [v for v in v_walls if abs(v["x"] - x) <= snap],
                    key=lambda v: abs(v["x"] - x),
                )
                for v in near_v:
                    is_struct = is_h_struct or v.get("is_structural", False)
                    max_ext   = EXT_STRUCTURAL if is_struct else EXT_INTERNAL
                    if y < v["y1"] - snap:
                        gap = v["y1"] - y
                        if gap <= max_ext and _line_dark(v["x"], y, v["x"], v["y1"]):
                            print(f"[extend_junc] V x={v['x']:.3f} y1 {v['y1']:.3f}→{y:.3f} (gap={gap:.3f})")
                            v["y1"] = y
                            if ep_idx == 0:
                                h["x1"] = v["x"]
                            else:
                                h["x2"] = v["x"]
                            changed   = True
                            total_ext += 1
                            break
                    elif y > v["y2"] + snap:
                        gap = y - v["y2"]
                        if gap <= max_ext and _line_dark(v["x"], v["y2"], v["x"], y):
                            print(f"[extend_junc] V x={v['x']:.3f} y2 {v['y2']:.3f}→{y:.3f} (gap={gap:.3f})")
                            v["y2"] = y
                            if ep_idx == 0:
                                h["x1"] = v["x"]
                            else:
                                h["x2"] = v["x"]
                            changed   = True
                            total_ext += 1
                            break

    if total_ext > 0:
        print(f"[extend_junction] total {total_ext} ext in {rounds} round(s)")
    return h_walls, v_walls


def _rooms_by_raster_cut(image, room_masks, h_walls, v_walls,
                          boundary, doors, cfg, ppm=None) -> list:
    h_img, w_img = image.shape[:2]

    # Step 1: rasterize room mask union
    mask_img = np.zeros((h_img, w_img), dtype=np.uint8)
    try:
        room_union = unary_union([m["polygon"] for m in room_masks])
    except Exception:
        return []
    for poly in (
        [room_union] if isinstance(room_union, Polygon)
        else [g for g in getattr(room_union, "geoms", []) if isinstance(g, Polygon)]
    ):
        pts = np.array(
            [[int(x * w_img), int(y * h_img)] for x, y in poly.exterior.coords], np.int32
        )
        cv2.fillPoly(mask_img, [pts], 255)
    if mask_img.sum() == 0:
        return []

    # Step 2: rasterize walls as thick barriers (generous width to bridge micro-gaps)
    wall_t = cfg.get("thickness", 0.012)
    wall_px = max(4, int(wall_t * min(h_img, w_img) * 1.5))
    wall_img = np.zeros((h_img, w_img), dtype=np.uint8)
    for seg in h_walls:
        p1 = (int(seg["x1"] * w_img), int(seg["y"] * h_img))
        p2 = (int(seg["x2"] * w_img), int(seg["y"] * h_img))
        cv2.line(wall_img, p1, p2, 255, wall_px)
    for seg in v_walls:
        p1 = (int(seg["x"] * w_img), int(seg["y1"] * h_img))
        p2 = (int(seg["x"] * w_img), int(seg["y2"] * h_img))
        cv2.line(wall_img, p1, p2, 255, wall_px)

    # Step 3: erase wall pixels at door openings so adjacent rooms stay connected
    for door in (doors or []):
        bbox = door.get("bbox", {})
        if not bbox:
            continue
        bx = int(bbox.get("x", 0) * w_img)
        by = int(bbox.get("y", 0) * h_img)
        bx2 = int((bbox.get("x", 0) + bbox.get("w", 0)) * w_img)
        by2 = int((bbox.get("y", 0) + bbox.get("h", 0)) * h_img)
        pad = max(2, wall_px // 2)
        cv2.rectangle(wall_img, (bx - pad, by - pad), (bx2 + pad, by2 + pad), 0, -1)

    # Step 4: cut mask − walls
    interior = cv2.bitwise_and(mask_img, cv2.bitwise_not(wall_img))

    # morphological open removes thin bridges (wall micro-gaps)
    open_px = max(1, wall_px // 4)
    k_open = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (open_px * 2 + 1, open_px * 2 + 1)
    )
    interior = cv2.morphologyEx(interior, cv2.MORPH_OPEN, k_open)

    # Step 5: connected components → one component per room
    n_labels, labels_img = cv2.connectedComponents(interior, connectivity=8)
    if n_labels <= 1:
        return []

    print(f"[raster_cut] vector walls → {n_labels - 1} components")
    
    # Step 5b: if vector walls gave no separation (1 room), try dark-line image walls
    if n_labels == 2:
        gray_b = cv2.GaussianBlur(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), (3, 3), 0)
        _, dark_bin = cv2.threshold(gray_b, 140, 255, cv2.THRESH_BINARY_INV)
        # Remove small blobs (text, symbols) with open; keep long wall lines
        rm_sz = max(3, wall_px // 3)
        k_rm = cv2.getStructuringElement(cv2.MORPH_RECT, (rm_sz, rm_sz))
        dark_walls = cv2.morphologyEx(dark_bin, cv2.MORPH_OPEN, k_rm)
        # Dilate to wall thickness
        k_gw = cv2.getStructuringElement(cv2.MORPH_RECT, (wall_px, wall_px))
        dark_walls = cv2.dilate(dark_walls, k_gw)
        # Combine with vector walls, constrain to mask
        wall_img_aug = cv2.bitwise_or(wall_img, cv2.bitwise_and(dark_walls, mask_img))
        interior2 = cv2.bitwise_and(mask_img, cv2.bitwise_not(wall_img_aug))
        interior2 = cv2.morphologyEx(interior2, cv2.MORPH_OPEN, k_open)
        n2, labels2 = cv2.connectedComponents(interior2, connectivity=8)
        if n2 > n_labels:
            n_labels, labels_img = n2, labels2
            print(f"[raster_cut] dark-line fallback → {n_labels - 1} components")
        else:
            print(f"[raster_cut] dark-line no improvement, stay {n_labels - 1}")

    if n_labels <= 1:
        return []

    # Step 6: extract, dilate (recover wall area), clip, polygonize
    # Step 6: extract, dilate (recover wall area), clip, polygonize
    min_px = 50   
    all_cells = []
    for lid in range(1, n_labels):
        comp = (labels_img == lid).astype(np.uint8) * 255
        px_count = int(comp.sum()) // 255
        print(f"[step6] lid={lid} pixels={px_count} min_px={min_px}")
        if px_count < min_px:
            print(f"[step6] lid={lid} → dropped early: pixels {px_count} < min_px")
            continue

        # ใช้ max(1, ...) เพื่อไม่ให้ dilate บวมหนาจนเกินไปสำหรับส่วนประกอบขนาดเล็ก
        dil_px = max(1, wall_px // 6)
        k_dil = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (dil_px * 2 + 1, dil_px * 2 + 1)
        )
        comp = cv2.bitwise_and(cv2.dilate(comp, k_dil), mask_img)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            print(f"[step6] lid={lid} → no contours after dilate")
            continue
            
        cnt = max(cnts, key=cv2.contourArea)
        cnt_area = cv2.contourArea(cnt)
        if cnt_area < min_px:
            print(f"[step6] lid={lid} → contour area {cnt_area:.0f} < min_px")
            continue
            
        norm = [(_clip(float(x) / w_img), _clip(float(y) / h_img)) for x, y in cnt[:, 0]]
        poly = _clean_poly(Polygon(norm))
        if poly is None:
            print(f"[step6] lid={lid} → _clean_poly returned None")
            continue
            
        poly = _largest_poly(poly.simplify(0.002, preserve_topology=True))
        if poly is None:
            print(f"[step6] lid={lid} → simplify returned None")
            continue
            
        print(f"[step6] lid={lid} → poly.area={poly.area:.5f} MIN_ROOM_AREA*0.08={MIN_ROOM_AREA * 0.08:.5f}")
        if poly.area < MIN_ROOM_AREA * 0.08:
            print(f"[step6] lid={lid} → dropped by area check 1")
            continue
            
        try:
            poly = _largest_poly(poly.intersection(boundary))
        except Exception as e:
            print(f"[step6] lid={lid} → intersection failed: {e}")
            continue
            
        if poly is None:
            print(f"[step6] lid={lid} → intersection returned None")
            continue
            
        print(f"[step6] lid={lid} → after intersection area={poly.area:.5f}")
        if poly.area < MIN_ROOM_AREA * 0.08:
            print(f"[step6] lid={lid} → dropped by area check 2")
            continue
            
        all_cells.append(poly)
        print(f"[step6] lid={lid} → ✅ added to all_cells")

    if not all_cells:
        return []

    # Step 7: deoverlap (dilation can create overlap at shared wall boundaries)
    occupied = GeometryCollection()
    final_cells = []
    for poly in sorted(all_cells, key=lambda p: -p.area):
        if not occupied.is_empty:
            try:
                diff = _largest_poly(poly.difference(occupied.buffer(1e-6)))
            except Exception:
                diff = None
                
            ratio = (diff.area / poly.area) if diff else 0
            print(f"[deoverlap] area={poly.area:.5f} diff_ratio={ratio:.3f} "
                    f"kept={diff is not None and diff.area >= poly.area * 0.05:.5f}")
        
            if diff is None or diff.area < poly.area * 0.03:
                continue
            poly = diff
        final_cells.append(poly)
        occupied = unary_union([occupied, poly]) if not occupied.is_empty else poly

    # Step 8: name rooms using heuristic
    cells_by_size = sorted(final_cells, key=lambda p: -p.area)
    used_names: dict = {}
    counters: dict = defaultdict(int)
    rooms = []
    for poly in cells_by_size:
        label = _name_room_heuristic(poly, boundary, doors, used_names, cells_by_size)
        counters[label] += 1
        room = _make_room(label, counters[label], poly,
                          ppm=ppm, img_shape=image.shape)   # ← เพิ่ม
        if room:
            rooms.append(room)
    return rooms


def _raster_rooms_valid(rooms, room_masks, boundary):
    if not rooms:
        return False

    # ลด threshold จาก 0.80 → 0.55 เพราะ raster-cut อาจรวมห้องเล็กบางห้อง
    min_expected = max(2, int(len(room_masks) * 0.55))
    if len(rooms) < min_expected:
        print(f"❌ raster_cut: {len(rooms)} rooms < expected {min_expected}")
        return False

    try:
        covered = unary_union([
            Polygon([(p["x"], p["y"]) for p in r["polygon"]])
            for r in rooms if len(r.get("polygon", [])) >= 3
        ])
        mask_area = unary_union([m["polygon"] for m in room_masks]).area
        ratio = covered.area / max(mask_area, 1e-6)
        if ratio < 0.25: 
            print(f"❌ raster_cut: coverage {ratio:.2f} < 0.25")
            return False
        print(f"✅ raster_cut: {len(rooms)} rooms, coverage {ratio:.2f}")
    except Exception:
        return False
    return True


def _rooms_from_masks(room_masks, boundary, h_walls=None,
                      v_walls=None, cfg=None, ppm=None, img_shape=None):

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

        if poly.area < MIN_ROOM_AREA * 0.08:
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
            ppm=ppm,
            img_shape=img_shape,
            wall_thickness=cfg.get("thickness", 0.0) if cfg else 0.0,
        )

        if room:

            rooms.append(room)

            occupied = (
                unary_union([occupied, poly])
                if not occupied.is_empty
                else poly
            )

    return rooms


def _make_room(label, index, poly, ppm=None, img_shape=None,
               wall_thickness: float = 0.0) -> Optional[dict]:
    """
    สร้าง room dict จาก polygon ที่ได้จาก polygonize

    wall_thickness > 0  →  คำนวณ NIA (Net Internal Area) โดย negative buffer
      polygon     = NIA polygon (หดเข้าในครึ่งความหนาผนัง) → ใช้วาง tile grid
      wallPolygon = outer polygon เต็ม (รวมส่วนกำแพง) → ใช้สร้าง 3D
    """
    outer_pts = _poly_pts(poly)
    if not outer_pts:
        return None

    # ─── NIA: หด inward ครึ่งความหนาผนัง ───────────────────────────────────
    nia_poly = poly
    if wall_thickness > 0:
        try:
            shrunk = poly.buffer(-wall_thickness / 2, join_style=2)
            nia = _largest_poly(shrunk)
            # ยอมรับ NIA ก็ต่อเมื่อพื้นที่ยังเหลือ >= 5% ของ outer
            if nia and not nia.is_empty and nia.area >= poly.area * 0.05:
                nia_poly = nia
        except Exception:
            pass

    nia_pts = _poly_pts(nia_poly) or outer_pts
    center  = nia_poly.centroid if not nia_poly.is_empty else poly.centroid
    slug    = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_") or "room"

    area_sqm = None
    if ppm and img_shape:
        H, W = img_shape[:2]
        area_px2 = nia_poly.area * W * H
        area_sqm = round(area_px2 / (ppm ** 2), 2)

    return {
        "id": f"room_{slug}_{index}",
        "name": label,
        "label": label,
        "polygon":     nia_pts,    # NIA — สำหรับ tile grid / area คำนวณ
        "wallPolygon": outer_pts,  # outer — สำหรับ 3D walls
        "center": {"x": float(center.x), "y": float(center.y)},
        "bbox": _bbox(poly),
        "areaNorm": float(nia_poly.area),
        "areaSqm":  area_sqm,
    }


def _deoverlap(rooms, boundary, wall_thickness: float = 0.0) -> list:
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

        # คำนวณ NIA จาก outer polygon ที่ clip แล้ว
        nia_pts = outer_new_pts
        nia_area = outer_poly.area
        if wall_thickness > 0:
            try:
                shrunk = outer_poly.buffer(-wall_thickness / 2, join_style=2)
                nia = _largest_poly(shrunk)
                if nia and not nia.is_empty and nia.area >= outer_poly.area * 0.05:
                    nia_pts = _poly_pts(nia) or outer_new_pts
                    nia_area = nia.area
            except Exception:
                pass

        center = outer_poly.centroid
        room.update({
            "polygon":     nia_pts,        # NIA — tile grid
            "wallPolygon": outer_new_pts,  # outer — 3D walls
            "center": {"x": float(center.x), "y": float(center.y)},
            "bbox": _bbox(outer_poly),
            "areaNorm": nia_area,
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
            "thicknessRatio": float(np.clip(seg.get("t", 0.012), 0.004, 0.035))
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
