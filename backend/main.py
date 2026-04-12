import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

app = FastAPI(title="Floor Plan Vision API")
model = YOLO("best_v2.pt")
IMG_SIZE = 960

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

def to_python(obj):
    if isinstance(obj, dict): return {k: to_python(v) for k, v in obj.items()}
    if isinstance(obj, list): return [to_python(i) for i in obj]
    if isinstance(obj, np.generic): return obj.item()
    return obj

def build_wall_mask(results, width, height):
    mask = np.zeros((height, width), dtype=np.uint8)
    if results.masks is not None:
        for i, cls in enumerate(results.boxes.cls):
            if results.names[int(cls)] == "wall":
                poly = results.masks.xy[i]
                if poly is not None: cv2.fillPoly(mask, [np.array(poly, dtype=np.int32)], 255)
    return mask

def extract_rooms(results, width, height):
    rooms = []
    if results.masks is None: return rooms
    for i, cls in enumerate(results.boxes.cls):
        label = results.names[int(cls)]
        if "room" not in label.lower(): continue
        poly = results.masks.xy[i]
        if poly is None or len(poly) < 3: continue
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
    lines = cv2.HoughLinesP(mask, 1, np.pi/180, threshold=30, minLineLength=15, maxLineGap=20)
    if lines is None: return []
    return [{"x1": float(l[0][0]), "y1": float(l[0][1]), "x2": float(l[0][2]), "y2": float(l[0][3])} for l in lines]

def align_axis(walls):
    for w in walls:
        if abs(w["x2"] - w["x1"]) > abs(w["y2"] - w["y1"]):
            y = (w["y1"] + w["y2"]) / 2
            w["y1"] = w["y2"] = y
        else:
            x = (w["x1"] + w["x2"]) / 2
            w["x1"] = w["x2"] = x
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
                        if min(w["x1"], w["x2"]) <= max(m["x1"], m["x2"]) + gap_thresh and max(w["x1"], w["x2"]) >= min(m["x1"], m["x2"]) - gap_thresh:
                            m["x1"], m["x2"] = min(w["x1"], w["x2"], m["x1"], m["x2"]), max(w["x1"], w["x2"], m["x1"], m["x2"])
                            m["y1"] = m["y2"] = (w["y1"] + m["y1"]) / 2
                            found = True; break
                    elif not is_horiz and abs(w["x1"] - m["x1"]) < perp_thresh:
                        if min(w["y1"], w["y2"]) <= max(m["y1"], m["y2"]) + gap_thresh and max(w["y1"], w["y2"]) >= min(m["y1"], m["y2"]) - gap_thresh:
                            m["y1"], m["y2"] = min(w["y1"], w["y2"], m["y1"], m["y2"]), max(w["y1"], w["y2"], m["y1"], m["y2"])
                            m["x1"] = m["x2"] = (w["x1"] + m["x1"]) / 2
                            found = True; break
            if not found: merged.append(w.copy())
        return merged
    return merge_pass(merge_pass(walls))

def snap_and_trim_corners(walls, snap_dist=70):
    for i, w1 in enumerate(walls):
        is_h1 = abs(w1["y1"] - w1["y2"]) < 1e-5
        for j, w2 in enumerate(walls):
            if i == j or is_h1 == (abs(w2["y1"] - w2["y2"]) < 1e-5): continue
            h, v = (w1, w2) if is_h1 else (w2, w1)
            ix, iy = v["x1"], h["y1"]
            if (min(h["x1"], h["x2"]) - snap_dist <= ix <= max(h["x1"], h["x2"]) + snap_dist) and \
               (min(v["y1"], v["y2"]) - snap_dist <= iy <= max(v["y1"], v["y2"]) + snap_dist):
                if abs(h["x1"] - ix) < snap_dist: h["x1"] = ix
                elif abs(h["x2"] - ix) < snap_dist: h["x2"] = ix
                if abs(v["y1"] - iy) < snap_dist: v["y1"] = iy
                elif abs(v["y2"] - iy) < snap_dist: v["y2"] = iy
    return walls

