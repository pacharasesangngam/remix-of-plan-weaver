import base64
import cv2
import fitz
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

app = FastAPI(title="Floor Plan Vision API")
model = YOLO("best_v10.pt")
IMG_SIZE = 1024

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


# ---------------------------------------------------------
# อัลกอริทึมทำความสะอาดและรวมเส้น (Vector Cleanup Magic)
# ---------------------------------------------------------
def clean_and_merge_walls(raw_walls, merge_tol=0.03, snap_tol=0.04):
    h_lines = []
    v_lines = []
    
    # 1. แยกเส้นแนวนอน/แนวตั้ง และดัดให้ตรงเป๊ะ 100%
    for w in raw_walls:
        if abs(w['x1'] - w['x2']) > abs(w['y1'] - w['y2']):
            y_avg = (w['y1'] + w['y2']) / 2.0
            h_lines.append({'x1': min(w['x1'], w['x2']), 'x2': max(w['x1'], w['x2']), 'y': y_avg, 't': w['thicknessRatio']})
        else:
            x_avg = (w['x1'] + w['x2']) / 2.0
            v_lines.append({'y1': min(w['y1'], w['y2']), 'y2': max(w['y1'], w['y2']), 'x': x_avg, 't': w['thicknessRatio']})
            
    # 2. รวมเส้นแนวนอน (Merge Horizontal)
    merged_h = []
    while h_lines:
        base = h_lines.pop(0)
        merged = True
        while merged:
            merged = False
            for i in range(len(h_lines)-1, -1, -1):
                chk = h_lines[i]
                # ถ้าระนาบ Y เดียวกัน (เหลื่อมกันไม่เกินค่า tolerance)
                if abs(base['y'] - chk['y']) < merge_tol:
                    # ถ้าเส้นทับกัน หรือเกือบจะต่อกัน (ห่างกันนิดเดียว)
                    if max(base['x1'], chk['x1']) - min(base['x2'], chk['x2']) < snap_tol:
                        # ขยายเส้นรวมกัน
                        base['x1'] = min(base['x1'], chk['x1'])
                        base['x2'] = max(base['x2'], chk['x2'])
                        base['y'] = (base['y'] + chk['y']) / 2.0
                        base['t'] = (base['t'] + chk['t']) / 2.0
                        h_lines.pop(i)
                        merged = True
        merged_h.append(base)
        
    # 3. รวมเส้นแนวตั้ง (Merge Vertical)
    merged_v = []
    while v_lines:
        base = v_lines.pop(0)
        merged = True
        while merged:
            merged = False
            for i in range(len(v_lines)-1, -1, -1):
                chk = v_lines[i]
                if abs(base['x'] - chk['x']) < merge_tol:
                    if max(base['y1'], chk['y1']) - min(base['y2'], chk['y2']) < snap_tol:
                        base['y1'] = min(base['y1'], chk['y1'])
                        base['y2'] = max(base['y2'], chk['y2'])
                        base['x'] = (base['x'] + chk['x']) / 2.0
                        base['t'] = (base['t'] + chk['t']) / 2.0
                        v_lines.pop(i)
                        merged = True
        merged_v.append(base)
        
    # 4. เข้ามุม Snap Corners (แก้เส้นเหลื่อมตรงมุม)
    for hw in merged_h:
        for vw in merged_v:
            # ตรวจสอบว่าเส้นมาตัดกันหรือใกล้กันตรงมุมไหม
            if (hw['x1'] - snap_tol <= vw['x'] <= hw['x2'] + snap_tol) and \
               (vw['y1'] - snap_tol <= hw['y'] <= vw['y2'] + snap_tol):
                
                # ดึงปลายเส้นแนวนอนให้มาชนแกน X ของเส้นแนวตั้ง
                if abs(hw['x1'] - vw['x']) < snap_tol: hw['x1'] = vw['x']
                if abs(hw['x2'] - vw['x']) < snap_tol: hw['x2'] = vw['x']
                
                # ดึงปลายเส้นแนวตั้งให้มาชนแกน Y ของเส้นแนวนอน
                if abs(vw['y1'] - hw['y']) < snap_tol: vw['y1'] = hw['y']
                if abs(vw['y2'] - hw['y']) < snap_tol: vw['y2'] = hw['y']

    # 5. จัด Format คืนให้ระบบ
    final_walls = []
    idx = 0
    for hw in merged_h:
        final_walls.append({
            "id": f"wall-{idx}", "type": "interior",
            "x1": float(hw['x1']), "y1": float(hw['y']),
            "x2": float(hw['x2']), "y2": float(hw['y']),
            "thicknessRatio": float(hw['t'])
        })
        idx += 1
    for vw in merged_v:
        final_walls.append({
            "id": f"wall-{idx}", "type": "interior",
            "x1": float(vw['x']), "y1": float(vw['y1']),
            "x2": float(vw['x']), "y2": float(vw['y2']),
            "thicknessRatio": float(vw['t'])
        })
        idx += 1
        
    return final_walls

