import type { NormalizedPoint, Room } from "./floorplan";
import type { WallTextureId } from "./materialCatalog";

export type { BBox, NormalizedPoint } from "./floorplan";

export interface DetectedDoor {
  id: string;
  bbox: import("./floorplan").BBox;
  polygon?: NormalizedPoint[] | null;
  widthPx?: number;
  widthM?: number;
  scgDoorCode?: string;
  doorName?: string;
  doorMaterial?: string;
  doorColor?: string;
  frameColor?: string;
  useBlenderModel?: string;
}

export interface DetectedWindow {
  id: string;
  bbox: import("./floorplan").BBox;
  polygon?: NormalizedPoint[] | null;
  widthPx?: number;
  widthM?: number;
  scgWindowCode?: string;
  windowName?: string;
  windowMaterial?: string;
  frameColor?: string;
  glassColor?: string;
  useBlenderModel?: string;
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
  scgPaintCode?: string;
  wallColor?: string;
  wallFinish?: string;
  wallTexture?: WallTextureId;
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
  cleanImage?: string;
  debugImages?: Record<string, string>;
}
