import type { BBox } from "@/types/floorplan";
import type { DetectedWallSegment } from "@/types/detection";
import { APPROXIMATE_PLAN_SIZE_M as PLAN_SIZE, getWallThicknessM } from "./wallMetrics";
export const projectOpeningEdgesOntoWall = (
  bbox: BBox,
  wall: DetectedWallSegment,
  wallLengthM: number,
  pw = PLAN_SIZE,
  ph = PLAN_SIZE,
): { tStart: number; tEnd: number } | null => {
  const wx1 = wall.x1 * pw;
  const wz1 = wall.y1 * ph;
  const wx2 = wall.x2 * pw;
  const wz2 = wall.y2 * ph;

  const dx = wx2 - wx1;
  const dz = wz2 - wz1;
  const wallLen = Math.sqrt(dx * dx + dz * dz);
  if (wallLen < 1e-6) return null;

  const ux = dx / wallLen;
  const uz = dz / wallLen;

  const leftX  = bbox.x * pw;
  const rightX = (bbox.x + bbox.w) * pw;
  const topZ   = bbox.y * ph;
  const bottomZ = (bbox.y + bbox.h) * ph;

  const corners = [[leftX, topZ], [rightX, topZ], [rightX, bottomZ], [leftX, bottomZ]];
  let minT = Infinity, maxT = -Infinity;
  for (const [px, pz] of corners) {
    const t = (px - wx1) * ux + (pz - wz1) * uz;
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
  }

  const thickness = getWallThicknessM(wall, pw, ph);
  const tolerance = Math.max(thickness, 0.2);
  const cx = (bbox.x + bbox.w / 2) * pw;
  const cz = (bbox.y + bbox.h / 2) * ph;
  const perp = Math.abs((cx - wx1) * (-uz) + (cz - wz1) * ux);
  if (perp > tolerance) return null;
  if (maxT < 0 || minT > wallLengthM) return null;

  return { tStart: Math.max(0, minT), tEnd: Math.min(wallLengthM, maxT) };
};

