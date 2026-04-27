import type { DetectFloorPlanResult } from "@/types/detection";
import type { Room, BBox, NormalizedPoint } from "@/types/floorplan";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:8000").replace(/\/+$/, "");

interface RawPoint {
  x: number;
  y: number;
}

interface RawRoom {
  id: string;
  name: string;
  polygon: RawPoint[];
  wallPolygon?: RawPoint[] | null;
  center?: RawPoint | null;
  bbox?: BBox | null;
}

interface RawDoor {
  id: string;
  bbox: BBox;
  polygon?: RawPoint[] | null;
  widthPx?: number;
  widthM?: number;
}

interface RawWindow {
  id: string;
  bbox: BBox;
  polygon?: RawPoint[] | null;
  widthPx?: number;
  widthM?: number;
}

interface RawApiResponse {
  meta: { unit: string; scale: number };
  rooms: RawRoom[];
  walls: DetectFloorPlanResult["walls"];
  doors: RawDoor[];
  windows: RawWindow[];
  image?: string;
}

function polygonCentroid(points: RawPoint[]): RawPoint | null {
  if (points.length < 3) return null;

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < points.length; i += 1) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const cross = p1.x * p2.y - p2.x * p1.y;
    twiceArea += cross;
    cx += (p1.x + p2.x) * cross;
    cy += (p1.y + p2.y) * cross;
  }

  if (Math.abs(twiceArea) < 1e-8) {
    const sum = points.reduce(
      (acc, point) => {
        acc.x += point.x;
        acc.y += point.y;
        return acc;
      },
      { x: 0, y: 0 },
    );
    return { x: sum.x / points.length, y: sum.y / points.length };
  }

  const factor = 1 / (3 * twiceArea);
  return {
    x: cx * factor,
    y: cy * factor,
  };
}

function polygonToRoom(raw: RawRoom): Room {
  const originalPolygon = raw.polygon ?? [];
  const wallPolygon = raw.wallPolygon ?? originalPolygon;

  if (originalPolygon.length === 0 && wallPolygon.length === 0) {
    return {
      id: raw.id,
      name: raw.name,
      width: 0,
      height: 0,
      confidence: "low",
      polygon: [],
      wallPolygon: [],
      center: { x: 0, y: 0 },
      bbox: { x: 0, y: 0, w: 0, h: 0 },
    };
  }

  const shapePolygon = wallPolygon.length > 0 ? wallPolygon : originalPolygon;
  const xs = shapePolygon.map((p) => p.x);
  const ys = shapePolygon.map((p) => p.y);

  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  const bbox: BBox = raw.bbox ?? { x, y, w, h };
  const center = raw.center ?? polygonCentroid(shapePolygon) ?? { x: x + w / 2, y: y + h / 2 };

  return {
    id: raw.id,
    name: raw.name,
    width: bbox.w,
    height: bbox.h,
    confidence: "high",
    polygon: originalPolygon as NormalizedPoint[],
    wallPolygon: wallPolygon as NormalizedPoint[],
    center,
    wallHeight: 2.8,
    bbox,
  };
}

export async function detectFloorPlan(file: File): Promise<DetectFloorPlanResult> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE_URL}/api/detect-floorplan`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "unknown error");
    throw new Error(`Backend error ${res.status}: ${detail}`);
  }

  const json: RawApiResponse = await res.json();
  const rooms: Room[] = (json.rooms ?? []).map(polygonToRoom);

  return {
    rooms,
    walls: json.walls ?? [],
    doors: json.doors ?? [],
    windows: json.windows ?? [],
    image: json.image,
  };
}
