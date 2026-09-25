import type { DetectedWallSegment } from "@/types/detection";

import type { Room } from "@/types/floorplan";

export type CalibrationStatus = "uncalibrated" | "calibrated";
export const hasCalibration = (status: unknown, scale: number, width: number, height: number): boolean =>
  status === "calibrated" && [scale, width, height].every(value => Number.isFinite(value) && value > 0);

/** Measurement only: ignore cached areas and provisional rendering dimensions. */
export const getMeasuredRoomArea = (room: Room, width: number, height: number, calibrated: boolean): number | null => {
  if (!calibrated) return null;
  const polygon = room.polygon?.length >= 3 ? room.polygon : room.wallPolygon;
  if (!polygon || polygon.length < 3) return room.bbox ? room.bbox.w * room.bbox.h * width * height : null;
  const twiceArea = polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  return Math.abs(twiceArea) * 0.5 * width * height;
};

export const APPROXIMATE_PLAN_SIZE_M = 20;
export const DEFAULT_WALL_THICKNESS_M = 0.15;

export interface PlanDimensions {
  width: number;
  height: number;
}

export const resolvePlanDimensions = (planWidth = 0, planHeight = 0): PlanDimensions => ({
  width: planWidth > 0 ? planWidth : APPROXIMATE_PLAN_SIZE_M,
  height: planHeight > 0 ? planHeight : APPROXIMATE_PLAN_SIZE_M,
});

/** Convert backend normalized thickness using its max-image-dimension basis. */
export const getWallThicknessM = (
  wall: DetectedWallSegment,
  planWidth: number,
  planHeight: number,
): number => {
  if (typeof wall.thickness === "number" && wall.thickness > 0) return wall.thickness;
  if (typeof wall.thicknessRatio === "number" && wall.thicknessRatio > 0) {
    return wall.thicknessRatio * Math.max(planWidth, planHeight);
  }
  return DEFAULT_WALL_THICKNESS_M;
};

export const initializeDetectedWalls = (walls: DetectedWallSegment[]): DetectedWallSegment[] =>
  walls.map(wall => ({ ...wall, thickness: DEFAULT_WALL_THICKNESS_M }));

export const uniformWallThicknessM = (
  walls: DetectedWallSegment[],
  planWidth: number,
  planHeight: number,
): number | null => {
  if (walls.length === 0) return DEFAULT_WALL_THICKNESS_M;
  const first = getWallThicknessM(walls[0], planWidth, planHeight);
  return walls.every(wall => Math.abs(getWallThicknessM(wall, planWidth, planHeight) - first) < 1e-9)
    ? first
    : null;
};

export const rescalePlanDimensions = (
  planWidth: number,
  planHeight: number,
  previousScale: number,
  nextScale: number,
): { planWidth: number; planHeight: number } => {
  if (previousScale <= 0 || nextScale <= 0 || planWidth <= 0 || planHeight <= 0) {
    return { planWidth, planHeight };
  }
  const ratio = nextScale / previousScale;
  return { planWidth: planWidth * ratio, planHeight: planHeight * ratio };
};

/** Physical wall width expressed in normalized SVG coordinates for a wall direction. */
export const wallStrokeWidthNormalized = (
  wall: DetectedWallSegment,
  planWidth: number,
  planHeight: number,
): number => {
  const dx = (wall.x2 - wall.x1) * planWidth;
  const dy = (wall.y2 - wall.y1) * planHeight;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) return 0;
  const ux = dx / length;
  const uy = dy / length;
  const thickness = getWallThicknessM(wall, planWidth, planHeight);
  return thickness * Math.hypot(uy / planWidth, ux / planHeight);
};
