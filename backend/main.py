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
    """True if point (x, y) lies on any V wall segment."""
    return any(abs(vw["x"] - x) < tol and vw["y1"] - tol <= y <= vw["y2"] + tol for vw in v_walls)


def _v_on_h(x, y, h_walls, tol=1e-3):
    """True if point (x, y) lies on any H wall segment."""
    return any(abs(hw["y"] - y) < tol and hw["x1"] - tol <= x <= hw["x2"] + tol for hw in h_walls)


def _extend_dangling_ends(h_walls, v_walls, extend_tol=0.12):
    """
    Structural Healing — Ray-casting for dangling endpoints.

    A dangling H wall endpoint (x, y) is one where no V wall passes through x
    at the Y level of that wall. We ray-cast horizontally to the nearest V wall
    that spans y and extend to it (if within extend_tol). Vice-versa for V walls.
    Operates in-place; does two passes for chain reactions.
    """
    conn_tol = 1.5e-3

    for _ in range(2):
        for hw in h_walls:
            hy = hw["y"]

            # ── left endpoint ─────────────────────────────────────
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

            # ── right endpoint ────────────────────────────────────
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

            # ── top endpoint ──────────────────────────────────────
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

            # ── bottom endpoint ───────────────────────────────────
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
    """
    Orthogonalize → merge collinear segments → snap corners → heal dangling ends.
    Returns (h_walls, v_walls) where every segment is 100% horizontal or vertical.
    """
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

    # Corner snapping: pull H endpoints onto V wall axes and vice versa (3 passes).
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

    # Structural Healing: extend dangling endpoints to close open loops.
    _extend_dangling_ends(h_walls, v_walls, extend_tol=extend_tol)

    # One more corner snap pass after healing (chain-reaction fixes).
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
# Step 2b — Filter spurious wall segments (YOLO false positives)
# ─────────────────────────────────────────────────────────────

def _filter_wall_outliers(h_walls, v_walls, min_len=0.025, conn_tol=0.02):
    """
    Remove wall segments that are almost certainly YOLO false positives.

    Two criteria — a segment is dropped only if it fails BOTH:
      1. Too short  : length < min_len (normalized).  Genuine walls are almost
                      always ≥ 2–3 % of the image dimension.
      2. Isolated   : both endpoints are structurally disconnected from every
                      other wall in the skeleton.  A floating stub that touches
                      nothing is noise; a stub that at least T-intersects one
                      real wall is kept.

    Two passes so that removing one isolated wall can cascade-expose another.
    Returns new (h_walls, v_walls) lists; does not mutate inputs.
    """
    # ── 1. Length filter ──────────────────────────────────────────
    h_walls = [hw for hw in h_walls if hw["x2"] - hw["x1"] >= min_len]
    v_walls = [vw for vw in v_walls if vw["y2"] - vw["y1"] >= min_len]

    # ── 2. Connectivity helpers ───────────────────────────────────
    def h_ep_ok(px, py, src):
        """H wall endpoint (px, py) connected to any other wall?"""
        # Lands on a V wall (T- or corner-intersection) — most common case
        for vw in v_walls:
            if abs(vw["x"] - px) < conn_tol and vw["y1"] - conn_tol <= py <= vw["y2"] + conn_tol:
                return True
        # Shares an endpoint with another H wall (collinear junction after merging)
        for hw in h_walls:
            if hw is src:
                continue
            if abs(hw["y"] - py) < conn_tol and (
                abs(hw["x1"] - px) < conn_tol or abs(hw["x2"] - px) < conn_tol
            ):
                return True
        return False

    def v_ep_ok(px, py, src):
        """V wall endpoint (px, py) connected to any other wall?"""
        # Lands on an H wall (T- or corner-intersection)
        for hw in h_walls:
            if abs(hw["y"] - py) < conn_tol and hw["x1"] - conn_tol <= px <= hw["x2"] + conn_tol:
                return True
        # Shares an endpoint with another V wall
        for vw in v_walls:
            if vw is src:
                continue
            if abs(vw["x"] - px) < conn_tol and (
                abs(vw["y1"] - py) < conn_tol or abs(vw["y2"] - py) < conn_tol
            ):
                return True
        return False

    # ── 3. Two rounds of connectivity filtering ───────────────────
    for _ in range(2):
        h_walls = [
            hw for hw in h_walls
            if h_ep_ok(hw["x1"], hw["y"], hw) or h_ep_ok(hw["x2"], hw["y"], hw)
        ]
        v_walls = [
            vw for vw in v_walls
            if v_ep_ok(vw["x"], vw["y1"], vw) or v_ep_ok(vw["x"], vw["y2"], vw)
        ]

    return h_walls, v_walls


