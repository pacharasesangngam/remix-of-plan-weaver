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
MIN_ROOM_AREA = 0.008

WALL_EXT_CLR = (200, 80, 30)
WALL_INT_CLR = (80, 160, 60)
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
        debug_images["02_dark_threshold"] = encode_preview(cv2.cvtColor(_dark_line_mask(clean_image), cv2.COLOR_GRAY2BGR))
    geometry = build_geometry(clean_image, yolo_result, debug_images=debug_images if debug else None)
    geometry["rooms"] = [r for r in geometry["rooms"] if r.get("areaNorm", 0) >= MIN_ROOM_AREA]
    _estimate_widths(geometry)
    preview = encode_preview(draw_preview(clean_image, geometry))

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


def build_geometry(image: np.ndarray, yolo_results, debug_images=None) -> dict:
    h, w = image.shape[:2]
    room_masks = _extract_room_masks(yolo_results, w, h)
    yolo_h, yolo_v = _extract_walls_yolo(yolo_results, w, h)
    cv_h, cv_v = _extract_walls_cv(image)
    doors = _extract_openings(yolo_results, w, h, "door")
    windows = _extract_openings(yolo_results, w, h, "window")

    all_h = yolo_h + cv_h
    all_v = yolo_v + cv_v

    if debug_images is not None:
        debug_images["03_yolo_walls"] = encode_preview(_debug_wall_image(image, yolo_h, yolo_v, "YOLO walls", (255, 100, 0), 4))
        debug_images["04_cv_walls"] = encode_preview(_debug_wall_image(image, cv_h, cv_v, "CV dark-line walls", (0, 255, 255), 3))

    boundary = _build_boundary(room_masks, all_h, all_v)
    cfg = _wall_config(all_h, all_v)

    # --- Stage 1: CV binary + door-close → connected components ---
    cv_cells = _cv_room_segments(image, doors, boundary, w, h)
    if cv_cells and _cells_valid(cv_cells, room_masks, boundary):
        h_walls, v_walls = _process_wall_graph(all_h, all_v, doors + windows, boundary, cfg)
        if debug_images is not None:
            debug_images["05_final_walls"] = encode_preview(_debug_wall_image(image, h_walls, v_walls, "Final walls", (0, 255, 0), 4))
        rooms = _assign_rooms(cv_cells, room_masks, boundary, cfg)
        walls = _wall_output(h_walls, v_walls, boundary)
        return {
            "rooms": rooms, "walls": walls, "doors": doors, "windows": windows,
            "meta": {"mode": "cv_binary", "roomMaskCount": len(room_masks),
                     "roomCount": len(rooms), "wallCount": len(walls),
                     "doorCount": len(doors), "windowCount": len(windows)},
        }

    # --- Stage 2: wall-graph polygonize ---
    h_walls, v_walls = _process_wall_graph(all_h, all_v, doors + windows, boundary, cfg)

    if debug_images is not None:
        debug_images["05_final_walls"] = encode_preview(_debug_wall_image(image, h_walls, v_walls, "Final walls", (0, 255, 0), 4))

    cells = _polygonize_cells(h_walls, v_walls, boundary)
    if _cells_valid(cells, room_masks, boundary):
        rooms = _assign_rooms(cells, room_masks, boundary, cfg)
        mode = "polygonize"
    else:
        rooms = _rooms_from_masks(room_masks, boundary)
        mode = "mask_direct"

    if not rooms:
        fallback = _make_room("Floor", 1, boundary)
        rooms = [fallback] if fallback else []
        mode = "boundary_fallback"

    walls = _wall_output(h_walls, v_walls, boundary)
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


def _clip(v: float) -> float:
    return float(np.clip(v, 0.0, 1.0))


