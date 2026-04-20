import base64
import cv2
import fitz
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

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


def build_wall_mask(results, width, height):
    mask = np.zeros((height, width), dtype=np.uint8)
    if results.masks is not None:
        for i, cls in enumerate(results.boxes.cls):
            if results.names[int(cls)] == "wall":
                poly = results.masks.xy[i]
                if poly is not None:
                    cv2.fillPoly(mask, [np.array(poly, dtype=np.int32)], 255)
    return mask


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


def extract_rooms(results, width, height):
    rooms = []
    if results.masks is None:
        return rooms

    for i, cls in enumerate(results.boxes.cls):
        label = results.names[int(cls)]
        if "room" not in label.lower():
            continue

        poly = results.masks.xy[i]
        if poly is None or len(poly) < 3:
            continue

        contour = np.array(poly, dtype=np.float32).reshape(-1, 1, 2)
        approx = cv2.approxPolyDP(contour, 0.01 * cv2.arcLength(contour, True), True)
        points = [{"x": float(p[0][0] / width), "y": float(p[0][1] / height)} for p in approx]
        rooms.append({"id": f"room-{i}", "name": label, "polygon": points})
    return rooms


def skeletonize(mask):
    skel = np.zeros_like(mask)
    element = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    temp_mask = mask.copy()
    while cv2.countNonZero(temp_mask) > 0:
        eroded = cv2.erode(temp_mask, element)
        temp = cv2.subtract(temp_mask, cv2.dilate(eroded, element))
        skel = cv2.bitwise_or(skel, temp)
        temp_mask = eroded.copy()
    return skel


def detect_lines(mask):
    lines = cv2.HoughLinesP(mask, 1, np.pi / 180, threshold=30, minLineLength=15, maxLineGap=20)
    if lines is None:
        return []
    return [
        {"x1": float(l[0][0]), "y1": float(l[0][1]), "x2": float(l[0][2]), "y2": float(l[0][3])}
        for l in lines
    ]


def align_axis(walls):
    for w in walls:
        if abs(w["x2"] - w["x1"]) > abs(w["y2"] - w["y1"]):
            y = (w["y1"] + w["y2"]) / 2
            w["y1"] = w["y2"] = y
        else:
            x = (w["x1"] + w["x2"]) / 2
            w["x1"] = w["x2"] = x
    return walls


def normalize_wall_endpoints(walls):
    normalized = []
    for wall in walls:
        w = wall.copy()
        if is_horizontal_wall(w):
            x1, x2 = sorted((w["x1"], w["x2"]))
            y = (w["y1"] + w["y2"]) / 2
            w["x1"], w["x2"] = x1, x2
            w["y1"] = w["y2"] = y
        else:
            y1, y2 = sorted((w["y1"], w["y2"]))
            x = (w["x1"] + w["x2"]) / 2
            w["y1"], w["y2"] = y1, y2
            w["x1"] = w["x2"] = x
        normalized.append(w)
    return normalized


def snap_axis_clusters(walls, axis_thresh=12):
    horizontals = [w for w in walls if is_horizontal_wall(w)]
    verticals = [w for w in walls if not is_horizontal_wall(w)]

    def snap_group(group, axis_key):
        if not group:
            return
        group.sort(key=lambda wall: wall[axis_key])
        cluster = [group[0]]
        for wall in group[1:]:
            if abs(wall[axis_key] - cluster[-1][axis_key]) <= axis_thresh:
                cluster.append(wall)
                continue
            snapped = float(np.mean([item[axis_key] for item in cluster]))
            for item in cluster:
                item[axis_key] = snapped
                if axis_key == "x1":
                    item["x2"] = snapped
                else:
                    item["y2"] = snapped
            cluster = [wall]

        snapped = float(np.mean([item[axis_key] for item in cluster]))
        for item in cluster:
            item[axis_key] = snapped
            if axis_key == "x1":
                item["x2"] = snapped
            else:
                item["y2"] = snapped

    snap_group(horizontals, "y1")
    snap_group(verticals, "x1")
    return walls


