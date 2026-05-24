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
MIN_ROOM_AREA = 0.005  # inner polygon area threshold (was 0.008 outer)

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
    file:           UploadFile = File(...),
    debug:          bool       = Query(False),
    scale_px:       float      = Form(0),
    scale_m:        float      = Form(0),
    img_display_w:  float      = Form(0),
    img_display_h:  float      = Form(0),
):
    try:
        raw = await file.read()
        return run_pipeline(
            raw, file.filename or "", debug=debug,
            scale_px=scale_px, scale_m=scale_m,
            img_display_w=img_display_w, img_display_h=img_display_h,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def run_pipeline(file_bytes: bytes, filename: str = "", debug: bool = False,scale_px: float = 0,scale_m: float = 0,img_display_w: float = 0,img_display_h: float = 0) -> dict:
    image = decode_image(file_bytes, filename)
    prep = preprocess(image)
    clean_image = prep["image"]
    H, W    = clean_image.shape[:2]
    ppm = _resolve_ppm(scale_px, scale_m, img_display_w, W)
    
    yolo_result = get_model()(clean_image, imgsz=IMG_SIZE)[0]
    debug_images = {}
    if debug:
        debug_images["01_preprocessed"] = encode_preview(clean_image)
    geometry = build_geometry(clean_image, yolo_result,ppm=ppm, debug_images=debug_images if debug else None)
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
    max_bridge_normal     = cfg.get("connect_gap", 0.028)
    max_bridge_structural = max_bridge_normal * 3.0  # ผนังโครงบ้านเชื่อมได้ไกลกว่า
 
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
                room = _make_room(label, 1, cell, ppm=ppm, img_shape=img_shape)
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
                room = _make_room(label, 1, half, ppm=ppm, img_shape=img_shape)
                if room:
                    rooms.append(room)
            return _deoverlap(rooms, boundary)
    except Exception:
        pass

    # --- Level 3: Floor เดียว ---
    room = _make_room("Floor", 1, boundary, ppm=ppm, img_shape=img_shape)
    return [room] if room else []

def build_geometry(image: np.ndarray, yolo_results, ppm=None, debug_images=None) -> dict:
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
    
    clean_doors = []
    for d in doors:
        bbox = d.get("bbox", {})
        bw, bh = bbox.get("w", 0), bbox.get("h", 0)
        door_area = bw * bh
        
        # 1. เช็คตามสัดส่วนพื้นที่สะสมสะท้อนขนาดจริง
        if door_area > 0.025:  # สัดส่วนเกิน 2.5% ของพื้นที่ภาพรวม (ปรับลดลงมานิดนึงจาก 0.03 เพื่อความเป๊ะ)
            print(f"[Anti-Ghost-Door] Removed giant door ID: {d.get('id')} with area: {door_area:.4f}")
            continue
            
        # 2. เช็คมิติรูปร่าง ประตูจริงต้องเป็นเส้นยาวเรียว ไม่ใช่สี่เหลี่ยมจัตุรัสหม่ำหนาเท่าขนาดห้อง
        # ถ้าความกว้างและความหนาเกิน 15% ของรูปภาพทั้งคู่ แปลว่าโมเดลจับคลาสพลาดครอบระเบียงแน่นอน
        if bw > 0.15 and bh > 0.15:
            print(f"[Anti-Ghost-Door] Removed fat door ID: {d.get('id')} ({bw:.3f}x{bh:.3f})")
            continue
            
        clean_doors.append(d)
    doors = clean_doors

    clean_windows = []
    for win in windows:
        bbox = win.get("bbox", {})
        bw, bh = bbox.get("w", 0), bbox.get("h", 0)
        win_area = bw * bh
        if win_area > 0.035 or (bw > 0.15 and bh > 0.15):
            print(f"[Anti-Ghost-Window] Removed giant window ID: {w.get('id')} with area: {win_area:.4f}")
            continue
        clean_windows.append(win)
    windows = clean_windows
    
    openings = doors + windows

    yolo_h, yolo_v = _extract_walls_yolo(
        yolo_results,
        w,
        h,
    )
        
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
            cfg["connect_gap"] = float(np.clip(cfg["snap"] * 2.0, 0.020, 0.055))
            print(f"[wall_config] thickness clamped: {median_m:.3f}m → {clamped_m:.3f}m")
    

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
    
    all_h, all_v = _patch_wall_holes(all_h, all_v, room_masks, cfg)
    all_h, all_v = _close_topology_gaps(all_h, all_v, cfg, room_masks) 
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
    h_walls, v_walls = _force_connect_broken(h_walls, v_walls, cfg ,image=image)
    print("[after force_connect]")
    _debug_wall_connectivity(h_walls, v_walls, cfg)

    if debug_images is not None:
        debug_images["03_yolo_walls"] = encode_preview(
            _debug_wall_image(image, yolo_h, yolo_v, "YOLO walls", (255, 100, 0), 4)
        )
        debug_images["05_final_walls"] = encode_preview(
            _debug_wall_image(image, h_walls, v_walls, "Final walls", (0, 255, 0), 4)
        )

    mode = "mask_direct"
    rooms = []

    # ชั้นที่ 1: 🚀 PRIMARY PATH - Raster-based Wall Cut Strategy
    if room_masks and (h_walls or v_walls):
        try:
            print(f"[pipeline] Layer 1/4: Executing Raster-Cut (masks={len(room_masks)}, h={len(h_walls)}, v={len(v_walls)})")
            
            raster_rooms = _rooms_by_raster_cut(image, room_masks, h_walls, v_walls, boundary, doors, cfg ,ppm=ppm)
            
            if raster_rooms and _raster_rooms_valid(raster_rooms, room_masks, boundary):
                rooms = raster_rooms
                mode = "raster_cut"
                print(f"✅ Layer 1 Success: Raster-Cut parsed {len(rooms)} rooms.")
            else:
                print("[pipeline] Layer 1 Bypass: Raster-Cut validation failed or rooms empty.")
        except Exception as e:
            print(f"[pipeline] Layer 1 Error: {str(e)}")

    # ชั้นที่ 2: 🥈 FALLBACK 1 - Graph-based Polygonize Cell Extraction
    if not rooms:
        try:
            print("[pipeline] Layer 2/4: Trying Vector Polygonize Graph...")
            cells = _polygonize_cells(h_walls, v_walls, boundary, room_masks)
            cells = _cleanup_cells(cells, boundary, cfg)
            cells = _merge_fragmented_cells(cells, cfg)
            
            if cells and _cells_valid(cells, room_masks, boundary):
                rooms = _assign_rooms(cells, room_masks, boundary, cfg, doors=doors, ppm=ppm, img_shape=image.shape)
                rooms = _filter_room_area_outliers(rooms, boundary)
                rooms = _filter_room_area_outliers(rooms, boundary)
                rooms = _ensure_full_coverage(rooms, boundary, doors, cfg)
                mode = "polygonize"
                print(f"✅ Layer 2 Success: Polygonize parsed {len(rooms)} rooms.")
            else:
                print("[pipeline] Layer 2 Bypass: Cell structures are invalid.")
        except Exception as e:
            print(f"[pipeline] Layer 2 Error: {str(e)}")

    # ชั้นที่ 3: 🥉 FALLBACK 2 - Raw YOLO Masks with Sequential Deoverlap
    if not rooms:
        try:
            print("[pipeline] Layer 3/4: Trying Mask Direct Subtract...")
            rooms = _rooms_from_masks(room_masks, boundary, h_walls, v_walls, cfg, ppm=ppm, img_shape=image.shape)
            mode = "mask_direct"
            if rooms:
                print(f"✅ Layer 3 Success: Mask Direct parsed {len(rooms)} rooms.")
        except Exception as e:
            print(f"[pipeline] Layer 3 Error: {str(e)}")

    # ชั้นที่ 4: 🎖️ FALLBACK 3 - Last Resort Single Shell
    if not rooms:
        print("[pipeline] Layer 4/4: Critical! All paths failed. Invoking Graceful Fallback.")
        rooms = _graceful_fallback(boundary, h_walls, v_walls, doors, cfg, ppm=ppm, img_shape=image.shape)
        mode = "graceful_fallback"

    # ── Wrap up outputs ──────────────────────────────────────────────────────
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
        room_area = room_union.buffer(cfg["snap"] * 8)
    except Exception:
        return h_walls, v_walls

    # source เหล่านี้เก็บไว้เสมอ ไม่กรองออก
    KEEP_SOURCES = {"yolo", "room_shell", "opening_inferred",
                "gap_bridge", "force_connect", "hole_patch", "topo_bridge"}

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
    snap    = cfg["snap"]
    connect = cfg["connect_gap"]
    structural_connect = connect * 2.5  # ผนังโครงบ้านยืดได้ไกลกว่า
 
    for _ in range(2):
        # ── ผนังนอน: ยืดปลายซ้าย-ขวา ──────────────────────────────────
        for seg in h_walls:
            y = seg["y"]
            reach = structural_connect if seg.get("is_structural") else connect
 
            # ปลายซ้าย: หาผนังตั้งที่อยู่ทางซ้าย และผ่านแนว y นี้
            if not _h_anchored(seg["x1"], y, v_walls, snap):
                candidates = [
                    v for v in v_walls
                    if v["x"] < seg["x1"]
                    and v["y1"] - snap <= y <= v["y2"] + snap
                ]
                if candidates:
                    hit = max(candidates, key=lambda v: v["x"])
                    if seg["x1"] - hit["x"] <= reach:
                        seg["x1"] = hit["x"]
                        hit["y1"] = min(hit["y1"], y)
                        hit["y2"] = max(hit["y2"], y)
 
            # ปลายขวา: หาผนังตั้งที่อยู่ทางขวา และผ่านแนว y นี้
            if not _h_anchored(seg["x2"], y, v_walls, snap):
                candidates = [
                    v for v in v_walls
                    if v["x"] > seg["x2"]
                    and v["y1"] - snap <= y <= v["y2"] + snap
                ]
                if candidates:
                    hit = min(candidates, key=lambda v: v["x"])
                    if hit["x"] - seg["x2"] <= reach:
                        seg["x2"] = hit["x"]
                        hit["y1"] = min(hit["y1"], y)
                        hit["y2"] = max(hit["y2"], y)
 
        # ── ผนังตั้ง: ยืดปลายบน-ล่าง ────────────────────────────────────
        for seg in v_walls:
            x = seg["x"]
            reach = structural_connect if seg.get("is_structural") else connect
 
            # ปลายบน: หาผนังนอนที่อยู่เหนือขึ้นไป และผ่านแนว x นี้
            if not _v_anchored(x, seg["y1"], h_walls, snap):
                candidates = [
                    h for h in h_walls
                    if h["y"] < seg["y1"]
                    and h["x1"] - snap <= x <= h["x2"] + snap
                ]
                if candidates:
                    hit = max(candidates, key=lambda h: h["y"])
                    if seg["y1"] - hit["y"] <= reach:
                        seg["y1"] = hit["y"]
                        hit["x1"] = min(hit["x1"], x)
                        hit["x2"] = max(hit["x2"], x)
 
            # ปลายล่าง: หาผนังนอนที่อยู่ใต้ลงไป และผ่านแนว x นี้
            if not _v_anchored(x, seg["y2"], h_walls, snap):
                candidates = [
                    h for h in h_walls
                    if h["y"] > seg["y2"]
                    and h["x1"] - snap <= x <= h["x2"] + snap
                ]
                if candidates:
                    hit = min(candidates, key=lambda h: h["y"])
                    if hit["y"] - seg["y2"] <= reach:
                        seg["y2"] = hit["y"]
                        hit["x1"] = min(hit["x1"], x)
                        hit["x2"] = max(hit["x2"], x)

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
            best["y1"] = min(best["y1"], y)
            best["y2"] = max(best["y2"], y)
 
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
            best["y1"] = min(best["y1"], y)
            best["y2"] = max(best["y2"], y)
 
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
            best["x1"] = min(best["x1"], x)
            best["x2"] = max(best["x2"], x)
 
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
            best["x1"] = min(best["x1"], x)
            best["x2"] = max(best["x2"], x)
            
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
        seg.get("source") in ("opening_inferred", "room_shell","hole_patch","topo_bridge","force_connect")
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
            or (seg_len >= min_keep and v_conn(seg) >= 1) 
        )
        if keep:
            out_v.append(seg)

    return out_h, out_v


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
            img_shape=img_shape
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
        room = _make_room(label, used_names.get(label, 1), poly)
        if room:
            rooms.append(room)

    return rooms