def _extract_room_masks(results, w, h) -> list[dict]:
    out = []
    if results.masks is None or results.boxes is None:
        return out
    count = min(len(results.masks.xy), len(results.boxes.cls))
    for i in range(count):
        label = results.names[int(results.boxes.cls[i])]
        conf = float(results.boxes.conf[i])
        if "room" not in label.lower() or conf < ROOM_CONF:
            continue
        pts = results.masks.xy[i]
        if pts is None or len(pts) < 3:
            continue
        norm = [(_clip(x / w), _clip(y / h)) for x, y in pts]
        poly = _clean_poly(Polygon(norm))
        if poly is None or poly.area < 0.0002:
            continue
        c = poly.centroid
        out.append({"label": label, "conf": conf, "polygon": poly, "centroid": (float(c.x), float(c.y))})
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
        out.append({"id": f"{kind}-{i}", "bbox": bbox, "polygon": polygon, "widthPx": float(max(bbox["w"] * w, bbox["h"] * h)), "widthM": None})
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
            h_walls.append({"x1": _clip((cx - length / 2) / w), "x2": _clip((cx + length / 2) / w), "y": _clip(cy / h), "t": t, "source": "yolo"})
        else:
            v_walls.append({"x": _clip(cx / w), "y1": _clip((cy - length / 2) / h), "y2": _clip((cy + length / 2) / h), "t": t, "source": "yolo"})
    for seg in h_walls:
        if seg["x1"] > seg["x2"]:
            seg["x1"], seg["x2"] = seg["x2"], seg["x1"]
    for seg in v_walls:
        if seg["y1"] > seg["y2"]:
            seg["y1"], seg["y2"] = seg["y2"], seg["y1"]
    return h_walls, v_walls


