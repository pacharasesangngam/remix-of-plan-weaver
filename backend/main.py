import base64
import cv2
import fitz
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO
from shapely.geometry import LineString, Polygon, Point
from shapely.ops import polygonize, unary_union
from collections import defaultdict

app = FastAPI(title="Floor Plan Vision API")
model = YOLO("best_v2.pt")
IMG_SIZE = 960

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────
# Utility helpers
# ─────────────────────────────────────────────────────────────

def to_python(obj):
    if isinstance(obj, dict):
        return {k: to_python(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_python(i) for i in obj]
    if isinstance(obj, np.generic):
        return obj.item()
    return obj


def normalized_bbox_from_poly(poly, width, height):
    if poly is None or len(poly) < 3:
        return None
    pts = np.array(poly, dtype=np.float32)
    x_min = float(np.clip(np.min(pts[:, 0]), 0, width))
    y_min = float(np.clip(np.min(pts[:, 1]), 0, height))
    x_max = float(np.clip(np.max(pts[:, 0]), 0, width))
    y_max = float(np.clip(np.max(pts[:, 1]), 0, height))
    if x_max <= x_min or y_max <= y_min:
        return None
    return {
        "x": x_min / width,
        "y": y_min / height,
        "w": (x_max - x_min) / width,
        "h": (y_max - y_min) / height,
    }


def normalized_polygon(poly, width, height):
    if poly is None or len(poly) < 3:
        return None
    pts = np.array(poly, dtype=np.float32)
    pts[:, 0] = np.clip(pts[:, 0], 0, width) / width
    pts[:, 1] = np.clip(pts[:, 1], 0, height) / height
    return [{"x": float(x), "y": float(y)} for x, y in pts]


def decode_input_image(file_bytes, filename=""):
    lower_name = (filename or "").lower()
    if lower_name.endswith(".pdf") or file_bytes[:4] == b"%PDF":
        pdf = fitz.open(stream=file_bytes, filetype="pdf")
        if pdf.page_count == 0:
            raise ValueError("PDF has no pages")
        page = pdf.load_page(0)
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        pdf.close()
        return cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    nparr = np.frombuffer(file_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Unsupported file format")
    return img


def encode_image_data_url(img):
    success, encoded = cv2.imencode(".png", img)
    if not success:
        return None
    return f"data:image/png;base64,{base64.b64encode(encoded.tobytes()).decode('ascii')}"


# ─────────────────────────────────────────────────────────────
# Step 1 — Extract raw wall segments from YOLO masks
# ─────────────────────────────────────────────────────────────

def extract_raw_walls(results, width, height):
    raw_walls = []
    if results.masks is None:
        return raw_walls
    for i, (cls, conf) in enumerate(zip(results.boxes.cls, results.boxes.conf)):
        if conf < 0.25:
            continue
        if results.names[int(cls)] != "wall":
            continue
        poly = results.masks.xy[i]
        if poly is None or len(poly) < 3:
            continue
        pts = np.array(poly, dtype=np.float32)
        rect = cv2.minAreaRect(pts)
        (cx, cy), (w_rect, h_rect), angle = rect
        if w_rect < 1 or h_rect < 1:
            continue
        if w_rect > h_rect:
            length, thickness, theta = w_rect, h_rect, np.deg2rad(angle)
        else:
            length, thickness, theta = h_rect, w_rect, np.deg2rad(angle + 90)
        dx = (length / 2.0) * np.cos(theta)
        dy = (length / 2.0) * np.sin(theta)
        raw_walls.append({
            "x1": (cx - dx) / width,
            "y1": (cy - dy) / height,
            "x2": (cx + dx) / width,
            "y2": (cy + dy) / height,
            "thicknessRatio": thickness / max(width, height),
        })
    return raw_walls


# ─────────────────────────────────────────────────────────────
# Step 2 — Build Manhattan World skeleton (100% orthogonal)
# ─────────────────────────────────────────────────────────────

def _merge_collinear_h(h_walls, y_tol, gap_tol):
    """Merge H segments on similar Y levels, closing small gaps."""
    if not h_walls:
        return []
    groups = []
    for hw in sorted(h_walls, key=lambda w: w["y"]):
        placed = False
        for g in groups:
            if abs(g["y_acc"] / g["n"] - hw["y"]) < y_tol:
                g["walls"].append(hw)
                g["y_acc"] += hw["y"]
                g["n"] += 1
                placed = True
                break
        if not placed:
            groups.append({"walls": [hw], "y_acc": hw["y"], "n": 1})
    result = []
    for g in groups:
        y_avg = g["y_acc"] / g["n"]
        merged = []
        for hw in sorted(g["walls"], key=lambda w: w["x1"]):
            if merged and hw["x1"] - merged[-1]["x2"] < gap_tol:
                merged[-1]["x2"] = max(merged[-1]["x2"], hw["x2"])
                merged[-1]["t"] = max(merged[-1]["t"], hw["t"])
            else:
                merged.append({"x1": hw["x1"], "x2": hw["x2"], "y": y_avg, "t": hw["t"]})
        for m in merged:
            m["y"] = y_avg
        result.extend(merged)
    return result


def _merge_collinear_v(v_walls, x_tol, gap_tol):
    """Merge V segments on similar X levels, closing small gaps."""
    if not v_walls:
        return []
    groups = []
    for vw in sorted(v_walls, key=lambda w: w["x"]):
        placed = False
        for g in groups:
            if abs(g["x_acc"] / g["n"] - vw["x"]) < x_tol:
                g["walls"].append(vw)
                g["x_acc"] += vw["x"]
                g["n"] += 1
                placed = True
                break
        if not placed:
            groups.append({"walls": [vw], "x_acc": vw["x"], "n": 1})
    result = []
    for g in groups:
        x_avg = g["x_acc"] / g["n"]
        merged = []
        for vw in sorted(g["walls"], key=lambda w: w["y1"]):
            if merged and vw["y1"] - merged[-1]["y2"] < gap_tol:
                merged[-1]["y2"] = max(merged[-1]["y2"], vw["y2"])
                merged[-1]["t"] = max(merged[-1]["t"], vw["t"])
            else:
                merged.append({"y1": vw["y1"], "y2": vw["y2"], "x": x_avg, "t": vw["t"]})
        for m in merged:
            m["x"] = x_avg
        result.extend(merged)
    return result


def _h_on_v(x, y, v_walls, tol=1e-3):
    return any(abs(vw["x"] - x) < tol and vw["y1"] - tol <= y <= vw["y2"] + tol for vw in v_walls)


def _v_on_h(x, y, h_walls, tol=1e-3):
    return any(abs(hw["y"] - y) < tol and hw["x1"] - tol <= x <= hw["x2"] + tol for hw in h_walls)


def _extend_dangling_ends(h_walls, v_walls, extend_tol=0.12):
    """Ray-casting structural healing for dangling endpoints. Operates in-place."""
    conn_tol = 1.5e-3
    for _ in range(2):
        for hw in h_walls:
            hy = hw["y"]
            if not _h_on_v(hw["x1"], hy, v_walls, conn_tol):
                cands = [vw for vw in v_walls
                         if vw["x"] < hw["x1"] - conn_tol
                         and vw["y1"] - conn_tol <= hy <= vw["y2"] + conn_tol]
                if cands:
                    near = max(cands, key=lambda v: v["x"])
                    if hw["x1"] - near["x"] <= extend_tol:
                        hw["x1"] = near["x"]
                        near["y1"] = min(near["y1"], hy)
                        near["y2"] = max(near["y2"], hy)
            if not _h_on_v(hw["x2"], hy, v_walls, conn_tol):
                cands = [vw for vw in v_walls
                         if vw["x"] > hw["x2"] + conn_tol
                         and vw["y1"] - conn_tol <= hy <= vw["y2"] + conn_tol]
                if cands:
                    near = min(cands, key=lambda v: v["x"])
                    if near["x"] - hw["x2"] <= extend_tol:
                        hw["x2"] = near["x"]
                        near["y1"] = min(near["y1"], hy)
                        near["y2"] = max(near["y2"], hy)
        for vw in v_walls:
            vx = vw["x"]
            if not _v_on_h(vx, vw["y1"], h_walls, conn_tol):
                cands = [hw for hw in h_walls
                         if hw["y"] < vw["y1"] - conn_tol
                         and hw["x1"] - conn_tol <= vx <= hw["x2"] + conn_tol]
                if cands:
                    near = max(cands, key=lambda h: h["y"])
                    if vw["y1"] - near["y"] <= extend_tol:
                        vw["y1"] = near["y"]
                        near["x1"] = min(near["x1"], vx)
                        near["x2"] = max(near["x2"], vx)
            if not _v_on_h(vx, vw["y2"], h_walls, conn_tol):
                cands = [hw for hw in h_walls
                         if hw["y"] > vw["y2"] + conn_tol
                         and hw["x1"] - conn_tol <= vx <= hw["x2"] + conn_tol]
                if cands:
                    near = min(cands, key=lambda h: h["y"])
                    if near["y"] - vw["y2"] <= extend_tol:
                        vw["y2"] = near["y"]
                        near["x1"] = min(near["x1"], vx)
                        near["x2"] = max(near["x2"], vx)


def build_manhattan_skeleton(raw_walls, snap_tol=0.025, merge_gap=0.035, extend_tol=0.12):
    """Orthogonalize → merge collinear → snap corners → heal dangling ends."""
    h_raw, v_raw = [], []
    for w in raw_walls:
        dx = abs(w["x2"] - w["x1"])
        dy = abs(w["y2"] - w["y1"])
        t = float(w.get("thicknessRatio", 0.01))
        if dx >= dy:
            y = (w["y1"] + w["y2"]) / 2.0
            x1, x2 = min(w["x1"], w["x2"]), max(w["x1"], w["x2"])
            if x2 - x1 > 5e-4:
                h_raw.append({"x1": x1, "x2": x2, "y": y, "t": t})
        else:
            x = (w["x1"] + w["x2"]) / 2.0
            y1, y2 = min(w["y1"], w["y2"]), max(w["y1"], w["y2"])
            if y2 - y1 > 5e-4:
                v_raw.append({"y1": y1, "y2": y2, "x": x, "t": t})

    h_walls = _merge_collinear_h(h_raw, y_tol=snap_tol, gap_tol=merge_gap)
    v_walls = _merge_collinear_v(v_raw, x_tol=snap_tol, gap_tol=merge_gap)

    for _ in range(3):
        for hw in h_walls:
            for vw in v_walls:
                vx, hy = vw["x"], hw["y"]
                if vw["y1"] - snap_tol <= hy <= vw["y2"] + snap_tol:
                    if abs(hw["x1"] - vx) <= snap_tol:
                        hw["x1"] = vx
                    if abs(hw["x2"] - vx) <= snap_tol:
                        hw["x2"] = vx
                if hw["x1"] - snap_tol <= vx <= hw["x2"] + snap_tol:
                    if abs(vw["y1"] - hy) <= snap_tol:
                        vw["y1"] = hy
                    if abs(vw["y2"] - hy) <= snap_tol:
                        vw["y2"] = hy

    _extend_dangling_ends(h_walls, v_walls, extend_tol=extend_tol)

    for hw in h_walls:
        for vw in v_walls:
            vx, hy = vw["x"], hw["y"]
            if vw["y1"] - snap_tol <= hy <= vw["y2"] + snap_tol:
                if abs(hw["x1"] - vx) <= snap_tol:
                    hw["x1"] = vx
                if abs(hw["x2"] - vx) <= snap_tol:
                    hw["x2"] = vx
            if hw["x1"] - snap_tol <= vx <= hw["x2"] + snap_tol:
                if abs(vw["y1"] - hy) <= snap_tol:
                    vw["y1"] = hy
                if abs(vw["y2"] - hy) <= snap_tol:
                    vw["y2"] = hy

    return h_walls, v_walls


# ─────────────────────────────────────────────────────────────
# Step 2b — Filter spurious wall segments
#            Outer-wall segments are EXEMPT from connectivity check
# ─────────────────────────────────────────────────────────────

def _filter_wall_outliers(h_walls, v_walls, min_len=0.025, conn_tol=0.02):
    """
    Remove YOLO false-positive stubs.
    Segments near the perimeter bbox are always kept — YOLO often
    detects outer walls as short isolated stubs that look like noise.
    """
    h_walls = [hw for hw in h_walls if hw["x2"] - hw["x1"] >= min_len]
    v_walls = [vw for vw in v_walls if vw["y2"] - vw["y1"] >= min_len]

    all_x = ([hw["x1"] for hw in h_walls] + [hw["x2"] for hw in h_walls]
             + [vw["x"] for vw in v_walls])
    all_y = ([hw["y"] for hw in h_walls]
             + [vw["y1"] for vw in v_walls] + [vw["y2"] for vw in v_walls])
    if not all_x or not all_y:
        return h_walls, v_walls

    xmin, xmax = min(all_x), max(all_x)
    ymin, ymax = min(all_y), max(all_y)
    edge_tol = 0.06

    def is_outer_h(hw):
        return abs(hw["y"] - ymin) < edge_tol or abs(hw["y"] - ymax) < edge_tol

    def is_outer_v(vw):
        return abs(vw["x"] - xmin) < edge_tol or abs(vw["x"] - xmax) < edge_tol

    def h_ep_ok(px, py, src):
        for vw in v_walls:
            if abs(vw["x"] - px) < conn_tol and vw["y1"] - conn_tol <= py <= vw["y2"] + conn_tol:
                return True
        for hw in h_walls:
            if hw is src:
                continue
            if abs(hw["y"] - py) < conn_tol and (
                abs(hw["x1"] - px) < conn_tol or abs(hw["x2"] - px) < conn_tol
            ):
                return True
        return False

    def v_ep_ok(px, py, src):
        for hw in h_walls:
            if abs(hw["y"] - py) < conn_tol and hw["x1"] - conn_tol <= px <= hw["x2"] + conn_tol:
                return True
        for vw in v_walls:
            if vw is src:
                continue
            if abs(vw["x"] - px) < conn_tol and (
                abs(vw["y1"] - py) < conn_tol or abs(vw["y2"] - py) < conn_tol
            ):
                return True
        return False

    for _ in range(2):
        h_walls = [
            hw for hw in h_walls
            if is_outer_h(hw)
            or h_ep_ok(hw["x1"], hw["y"], hw)
            or h_ep_ok(hw["x2"], hw["y"], hw)
        ]
        v_walls = [
            vw for vw in v_walls
            if is_outer_v(vw)
            or v_ep_ok(vw["x"], vw["y1"], vw)
            or v_ep_ok(vw["x"], vw["y2"], vw)
        ]

    return h_walls, v_walls


# ─────────────────────────────────────────────────────────────
# Step 2c — Outer Shell Recovery
#            Guarantee a closed perimeter even when YOLO misses walls
# ─────────────────────────────────────────────────────────────

def recover_outer_shell(h_walls, v_walls):
    """
    Check coverage of all 4 perimeter edges.
    Any edge covered < 55% gets a synthetic full-length wall injected.
    Synthetic walls carry synthetic=True for downstream rendering.
    """
    if not h_walls and not v_walls:
        return h_walls, v_walls

    all_x = ([hw["x1"] for hw in h_walls] + [hw["x2"] for hw in h_walls]
             + [vw["x"] for vw in v_walls])
    all_y = ([hw["y"] for hw in h_walls]
             + [vw["y1"] for vw in v_walls] + [vw["y2"] for vw in v_walls])

    xmin, xmax = min(all_x), max(all_x)
    ymin, ymax = min(all_y), max(all_y)

    margin    = 0.005
    edge_band = 0.04
    min_cover = 0.55

    SX1, SX2 = xmin - margin, xmax + margin
    SY1, SY2 = ymin - margin, ymax + margin

    def h_coverage(target_y, x1r, x2r):
        span = x2r - x1r
        if span <= 0:
            return 1.0
        covered = sum(
            max(0.0, min(hw["x2"], x2r) - max(hw["x1"], x1r))
            for hw in h_walls if abs(hw["y"] - target_y) < edge_band
        )
        return min(covered / span, 1.0)

    def v_coverage(target_x, y1r, y2r):
        span = y2r - y1r
        if span <= 0:
            return 1.0
        covered = sum(
            max(0.0, min(vw["y2"], y2r) - max(vw["y1"], y1r))
            for vw in v_walls if abs(vw["x"] - target_x) < edge_band
        )
        return min(covered / span, 1.0)

    new_h = list(h_walls)
    new_v = list(v_walls)

    if h_coverage(ymin, xmin, xmax) < min_cover:
        new_h.append({"x1": SX1, "x2": SX2, "y": SY1, "t": 0.012, "synthetic": True})
    if h_coverage(ymax, xmin, xmax) < min_cover:
        new_h.append({"x1": SX1, "x2": SX2, "y": SY2, "t": 0.012, "synthetic": True})
    if v_coverage(xmin, ymin, ymax) < min_cover:
        new_v.append({"y1": SY1, "y2": SY2, "x": SX1, "t": 0.012, "synthetic": True})
    if v_coverage(xmax, ymin, ymax) < min_cover:
        new_v.append({"y1": SY1, "y2": SY2, "x": SX2, "t": 0.012, "synthetic": True})

    return new_h, new_v


# ─────────────────────────────────────────────────────────────
# Step 2d — Trim segments at every T/X intersection
#            Eliminates wall-overshoot at corners
# ─────────────────────────────────────────────────────────────

def trim_at_intersections(h_walls, v_walls, tol=1e-4):
    """
    Split each H segment at every V wall that crosses it, and vice versa.
    Produces clean T- and L-junctions with zero overhang.
    """
    new_h = []
    for hw in h_walls:
        hy  = hw["y"]
        t   = hw.get("t", 0.01)
        syn = hw.get("synthetic", False)
        cuts = {vw["x"] for vw in v_walls
                if vw["y1"] - tol <= hy <= vw["y2"] + tol
                and hw["x1"] + tol < vw["x"] < hw["x2"] - tol}
        if not cuts:
            new_h.append(hw)
            continue
        xs = sorted([hw["x1"]] + list(cuts) + [hw["x2"]])
        for i in range(len(xs) - 1):
            if xs[i + 1] - xs[i] > 1e-5:
                new_h.append({"x1": xs[i], "x2": xs[i + 1], "y": hy, "t": t, "synthetic": syn})

    new_v = []
    for vw in v_walls:
        vx  = vw["x"]
        t   = vw.get("t", 0.01)
        syn = vw.get("synthetic", False)
        cuts = {hw["y"] for hw in new_h
                if hw["x1"] - tol <= vx <= hw["x2"] + tol
                and vw["y1"] + tol < hw["y"] < vw["y2"] - tol}
        if not cuts:
            new_v.append(vw)
            continue
        ys = sorted([vw["y1"]] + list(cuts) + [vw["y2"]])
        for i in range(len(ys) - 1):
            if ys[i + 1] - ys[i] > 1e-5:
                new_v.append({"y1": ys[i], "y2": ys[i + 1], "x": vx, "t": t, "synthetic": syn})

    return new_h, new_v


# ─────────────────────────────────────────────────────────────
# Step 3 — Polygonize the wall graph into closed room cells
#
# FIX: Only add a shell edge when that side is NOT already covered
#      by detected walls — prevents sliver cells between real outer
#      walls and a duplicate synthetic shell line.
# ─────────────────────────────────────────────────────────────

def polygonize_floor(h_walls, v_walls, bbox_margin=0.008, shell_snap=0.04):
    """
    Convert the orthogonal wall graph to closed spatial cells via Shapely polygonize.

    Key change vs original:
    - Shell edges are added ONLY for sides not already covered by detected walls.
      Adding a duplicate shell alongside an existing outer wall creates a sliver
      cell (very thin room) at every perimeter edge — this is the main cause of
      "room split weirdly at the edge" bugs.
    """
    if not h_walls and not v_walls:
        return []

    all_x = ([hw["x1"] for hw in h_walls] + [hw["x2"] for hw in h_walls]
             + [vw["x"] for vw in v_walls])
    all_y = ([hw["y"] for hw in h_walls]
             + [vw["y1"] for vw in v_walls] + [vw["y2"] for vw in v_walls])
    xmin = max(0.0, min(all_x) - bbox_margin)
    xmax = min(1.0, max(all_x) + bbox_margin)
    ymin = max(0.0, min(all_y) - bbox_margin)
    ymax = min(1.0, max(all_y) + bbox_margin)

    # Snap peripheral endpoints onto the bbox shell.
    for hw in h_walls:
        if abs(hw["x1"] - xmin) <= shell_snap:
            hw["x1"] = xmin
        if abs(hw["x2"] - xmax) <= shell_snap:
            hw["x2"] = xmax
    for vw in v_walls:
        if abs(vw["y1"] - ymin) <= shell_snap:
            vw["y1"] = ymin
        if abs(vw["y2"] - ymax) <= shell_snap:
            vw["y2"] = ymax

    lines = []
    for hw in h_walls:
        if hw["x2"] - hw["x1"] > 1e-5:
            lines.append(LineString([(hw["x1"], hw["y"]), (hw["x2"], hw["y"])]))
    for vw in v_walls:
        if vw["y2"] - vw["y1"] > 1e-5:
            lines.append(LineString([(vw["x"], vw["y1"]), (vw["x"], vw["y2"])]))

    if not lines:
        return []

    # ── Smart shell: add edge only when coverage < threshold ─────
    # This prevents sliver cells between a real outer wall and a
    # duplicate shell line sitting 1–2 px away.
    edge_band  = 0.015   # tight band — wall must be very close to shell edge
    min_cover  = 0.80    # need 80% coverage to consider an edge already present

    def _h_cover(target_y, x1r, x2r):
        span = x2r - x1r
        if span <= 0:
            return 1.0
        covered = sum(
            max(0.0, min(hw["x2"], x2r) - max(hw["x1"], x1r))
            for hw in h_walls if abs(hw["y"] - target_y) < edge_band
        )
        return min(covered / span, 1.0)

    def _v_cover(target_x, y1r, y2r):
        span = y2r - y1r
        if span <= 0:
            return 1.0
        covered = sum(
            max(0.0, min(vw["y2"], y2r) - max(vw["y1"], y1r))
            for vw in v_walls if abs(vw["x"] - target_x) < edge_band
        )
        return min(covered / span, 1.0)

    if _h_cover(ymin, xmin, xmax) < min_cover:
        lines.append(LineString([(xmin, ymin), (xmax, ymin)]))
    if _h_cover(ymax, xmin, xmax) < min_cover:
        lines.append(LineString([(xmin, ymax), (xmax, ymax)]))
    if _v_cover(xmin, ymin, ymax) < min_cover:
        lines.append(LineString([(xmin, ymin), (xmin, ymax)]))
    if _v_cover(xmax, ymin, ymax) < min_cover:
        lines.append(LineString([(xmax, ymin), (xmax, ymax)]))

    try:
        merged = unary_union(lines)
        cells  = list(polygonize(merged))
        total_area = (xmax - xmin) * (ymax - ymin)
        min_area   = total_area * 0.004
        cells = [c for c in cells if not c.is_empty and c.area >= min_area]
        cells.sort(key=lambda c: -c.area)
        return cells
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────
# Step 4 — Extract room seed centroids from YOLO masks
# ─────────────────────────────────────────────────────────────

def extract_room_seeds(results, width, height):
    seeds = []
    if results.masks is None or results.boxes is None:
        return seeds
    n = min(
        len(results.masks.xy) if results.masks.xy is not None else 0,
        len(results.boxes.cls) if results.boxes.cls is not None else 0,
    )
    for i in range(n):
        cls   = results.boxes.cls[i]
        conf  = results.boxes.conf[i]
        label = results.names[int(cls)]
        if "room" not in label.lower() or conf < 0.25:
            continue
        poly = results.masks.xy[i]
        if poly is None or len(poly) < 3:
            continue
        pts = np.array(poly, dtype=np.float32)
        M = cv2.moments(pts.reshape(-1, 1, 2))
        if abs(M["m00"]) > 1e-6:
            cx = float(M["m10"] / M["m00"]) / width
            cy = float(M["m01"] / M["m00"]) / height
        else:
            cx = float(np.mean(pts[:, 0])) / width
            cy = float(np.mean(pts[:, 1])) / height
        seeds.append({
            "label": label,
            "cx": float(np.clip(cx, 0.0, 1.0)),
            "cy": float(np.clip(cy, 0.0, 1.0)),
        })
    return seeds


# ─────────────────────────────────────────────────────────────
# Step 5 — Assign room labels to cells
#
# FIX: Replace bisector-split with closest-cell assignment.
#
# Old approach: if a cell contained multiple seeds, split the cell
#   with a perpendicular bisector → produced non-wall-aligned boundaries
#   that looked wrong even when walls were correct.
#
# New approach:
#   Round 1 — direct Point-in-Polygon: each seed clains the cell it
#             sits inside.  If a cell has multiple seeds, the one
#             nearest the centroid wins the label; the others are
#             discarded (they belong to a cell that leaked because of
#             a missing wall — better to show one room than a fake split).
#   Round 2 — nearest-cell fallback: seeds that didn't land inside any
#             cell (e.g. seed is on a wall line) are matched to the
#             closest unoccupied cell by centroid distance.
#
# Result: every cell maps to exactly one label; no artificial
# bisector lines; room boundaries always follow real walls.
# ─────────────────────────────────────────────────────────────

def _shapely_to_pts(poly):
    if poly is None or poly.is_empty:
        return None
    coords = list(poly.exterior.coords)[:-1]
    if len(coords) < 3:
        return None
    return [{"x": float(x), "y": float(y)} for x, y in coords]


def _shapely_bbox(poly):
    if poly is None or poly.is_empty:
        return None
    minx, miny, maxx, maxy = poly.bounds
    return {"x": float(minx), "y": float(miny),
            "w": float(maxx - minx), "h": float(maxy - miny)}


def assign_rooms_to_cells(cells, seeds):
    """
    1-to-1 cell→label assignment with no bisector splitting.
    Each polygonized cell becomes exactly one room whose boundary
    always follows the real wall graph.
    """
    if not cells or not seeds:
        return []

    rooms       = []
    room_idx    = 0
    used_cells  = set()   # cell indices already assigned
    used_seeds  = set()   # seed indices already claimed

    # ── Round 1: Point-in-Polygon ─────────────────────────────────
    # Map each cell → list of seeds that fall inside it.
    cell_seeds: dict[int, list] = defaultdict(list)
    for si, s in enumerate(seeds):
        pt = Point(s["cx"], s["cy"])
        for ci, cell in enumerate(cells):
            if cell.contains(pt):
                cell_seeds[ci].append((si, s))
                used_seeds.add(si)
                break   # a seed belongs to exactly one cell

    for ci, seed_list in cell_seeds.items():
        cell = cells[ci]
        used_cells.add(ci)
        centroid = cell.centroid
        # When multiple seeds landed in the same cell (wall leak),
        # pick the one closest to the centroid as the room label.
        best_seed = min(
            seed_list,
            key=lambda x: (x[1]["cx"] - centroid.x) ** 2 + (x[1]["cy"] - centroid.y) ** 2,
        )[1]
        pts = _shapely_to_pts(cell)
        if not pts or len(pts) < 3:
            continue
        rooms.append({
            "id":         f"room-{room_idx}",
            "name":       best_seed["label"],
            "polygon":    pts,
            "wallPolygon": pts,
            "center":     {"x": float(centroid.x), "y": float(centroid.y)},
            "bbox":       _shapely_bbox(cell),
        })
        room_idx += 1

    # ── Round 2: nearest-cell fallback for unmatched seeds ────────
    # Handles seeds that sit exactly on a wall line (Point-in-Polygon
    # returns False for boundary points in Shapely).
    unmatched_seeds = [(si, s) for si, s in enumerate(seeds) if si not in used_seeds]
    free_cells      = [(ci, cells[ci]) for ci in range(len(cells)) if ci not in used_cells]

    for si, s in unmatched_seeds:
        if not free_cells:
            break
        pt = Point(s["cx"], s["cy"])
        best_ci, best_cell = min(
            free_cells,
            key=lambda x: x[1].centroid.distance(pt),
        )
        free_cells.remove((best_ci, best_cell))
        used_cells.add(best_ci)
        centroid = best_cell.centroid
        pts = _shapely_to_pts(best_cell)
        if not pts or len(pts) < 3:
            continue
        rooms.append({
            "id":         f"room-{room_idx}",
            "name":       s["label"],
            "polygon":    pts,
            "wallPolygon": pts,
            "center":     {"x": float(centroid.x), "y": float(centroid.y)},
            "bbox":       _shapely_bbox(best_cell),
        })
        room_idx += 1

    return rooms


# ─────────────────────────────────────────────────────────────
# Opening bridge — unchanged
# ─────────────────────────────────────────────────────────────

def _bridge_openings(h_walls, v_walls, openings):
    """Close wall-centerline gaps left by door/window detections. In-place."""
    wall_tol = 0.06
    new_h: list = []
    new_v: list = []

    for item in openings:
        bbox = item.get("bbox", {})
        ox1  = float(bbox.get("x", 0))
        oy1  = float(bbox.get("y", 0))
        ow   = float(bbox.get("w", 0))
        oh   = float(bbox.get("h", 0))
        if ow <= 0 or oh <= 0:
            continue
        ocx = ox1 + ow / 2
        ocy = oy1 + oh / 2

        if ow >= oh:
            near = [hw for hw in h_walls if abs(hw["y"] - ocy) < wall_tol]
            if not near:
                continue
            best_y = min(near, key=lambda hw: abs(hw["y"] - ocy))["y"]
            same_y = [hw for hw in near if abs(hw["y"] - best_y) < 1e-4]
            lefts  = [s for s in same_y if s["x2"] <= ocx]
            rights = [s for s in same_y if s["x1"] >= ocx]
            if lefts and rights:
                l = max(lefts,  key=lambda s: s["x2"])
                r = min(rights, key=lambda s: s["x1"])
                gap = r["x1"] - l["x2"]
                if 1e-4 < gap <= ow * 1.6 + 0.03:
                    new_h.append({"x1": l["x2"], "x2": r["x1"], "y": best_y,
                                  "t": max(l.get("t", 0.01), r.get("t", 0.01))})
        else:
            near = [vw for vw in v_walls if abs(vw["x"] - ocx) < wall_tol]
            if not near:
                continue
            best_x = min(near, key=lambda vw: abs(vw["x"] - ocx))["x"]
            same_x = [vw for vw in near if abs(vw["x"] - best_x) < 1e-4]
            tops = [s for s in same_x if s["y2"] <= ocy]
            bots = [s for s in same_x if s["y1"] >= ocy]
            if tops and bots:
                t = max(tops, key=lambda s: s["y2"])
                b = min(bots, key=lambda s: s["y1"])
                gap = b["y1"] - t["y2"]
                if 1e-4 < gap <= oh * 1.6 + 0.03:
                    new_v.append({"y1": t["y2"], "y2": b["y1"], "x": best_x,
                                  "t": max(t.get("t", 0.01), b.get("t", 0.01))})

    h_walls.extend(new_h)
    v_walls.extend(new_v)


def compute_floor_boundary(results, width, height, margin=0.03):
    """
    Union ของ room masks ทั้งหมด = พื้นที่บ้านจริง
    ขยาย margin เพื่อให้ผนังริมขอบยังอยู่ใน boundary
    """
    from shapely.ops import unary_union
    from shapely.geometry import Polygon
    
    room_polys = []
    if results.masks is None or results.boxes is None:
        return None
    
    n = min(
        len(results.masks.xy) if results.masks.xy is not None else 0,
        len(results.boxes.cls) if results.boxes.cls is not None else 0,
    )
    for i in range(n):
        label = results.names[int(results.boxes.cls[i])]
        conf  = results.boxes.conf[i]
        # รวม room + wall masks เพื่อให้ได้ floor ที่ครบ
        if conf < 0.25:
            continue
        poly = results.masks.xy[i]
        if poly is None or len(poly) < 3:
            continue
        pts = [(float(x / width), float(y / height)) for x, y in poly]
        try:
            p = Polygon(pts)
            if p.is_valid and not p.is_empty:
                room_polys.append(p)
        except Exception:
            continue
    
    if not room_polys:
        return None
    
    try:
        floor = unary_union(room_polys)
        # ขยาย margin เล็กน้อยเพื่อไม่ให้ผนังริมขอบถูกตัด
        floor = floor.buffer(margin)
        # เอาเฉพาะ convex hull ถ้า floor เป็น MultiPolygon แปลกๆ
        if floor.geom_type != "Polygon":
            floor = floor.convex_hull
        return floor
    except Exception:
        return None
# ─────────────────────────────────────────────────────────────
# Wall segment export
# ─────────────────────────────────────────────────────────────

def clip_walls_to_floor(h_walls, v_walls, floor_poly):
    """
    ตัด wall segments ที่อยู่นอก floor_poly ทิ้ง
    ถ้า segment พาดผ่านขอบ → ตัดเฉพาะส่วนที่อยู่ใน floor
    """
    if floor_poly is None:
        return h_walls, v_walls
    
    from shapely.geometry import LineString
    
    new_h = []
    for hw in h_walls:
        line = LineString([(hw["x1"], hw["y"]), (hw["x2"], hw["y"])])
        try:
            clipped = line.intersection(floor_poly)
        except Exception:
            new_h.append(hw)
            continue
        if clipped.is_empty:
            continue
        # intersection อาจได้ MultiLineString ถ้าเส้นพาดผ่านหลายส่วน
        if clipped.geom_type == "LineString":
            coords = list(clipped.coords)
            if len(coords) >= 2:
                new_h.append({**hw,
                    "x1": float(coords[0][0]),
                    "x2": float(coords[-1][0]),
                })
        elif clipped.geom_type == "MultiLineString":
            for seg in clipped.geoms:
                coords = list(seg.coords)
                if len(coords) >= 2:
                    x1 = min(coords[0][0], coords[-1][0])
                    x2 = max(coords[0][0], coords[-1][0])
                    if x2 - x1 > 1e-4:
                        new_h.append({**hw, "x1": float(x1), "x2": float(x2)})
    
    new_v = []
    for vw in v_walls:
        line = LineString([(vw["x"], vw["y1"]), (vw["x"], vw["y2"])])
        try:
            clipped = line.intersection(floor_poly)
        except Exception:
            new_v.append(vw)
            continue
        if clipped.is_empty:
            continue
        if clipped.geom_type == "LineString":
            coords = list(clipped.coords)
            if len(coords) >= 2:
                new_v.append({**vw,
                    "y1": float(min(coords[0][1], coords[-1][1])),
                    "y2": float(max(coords[0][1], coords[-1][1])),
                })
        elif clipped.geom_type == "MultiLineString":
            for seg in clipped.geoms:
                coords = list(seg.coords)
                if len(coords) >= 2:
                    y1 = min(coords[0][1], coords[-1][1])
                    y2 = max(coords[0][1], coords[-1][1])
                    if y2 - y1 > 1e-4:
                        new_v.append({**vw, "y1": float(y1), "y2": float(y2)})
    
    return new_h, new_v

def walls_to_segments(h_walls, v_walls):
    """Export wall dicts to API format. Synthetic walls get type='outer'."""
    segments = []
    idx = 0
    for hw in h_walls:
        if hw["x2"] - hw["x1"] > 1e-5:
            segments.append({
                "id":   f"wall-{idx}",
                "type": "outer" if hw.get("synthetic") else "interior",
                "x1":   float(hw["x1"]), "y1": float(hw["y"]),
                "x2":   float(hw["x2"]), "y2": float(hw["y"]),
                "thicknessRatio": float(hw.get("t", 0.01)),
            })
            idx += 1
    for vw in v_walls:
        if vw["y2"] - vw["y1"] > 1e-5:
            segments.append({
                "id":   f"wall-{idx}",
                "type": "outer" if vw.get("synthetic") else "interior",
                "x1":   float(vw["x"]),  "y1": float(vw["y1"]),
                "x2":   float(vw["x"]),  "y2": float(vw["y2"]),
                "thicknessRatio": float(vw.get("t", 0.01)),
            })
            idx += 1
    return segments


# ─────────────────────────────────────────────────────────────
# Fallback — use raw YOLO masks when wall graph yields nothing
# ─────────────────────────────────────────────────────────────

def _fallback_mask_rooms(results, width, height):
    rooms = []
    if results.masks is None or results.boxes is None:
        return rooms
    n = min(
        len(results.masks.xy) if results.masks.xy is not None else 0,
        len(results.boxes.cls) if results.boxes.cls is not None else 0,
    )
    for i in range(n):
        cls   = results.boxes.cls[i]
        label = results.names[int(cls)]
        if "room" not in label.lower():
            continue
        poly = results.masks.xy[i]
        if poly is None or len(poly) < 3:
            continue
        pts     = np.array(poly, dtype=np.float32)
        contour = pts.reshape(-1, 1, 2)
        approx  = cv2.approxPolyDP(contour, 0.01 * cv2.arcLength(contour, True), True)
        norm_pts = normalized_polygon(approx.reshape(-1, 2), width, height)
        if not norm_pts or len(norm_pts) < 3:
            continue
        xs = [p["x"] for p in norm_pts]
        ys = [p["y"] for p in norm_pts]
        x0, y0 = min(xs), min(ys)
        bbox = {"x": x0, "y": y0, "w": max(xs) - x0, "h": max(ys) - y0}
        rooms.append({
            "id":          f"room-{i}",
            "name":        label,
            "polygon":     norm_pts,
            "wallPolygon": norm_pts,
            "center":      {"x": x0 + bbox["w"] / 2, "y": y0 + bbox["h"] / 2},
            "bbox":        bbox,
        })
    return rooms


# ─────────────────────────────────────────────────────────────
# Main detection pipeline
# ─────────────────────────────────────────────────────────────

def detect(file_bytes, filename=""):
    img = decode_input_image(file_bytes, filename)
    preview_image = encode_image_data_url(img)
    h, w = img.shape[:2]
    results = model(img, imgsz=IMG_SIZE)[0]

    doors, windows = [], []

    for i, (cls, conf, box) in enumerate(
        zip(results.boxes.cls, results.boxes.conf, results.boxes.xyxy)
    ):
        if conf < 0.4:
            continue
        label = results.names[int(cls)]
        x1_b, y1_b, x2_b, y2_b = box.cpu().numpy()
        bw_px = x2_b - x1_b
        bh_px = y2_b - y1_b

        bbox     = {"x": float(x1_b / w), "y": float(y1_b / h),
                    "w": float(bw_px / w), "h": float(bh_px / h)}
        poly     = (results.masks.xy[i]
                    if results.masks is not None and i < len(results.masks.xy) else None)
        poly_bbox = normalized_bbox_from_poly(poly, w, h)
        polygon   = normalized_polygon(poly, w, h)

        if label == "door":
            final_bbox = poly_bbox if poly_bbox is not None else bbox
            if final_bbox["w"] > 0.20 or final_bbox["h"] > 0.20:
                continue
            if final_bbox["w"] * final_bbox["h"] > 0.03:
                continue
            doors.append({"id": f"door-{i}", "bbox": final_bbox, "polygon": polygon,
                          "widthPx": float(max(final_bbox["w"] * w, final_bbox["h"] * h)),
                          "widthM": None})

        elif label == "window":
            final_bbox = poly_bbox if poly_bbox is not None else bbox
            if final_bbox["w"] > 0.30 or final_bbox["h"] > 0.30:
                continue
            if final_bbox["w"] * final_bbox["h"] > 0.05:
                continue
            windows.append({"id": f"window-{i}", "bbox": final_bbox, "polygon": polygon,
                            "widthPx": float(max(final_bbox["w"] * w, final_bbox["h"] * h)),
                            "widthM": None})

    # ── Space Partitioning Pipeline ──────────────────────────────
    raw_walls        = extract_raw_walls(results, w, h)
    h_walls, v_walls = build_manhattan_skeleton(raw_walls)
    h_walls, v_walls = _filter_wall_outliers(h_walls, v_walls)   # noise removal; outer walls exempt
    _bridge_openings(h_walls, v_walls, doors + windows)           # close door/window gaps
    
    floor_poly       = compute_floor_boundary(results, w, h, margin=0.03)
    h_walls, v_walls = clip_walls_to_floor(h_walls, v_walls, floor_poly)
    
    h_walls, v_walls = recover_outer_shell(h_walls, v_walls)      # guarantee closed perimeter
    h_walls, v_walls = trim_at_intersections(h_walls, v_walls)    # clean T/L corner junctions
    cells            = polygonize_floor(h_walls, v_walls)         # smart shell (no sliver cells)
    seeds            = extract_room_seeds(results, w, h)
    rooms            = assign_rooms_to_cells(cells, seeds)        # 1-to-1; no bisector split
    walls            = walls_to_segments(h_walls, v_walls)

    if not rooms and seeds:
        rooms = _fallback_mask_rooms(results, w, h)

    return rooms, walls, doors, windows, 1.0, preview_image


@app.post("/api/detect-floorplan")
async def analyze(file: UploadFile = File(...)):
    try:
        rooms, walls, doors, windows, scale, preview_image = detect(
            await file.read(), file.filename or ""
        )
        return {
            "meta":    {"unit": "m", "scale": float(scale)},
            "rooms":   to_python(rooms),
            "walls":   to_python(walls),
            "doors":   to_python(doors),
            "windows": to_python(windows),
            "image":   preview_image,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))