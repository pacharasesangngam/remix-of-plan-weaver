import re
from collections import defaultdict

import cv2
import numpy as np
from shapely.geometry import GeometryCollection, LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union


MIN_SEGMENT = 0.018


def _clip01(value):
    return float(np.clip(value, 0.0, 1.0))


def _clean_geom(geom):
    if geom is None or geom.is_empty:
        return None
    try:
        fixed = geom.buffer(0)
    except Exception:
        return None
    if fixed.is_empty:
        return None
    return fixed


def _largest_polygon(geom):
    geom = _clean_geom(geom)
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


def _label_slug(label):
    slug = re.sub(r"[^a-z0-9]+", "_", str(label).strip().lower()).strip("_")
    return slug or "room"


def _polygon_points(poly):
    poly = _largest_polygon(poly)
    if poly is None:
        return None
    coords = list(poly.exterior.coords)[:-1]
    if len(coords) < 3:
        return None
    return [{"x": float(x), "y": float(y)} for x, y in coords]


def _bbox(poly):
    minx, miny, maxx, maxy = poly.bounds
    return {
        "x": float(minx),
        "y": float(miny),
        "w": float(maxx - minx),
        "h": float(maxy - miny),
    }


def _threshold_plan(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)

    # Keep only dark, low-saturation ink. This excludes cyan/orange markup,
    # dimension labels, and most UI-colored detections from the wall graph.
    dark = gray < 145
    neutral = hsv[:, :, 1] < 75
    binary = np.where(dark & neutral, 255, 0).astype(np.uint8)
    return cv2.morphologyEx(
        binary,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
        iterations=1,
    )


def _room_mask_polygons(results, width, height):
    rooms = []
    if results.masks is None or results.boxes is None:
        return rooms

    count = min(len(results.masks.xy), len(results.boxes.cls))
    for index in range(count):
        label = results.names[int(results.boxes.cls[index])]
        confidence = float(results.boxes.conf[index])
        if "room" not in label.lower() or confidence < 0.18:
            continue

        poly = results.masks.xy[index]
        if poly is None or len(poly) < 3:
            continue

        pts = [(_clip01(x / width), _clip01(y / height)) for x, y in poly]
        polygon = _largest_polygon(Polygon(pts))
        if polygon is None or polygon.area < 0.0002:
            continue

        centroid = polygon.centroid
        rooms.append({
            "label": label,
            "confidence": confidence,
            "polygon": polygon,
            "seed": {"label": label, "cx": float(centroid.x), "cy": float(centroid.y)},
        })
    return rooms


def _virtual_outer_shell(room_masks, fallback_bounds=None, margin=0.018):
    if room_masks:
        union = unary_union([item["polygon"] for item in room_masks])
        shell = _largest_polygon(union)
        if shell is not None:
            shell = _largest_polygon(shell.buffer(margin, join_style=2).simplify(0.006, preserve_topology=True))
            if shell is not None and shell.area > 0.001:
                return shell

    if fallback_bounds is None:
        return Polygon([(0.02, 0.02), (0.98, 0.02), (0.98, 0.98), (0.02, 0.98)])

    xmin, xmax, ymin, ymax = fallback_bounds
    pad = 0.012
    xmin = _clip01(xmin - pad)
    xmax = _clip01(xmax + pad)
    ymin = _clip01(ymin - pad)
    ymax = _clip01(ymax + pad)
    return Polygon([(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)])