# ─────────────────────────────────────────────────────────────
# Step 3 — Polygonize the wall graph into closed room cells
# ─────────────────────────────────────────────────────────────

def polygonize_floor(h_walls, v_walls, bbox_margin=0.008, shell_snap=0.04):
    """
    Convert the orthogonal wall graph to closed spatial cells via Shapely polygonize.

    Strategy:
    1. Build exterior shell at the bounding box of all wall endpoints.
    2. Snap peripheral wall endpoints to the shell so they connect (no gaps at edges).
    3. unary_union → polygonize → filter noise cells.

    Returns a list of Shapely Polygons sorted largest-first.
    """
    if not h_walls and not v_walls:
        return []

    all_x = [hw["x1"] for hw in h_walls] + [hw["x2"] for hw in h_walls] + [vw["x"] for vw in v_walls]
    all_y = [hw["y"] for hw in h_walls] + [vw["y1"] for vw in v_walls] + [vw["y2"] for vw in v_walls]
    xmin = max(0.0, min(all_x) - bbox_margin)
    xmax = min(1.0, max(all_x) + bbox_margin)
    ymin = max(0.0, min(all_y) - bbox_margin)
    ymax = min(1.0, max(all_y) + bbox_margin)

    # Snap peripheral wall endpoints onto the shell boundary so there are no gaps
    # between outer walls and the shell (critical for closed-loop formation).
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

    # Exterior shell as 4 separate segments so unary_union can node them with interior walls.
    lines += [
        LineString([(xmin, ymin), (xmax, ymin)]),
        LineString([(xmax, ymin), (xmax, ymax)]),
        LineString([(xmax, ymax), (xmin, ymax)]),
        LineString([(xmin, ymax), (xmin, ymin)]),
    ]

    try:
        merged = unary_union(lines)        # nodes all T-/X-intersections
        cells = list(polygonize(merged))
        total_area = (xmax - xmin) * (ymax - ymin)
        min_area = total_area * 0.004      # drop cells < 0.4 % of bounding box
        cells = [c for c in cells if not c.is_empty and c.area >= min_area]
        cells.sort(key=lambda c: -c.area)
        return cells
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────
# Step 4 — Extract room seed centroids from YOLO masks
# ─────────────────────────────────────────────────────────────

def extract_room_seeds(results, width, height):
    """
    Return one {'label', 'cx', 'cy'} dict per detected room mask.
    cx/cy are normalised [0, 1] image coordinates.
    """
    seeds = []
    if results.masks is None or results.boxes is None:
        return seeds

    n = min(
        len(results.masks.xy) if results.masks.xy is not None else 0,
        len(results.boxes.cls) if results.boxes.cls is not None else 0,
    )
    for i in range(n):
        cls = results.boxes.cls[i]
        conf = results.boxes.conf[i]
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
# Step 5 — Assign room labels to cells (Seed Logic)
# ─────────────────────────────────────────────────────────────

def _shapely_to_pts(poly):
    """Convert Shapely Polygon exterior to [{x, y}, ...] (no closing duplicate)."""
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
    return {"x": float(minx), "y": float(miny), "w": float(maxx - minx), "h": float(maxy - miny)}


