import type { BBox, NormalizedPoint } from "@/types/floorplan";
import type { DetectedWallSegment } from "@/types/detection";
import { wallStrokeWidthNormalized } from "@/lib/wallMetrics";

/**
 * Creates the axis-aligned bounds for an opening drawn between two points on a
 * wall. The along-wall span comes solely from the two user points; the only
 * cross-wall span is the measured wall thickness.
 */
export const createOpeningBboxFromWallPoints = (
  wall: DetectedWallSegment,
  start: NormalizedPoint,
  end: NormalizedPoint,
  planWidth: number,
  planHeight: number,
): BBox | null => {
  const dx = wall.x2 - wall.x1;
  const dy = wall.y2 - wall.y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) return null;

  const project = (point: NormalizedPoint) => {
    const t = Math.max(0, Math.min(1, ((point.x - wall.x1) * dx + (point.y - wall.y1) * dy) / lengthSquared));
    return { x: wall.x1 + dx * t, y: wall.y1 + dy * t };
  };

  const from = project(start);
  const to = project(end);
  if (Math.hypot(to.x - from.x, to.y - from.y) <= Number.EPSILON) return null;

  const length = Math.sqrt(lengthSquared);
  const normal = { x: -dy / length, y: dx / length };
  const halfThickness = wallStrokeWidthNormalized(wall, planWidth, planHeight) / 2;
  const corners = [
    { x: from.x + normal.x * halfThickness, y: from.y + normal.y * halfThickness },
    { x: from.x - normal.x * halfThickness, y: from.y - normal.y * halfThickness },
    { x: to.x + normal.x * halfThickness, y: to.y + normal.y * halfThickness },
    { x: to.x - normal.x * halfThickness, y: to.y - normal.y * halfThickness },
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);

  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
};
