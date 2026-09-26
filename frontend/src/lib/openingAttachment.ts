import type { BBox } from "@/types/floorplan";
import type { DetectedWallSegment } from "@/types/detection";
import { getWallThicknessM } from "@/lib/wallMetrics";

export type OpeningWallResolution =
  | { status: "resolved"; wall: DetectedWallSegment }
  | { status: "unresolved" | "ambiguous"; wall: null };

/** Resolve only geometrically valid, unambiguous hosts; never changes the opening bbox. */
export const resolveOpeningWall = (
  bbox: BBox,
  walls: DetectedWallSegment[],
  planWidth: number,
  planHeight: number,
): OpeningWallResolution => {
  const cx = (bbox.x + bbox.w / 2) * planWidth;
  const cy = (bbox.y + bbox.h / 2) * planHeight;
  const candidates = walls.flatMap(wall => {
    const ax = wall.x1 * planWidth, ay = wall.y1 * planHeight;
    const bx = wall.x2 * planWidth, by = wall.y2 * planHeight;
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    if (length <= Number.EPSILON) return [];
    const ux = dx / length, uy = dy / length;
    const centerT = (cx - ax) * ux + (cy - ay) * uy;
    const perpendicular = Math.abs((cx - ax) * -uy + (cy - ay) * ux);
    const ts = [
      [bbox.x, bbox.y], [bbox.x + bbox.w, bbox.y],
      [bbox.x + bbox.w, bbox.y + bbox.h], [bbox.x, bbox.y + bbox.h],
    ].map(([x, y]) => (x * planWidth - ax) * ux + (y * planHeight - ay) * uy);
    const overlapsWall = Math.max(...ts) >= 0 && Math.min(...ts) <= length;
    const tolerance = Math.max(getWallThicknessM(wall, planWidth, planHeight), 0.2);
    return centerT >= 0 && centerT <= length && overlapsWall && perpendicular <= tolerance
      ? [{ wall, perpendicular }]
      : [];
  }).sort((a, b) => a.perpendicular - b.perpendicular);

  if (!candidates.length) return { status: "unresolved", wall: null };
  if (candidates.length > 1 && candidates[1].perpendicular - candidates[0].perpendicular < 0.05) {
    return { status: "ambiguous", wall: null };
  }
  return { status: "resolved", wall: candidates[0].wall };
};