def _split_polygon_by_bisector(poly, s1, s2):
    """
    Split poly with the perpendicular bisector between s1 and s2.
    Uses rectangular half-plane intersection — robust for all orientations.
    Returns list of (sub_polygon, assigned_seed) tuples.
    """
    big = 10.0  # Much larger than any normalised coordinate
    mx = (s1["cx"] + s2["cx"]) / 2
    my = (s1["cy"] + s2["cy"]) / 2
    dx = s2["cx"] - s1["cx"]
    dy = s2["cy"] - s1["cy"]
    length = max(float(np.hypot(dx, dy)), 1e-10)

    pdx, pdy = -dy / length, dx / length   # unit perp (divider) direction
    ndx, ndy = dx / length, dy / length    # unit seed-to-seed direction

    # Divider endpoints
    d1x, d1y = mx - pdx * big, my - pdy * big
    d2x, d2y = mx + pdx * big, my + pdy * big

    # Rectangle on s1 side (back along seed-to-seed direction)
    hp_s1 = Polygon([
        (d1x - ndx * big, d1y - ndy * big),
        (d2x - ndx * big, d2y - ndy * big),
        (d2x, d2y),
        (d1x, d1y),
    ])
    # Rectangle on s2 side (forward along seed-to-seed direction)
    hp_s2 = Polygon([
        (d1x, d1y),
        (d2x, d2y),
        (d2x + ndx * big, d2y + ndy * big),
        (d1x + ndx * big, d1y + ndy * big),
    ])

    parts = []
    for hp, seed in ((hp_s1, s1), (hp_s2, s2)):
        try:
            cut = poly.intersection(hp)
        except Exception:
            continue
        if cut.is_empty:
            continue
        if cut.geom_type == "Polygon":
            parts.append((cut, seed))
        elif cut.geom_type in ("MultiPolygon", "GeometryCollection"):
            for g in cut.geoms:
                if g.geom_type == "Polygon" and not g.is_empty:
                    parts.append((g, seed))

    return parts if len(parts) >= 2 else [(poly, s1)]


def _split_cell_by_seeds(cell, seeds):
    """
    Recursively split a cell for all seeds it contains.
    Returns list of (sub_polygon, seed) tuples.
    """
    if len(seeds) <= 1:
        return [(cell, seeds[0])] if seeds else []

    # Find the most distant seed pair to bisect first
    max_d, best = -1, (0, 1)
    for i in range(len(seeds)):
        for j in range(i + 1, len(seeds)):
            d = (seeds[i]["cx"] - seeds[j]["cx"]) ** 2 + (seeds[i]["cy"] - seeds[j]["cy"]) ** 2
            if d > max_d:
                max_d, best = d, (i, j)

    s1, s2 = seeds[best[0]], seeds[best[1]]
    parts = _split_polygon_by_bisector(cell, s1, s2)

    result = []
    used = set()
    for part, hint_seed in parts:
        pc = part.centroid
        inside = [
            (k, s) for k, s in enumerate(seeds)
            if k not in used and part.contains(Point(s["cx"], s["cy"]))
        ]
        if not inside:
            # Fall back to the bisector's hint seed, or nearest unused
            hint_k = next((k for k, s in enumerate(seeds) if s is hint_seed and k not in used), None)
            if hint_k is not None:
                inside = [(hint_k, hint_seed)]
            else:
                k = min(
                    (k for k in range(len(seeds)) if k not in used),
                    key=lambda k: (seeds[k]["cx"] - pc.x) ** 2 + (seeds[k]["cy"] - pc.y) ** 2,
                    default=None,
                )
                if k is None:
                    continue
                inside = [(k, seeds[k])]
        for k, _ in inside:
            used.add(k)
        sub_seeds = [s for _, s in inside]
        result.extend(_split_cell_by_seeds(part, sub_seeds) if len(sub_seeds) > 1 else [(part, sub_seeds[0])])

    return result if result else [(cell, seeds[0])]


