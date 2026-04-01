// ── Extended types for AI detection results ──────────────────────────────────

import type { Room } from "./floorplan";

/** Normalised bounding box (0–1 relative to image width/height) */
export interface BBox {
    x: number; // left edge
    y: number; // top edge
    w: number; // width
    h: number; // height
}

export interface DetectedDoor {
    id: string;
    bbox: BBox;
    /** Approximate width in meters */
    widthM: number;
}

export interface DetectedWindow {
    id: string;
    bbox: BBox;
    /** Approximate width in meters */
    widthM: number;
}

export interface DetectedWallSegment {
    id: string;
    /** Normalised start point */
    x1: number;
    y1: number;
    /** Normalised end point */
    x2: number;
    y2: number;
    type: "exterior" | "interior";
    /** Wall thickness in meters (default: exterior=0.25, interior=0.15) */
    thickness?: number;
    /** Raw thickness ratio relative to image size (from AI) */
    thicknessRatio?: number;
    /** Wall height in meters (default: 2.8) */
    wallHeight?: number;
}

export interface DetectionResult {
    rooms: Room[];
    walls: DetectedWallSegment[];
    doors: DetectedDoor[];
    windows: DetectedWindow[];
    /** Raw summary from AI */
    summary?: string;
}