def _extract_walls_cv(image: np.ndarray):
    h, w = image.shape[:2]
    binary = _dark_line_mask(image)
    h_m = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(24, w // 34), 1)))
    v_m = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(24, h // 34))))
    min_l = max(34, int(min(w, h) * 0.045))
    h_walls, v_walls = [], []
    for cnt in cv2.findContours(h_m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        bx, by, bw, bh = cv2.boundingRect(cnt)
        if bw < min_l or bw < bh * 4.0 or bh > max(28, h * 0.045):
            continue
        h_walls.append({"x1": _clip(bx / w), "x2": _clip((bx + bw) / w), "y": _clip((by + bh / 2) / h), "t": float(np.clip(bh / max(w, h), 0.005, 0.03)), "source": "cv"})
    for cnt in cv2.findContours(v_m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        bx, by, bw, bh = cv2.boundingRect(cnt)
        if bh < min_l or bh < bw * 4.0 or bw > max(28, w * 0.045):
            continue
        v_walls.append({"x": _clip((bx + bw / 2) / w), "y1": _clip(by / h), "y2": _clip((by + bh) / h), "t": float(np.clip(bw / max(w, h), 0.005, 0.03)), "source": "cv"})
    return _filter_staircase_walls(h_walls, v_walls)


def _cv_room_segments(image: np.ndarray, doors: list, boundary: Polygon, w: int, h: int) -> list:
    """Detect room cells directly from binary wall mask + door-closing."""
    binary = _dark_line_mask(image)

    # Close only actual door/window openings (not general gaps)
    closed = binary.copy()
    for opening in doors:
        bbox = opening.get("bbox", {})
        x1 = max(0, int(bbox.get("x", 0) * w) - 3)
        y1 = max(0, int(bbox.get("y", 0) * h) - 3)
        x2 = min(w, int((bbox.get("x", 0) + bbox.get("w", 0)) * w) + 3)
        y2 = min(h, int((bbox.get("y", 0) + bbox.get("h", 0)) * h) + 3)
        cv2.rectangle(closed, (x1, y1), (x2, y2), 255, -1)

    # Tiny close to bridge wall-pixel micro-gaps (not door-sized)
    closed = cv2.morphologyEx(closed, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))

    # Room space = white areas inside the plan boundary
    bx, by, bw, bh = (int(boundary.bounds[0] * w), int(boundary.bounds[1] * h),
                      int((boundary.bounds[2] - boundary.bounds[0]) * w),
                      int((boundary.bounds[3] - boundary.bounds[1]) * h))
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[by:by + bh, bx:bx + bw] = 255
    room_space = cv2.bitwise_and(255 - closed, mask)

    # Remove tiny noise (furniture symbols, fixture outlines)
    open_px = max(8, min(w, h) // 65)
    room_space = cv2.morphologyEx(room_space, cv2.MORPH_OPEN,
                                  cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_px, open_px)))

    n, labels, stats, _ = cv2.connectedComponentsWithStats(room_space)
    if n < 3:
        return []

    min_px = max(int(w * h * 0.012), 400)
    cells = []
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < min_px:
            continue
        comp = ((labels == i) * 255).astype(np.uint8)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        cnt = max(cnts, key=cv2.contourArea)
        eps = max(3.0, cv2.arcLength(cnt, True) * 0.018)
        approx = cv2.approxPolyDP(cnt, eps, True)
        if len(approx) < 3:
            continue
        poly = _clean_poly(Polygon([(_clip(float(p[0][0]) / w), _clip(float(p[0][1]) / h))
                                    for p in approx]))
        if poly is None or poly.area < 0.001:
            continue
        poly = _largest_poly(poly.simplify(0.005, preserve_topology=True))
        if poly:
            cells.append(poly)

    return cells


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
        "connect_gap": float(np.clip(snap * 3.5, 0.040, 0.10)),
        "bnd_pad": float(np.clip(snap * 1.5, 0.012, 0.04)),
    }


def _process_wall_graph(h_raw, v_raw, openings, boundary, cfg):
    h_walls, v_walls = [dict(seg) for seg in h_raw], [dict(seg) for seg in v_raw]
    h_walls, v_walls = _snap_merge(h_walls, v_walls, cfg)
    _heal(h_walls, v_walls, cfg)
    _bridge_openings(h_walls, v_walls, openings, cfg)
    _snap_anchors(h_walls, v_walls, cfg)
    h_walls, v_walls = _snap_merge(h_walls, v_walls, cfg)
    h_walls, v_walls = _clip_to_boundary(h_walls, v_walls, boundary, cfg)
    h_walls, v_walls = _filter_structural(h_walls, v_walls, boundary, cfg)
    h_walls, v_walls = _ensure_outer_edges(h_walls, v_walls, boundary, cfg)
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


def _bridge_openings(h_walls, v_walls, openings, cfg):
    snap, connect = cfg["snap"], cfg["connect_gap"]
    for opening in openings:
        bbox = opening.get("bbox", {})
        ox = float(bbox.get("x", 0)) + float(bbox.get("w", 0)) / 2
        oy = float(bbox.get("y", 0)) + float(bbox.get("h", 0)) / 2
        ow, oh = float(bbox.get("w", 0)), float(bbox.get("h", 0))
        if ow <= 0 or oh <= 0:
            continue
        if ow >= oh:
            candidates = [seg for seg in h_walls if abs(seg["y"] - oy) <= connect]
            if not candidates:
                continue
            y = min(candidates, key=lambda seg: abs(seg["y"] - oy))["y"]
            left = [seg for seg in candidates if abs(seg["y"] - y) <= snap and seg["x2"] <= ox]
            right = [seg for seg in candidates if abs(seg["y"] - y) <= snap and seg["x1"] >= ox]
            if left and right:
                lw, rw = max(left, key=lambda seg: seg["x2"]), min(right, key=lambda seg: seg["x1"])
                gap = rw["x1"] - lw["x2"]
                if 0 < gap <= max(connect, ow * 1.9 + snap):
                    h_walls.append({"x1": lw["x2"], "x2": rw["x1"], "y": y, "t": max(lw["t"], rw["t"]), "source": "bridge"})
        else:
            candidates = [seg for seg in v_walls if abs(seg["x"] - ox) <= connect]
            if not candidates:
                continue
            x = min(candidates, key=lambda seg: abs(seg["x"] - ox))["x"]
            top = [seg for seg in candidates if abs(seg["x"] - x) <= snap and seg["y2"] <= oy]
            bottom = [seg for seg in candidates if abs(seg["x"] - x) <= snap and seg["y1"] >= oy]
            if top and bottom:
                tw, bw = max(top, key=lambda seg: seg["y2"]), min(bottom, key=lambda seg: seg["y1"])
                gap = bw["y1"] - tw["y2"]
                if 0 < gap <= max(connect, oh * 1.9 + snap):
                    v_walls.append({"x": x, "y1": tw["y2"], "y2": bw["y1"], "t": max(tw["t"], bw["t"]), "source": "bridge"})


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
    interior_keep = max(0.075, snap * 3.5)

    def on_h(seg):
        return abs(seg["y"] - miny) <= snap * 1.5 or abs(seg["y"] - maxy) <= snap * 1.5

    def on_v(seg):
        return abs(seg["x"] - minx) <= snap * 1.5 or abs(seg["x"] - maxx) <= snap * 1.5

    def h_conn(seg):
        y = seg["y"]
        return sum(1 for v in v_walls if seg["x1"] - snap <= v["x"] <= seg["x2"] + snap and v["y1"] - snap <= y <= v["y2"] + snap)

    def v_conn(seg):
        x = seg["x"]
        return sum(1 for h in h_walls if seg["y1"] - snap <= h["y"] <= seg["y2"] + snap and h["x1"] - snap <= x <= h["x2"] + snap)

    out_h = [
        seg for seg in h_walls
        if seg.get("synthetic")
        or on_h(seg)
        or seg["x2"] - seg["x1"] >= interior_keep
        or (seg["x2"] - seg["x1"] >= min_keep and h_conn(seg) >= 1)
    ]
    out_v = [
        seg for seg in v_walls
        if seg.get("synthetic")
        or on_v(seg)
        or seg["y2"] - seg["y1"] >= interior_keep
        or (seg["y2"] - seg["y1"] >= min_keep and v_conn(seg) >= 1)
    ]
    return out_h, out_v


def _ensure_outer_edges(h_walls, v_walls, boundary, cfg):
    minx, miny, maxx, maxy = boundary.bounds
    snap, thickness = cfg["snap"], cfg["thickness"]

    def h_cover(y):
        span = maxx - minx
        if span <= 0:
            return 1.0
        return sum(max(0, min(seg["x2"], maxx) - max(seg["x1"], minx)) for seg in h_walls if abs(seg["y"] - y) <= snap) / span

    def v_cover(x):
        span = maxy - miny
        if span <= 0:
            return 1.0
        return sum(max(0, min(seg["y2"], maxy) - max(seg["y1"], miny)) for seg in v_walls if abs(seg["x"] - x) <= snap) / span

    for y in [miny, maxy]:
        if h_cover(y) < 0.75:
            h_walls.append({"x1": float(minx), "x2": float(maxx), "y": float(y), "t": thickness, "synthetic": True, "source": "shell"})
    for x in [minx, maxx]:
        if v_cover(x) < 0.75:
            v_walls.append({"x": float(x), "y1": float(miny), "y2": float(maxy), "t": thickness, "synthetic": True, "source": "shell"})
    return h_walls, v_walls


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
    candidates = []

    if room_masks:
        union = unary_union([mask["polygon"] for mask in room_masks])
        poly = _largest_poly(union)
        if poly and poly.area > 0.001:
            shell = _largest_poly(poly.buffer(0.018, join_style=2).simplify(0.006, preserve_topology=True))
            if shell:
                candidates.append(shell)

    xs = [seg["x1"] for seg in h_walls] + [seg["x2"] for seg in h_walls] + [seg["x"] for seg in v_walls]
    ys = [seg["y"] for seg in h_walls] + [seg["y1"] for seg in v_walls] + [seg["y2"] for seg in v_walls]
    if xs and ys:
        pad = 0.012
        candidates.append(Polygon([
            (_clip(min(xs) - pad), _clip(min(ys) - pad)),
            (_clip(max(xs) + pad), _clip(min(ys) - pad)),
            (_clip(max(xs) + pad), _clip(max(ys) + pad)),
            (_clip(min(xs) - pad), _clip(max(ys) + pad)),
        ]))

    if candidates:
        merged = _largest_poly(unary_union(candidates))
        if merged:
            return merged

    return Polygon([(0.02, 0.02), (0.98, 0.02), (0.98, 0.98), (0.02, 0.98)])


def _polygonize_cells(h_walls, v_walls, boundary) -> list:
    lines = [_seg_line(seg, "h") for seg in h_walls if seg["x2"] - seg["x1"] > 1e-5]
    lines += [_seg_line(seg, "v") for seg in v_walls if seg["y2"] - seg["y1"] > 1e-5]
    boundary_line = boundary.boundary
    lines += list(boundary_line.geoms) if hasattr(boundary_line, "geoms") else [boundary_line]
    try:
        raw = list(polygonize(unary_union(lines)))
    except Exception:
        return []
    min_area = max(boundary.area * 0.018, 0.0008)
    cells, occupied = [], GeometryCollection()
    for cell in sorted(raw, key=lambda item: -item.area):
        clipped = _largest_poly(cell.intersection(boundary))
        if not clipped or clipped.area < min_area:
            continue
        if not occupied.is_empty:
            clipped = _largest_poly(clipped.difference(occupied.buffer(1e-6)))
            if not clipped or clipped.area < min_area:
                continue
        cells.append(clipped)
        occupied = unary_union([occupied, clipped]) if not occupied.is_empty else clipped
    return cells


def _cells_valid(cells, room_masks, boundary) -> bool:
    if not cells:
        return False
    if not room_masks:
        return len(cells) > 0
    count = len(room_masks)
    min_area = max(boundary.area * 0.018, 0.0008)
    large_cells = [c for c in cells if c.area >= min_area]
    if len(large_cells) < max(1, int(count * 0.45)) or len(large_cells) > max(count * 3 + 4, 14):
        return False
    cell_area = sum(c.area for c in large_cells)
    mask_area = unary_union([mask["polygon"] for mask in room_masks]).intersection(boundary).area
    if mask_area <= 0 or not (0.45 <= cell_area / mask_area <= 1.55):
        return False
    hits = sum(
        1
        for mask in room_masks
        if any(c.contains(Point(mask["centroid"])) or c.distance(Point(mask["centroid"])) <= 0.025 for c in large_cells)
    )
    return hits >= max(1, int(count * 0.60))


def _assign_rooms(cells, room_masks, boundary, cfg) -> list:
    used, rooms, counters = set(), [], defaultdict(int)
    snap = cfg["snap"]
    min_area = max(boundary.area * 0.018, 0.0008)
    viable = [(i, c) for i, c in enumerate(cells) if c.area >= min_area]
    for mask in room_masks:
        point = Point(mask["centroid"])
        choices = [(i, cell) for i, cell in viable if i not in used and (cell.contains(point) or cell.distance(point) <= snap)]
        if not choices:
            choices = [(i, cell) for i, cell in viable if i not in used]
        if not choices:
            continue
        index, cell = min(choices, key=lambda item: item[1].centroid.distance(point))
        used.add(index)
        counters[mask["label"]] += 1
        room = _make_room(mask["label"], counters[mask["label"]], cell)
        if room:
            rooms.append(room)
    unnamed_min = max(boundary.area * 0.10, 0.005)
    for i, cell in viable:
        if i in used:
            continue
        if cell.area < unnamed_min:
            continue
        counters["Room"] += 1
        room = _make_room("Room", counters["Room"], cell)
        if room:
            rooms.append(room)
    return _deoverlap(rooms, boundary)


def _rooms_from_masks(room_masks, boundary) -> list:
    rooms, counters, occupied = [], defaultdict(int), GeometryCollection()
    for mask in sorted(room_masks, key=lambda item: -item["polygon"].area):
        poly = _largest_poly(mask["polygon"].intersection(boundary))
        if not poly or poly.area < MIN_ROOM_AREA:
            continue
        if not occupied.is_empty:
            poly = _largest_poly(poly.difference(occupied.buffer(1e-6)))
            if not poly or poly.area < MIN_ROOM_AREA:
                continue
        counters[mask["label"]] += 1
        room = _make_room(mask["label"], counters[mask["label"]], poly)
        if room:
            rooms.append(room)
            occupied = unary_union([occupied, poly]) if not occupied.is_empty else poly
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
        poly = _largest_poly(Polygon([(point["x"], point["y"]) for point in room["polygon"]]).intersection(boundary))
        if not poly:
            continue
        if not occupied.is_empty:
            poly = _largest_poly(poly.difference(occupied.buffer(1e-6)))
            if not poly:
                continue
        pts = _poly_pts(poly)
        if not pts:
            continue
        center = poly.centroid
        room.update({"polygon": pts, "wallPolygon": pts, "center": {"x": float(center.x), "y": float(center.y)}, "bbox": _bbox(poly), "areaNorm": float(poly.area)})
        cleaned.append(room)
        occupied = unary_union([occupied, poly]) if not occupied.is_empty else poly
    return cleaned


def _wall_output(h_walls, v_walls, boundary) -> list:
    minx, miny, maxx, maxy = boundary.bounds
    tol, walls, index = 0.024, [], 1
    for seg in h_walls:
        if seg["x2"] - seg["x1"] <= 1e-5:
            continue
        wall_type = "exterior" if seg.get("synthetic") or abs(seg["y"] - miny) <= tol or abs(seg["y"] - maxy) <= tol else "interior"
        walls.append({"id": f"w{index}", "type": wall_type, "x1": float(seg["x1"]), "y1": float(seg["y"]), "x2": float(seg["x2"]), "y2": float(seg["y"]), "thicknessRatio": float(seg.get("t", 0.012))})
        index += 1
    for seg in v_walls:
        if seg["y2"] - seg["y1"] <= 1e-5:
            continue
        wall_type = "exterior" if seg.get("synthetic") or abs(seg["x"] - minx) <= tol or abs(seg["x"] - maxx) <= tol else "interior"
        walls.append({"id": f"w{index}", "type": wall_type, "x1": float(seg["x"]), "y1": float(seg["y1"]), "x2": float(seg["x"]), "y2": float(seg["y2"]), "thicknessRatio": float(seg.get("t", 0.012))})
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
        pts = room.get("polygon", [])
        if len(pts) < 3:
            continue
        arr = np.array([[px(point["x"], point["y"])] for point in pts], dtype=np.int32)
        cv2.fillPoly(overlay, [arr], _room_color(room.get("label", "Room")))
    cv2.addWeighted(overlay, 0.25, out, 0.75, 0, out)

    for room in geometry.get("rooms", []):
        pts = room.get("polygon", [])
        if len(pts) < 3:
            continue
        arr = np.array([[px(point["x"], point["y"])] for point in pts], dtype=np.int32)
        cx, cy = px(room["center"]["x"], room["center"]["y"])
        _put_label(out, room.get("label", ""), cx, cy)

    for wall in geometry.get("walls", []):
        x1, y1 = px(wall["x1"], wall["y1"])
        x2, y2 = px(wall["x2"], wall["y2"])
        color = WALL_EXT_CLR if wall.get("type") == "exterior" else WALL_INT_CLR
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
        (WALL_EXT_CLR, "exterior wall"),
        (WALL_INT_CLR, "interior wall"),
        (DOOR_CLR, "door"),
        (WIN_CLR, "window"),
    ]):
        y = 10 + i * 18
        cv2.rectangle(img, (10, y), (22, y + 12), color, -1)
        cv2.putText(img, text, (26, y + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (30, 30, 30), 1, cv2.LINE_AA)