def _force_connect_broken(h_walls: list, v_walls: list, cfg: dict, image=None) -> tuple:
    snap = cfg["snap"]
    force_snap = snap * 6.0
    changed = True
    rounds = 0
    
    gray_img = None
    if image is not None:
        try:
            gray_img = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        except Exception:
            gray_img = image

    while changed and rounds < 3:
        changed = False
        rounds += 1

        # ── ผนังนอน: ยืดปลายซ้าย/ขวาหาผนังตั้ง ──────────────────────
        for seg in h_walls:
            y = seg["y"]

            # ปลายซ้าย
            if not _h_anchored(seg["x1"], y, v_walls, snap):
                candidates = [
                    v for v in v_walls
                    if v["x"] <= seg["x1"] + force_snap
                    and v["y1"] - force_snap <= y <= v["y2"] + force_snap
                ]
                if candidates:
                    hit = max(candidates, key=lambda v: v["x"])
                    if abs(hit["x"] - seg["x1"]) <= force_snap:
                        seg["x1"] = hit["x"]
                        hit["y1"] = min(hit["y1"], y)
                        hit["y2"] = max(hit["y2"], y)
                        changed = True

            # ปลายขวา
            if not _h_anchored(seg["x2"], y, v_walls, snap):
                candidates = [
                    v for v in v_walls
                    if v["x"] >= seg["x2"] - force_snap
                    and v["y1"] - force_snap <= y <= v["y2"] + force_snap
                ]
                if candidates:
                    hit = min(candidates, key=lambda v: v["x"])
                    if abs(hit["x"] - seg["x2"]) <= force_snap:
                        seg["x2"] = hit["x"]
                        hit["y1"] = min(hit["y1"], y)
                        hit["y2"] = max(hit["y2"], y)
                        changed = True

        # ── ผนังตั้ง: ยืดปลายบน/ล่างหาผนังนอน ──────────────────────
        for seg in v_walls:
            x = seg["x"]

            # ปลายบน
            if not _v_anchored(x, seg["y1"], h_walls, snap):
                candidates = [
                    h for h in h_walls
                    if h["y"] <= seg["y1"] + force_snap
                    and h["x1"] - force_snap <= x <= h["x2"] + force_snap
                ]
                if candidates:
                    hit = max(candidates, key=lambda h: h["y"])
                    if abs(hit["y"] - seg["y1"]) <= force_snap:
                        seg["y1"] = hit["y"]
                        hit["x1"] = min(hit["x1"], x)
                        hit["x2"] = max(hit["x2"], x)
                        changed = True

            # ปลายล่าง
            if not _v_anchored(x, seg["y2"], h_walls, snap):
                candidates = [
                    h for h in h_walls
                    if h["y"] >= seg["y2"] - force_snap
                    and h["x1"] - force_snap <= x <= h["x2"] + force_snap
                ]
                if candidates:
                    hit = min(candidates, key=lambda h: h["y"])
                    if abs(hit["y"] - seg["y2"]) <= force_snap:
                        seg["y2"] = hit["y"]
                        hit["x1"] = min(hit["x1"], x)
                        hit["x2"] = max(hit["x2"], x)
                        changed = True

    new_h, new_v = [], []

    for seg in v_walls:
        x = seg["x"]

        # 1. เคสเพิ่มผนังแนวตั้ง วิ่งหาแนวตั้งด้านบน
        if not _v_anchored(x, seg["y1"], h_walls, snap * 2):
            above = [h for h in h_walls
                     if h["y"] < seg["y1"]
                     and h["x1"] - force_snap <= x <= h["x2"] + force_snap]
            if above:
                hit = max(above, key=lambda h: h["y"])
                gap = seg["y1"] - hit["y"]
                if 0 < gap <= force_snap:
                    # 👉 เพิ่มเติม: ตรวจสอบเมทริกซ์พิกเซลภาพจริงบนกึ่งกลางช่องว่างแนวตั้ง
                    if gray_img is not None:
                        hi, wi = gray_img.shape[:2]
                        mid_px = int(np.clip(x * wi, 0, wi - 1))
                        mid_py = int(np.clip(((hit["y"] + seg["y1"]) / 2) * hi, 0, hi - 1))
                        # ถ้าพื้นผิวสว่างเกินไป (> 180 คือค่อนไปทางสีขาวบริสุทธิ์) แปลว่าไม่มีเส้นพิมพ์เขียวอยู่จริง
                        if gray_img[mid_py, mid_px] > 180:
                            continue # ข้าม ไม่สร้างผนังมั่ว

                    new_v.append({
                        "x": float(x),
                        "y1": float(hit["y"]),
                        "y2": float(seg["y1"]),
                        "t": seg.get("t", cfg["thickness"]),
                        "source": "force_connect",
                        "synthetic": True,
                    })

        if not _v_anchored(x, seg["y2"], h_walls, snap * 2):
            below = [h for h in h_walls
                     if h["y"] > seg["y2"]
                     and h["x1"] - force_snap <= x <= h["x2"] + force_snap]
            if below:
                hit = min(below, key=lambda h: h["y"])
                gap = hit["y"] - seg["y2"]
                if 0 < gap <= force_snap:
                    if gray_img is not None:
                        hi, wi = gray_img.shape[:2]
                        mid_px = int(np.clip(x * wi, 0, wi - 1))
                        mid_py = int(np.clip(((seg["y2"] + hit["y"]) / 2) * hi, 0, hi - 1))
                        if gray_img[mid_py, mid_px] > 180:
                            continue

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
            left_v = [v for v in v_walls
                      if v["x"] < seg["x1"]
                      and v["y1"] - force_snap <= y <= v["y2"] + force_snap]
            if left_v:
                hit = max(left_v, key=lambda v: v["x"])
                gap = seg["x1"] - hit["x"]
                if 0 < gap <= force_snap:
                    if gray_img is not None:
                        hi, wi = gray_img.shape[:2]
                        mid_px = int(np.clip(((hit["x"] + seg["x1"]) / 2) * wi, 0, wi - 1))
                        mid_py = int(np.clip(y * hi, 0, hi - 1))
                        if gray_img[mid_py, mid_px] > 180:
                            continue

                    new_h.append({
                        "x1": float(hit["x"]),
                        "x2": float(seg["x1"]),
                        "y": float(y),
                        "t": seg.get("t", cfg["thickness"]),
                        "source": "force_connect",
                        "synthetic": True,
                    })
                    
        if not _h_anchored(seg["x2"], y, v_walls, snap * 2):
            right_v = [v for v in v_walls
                       if v["x"] > seg["x2"]
                       and v["y1"] - force_snap <= y <= v["y2"] + force_snap]
            if right_v:
                hit = min(right_v, key=lambda v: v["x"])
                gap = hit["x"] - seg["x2"]
                if 0 < gap <= force_snap:
                    if gray_img is not None:
                        hi, wi = gray_img.shape[:2]
                        mid_px = int(np.clip(((seg["x2"] + hit["x"]) / 2) * wi, 0, wi - 1))
                        mid_py = int(np.clip(y * hi, 0, hi - 1))
                        if gray_img[mid_py, mid_px] > 180:
                            continue

                    new_h.append({
                        "x1": float(seg["x2"]),
                        "x2": float(hit["x"]),
                        "y": float(y),
                        "t": seg.get("t", cfg["thickness"]),
                        "source": "force_connect",
                        "synthetic": True,
                    })

    if new_h or new_v:
        h_walls = h_walls + new_h
        v_walls = v_walls + new_v
        h_walls, v_walls = _snap_merge(h_walls, v_walls, cfg)

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
    min_px = max(10, int(h_img * w_img * MIN_ROOM_AREA * 0.5))    
    all_cells = []
    for lid in range(1, n_labels):
        comp = (labels_img == lid).astype(np.uint8) * 255
        if int(comp.sum()) // 255 < min_px:
            continue
        # dilate back to reclaim wall-zone pixels
        dil_px = max(2, wall_px // 3)
        k_dil = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (dil_px * 2 + 1, dil_px * 2 + 1)
        )
        comp = cv2.bitwise_and(cv2.dilate(comp, k_dil), mask_img)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        cnt = max(cnts, key=cv2.contourArea)
        if cv2.contourArea(cnt) < min_px:
            continue
        norm = [(_clip(float(x) / w_img), _clip(float(y) / h_img)) for x, y in cnt[:, 0]]
        poly = _clean_poly(Polygon(norm))
        if poly is None:
            continue
        poly = _largest_poly(poly.simplify(0.002, preserve_topology=True))
        if poly is None or poly.area < MIN_ROOM_AREA:
            continue
        try:
            poly = _largest_poly(poly.intersection(boundary))
        except Exception:
            continue
        if poly is None or poly.area < MIN_ROOM_AREA:
            continue
        all_cells.append(poly)

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
            if diff is None or diff.area < poly.area * 0.15:
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


