import type { Room } from "./floorplan";

export type { BBox } from "./floorplan"; // re-export จาก floorplan เพื่อไม่ให้ define ซ้ำ

export interface DetectedDoor {
  id: string;
  bbox: import("./floorplan").BBox;
  widthPx?: number;
  widthM?: number;   // ← ชื่อตรงกับ backend (เปลี่ยน widthMeter → widthM ที่ backend แล้ว)
}

export interface DetectedWindow {
  id: string;
  bbox: import("./floorplan").BBox;
  widthPx?: number;
  widthM?: number;   // ← เช่นเดียวกัน
}

export interface DetectedWallSegment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  type: "exterior" | "interior";
  thickness?: number;
  thicknessRatio?: number;
  wallHeight?: number;
}

export interface DetectionResult {
  rooms: Room[];
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  summary?: string;
}

export interface DetectFloorPlanResult extends DetectionResult {
  usedModel?: string;
  usedMock?: boolean;
  image?: string;
}