def snap_to_borders(walls, w, h, margin=35):
    for wall in walls:
        for k in ["x1", "x2"]:
            if wall[k] < margin: wall[k] = 0.0
            elif wall[k] > w - margin: wall[k] = float(w)
        for k in ["y1", "y2"]:
            if wall[k] < margin: wall[k] = 0.0
            elif wall[k] > h - margin: wall[k] = float(h)
    return walls

def extract_clean_walls(results, width, height, doors, windows):
    mask = build_wall_mask(results, width, height)
    # ลด Padding เหลือ 2 เพื่อความผอม
    for item in doors + windows:
        x, y, bw, bh = item["bbox"]["x"]*width, item["bbox"]["y"]*height, item["bbox"]["w"]*width, item["bbox"]["h"]*height
        cv2.rectangle(mask, (int(x-0), int(y-0)), (int(x+bw+0), int(y+bh+0)), 255, -1)
    
    mask = cv2.medianBlur(mask, 5)
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=1)
    skel = skeletonize(mask)
    
    # cv2.imwrite("debug_1_mask.png", mask)
    # cv2.imwrite("debug_2_skel.png", skel)
    
    
    walls = detect_lines(skel)
    walls = align_axis(walls)
    walls = merge_collinear(walls)
    walls = snap_and_trim_corners(walls, 50)
    walls = snap_to_borders(walls, width, height, 35)
    
    final_walls = []
    for i, w in enumerate(walls):
        if np.hypot(w["x2"] - w["x1"], w["y2"] - w["y1"]) >= 5:
            w.update({"id": f"wall-{i}", "x1": w["x1"]/width, "y1": w["y1"]/height, "x2": w["x2"]/width, "y2": w["y2"]/height, "type": "interior", "thicknessRatio": 0.01})
            final_walls.append(w)
    return final_walls

def detect(image_bytes):
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    h, w = img.shape[:2]
    results = model(img, imgsz=IMG_SIZE)[0]
    doors, windows = [], []
    
    # Calibration variables
    door_widths = []

    for i, (cls, conf, box) in enumerate(zip(results.boxes.cls, results.boxes.conf, results.boxes.xyxy)):
        if conf < 0.4: continue
        label = results.names[int(cls)]
        x1, y1, x2, y2 = box.cpu().numpy()
        bw_px, bh_px = x2 - x1, y2 - y1
        bbox = {"x": float(x1/w), "y": float(y1/h), "w": float(bw_px/w), "h": float(bh_px/h)}
        
        if label == "door":
            # ยืด bbox ออกไปข้างละประมาณ 5-8 พิกเซล
            padding_px = 7 
            x1_final = max(0, x1 - padding_px)
            x2_final = min(w, x2 + padding_px)
            
            bw_px = x2_final - x1_final
            bh_px = y2 - y1 # ความหนาประตูใช้ค่าเดิม
            
            # อัปเดต bbox ใหม่
            bbox = {"x": float(x1_final/w), "y": float(y1/h), "w": float(bw_px/w), "h": float(bh_px/h)}
            
            px_w = float(bw_px) # ใช้ความกว้างที่ยืดแล้ว
            doors.append({"id": f"door-{i}", "bbox": bbox, "widthPx": px_w, "widthM": None})
        elif label == "window":
            windows.append({"id": f"window-{i}", "bbox": bbox, "widthPx": float(bw_px), "widthM": None})
    
    # Calculate scale (Calibration)
    avg_door_px = np.mean(door_widths) if door_widths else 40 
    calculated_scale = 1.0

    rooms = extract_rooms(results, w, h)
    walls = extract_clean_walls(results, w, h, doors, windows)
    
    return rooms, walls, doors, windows, calculated_scale

@app.post("/api/detect-floorplan")
async def analyze(file: UploadFile = File(...)):
    try:
        rooms, walls, doors, windows, scale = detect(await file.read())
        return {
            "meta": {
                "unit": "m",
                "scale": float(scale) # ส่งสเกลจริงกลับไปให้ Frontend
            },
            "rooms": to_python(rooms),
            "walls": to_python(walls),
            "doors": to_python(doors),
            "windows": to_python(windows)
        }
    except Exception as e: raise HTTPException(status_code=400, detail=str(e))