def merge_collinear(walls, perp_thresh=15, gap_thresh=80):
    def merge_pass(wall_list):
        merged = []
        for w in wall_list:
            is_horiz = abs(w["y1"] - w["y2"]) < 1e-5
            found = False
            for m in merged:
                if is_horiz == (abs(m["y1"] - m["y2"]) < 1e-5):
                    if is_horiz and abs(w["y1"] - m["y1"]) < perp_thresh:
                        overlaps = (
                            min(w["x1"], w["x2"]) <= max(m["x1"], m["x2"]) + gap_thresh
                            and max(w["x1"], w["x2"]) >= min(m["x1"], m["x2"]) - gap_thresh
                        )
                        if overlaps:
                            m["x1"], m["x2"] = (
                                min(w["x1"], w["x2"], m["x1"], m["x2"]),
                                max(w["x1"], w["x2"], m["x1"], m["x2"]),
                            )
                            m["y1"] = m["y2"] = (w["y1"] + m["y1"]) / 2
                            found = True
                            break
                    elif not is_horiz and abs(w["x1"] - m["x1"]) < perp_thresh:
                        overlaps = (
                            min(w["y1"], w["y2"]) <= max(m["y1"], m["y2"]) + gap_thresh
                            and max(w["y1"], w["y2"]) >= min(m["y1"], m["y2"]) - gap_thresh
                        )
                        if overlaps:
                            m["y1"], m["y2"] = (
                                min(w["y1"], w["y2"], m["y1"], m["y2"]),
                                max(w["y1"], w["y2"], m["y1"], m["y2"]),
                            )
                            m["x1"] = m["x2"] = (w["x1"] + m["x1"]) / 2
                            found = True
                            break
            if not found:
                merged.append(w.copy())
        return merged

    return merge_pass(merge_pass(walls))


def snap_and_trim_corners(walls, snap_dist=70):
    for i, w1 in enumerate(walls):
        is_h1 = abs(w1["y1"] - w1["y2"]) < 1e-5
        for j, w2 in enumerate(walls):
            if i == j or is_h1 == (abs(w2["y1"] - w2["y2"]) < 1e-5):
                continue

            h, v = (w1, w2) if is_h1 else (w2, w1)
            ix, iy = v["x1"], h["y1"]
            if (
                min(h["x1"], h["x2"]) - snap_dist <= ix <= max(h["x1"], h["x2"]) + snap_dist
                and min(v["y1"], v["y2"]) - snap_dist <= iy <= max(v["y1"], v["y2"]) + snap_dist
            ):
                if abs(h["x1"] - ix) < snap_dist:
                    h["x1"] = ix
                elif abs(h["x2"] - ix) < snap_dist:
                    h["x2"] = ix

                if abs(v["y1"] - iy) < snap_dist:
                    v["y1"] = iy
                elif abs(v["y2"] - iy) < snap_dist:
                    v["y2"] = iy
    return walls


def connect_wall_junctions(walls, snap_dist=35):
    horizontals = [w for w in walls if is_horizontal_wall(w)]
    verticals = [w for w in walls if not is_horizontal_wall(w)]

    for h in horizontals:
        hx1, hx2 = sorted((h["x1"], h["x2"]))
        hy = h["y1"]
        for v in verticals:
            vy1, vy2 = sorted((v["y1"], v["y2"]))
            vx = v["x1"]

            can_meet = hx1 - snap_dist <= vx <= hx2 + snap_dist and vy1 - snap_dist <= hy <= vy2 + snap_dist
            if not can_meet:
                continue

            if abs(h["x1"] - vx) <= snap_dist:
                h["x1"] = vx
            elif abs(h["x2"] - vx) <= snap_dist:
                h["x2"] = vx

            if abs(v["y1"] - hy) <= snap_dist:
                v["y1"] = hy
            elif abs(v["y2"] - hy) <= snap_dist:
                v["y2"] = hy

    return normalize_wall_endpoints(walls)


def snap_to_borders(walls, w, h, margin=35):
    for wall in walls:
        for k in ["x1", "x2"]:
            if wall[k] < margin:
                wall[k] = 0.0
            elif wall[k] > w - margin:
                wall[k] = float(w)
        for k in ["y1", "y2"]:
            if wall[k] < margin:
                wall[k] = 0.0
            elif wall[k] > h - margin:
                wall[k] = float(h)
    return walls


def wall_length(wall):
    return float(np.hypot(wall["x2"] - wall["x1"], wall["y2"] - wall["y1"]))


def is_horizontal_wall(wall):
    return abs(wall["y1"] - wall["y2"]) <= abs(wall["x1"] - wall["x2"])


def wall_overlap_ratio(a, b):
    a_horizontal = is_horizontal_wall(a)
    b_horizontal = is_horizontal_wall(b)
    if a_horizontal != b_horizontal:
        return 0.0

    if a_horizontal:
        if abs(a["y1"] - b["y1"]) > 10:
            return 0.0
        a_min, a_max = sorted((a["x1"], a["x2"]))
        b_min, b_max = sorted((b["x1"], b["x2"]))
    else:
        if abs(a["x1"] - b["x1"]) > 10:
            return 0.0
        a_min, a_max = sorted((a["y1"], a["y2"]))
        b_min, b_max = sorted((b["y1"], b["y2"]))

    overlap = max(0.0, min(a_max, b_max) - max(a_min, b_min))
    shorter = max(1.0, min(a_max - a_min, b_max - b_min))
    return overlap / shorter