def _raster_rooms_valid(rooms: list, room_masks: list, boundary: Polygon) -> bool:
    if not rooms:
        return False
    try:
        covered = unary_union([
            Polygon([(p["x"], p["y"]) for p in r["polygon"]])
            for r in rooms if len(r.get("polygon", [])) >= 3
        ])
        mask_area = unary_union([m["polygon"] for m in room_masks]).area
        ratio = covered.area / max(mask_area, 1e-6)
        if ratio < 0.25:
            print(f"❌ raster_cut: coverage {ratio:.2f} < 0.35")
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
            ppm=ppm,
            img_shape=img_shape
        )

        if room:

            rooms.append(room)

            occupied = (
                unary_union([occupied, poly])
                if not occupied.is_empty
                else poly
            )

    return rooms


def _make_room(label, index, poly, ppm=None, img_shape=None) -> Optional[dict]:
    pts = _poly_pts(poly)
    if not pts:
        return None
    center = poly.centroid
    slug = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_") or "room"

    area_sqm = None
    if ppm and img_shape:
        H, W = img_shape[:2]
        area_px2 = poly.area * W * H
        area_sqm = round(area_px2 / (ppm ** 2), 2)

    return {
        "id": f"room_{slug}_{index}",
        "name": label,
        "label": label,
        "polygon": pts,
        "wallPolygon": pts,
        "center": {"x": float(center.x), "y": float(center.y)},
        "bbox": _bbox(poly),
        "areaNorm": float(poly.area),
        "areaSqm": area_sqm,   # ← None ถ้ายังไม่ calibrate, ตัวเลขจริงถ้า calibrate แล้ว
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