def _extract_cv_wall_segments(img):
    height, width = img.shape[:2]
    binary = _threshold_plan(img)

    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(24, width // 34), 1))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(24, height // 34)))
    h_mask = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel, iterations=1)
    v_mask = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kernel, iterations=1)

    min_len_px = max(34, int(min(width, height) * 0.045))
    h_walls = []
    v_walls = []

    contours, _ = cv2.findContours(h_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w < min_len_px or w < h * 4.0 or h > max(28, height * 0.045):
            continue
        h_walls.append({
            "x1": _clip01(x / width),
            "x2": _clip01((x + w) / width),
            "y": _clip01((y + h / 2) / height),
            "t": float(max(0.005, min(0.03, h / max(width, height)))),
            "source": "cv",
        })

    contours, _ = cv2.findContours(v_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if h < min_len_px or h < w * 4.0 or w > max(28, width * 0.045):
            continue
        v_walls.append({
            "x": _clip01((x + w / 2) / width),
            "y1": _clip01(y / height),
            "y2": _clip01((y + h) / height),
            "t": float(max(0.005, min(0.03, w / max(width, height)))),
            "source": "cv",
        })

    return h_walls, v_walls


def _extract_yolo_wall_segments(results, width, height):
    h_walls = []
    v_walls = []
    if results.masks is None or results.boxes is None:
        return h_walls, v_walls

    count = min(len(results.masks.xy), len(results.boxes.cls))
    for index in range(count):
        label = results.names[int(results.boxes.cls[index])]
        confidence = float(results.boxes.conf[index])
        if label != "wall" or confidence < 0.20:
            continue

        poly = results.masks.xy[index]
        if poly is None or len(poly) < 3:
            continue

        pts = np.array(poly, dtype=np.float32)
        (cx, cy), (rw, rh), angle = cv2.minAreaRect(pts)
        if rw < 2 or rh < 2:
            continue

        if rw >= rh:
            length, thickness, theta = rw, rh, np.deg2rad(angle)
        else:
            length, thickness, theta = rh, rw, np.deg2rad(angle + 90)

        # Skeleton & Align: choose the dominant Manhattan axis and discard the angle.
        if abs(np.cos(theta)) >= abs(np.sin(theta)):
            h_walls.append({
                "x1": _clip01((cx - length / 2) / width),
                "x2": _clip01((cx + length / 2) / width),
                "y": _clip01(cy / height),
                "t": float(max(0.005, min(0.035, thickness / max(width, height)))),
                "source": "yolo",
            })
        else:
            v_walls.append({
                "x": _clip01(cx / width),
                "y1": _clip01((cy - length / 2) / height),
                "y2": _clip01((cy + length / 2) / height),
                "t": float(max(0.005, min(0.035, thickness / max(width, height)))),
                "source": "yolo",
            })

    for wall in h_walls:
        if wall["x1"] > wall["x2"]:
            wall["x1"], wall["x2"] = wall["x2"], wall["x1"]
    for wall in v_walls:
        if wall["y1"] > wall["y2"]:
            wall["y1"], wall["y2"] = wall["y2"], wall["y1"]
    return h_walls, v_walls


def _dynamic_config(h_walls, v_walls):
    thicknesses = [wall.get("t", 0.01) for wall in h_walls + v_walls if wall.get("t", 0) > 0]
    median_t = float(np.median(thicknesses)) if thicknesses else 0.012
    snap = float(np.clip(median_t * 2.8, 0.012, 0.04))
    return {
        "thickness": median_t,
        "snap": snap,
        "merge_gap": float(np.clip(snap * 2.6, 0.035, 0.085)),
        "connect_gap": float(np.clip(snap * 4.5, 0.055, 0.14)),
        "boundary_pad": float(np.clip(snap * 1.5, 0.012, 0.04)),
    }


def _has_enough_yolo_walls(h_walls, v_walls):
    long_h = [wall for wall in h_walls if wall["x2"] - wall["x1"] >= 0.06]
    long_v = [wall for wall in v_walls if wall["y2"] - wall["y1"] >= 0.06]
    return len(long_h) >= 2 and len(long_v) >= 2 and len(long_h) + len(long_v) >= 7


def _cluster_axis(values, tol):
    clusters = []
    for value in sorted(values):
        if clusters and abs(clusters[-1]["avg"] - value) <= tol:
            clusters[-1]["items"].append(value)
            clusters[-1]["avg"] = sum(clusters[-1]["items"]) / len(clusters[-1]["items"])
        else:
            clusters.append({"avg": value, "items": [value]})
    return [cluster["avg"] for cluster in clusters]


def _nearest(value, axes):
    return min(axes, key=lambda axis: abs(axis - value)) if axes else value


def _snap_and_merge(h_walls, v_walls, cfg):
    snap = cfg["snap"]
    merge_gap = cfg["merge_gap"]
    x_axes = _cluster_axis([wall["x"] for wall in v_walls], snap)
    y_axes = _cluster_axis([wall["y"] for wall in h_walls], snap)

    for wall in h_walls:
        wall["y"] = _nearest(wall["y"], y_axes)
        for axis in x_axes:
            if abs(wall["x1"] - axis) <= snap:
                wall["x1"] = axis
            if abs(wall["x2"] - axis) <= snap:
                wall["x2"] = axis
        if wall["x1"] > wall["x2"]:
            wall["x1"], wall["x2"] = wall["x2"], wall["x1"]

    for wall in v_walls:
        wall["x"] = _nearest(wall["x"], x_axes)
        for axis in y_axes:
            if abs(wall["y1"] - axis) <= snap:
                wall["y1"] = axis
            if abs(wall["y2"] - axis) <= snap:
                wall["y2"] = axis
        if wall["y1"] > wall["y2"]:
            wall["y1"], wall["y2"] = wall["y2"], wall["y1"]

    merged_h = []
    for axis in y_axes:
        same = sorted([wall for wall in h_walls if abs(wall["y"] - axis) <= snap], key=lambda wall: wall["x1"])
        for wall in same:
            if wall["x2"] - wall["x1"] < MIN_SEGMENT:
                continue
            if merged_h and abs(merged_h[-1]["y"] - axis) <= snap and wall["x1"] - merged_h[-1]["x2"] <= merge_gap:
                merged_h[-1]["x2"] = max(merged_h[-1]["x2"], wall["x2"])
                merged_h[-1]["t"] = max(merged_h[-1]["t"], wall["t"])
            else:
                merged_h.append({**wall, "y": axis})

    merged_v = []
    for axis in x_axes:
        same = sorted([wall for wall in v_walls if abs(wall["x"] - axis) <= snap], key=lambda wall: wall["y1"])
        for wall in same:
            if wall["y2"] - wall["y1"] < MIN_SEGMENT:
                continue
            if merged_v and abs(merged_v[-1]["x"] - axis) <= snap and wall["y1"] - merged_v[-1]["y2"] <= merge_gap:
                merged_v[-1]["y2"] = max(merged_v[-1]["y2"], wall["y2"])
                merged_v[-1]["t"] = max(merged_v[-1]["t"], wall["t"])
            else:
                merged_v.append({**wall, "x": axis})

    return merged_h, merged_v


def _is_h_endpoint_anchored(x, y, v_walls, tol):
    return any(abs(wall["x"] - x) <= tol and wall["y1"] - tol <= y <= wall["y2"] + tol for wall in v_walls)


def _is_v_endpoint_anchored(x, y, h_walls, tol):
    return any(abs(wall["y"] - y) <= tol and wall["x1"] - tol <= x <= wall["x2"] + tol for wall in h_walls)


def _directional_healing(h_walls, v_walls, cfg):
    snap = cfg["snap"]
    connect = cfg["connect_gap"]

    for _ in range(2):
        for wall in h_walls:
            y = wall["y"]
            if not _is_h_endpoint_anchored(wall["x1"], y, v_walls, snap):
                candidates = [item for item in v_walls if item["x"] < wall["x1"] and item["y1"] - snap <= y <= item["y2"] + snap]
                if candidates:
                    hit = max(candidates, key=lambda item: item["x"])
                    if wall["x1"] - hit["x"] <= connect:
                        wall["x1"] = hit["x"]
                        hit["y1"] = min(hit["y1"], y)
                        hit["y2"] = max(hit["y2"], y)
            if not _is_h_endpoint_anchored(wall["x2"], y, v_walls, snap):
                candidates = [item for item in v_walls if item["x"] > wall["x2"] and item["y1"] - snap <= y <= item["y2"] + snap]
                if candidates:
                    hit = min(candidates, key=lambda item: item["x"])
                    if hit["x"] - wall["x2"] <= connect:
                        wall["x2"] = hit["x"]
                        hit["y1"] = min(hit["y1"], y)
                        hit["y2"] = max(hit["y2"], y)

        for wall in v_walls:
            x = wall["x"]
            if not _is_v_endpoint_anchored(x, wall["y1"], h_walls, snap):
                candidates = [item for item in h_walls if item["y"] < wall["y1"] and item["x1"] - snap <= x <= item["x2"] + snap]
                if candidates:
                    hit = max(candidates, key=lambda item: item["y"])
                    if wall["y1"] - hit["y"] <= connect:
                        wall["y1"] = hit["y"]
                        hit["x1"] = min(hit["x1"], x)
                        hit["x2"] = max(hit["x2"], x)
            if not _is_v_endpoint_anchored(x, wall["y2"], h_walls, snap):
                candidates = [item for item in h_walls if item["y"] > wall["y2"] and item["x1"] - snap <= x <= item["x2"] + snap]
                if candidates:
                    hit = min(candidates, key=lambda item: item["y"])
                    if hit["y"] - wall["y2"] <= connect:
                        wall["y2"] = hit["y"]
                        hit["x1"] = min(hit["x1"], x)
                        hit["x2"] = max(hit["x2"], x)


def _bridge_openings(h_walls, v_walls, openings, cfg):
    snap = cfg["snap"]
    connect = cfg["connect_gap"]
    for opening in openings:
        bbox = opening.get("bbox", {})
        ox = float(bbox.get("x", 0)) + float(bbox.get("w", 0)) / 2
        oy = float(bbox.get("y", 0)) + float(bbox.get("h", 0)) / 2
        ow = float(bbox.get("w", 0))
        oh = float(bbox.get("h", 0))
        if ow <= 0 or oh <= 0:
            continue

        if ow >= oh:
            candidates = [wall for wall in h_walls if abs(wall["y"] - oy) <= connect]
            if not candidates:
                continue
            y = min(candidates, key=lambda wall: abs(wall["y"] - oy))["y"]
            left = [wall for wall in candidates if abs(wall["y"] - y) <= snap and wall["x2"] <= ox]
            right = [wall for wall in candidates if abs(wall["y"] - y) <= snap and wall["x1"] >= ox]
            if left and right:
                l_wall = max(left, key=lambda wall: wall["x2"])
                r_wall = min(right, key=lambda wall: wall["x1"])
                gap = r_wall["x1"] - l_wall["x2"]
                if 0 < gap <= max(connect, ow * 1.9 + snap):
                    h_walls.append({"x1": l_wall["x2"], "x2": r_wall["x1"], "y": y, "t": max(l_wall["t"], r_wall["t"]), "source": "opening_bridge"})
        else:
            candidates = [wall for wall in v_walls if abs(wall["x"] - ox) <= connect]
            if not candidates:
                continue
            x = min(candidates, key=lambda wall: abs(wall["x"] - ox))["x"]
            top = [wall for wall in candidates if abs(wall["x"] - x) <= snap and wall["y2"] <= oy]
            bottom = [wall for wall in candidates if abs(wall["x"] - x) <= snap and wall["y1"] >= oy]
            if top and bottom:
                t_wall = max(top, key=lambda wall: wall["y2"])
                b_wall = min(bottom, key=lambda wall: wall["y1"])
                gap = b_wall["y1"] - t_wall["y2"]
                if 0 < gap <= max(connect, oh * 1.9 + snap):
                    v_walls.append({"x": x, "y1": t_wall["y2"], "y2": b_wall["y1"], "t": max(t_wall["t"], b_wall["t"]), "source": "opening_bridge"})


def _anchor_snapping(h_walls, v_walls, cfg):
    snap = cfg["snap"]
    for _ in range(2):
        anchors = []
        for h_wall in h_walls:
            for v_wall in v_walls:
                x = v_wall["x"]
                y = h_wall["y"]
                near_h = h_wall["x1"] - snap <= x <= h_wall["x2"] + snap
                near_v = v_wall["y1"] - snap <= y <= v_wall["y2"] + snap
                if near_h and near_v:
                    anchors.append((x, y))

        for x, y in anchors:
            for wall in h_walls:
                if abs(wall["y"] - y) <= snap:
                    wall["y"] = y
                    if abs(wall["x1"] - x) <= snap:
                        wall["x1"] = x
                    if abs(wall["x2"] - x) <= snap:
                        wall["x2"] = x
                    if wall["x1"] <= x <= wall["x2"]:
                        continue
                    if 0 < wall["x1"] - x <= snap:
                        wall["x1"] = x
                    if 0 < x - wall["x2"] <= snap:
                        wall["x2"] = x
            for wall in v_walls:
                if abs(wall["x"] - x) <= snap:
                    wall["x"] = x
                    if abs(wall["y1"] - y) <= snap:
                        wall["y1"] = y
                    if abs(wall["y2"] - y) <= snap:
                        wall["y2"] = y
                    if wall["y1"] <= y <= wall["y2"]:
                        continue
                    if 0 < wall["y1"] - y <= snap:
                        wall["y1"] = y
                    if 0 < y - wall["y2"] <= snap:
                        wall["y2"] = y


def _wall_line(wall, orientation):
    if orientation == "h":
        return LineString([(wall["x1"], wall["y"]), (wall["x2"], wall["y"])])
    return LineString([(wall["x"], wall["y1"]), (wall["x"], wall["y2"])])


def _line_parts(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if hasattr(geom, "geoms"):
        parts = []
        for item in geom.geoms:
            parts.extend(_line_parts(item))
        return parts
    return []


def _clip_walls_to_boundary(h_walls, v_walls, boundary, cfg):
    allowed = boundary.buffer(cfg["boundary_pad"], join_style=2)
    clipped_h = []
    for wall in h_walls:
        try:
            intersection = _wall_line(wall, "h").intersection(allowed)
        except Exception:
            continue
        for line in _line_parts(intersection):
            coords = list(line.coords)
            if len(coords) < 2:
                continue
            x1 = min(coords[0][0], coords[-1][0])
            x2 = max(coords[0][0], coords[-1][0])
            if x2 - x1 >= MIN_SEGMENT:
                clipped_h.append({**wall, "x1": float(x1), "x2": float(x2), "y": float(coords[0][1])})

    clipped_v = []
    for wall in v_walls:
        try:
            intersection = _wall_line(wall, "v").intersection(allowed)
        except Exception:
            continue
        for line in _line_parts(intersection):
            coords = list(line.coords)
            if len(coords) < 2:
                continue
            y1 = min(coords[0][1], coords[-1][1])
            y2 = max(coords[0][1], coords[-1][1])
            if y2 - y1 >= MIN_SEGMENT:
                clipped_v.append({**wall, "x": float(coords[0][0]), "y1": float(y1), "y2": float(y2)})

    return clipped_h, clipped_v


def _filter_structural_walls(h_walls, v_walls, boundary, cfg):
    minx, miny, maxx, maxy = boundary.bounds
    snap = cfg["snap"]
    min_keep = max(0.045, snap * 2.2)

    def on_boundary_h(wall):
        return abs(wall["y"] - miny) <= snap * 1.5 or abs(wall["y"] - maxy) <= snap * 1.5

    def on_boundary_v(wall):
        return abs(wall["x"] - minx) <= snap * 1.5 or abs(wall["x"] - maxx) <= snap * 1.5

    def h_connections(wall):
        y = wall["y"]
        left = any(abs(item["x"] - wall["x1"]) <= snap and item["y1"] - snap <= y <= item["y2"] + snap for item in v_walls)
        right = any(abs(item["x"] - wall["x2"]) <= snap and item["y1"] - snap <= y <= item["y2"] + snap for item in v_walls)
        crosses = sum(1 for item in v_walls if wall["x1"] + snap <= item["x"] <= wall["x2"] - snap and item["y1"] - snap <= y <= item["y2"] + snap)
        return int(left) + int(right) + crosses

    def v_connections(wall):
        x = wall["x"]
        top = any(abs(item["y"] - wall["y1"]) <= snap and item["x1"] - snap <= x <= item["x2"] + snap for item in h_walls)
        bottom = any(abs(item["y"] - wall["y2"]) <= snap and item["x1"] - snap <= x <= item["x2"] + snap for item in h_walls)
        crosses = sum(1 for item in h_walls if wall["y1"] + snap <= item["y"] <= wall["y2"] - snap and item["x1"] - snap <= x <= item["x2"] + snap)
        return int(top) + int(bottom) + crosses

    filtered_h = []
    for wall in h_walls:
        length = wall["x2"] - wall["x1"]
        if wall.get("synthetic") or on_boundary_h(wall) or length >= min_keep or h_connections(wall) >= 2:
            filtered_h.append(wall)

    filtered_v = []
    for wall in v_walls:
        length = wall["y2"] - wall["y1"]
        if wall.get("synthetic") or on_boundary_v(wall) or length >= min_keep or v_connections(wall) >= 2:
            filtered_v.append(wall)

    return filtered_h, filtered_v


def _ensure_boundary_edges(h_walls, v_walls, boundary, cfg):
    minx, miny, maxx, maxy = boundary.bounds
    shell_edges = [
        {"x1": float(minx), "x2": float(maxx), "y": float(miny), "t": cfg["thickness"], "synthetic": True, "source": "virtual_shell"},
        {"x1": float(minx), "x2": float(maxx), "y": float(maxy), "t": cfg["thickness"], "synthetic": True, "source": "virtual_shell"},
    ]
    shell_v = [
        {"x": float(minx), "y1": float(miny), "y2": float(maxy), "t": cfg["thickness"], "synthetic": True, "source": "virtual_shell"},
        {"x": float(maxx), "y1": float(miny), "y2": float(maxy), "t": cfg["thickness"], "synthetic": True, "source": "virtual_shell"},
    ]

    def h_cover(y):
        span = maxx - minx
        if span <= 0:
            return 1.0
        return sum(max(0.0, min(w["x2"], maxx) - max(w["x1"], minx)) for w in h_walls if abs(w["y"] - y) <= cfg["snap"]) / span

    def v_cover(x):
        span = maxy - miny
        if span <= 0:
            return 1.0
        return sum(max(0.0, min(w["y2"], maxy) - max(w["y1"], miny)) for w in v_walls if abs(w["x"] - x) <= cfg["snap"]) / span

    if h_cover(miny) < 0.75:
        h_walls.append(shell_edges[0])
    if h_cover(maxy) < 0.75:
        h_walls.append(shell_edges[1])
    if v_cover(minx) < 0.75:
        v_walls.append(shell_v[0])
    if v_cover(maxx) < 0.75:
        v_walls.append(shell_v[1])
    return h_walls, v_walls


def _trim_at_junctions(h_walls, v_walls, cfg):
    snap = cfg["snap"] * 0.5
    split_h = []
    for wall in h_walls:
        cuts = [item["x"] for item in v_walls if wall["x1"] < item["x"] < wall["x2"] and item["y1"] - snap <= wall["y"] <= item["y2"] + snap]
        xs = sorted([wall["x1"], *cuts, wall["x2"]])
        for idx in range(len(xs) - 1):
            if xs[idx + 1] - xs[idx] >= MIN_SEGMENT / 2:
                split_h.append({**wall, "x1": xs[idx], "x2": xs[idx + 1]})

    split_v = []
    for wall in v_walls:
        cuts = [item["y"] for item in split_h if wall["y1"] < item["y"] < wall["y2"] and item["x1"] - snap <= wall["x"] <= item["x2"] + snap]
        ys = sorted([wall["y1"], *cuts, wall["y2"]])
        for idx in range(len(ys) - 1):
            if ys[idx + 1] - ys[idx] >= MIN_SEGMENT / 2:
                split_v.append({**wall, "y1": ys[idx], "y2": ys[idx + 1]})
    return split_h, split_v


def _polygonize_cells(h_walls, v_walls, boundary, cfg):
    lines = []
    for wall in h_walls:
        if wall["x2"] - wall["x1"] > 1e-5:
            lines.append(_wall_line(wall, "h"))
    for wall in v_walls:
        if wall["y2"] - wall["y1"] > 1e-5:
            lines.append(_wall_line(wall, "v"))

    # Add the virtual shell as a hard cutting boundary.
    boundary_line = boundary.boundary
    if hasattr(boundary_line, "geoms"):
        lines.extend([item for item in boundary_line.geoms if isinstance(item, LineString)])
    else:
        lines.append(boundary_line)

    try:
        raw_cells = list(polygonize(unary_union(lines)))
    except Exception:
        return []

    min_area = max(boundary.area * 0.004, 0.00015)
    cells = []
    occupied = GeometryCollection()
    for cell in sorted(raw_cells, key=lambda item: -item.area):
        clipped = _largest_polygon(cell.intersection(boundary))
        if clipped is None or clipped.area < min_area:
            continue
        if not occupied.is_empty:
            clipped = _largest_polygon(clipped.difference(occupied.buffer(1e-6)))
            if clipped is None or clipped.area < min_area:
                continue
        cells.append(clipped)
        occupied = unary_union([occupied, clipped]) if not occupied.is_empty else clipped
    return cells


def _room_seeds(room_masks):
    return [item["seed"] for item in room_masks]


def _make_room(room_index, label, poly):
    pts = _polygon_points(poly)
    if not pts:
        return None
    slug = _label_slug(label)
    return {
        "id": f"room_{slug}_{room_index}",
        "name": label,
        "label": label,
        "polygon": pts,
        "wallPolygon": pts,
        "center": {"x": float(poly.centroid.x), "y": float(poly.centroid.y)},
        "bbox": _bbox(poly),
        "areaNorm": float(poly.area),
    }


def _assign_rooms_to_cells(cells, room_masks, boundary, cfg):
    if not cells:
        return []

    seeds = _room_seeds(room_masks)
    used_cells = set()
    rooms = []
    counters = defaultdict(int)

    for seed in seeds:
        point = Point(seed["cx"], seed["cy"])
        choices = [
            (idx, cell)
            for idx, cell in enumerate(cells)
            if idx not in used_cells and (cell.contains(point) or cell.distance(point) <= cfg["snap"])
        ]
        if not choices:
            choices = [(idx, cell) for idx, cell in enumerate(cells) if idx not in used_cells]
        if not choices:
            continue

        cell_index, cell = min(choices, key=lambda item: item[1].centroid.distance(point))
        used_cells.add(cell_index)
        counters[_label_slug(seed["label"])] += 1
        room = _make_room(counters[_label_slug(seed["label"])], seed["label"], cell)
        if room:
            rooms.append(room)

    # Keep extra cells as separate instances instead of merging them into nearby rooms.
    for idx, cell in enumerate(cells):
        if idx in used_cells:
            continue
        label = "Room"
        counters[_label_slug(label)] += 1
        room = _make_room(counters[_label_slug(label)], label, cell)
        if room:
            rooms.append(room)

    return _remove_room_overlaps(rooms, boundary)


def _remove_room_overlaps(rooms, boundary):
    cleaned = []
    occupied = GeometryCollection()
    for room in sorted(rooms, key=lambda item: -item.get("areaNorm", 0)):
        poly = Polygon([(point["x"], point["y"]) for point in room["polygon"]])
        poly = _largest_polygon(poly.intersection(boundary))
        if poly is None:
            continue
        if not occupied.is_empty:
            poly = _largest_polygon(poly.difference(occupied.buffer(1e-6)))
            if poly is None:
                continue
        pts = _polygon_points(poly)
        if not pts:
            continue
        room["polygon"] = pts
        room["wallPolygon"] = pts
        room["center"] = {"x": float(poly.centroid.x), "y": float(poly.centroid.y)}
        room["bbox"] = _bbox(poly)
        room["areaNorm"] = float(poly.area)
        cleaned.append(room)
        occupied = unary_union([occupied, poly]) if not occupied.is_empty else poly
    return cleaned


def _mask_fallback_rooms(room_masks, boundary):
    rooms = []
    counters = defaultdict(int)
    occupied = GeometryCollection()
    for item in sorted(room_masks, key=lambda room: -room["polygon"].area):
        poly = _largest_polygon(item["polygon"].intersection(boundary))
        if poly is None:
            continue
        if not occupied.is_empty:
            poly = _largest_polygon(poly.difference(occupied.buffer(1e-6)))
            if poly is None:
                continue
        counters[_label_slug(item["label"])] += 1
        room = _make_room(counters[_label_slug(item["label"])], item["label"], poly)
        if room:
            rooms.append(room)
            occupied = unary_union([occupied, poly]) if not occupied.is_empty else poly
    return rooms


def _cells_are_usable(cells, room_masks, boundary):
    if not cells:
        return False
    if not room_masks:
        return len(cells) > 0

    seed_count = len(room_masks)
    if len(cells) < max(1, int(seed_count * 0.45)):
        return False
    if len(cells) > max(seed_count * 3 + 4, 12):
        return False

    cell_area = sum(cell.area for cell in cells)
    mask_area = unary_union([item["polygon"] for item in room_masks]).intersection(boundary).area
    if mask_area <= 0:
        return False

    coverage_ratio = cell_area / mask_area
    if coverage_ratio < 0.55 or coverage_ratio > 1.35:
        return False

    seed_hits = 0
    for item in room_masks:
        point = Point(item["seed"]["cx"], item["seed"]["cy"])
        if any(cell.contains(point) or cell.distance(point) <= 0.02 for cell in cells):
            seed_hits += 1

    return seed_hits >= max(1, int(seed_count * 0.65))


def _wall_segments(h_walls, v_walls, boundary):
    minx, miny, maxx, maxy = boundary.bounds
    edge_tol = 0.024
    walls = []
    index = 1

    for wall in h_walls:
        if wall["x2"] - wall["x1"] <= 1e-5:
            continue
        wall_type = "exterior" if wall.get("synthetic") or abs(wall["y"] - miny) <= edge_tol or abs(wall["y"] - maxy) <= edge_tol else "interior"
        walls.append({
            "id": f"w{index}",
            "type": wall_type,
            "x1": float(wall["x1"]),
            "y1": float(wall["y"]),
            "x2": float(wall["x2"]),
            "y2": float(wall["y"]),
            "thicknessRatio": float(wall.get("t", 0.012)),
        })
        index += 1

    for wall in v_walls:
        if wall["y2"] - wall["y1"] <= 1e-5:
            continue
        wall_type = "exterior" if wall.get("synthetic") or abs(wall["x"] - minx) <= edge_tol or abs(wall["x"] - maxx) <= edge_tol else "interior"
        walls.append({
            "id": f"w{index}",
            "type": wall_type,
            "x1": float(wall["x"]),
            "y1": float(wall["y1"]),
            "x2": float(wall["x"]),
            "y2": float(wall["y2"]),
            "thicknessRatio": float(wall.get("t", 0.012)),
        })
        index += 1

    return walls


def _rooms_are_usable(rooms, boundary):
    if not rooms:
        return False
    room_area = sum(float(room.get("areaNorm", 0)) for room in rooms)
    if boundary.area <= 0:
        return False
    if room_area < boundary.area * 0.35:
        return False
    return len(rooms) >= 2 or room_area >= boundary.area * 0.60


def _walls_from_rooms(rooms, boundary, thickness=0.012):
    raw_h = []
    raw_v = []
    for room in rooms:
        points = room.get("wallPolygon") or room.get("polygon") or []
        if len(points) < 3:
            continue
        coords = [(float(point["x"]), float(point["y"])) for point in points]
        for idx, (x1, y1) in enumerate(coords):
            x2, y2 = coords[(idx + 1) % len(coords)]
            dx = abs(x2 - x1)
            dy = abs(y2 - y1)
            if max(dx, dy) < MIN_SEGMENT:
                continue
            if dx >= dy:
                y = (y1 + y2) / 2
                raw_h.append({"x1": min(x1, x2), "x2": max(x1, x2), "y": y, "t": thickness, "source": "room_boundary"})
            else:
                x = (x1 + x2) / 2
                raw_v.append({"x": x, "y1": min(y1, y2), "y2": max(y1, y2), "t": thickness, "source": "room_boundary"})

    cfg = {
        "thickness": thickness,
        "snap": 0.018,
        "merge_gap": 0.035,
        "connect_gap": 0.08,
        "boundary_pad": 0.02,
    }
    h_walls, v_walls = _snap_and_merge(raw_h, raw_v, cfg)
    h_walls, v_walls = _clip_walls_to_boundary(h_walls, v_walls, boundary, cfg)
    h_walls, v_walls = _filter_structural_walls(h_walls, v_walls, boundary, cfg)
    h_walls, v_walls = _ensure_boundary_edges(h_walls, v_walls, boundary, cfg)
    h_walls, v_walls = _trim_at_junctions(h_walls, v_walls, cfg)
    return _wall_segments(h_walls, v_walls, boundary)


def _walls_from_yolo_graph(yolo_h, yolo_v, boundary, cfg):
    h_walls = [dict(wall) for wall in yolo_h]
    v_walls = [dict(wall) for wall in yolo_v]
    if not h_walls and not v_walls:
        return []

    h_walls, v_walls = _snap_and_merge(h_walls, v_walls, cfg)
    _directional_healing(h_walls, v_walls, cfg)
    _anchor_snapping(h_walls, v_walls, cfg)
    h_walls, v_walls = _snap_and_merge(h_walls, v_walls, cfg)
    h_walls, v_walls = _clip_walls_to_boundary(h_walls, v_walls, boundary, cfg)
    h_walls, v_walls = _filter_structural_walls(h_walls, v_walls, boundary, cfg)

    # Do not synthesize every room boundary here. Missing exterior edges are fine;
    # invented interior walls are worse than sparse but trustworthy wall output.
    if len(h_walls) + len(v_walls) >= 4:
        h_walls, v_walls = _ensure_boundary_edges(h_walls, v_walls, boundary, cfg)
    _anchor_snapping(h_walls, v_walls, cfg)
    h_walls, v_walls = _trim_at_junctions(h_walls, v_walls, cfg)
    return _wall_segments(h_walls, v_walls, boundary)


def _segment_bounds(h_walls, v_walls):
    xs = [wall["x1"] for wall in h_walls] + [wall["x2"] for wall in h_walls] + [wall["x"] for wall in v_walls]
    ys = [wall["y"] for wall in h_walls] + [wall["y1"] for wall in v_walls] + [wall["y2"] for wall in v_walls]
    if not xs or not ys:
        return None
    return min(xs), max(xs), min(ys), max(ys)


def detect_floorplan_geometry(img, results, doors=None, windows=None, return_meta=False):
    height, width = img.shape[:2]
    yolo_h, yolo_v = _extract_yolo_wall_segments(results, width, height)
    room_masks = _room_mask_polygons(results, width, height)

    primary_cfg = _dynamic_config(yolo_h, yolo_v)
    primary_boundary = _virtual_outer_shell(
        room_masks,
        fallback_bounds=_segment_bounds(yolo_h, yolo_v),
        margin=primary_cfg["boundary_pad"],
    )
    primary_rooms = _mask_fallback_rooms(room_masks, primary_boundary)
    if _rooms_are_usable(primary_rooms, primary_boundary):
        primary_walls = _walls_from_yolo_graph(yolo_h, yolo_v, primary_boundary, primary_cfg)
        if not primary_walls:
            primary_walls = _walls_from_rooms(primary_rooms, primary_boundary, primary_cfg["thickness"])
        meta = {
            "mode": "room_mask_primary",
            "vectorization": "room masks for room areas; YOLO wall masks for wall vectors",
            "roomMaskCount": len(room_masks),
            "roomCount": len(primary_rooms),
            "wallCount": len(primary_walls),
            "cellCount": 0,
        }
        return (primary_rooms, primary_walls, meta) if return_meta else (primary_rooms, primary_walls)

    if _has_enough_yolo_walls(yolo_h, yolo_v):
        h_walls = yolo_h
        v_walls = yolo_v
    else:
        cv_h, cv_v = _extract_cv_wall_segments(img)
        h_walls = yolo_h + cv_h
        v_walls = yolo_v + cv_v

    cfg = _dynamic_config(h_walls, v_walls)
    boundary = _virtual_outer_shell(room_masks, fallback_bounds=_segment_bounds(h_walls, v_walls), margin=cfg["boundary_pad"])

    h_walls, v_walls = _snap_and_merge(h_walls, v_walls, cfg)
    _bridge_openings(h_walls, v_walls, (doors or []) + (windows or []), cfg)
    _directional_healing(h_walls, v_walls, cfg)
    _anchor_snapping(h_walls, v_walls, cfg)
    h_walls, v_walls = _snap_and_merge(h_walls, v_walls, cfg)
    h_walls, v_walls = _clip_walls_to_boundary(h_walls, v_walls, boundary, cfg)
    h_walls, v_walls = _filter_structural_walls(h_walls, v_walls, boundary, cfg)
    h_walls, v_walls = _ensure_boundary_edges(h_walls, v_walls, boundary, cfg)
    _anchor_snapping(h_walls, v_walls, cfg)
    h_walls, v_walls = _trim_at_junctions(h_walls, v_walls, cfg)

    cells = _polygonize_cells(h_walls, v_walls, boundary, cfg)
    if _cells_are_usable(cells, room_masks, boundary):
        rooms = _assign_rooms_to_cells(cells, room_masks, boundary, cfg)
        mode = "structural_graph_polygonize"
    else:
        rooms = _mask_fallback_rooms(room_masks, boundary)
        mode = "mask_fallback_after_graph_validation"

    walls = _wall_segments(h_walls, v_walls, boundary)
    meta = {
        "mode": mode,
        "vectorization": "YOLO wall graph with validated polygonization and mask fallback",
        "roomMaskCount": len(room_masks),
        "roomCount": len(rooms),
        "wallCount": len(walls),
        "cellCount": len(cells),
    }
    return (rooms, walls, meta) if return_meta else (rooms, walls)
