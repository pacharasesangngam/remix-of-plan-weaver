import type { Room } from "./floorplan";

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectedDoor {
  id: string;
  bbox: BBox;
   widthPx?: number; 
  widthM?: number;
}

export interface DetectedWindow {
  id: string;
  bbox: BBox;
  widthPx?: number;
  widthM?: number;
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
  image?: string; // ✅ FIX สำคัญ
}