def _bridge_openings(h_walls, v_walls, openings):
    """
    Bridge wall centerline gaps that door/window openings create in the YOLO detections.

    YOLO typically outputs two short wall segments on either side of a door/window,
    leaving a gap equal to the opening width. Without bridging, polygonize cannot form
    a closed boundary and the room 'leaks' into the adjacent space.

    Strategy: for each opening bbox, find the nearest collinear wall pair separated by
    a gap that fits the opening, then append a bridge segment to close it.
    The bridge is purely for spatial partitioning — rendering still shows the gap.
    Operates in-place; new segments are appended to h_walls / v_walls.
    """
    wall_tol = 0.06  # max distance from opening-center Y (or X) to nearest wall

    new_h: list = []
    new_v: list = []

    for item in openings:
        bbox = item.get("bbox", {})
        ox1 = float(bbox.get("x", 0))
        oy1 = float(bbox.get("y", 0))
        ow  = float(bbox.get("w", 0))
        oh  = float(bbox.get("h", 0))
        if ow <= 0 or oh <= 0:
            continue
        ox2 = ox1 + ow
        oy2 = oy1 + oh
        ocx = (ox1 + ox2) / 2
        ocy = (oy1 + oy2) / 2

        if ow >= oh:
            # Horizontal opening → runs along an H wall; split is left/right of centre X
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
                # Only bridge if the gap is plausible for this opening (not a room-width gap)
                if 1e-4 < gap <= ow * 1.6 + 0.03:
                    new_h.append({
                        "x1": l["x2"], "x2": r["x1"],
                        "y":  best_y,
                        "t":  max(l.get("t", 0.01), r.get("t", 0.01)),
                    })
        else:
            # Vertical opening → runs along a V wall; split is top/bottom of centre Y
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
                    new_v.append({
                        "y1": t["y2"], "y2": b["y1"],
                        "x":  best_x,
                        "t":  max(t.get("t", 0.01), b.get("t", 0.01)),
                    })

    h_walls.extend(new_h)
    v_walls.extend(new_v)


def assign_rooms_to_cells(cells, seeds):
    """
    Point-in-Polygon: assign each seed to the cell it falls in.
    Cells with multiple seeds → virtual dividers (bisector split).
    Each seed = one distinct room instance; no label-based merging.
    Returns room dicts in the API format.
    """
    rooms = []
    room_idx = 0
    used_seeds = set()

    for cell in cells:
        if cell.is_empty:
            continue
        inside = [
            (i, s) for i, s in enumerate(seeds)
            if i not in used_seeds and cell.contains(Point(s["cx"], s["cy"]))
        ]
        if not inside:
            continue
        for i, _ in inside:
            used_seeds.add(i)

        sub_seeds = [s for _, s in inside]
        assignments = _split_cell_by_seeds(cell, sub_seeds) if len(sub_seeds) > 1 else [(cell, sub_seeds[0])]

        for sub_cell, seed in assignments:
            pts = _shapely_to_pts(sub_cell)
            if not pts or len(pts) < 3:
                continue
            centroid = sub_cell.centroid
            rooms.append({
                "id": f"room-{room_idx}",
                "name": seed["label"],
                "polygon": pts,
                "wallPolygon": pts,
                "center": {"x": float(centroid.x), "y": float(centroid.y)},
                "bbox": _shapely_bbox(sub_cell),
            })
            room_idx += 1

    return rooms


# ─────────────────────────────────────────────────────────────
# Step 6 — Convert wall dicts back to API segment format
# ─────────────────────────────────────────────────────────────

def walls_to_segments(h_walls, v_walls):
    segments = []
    idx = 0
    for hw in h_walls:
        if hw["x2"] - hw["x1"] > 1e-5:
            segments.append({
                "id": f"wall-{idx}", "type": "interior",
                "x1": float(hw["x1"]), "y1": float(hw["y"]),
                "x2": float(hw["x2"]), "y2": float(hw["y"]),
                "thicknessRatio": float(hw.get("t", 0.01)),
            })
            idx += 1
    for vw in v_walls:
        if vw["y2"] - vw["y1"] > 1e-5:
            segments.append({
                "id": f"wall-{idx}", "type": "interior",
                "x1": float(vw["x"]), "y1": float(vw["y1"]),
                "x2": float(vw["x"]), "y2": float(vw["y2"]),
                "thicknessRatio": float(vw.get("t", 0.01)),
            })
            idx += 1
    return segments


