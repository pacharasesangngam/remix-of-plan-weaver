import type { DetectFloorPlanResult } from "@/types/detection";
import type { Room, BBox } from "@/types/floorplan";

// ─────────────────────────────────────────────────────────────
// Raw types ที่ backend ส่งมา (ก่อน transform)
// ─────────────────────────────────────────────────────────────
interface RawPoint {
  x: number;
  y: number;
}

interface RawRoom {
  id: string;
  name: string;
  polygon: RawPoint[];
}

interface RawDoor {
  id: string;
  bbox: BBox;
  widthPx?: number;
  widthM?: number;
}

interface RawWindow {
  id: string;
  bbox: BBox;
  widthPx?: number;
  widthM?: number;
}

interface RawApiResponse {
  meta: { unit: string; scale: number };
  rooms: RawRoom[];
  walls: DetectFloorPlanResult["walls"];
  doors: RawDoor[];
  windows: RawWindow[];
}

// ─────────────────────────────────────────────────────────────
// Mapper: polygon (normalized 0–1) → Room
// ─────────────────────────────────────────────────────────────
function polygonToRoom(raw: RawRoom): Room {
  if (!raw.polygon || raw.polygon.length === 0) {
    // fallback กรณี polygon ว่าง
    return {
      id: raw.id,
      name: raw.name,
      width: 0,
      height: 0,
      confidence: "low",
      bbox: { x: 0, y: 0, w: 0, h: 0 },
    };
  }

  const xs = raw.polygon.map((p) => p.x);
  const ys = raw.polygon.map((p) => p.y);

  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;

  const bbox: BBox = { x, y, w, h };

  return {
    id: raw.id,
    name: raw.name,
    // width/height เก็บเป็น normalized fraction (0–1) ของรูป
    // การแปลงเป็นเมตรจริงทำทีหลังเมื่อผู้ใช้ calibrate scale แล้ว
    // → realWidth  = bbox.w * imgPixelWidth  * scale (m/px)
    // → realHeight = bbox.h * imgPixelHeight * scale (m/px)
    width: w,
    height: h,
    confidence: "high",
    wallHeight: 2.8,
    bbox,
  };
}

// ─────────────────────────────────────────────────────────────
// Main service
// ─────────────────────────────────────────────────────────────
export async function detectFloorPlan(file: File): Promise<DetectFloorPlanResult> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch("http://localhost:8000/api/detect-floorplan", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "unknown error");
    throw new Error(`Backend error ${res.status}: ${detail}`);
  }

  const json: RawApiResponse = await res.json();

  // transform rooms: polygon[] → Room (with bbox)
  const rooms: Room[] = (json.rooms ?? []).map(polygonToRoom);

  return {
    rooms,
    walls:   json.walls   ?? [],
    doors:   json.doors   ?? [],
    windows: json.windows ?? [],
    // scale จาก backend ไม่ได้ใช้ตรงๆ แล้ว
    // ผู้ใช้ต้อง calibrate เองผ่าน WallReview ก่อนถึงจะได้ค่าเมตรจริง
  };
}