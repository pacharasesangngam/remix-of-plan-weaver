import type { NormalizedPoint, Room } from "./floorplan";

export type { BBox, NormalizedPoint } from "./floorplan";

export interface DetectedDoor {
  id: string;
  bbox: import("./floorplan").BBox;
  polygon?: NormalizedPoint[] | null;
  widthPx?: number;
  widthM?: number;
}

export interface DetectedWindow {
  id: string;
  bbox: import("./floorplan").BBox;
  polygon?: NormalizedPoint[] | null;
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
  image?: string;
  debugImages?: Record<string, string>;
}