# ดึงข้อมูลผนังดิบๆ จาก YOLO
def extract_raw_walls(results, width, height):
    raw_walls = []
    if results.masks is None:
        return raw_walls
        
    for i, (cls, conf) in enumerate(zip(results.boxes.cls, results.boxes.conf)):
        if conf < 0.25: # กำแพงใช้ความแม่นยำต่ำได้เพราะเราเอาไปรวมร่างต่อ
            continue
            
        if results.names[int(cls)] == "wall":
            poly = results.masks.xy[i]
            if poly is None or len(poly) < 3:
                continue
                
            pts = np.array(poly, dtype=np.float32)
            rect = cv2.minAreaRect(pts)
            (cx, cy), (w_rect, h_rect), angle = rect
            
            if w_rect < 1 or h_rect < 1: continue
                
            if w_rect > h_rect:
                length, thickness, theta = w_rect, h_rect, np.deg2rad(angle)
            else:
                length, thickness, theta = h_rect, w_rect, np.deg2rad(angle + 90)
                
            dx = (length / 2.0) * np.cos(theta)
            dy = (length / 2.0) * np.sin(theta)
            
            raw_walls.append({
                "x1": (cx - dx) / width, "y1": (cy - dy) / height,
                "x2": (cx + dx) / width, "y2": (cy + dy) / height,
                "thicknessRatio": thickness / max(width, height)
            })
    return raw_walls


def detect(file_bytes, filename=""):
    img = decode_input_image(file_bytes, filename)
    preview_image = encode_image_data_url(img)
    h, w = img.shape[:2]
    results = model(img, imgsz=IMG_SIZE)[0]
    doors, windows = [], []

    for i, (cls, conf, box) in enumerate(zip(results.boxes.cls, results.boxes.conf, results.boxes.xyxy)):
        # คืนค่า Threshold เป็น 0.4 ป้องกันประตู/หน้าต่างมั่ว!!
        if conf < 0.4:
            continue

        label = results.names[int(cls)]
        x1_b, y1_b, x2_b, y2_b = box.cpu().numpy()
        bw_px, bh_px = x2_b - x1_b, y2_b - y1_b
        
        # กล่องตั้งต้นจาก Bounding Box ของ YOLO
        bbox = {"x": float(x1_b / w), "y": float(y1_b / h), "w": float(bw_px / w), "h": float(bh_px / h)}
        
        poly = results.masks.xy[i] if results.masks is not None and i < len(results.masks.xy) else None
        poly_bbox = normalized_bbox_from_poly(poly, w, h)
        polygon = normalized_polygon(poly, w, h)

        if label == "door":
            final_bbox = poly_bbox if poly_bbox is not None else bbox
            px_w = float(max(final_bbox["w"] * w, final_bbox["h"] * h))
            
            # ---------------------------------------------------
            # 🛡️ ระบบป้องกันประตูมั่ว (ฆ่ากล่องผีหลอก)
            # ---------------------------------------------------
            # 1. ถ้ากว้างเกิน 20% หรือ สูงเกิน 20% ของแปลนบ้าน = ขยะแน่นอน (ตัดทิ้ง)
            if final_bbox["w"] > 0.20 or final_bbox["h"] > 0.20:
                continue
            # 2. ถ้าพื้นที่โดยรวมเกิน 3% ของภาพ = ตัดทิ้ง
            if (final_bbox["w"] * final_bbox["h"]) > 0.03:
                continue
                
            doors.append({"id": f"door-{i}", "bbox": final_bbox, "polygon": polygon, "widthPx": px_w, "widthM": None})
            
        elif label == "window":
            final_bbox = poly_bbox if poly_bbox is not None else bbox
            px_w = float(max(final_bbox["w"] * w, final_bbox["h"] * h))
            
            # ---------------------------------------------------
            # 🛡️ ระบบป้องกันหน้าต่างมั่ว
            # ---------------------------------------------------
            # หน้าต่างอาจจะยาวได้ แต่ไม่ควรเกิน 30% ของแปลน
            if final_bbox["w"] > 0.30 or final_bbox["h"] > 0.30:
                continue
            if (final_bbox["w"] * final_bbox["h"]) > 0.05:
                continue
                
            windows.append({"id": f"window-{i}", "bbox": final_bbox, "polygon": polygon, "widthPx": px_w, "widthM": None})

            calculated_scale = 1.0

    rooms = extract_rooms(results, w, h)
    
    # ใช้งานกระบวนการใหม่: ดึงผนังดิบ -> ส่งเข้าเครื่องฟอกทำความสะอาด
    raw_walls = extract_raw_walls(results, w, h)
    walls = clean_and_merge_walls(raw_walls)

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