def average_parallel_gap(a, b):
    if is_horizontal_wall(a):
        return abs(a["y1"] - b["y1"])
    return abs(a["x1"] - b["x1"])


def dedupe_walls(walls):
    if len(walls) < 2:
        return walls

    kept = []
    for wall in sorted(walls, key=wall_length, reverse=True):
        duplicate = False
        for existing in kept:
            overlap_ratio = wall_overlap_ratio(wall, existing)
            if overlap_ratio >= 0.9 and average_parallel_gap(wall, existing) <= 10:
                duplicate = True
                break
        if not duplicate:
            kept.append(wall)
    return kept


def extract_clean_walls(results, width, height, doors, windows):
    mask = build_wall_mask(results, width, height)
    for item in doors + windows:
        x = item["bbox"]["x"] * width
        y = item["bbox"]["y"] * height
        bw = item["bbox"]["w"] * width
        bh = item["bbox"]["h"] * height
        cv2.rectangle(mask, (int(x), int(y)), (int(x + bw), int(y + bh)), 255, -1)

    mask = cv2.medianBlur(mask, 5)
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=1)
    skel = skeletonize(mask)

    # cv2.imwrite("debug_1_mask.png", mask)
    # cv2.imwrite("debug_2_skel.png", skel)

    walls = detect_lines(skel)
    walls = align_axis(walls)
    walls = normalize_wall_endpoints(walls)
    walls = snap_axis_clusters(walls)
    walls = merge_collinear(walls)
    walls = snap_and_trim_corners(walls, 50)
    walls = connect_wall_junctions(walls, 45)
    walls = merge_collinear(walls, perp_thresh=12, gap_thresh=45)
    walls = snap_to_borders(walls, width, height, 35)
    walls = dedupe_walls(walls)

    final_walls = []
    for i, w in enumerate(walls):
        if np.hypot(w["x2"] - w["x1"], w["y2"] - w["y1"]) >= 5:
            w.update(
                {
                    "id": f"wall-{i}",
                    "x1": w["x1"] / width,
                    "y1": w["y1"] / height,
                    "x2": w["x2"] / width,
                    "y2": w["y2"] / height,
                    "type": "interior",
                    "thicknessRatio": 0.01,
                }
            )
            final_walls.append(w)
    return final_walls


def detect(file_bytes, filename=""):
    img = decode_input_image(file_bytes, filename)
    preview_image = encode_image_data_url(img)
    h, w = img.shape[:2]
    results = model(img, imgsz=IMG_SIZE)[0]
    doors, windows = [], []

    # Calibration variables
    door_widths = []

    for i, (cls, conf, box) in enumerate(zip(results.boxes.cls, results.boxes.conf, results.boxes.xyxy)):
        if conf < 0.4:
            continue

        label = results.names[int(cls)]
        x1, y1, x2, y2 = box.cpu().numpy()
        bw_px, bh_px = x2 - x1, y2 - y1
        bbox = {"x": float(x1 / w), "y": float(y1 / h), "w": float(bw_px / w), "h": float(bh_px / h)}
        poly = results.masks.xy[i] if results.masks is not None and i < len(results.masks.xy) else None
        poly_bbox = normalized_bbox_from_poly(poly, w, h)
        polygon = normalized_polygon(poly, w, h)

        if label == "door":
            if poly_bbox is not None:
                bbox = poly_bbox
                px_w = float(max(bbox["w"] * w, bbox["h"] * h))
            else:
                px_w = float(max(bw_px, bh_px))
            doors.append({"id": f"door-{i}", "bbox": bbox, "polygon": polygon, "widthPx": px_w, "widthM": None})
        elif label == "window":
            if poly_bbox is not None:
                bbox = poly_bbox
                px_w = float(max(bbox["w"] * w, bbox["h"] * h))
            else:
                px_w = float(max(bw_px, bh_px))
            windows.append({"id": f"window-{i}", "bbox": bbox, "polygon": polygon, "widthPx": px_w, "widthM": None})

    avg_door_px = np.mean(door_widths) if door_widths else 40
    calculated_scale = 1.0

    rooms = extract_rooms(results, w, h)
    walls = extract_clean_walls(results, w, h, doors, windows)

    return rooms, walls, doors, windows, calculated_scale, preview_image


@app.post("/api/detect-floorplan")
async def analyze(file: UploadFile = File(...)):
    try:
        rooms, walls, doors, windows, scale, preview_image = detect(await file.read(), file.filename or "")
        return {
            "meta": {
                "unit": "m",
                "scale": float(scale),
            },
            "rooms": to_python(rooms),
            "walls": to_python(walls),
            "doors": to_python(doors),
            "windows": to_python(windows),
            "image": preview_image,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