# ─────────────────────────────────────────────────────────────
# Fallback — legacy mask-based room extraction
# (used when polygonize produces no usable cells)
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
        cls = results.boxes.cls[i]
        label = results.names[int(cls)]
        if "room" not in label.lower():
            continue
        poly = results.masks.xy[i]
        if poly is None or len(poly) < 3:
            continue
        pts = np.array(poly, dtype=np.float32)
        contour = pts.reshape(-1, 1, 2)
        approx = cv2.approxPolyDP(contour, 0.01 * cv2.arcLength(contour, True), True)
        norm_pts = normalized_polygon(approx.reshape(-1, 2), width, height)
        if not norm_pts or len(norm_pts) < 3:
            continue
        xs = [p["x"] for p in norm_pts]
        ys = [p["y"] for p in norm_pts]
        x0, y0 = min(xs), min(ys)
        bbox = {"x": x0, "y": y0, "w": max(xs) - x0, "h": max(ys) - y0}
        cx = x0 + bbox["w"] / 2
        cy = y0 + bbox["h"] / 2
        rooms.append({
            "id": f"room-{i}",
            "name": label,
            "polygon": norm_pts,
            "wallPolygon": norm_pts,
            "center": {"x": cx, "y": cy},
            "bbox": bbox,
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

    for i, (cls, conf, box) in enumerate(zip(results.boxes.cls, results.boxes.conf, results.boxes.xyxy)):
        if conf < 0.4:
            continue
        label = results.names[int(cls)]
        x1_b, y1_b, x2_b, y2_b = box.cpu().numpy()
        bw_px = x2_b - x1_b
        bh_px = y2_b - y1_b

        bbox = {"x": float(x1_b / w), "y": float(y1_b / h), "w": float(bw_px / w), "h": float(bh_px / h)}
        poly = results.masks.xy[i] if results.masks is not None and i < len(results.masks.xy) else None
        poly_bbox = normalized_bbox_from_poly(poly, w, h)
        polygon = normalized_polygon(poly, w, h)

        if label == "door":
            final_bbox = poly_bbox if poly_bbox is not None else bbox
            if final_bbox["w"] > 0.20 or final_bbox["h"] > 0.20:
                continue
            if final_bbox["w"] * final_bbox["h"] > 0.03:
                continue
            px_w = float(max(final_bbox["w"] * w, final_bbox["h"] * h))
            doors.append({"id": f"door-{i}", "bbox": final_bbox, "polygon": polygon, "widthPx": px_w, "widthM": None})

        elif label == "window":
            final_bbox = poly_bbox if poly_bbox is not None else bbox
            if final_bbox["w"] > 0.30 or final_bbox["h"] > 0.30:
                continue
            if final_bbox["w"] * final_bbox["h"] > 0.05:
                continue
            px_w = float(max(final_bbox["w"] * w, final_bbox["h"] * h))
            windows.append({"id": f"window-{i}", "bbox": final_bbox, "polygon": polygon, "widthPx": px_w, "widthM": None})

    # ── Space Partitioning Pipeline ─────────────────────────────
    raw_walls = extract_raw_walls(results, w, h)
    h_walls, v_walls = build_manhattan_skeleton(raw_walls)
    h_walls, v_walls = _filter_wall_outliers(h_walls, v_walls)  # drop YOLO false-positive stubs
    _bridge_openings(h_walls, v_walls, doors + windows)          # restore gaps at openings
    cells = polygonize_floor(h_walls, v_walls)
    seeds = extract_room_seeds(results, w, h)
    rooms = assign_rooms_to_cells(cells, seeds)
    walls = walls_to_segments(h_walls, v_walls)

    # Fallback when space partitioning yields nothing
    if not rooms and seeds:
        rooms = _fallback_mask_rooms(results, w, h)

    return rooms, walls, doors, windows, 1.0, preview_image


@app.post("/api/detect-floorplan")
async def analyze(file: UploadFile = File(...)):
    try:
        rooms, walls, doors, windows, scale, preview_image = detect(await file.read(), file.filename or "")
        return {
            "meta": {"unit": "m", "scale": float(scale)},
            "rooms": to_python(rooms),
            "walls": to_python(walls),
            "doors": to_python(doors),
            "windows": to_python(windows),
            "image": preview_image,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
