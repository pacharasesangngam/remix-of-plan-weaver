import type { BBox, Room } from "@/types/floorplan";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import { resolveOpeningWall } from "./openingAttachment";
import { APPROXIMATE_PLAN_SIZE_M as PLAN_SIZE, getWallThicknessM } from "./wallMetrics";
import { buildWallPrisms, wallFrame, type WallSolidInput } from "./wallSolidGeometry";

/** Wall-local distances in metres from the stored start endpoint. */
interface GapInterval {
  tStart: number;
  tEnd: number;
  yStart: number; // 0 for doors, wallHeight*0.35 for windows
  height: number; // opening height in metres
}

/**
 * Project an opening's bbox centre onto the wall axis.
 * Returns the [tStart, tEnd] interval in wall-local metres, or null
 * if the opening is too far off-axis to belong to this wall.
 */
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

/**
 * Collect all gap intervals for a wall from doors + windows.
 * Sorts and merges overlapping intervals.
 */
export const computeGapIntervals = (
  wall: DetectedWallSegment,
  wallLengthM: number,
  wallHeightM: number,
  doors: DetectedDoor[],
  windows: DetectedWindow[],
  allWalls: DetectedWallSegment[],
  pw = PLAN_SIZE,
  ph = PLAN_SIZE,
): GapInterval[] => {
  const raw: GapInterval[] = [];

  for (const door of doors) {
    if (!door.bbox) continue;
    if (door.wallId && door.wallId !== wall.id) continue;
    if (!door.wallId && resolveOpeningWall(door.bbox, allWalls, pw, ph).wall?.id !== wall.id) continue;
    const proj = projectOpeningEdgesOntoWall(door.bbox, wall, wallLengthM, pw, ph);
    if (!proj) continue;
    raw.push({
      ...proj,
      yStart: 0,
      height: Math.min(wallHeightM * 0.9, 2.2),
    });
  }

  for (const win of windows) {
    if (!win.bbox) continue;
    if (win.wallId && win.wallId !== wall.id) continue;
    if (!win.wallId && resolveOpeningWall(win.bbox, allWalls, pw, ph).wall?.id !== wall.id) continue;
    const proj = projectOpeningEdgesOntoWall(win.bbox, wall, wallLengthM, pw, ph);
    if (!proj) continue;
    raw.push({
      ...proj,
      yStart: wallHeightM * 0.35,
      height: Math.min(wallHeightM * 0.45, 1.2),
    });
  }

  if (raw.length === 0) return [];

  raw.sort((a, b) => a.tStart - b.tStart);

  const merged: GapInterval[] = [{ ...raw[0] }];
  for (let i = 1; i < raw.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = raw[i];
    const EPS = 0.05;
    if (cur.tStart <= prev.tEnd + EPS) {
      const newYStart = Math.min(prev.yStart, cur.yStart);
      const prevTop = prev.yStart + prev.height;
      const curTop = cur.yStart + cur.height;
      prev.tEnd = Math.max(prev.tEnd, cur.tEnd);
      prev.yStart = newYStart;
      prev.height = Math.max(prevTop, curTop) - newYStart;
    } else {
      merged.push({ ...cur });
    }
  }

  return merged;
};

/**
 * A solid box sub-segment of the wall.
 */
interface SolidSegment {
  tStart: number;
  tEnd: number;
  yStart: number;
  yEnd: number;
}

export const computeSolidSegments = (
  wallLengthM: number,
  wallHeightM: number,
  gaps: GapInterval[],
): SolidSegment[] => {
  const solids: SolidSegment[] = [];
  if (gaps.length === 0 && wallLengthM > 1e-9) return [{ tStart: 0, tEnd: wallLengthM, yStart: 0, yEnd: wallHeightM }];

  let cursor = 0;
  for (const gap of gaps) {
    if (gap.tStart > cursor + 0.001) {
      solids.push({ tStart: cursor, tEnd: gap.tStart, yStart: 0, yEnd: wallHeightM });
    }

    if (gap.yStart > 0.01) {
      solids.push({ tStart: gap.tStart, tEnd: gap.tEnd, yStart: 0, yEnd: gap.yStart });
    }

    const gapTop = gap.yStart + gap.height;
    if (gapTop < wallHeightM - 0.01) {
      solids.push({ tStart: gap.tStart, tEnd: gap.tEnd, yStart: gapTop, yEnd: wallHeightM });
    }

    cursor = gap.tEnd;
  }

  if (cursor < wallLengthM - 0.001) {
    solids.push({ tStart: cursor, tEnd: wallLengthM, yStart: 0, yEnd: wallHeightM });
  }

  return solids;
};

const finiteHeight = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Keep Review and the 3D scene on the same height and opening-band rules. */
export const defaultRenderWallHeight = (rooms: Room[]): number =>
  rooms.length ? Math.max(...rooms.map(room => finiteHeight(room.wallHeight, 2.8)), 2.8) : 2.8;

export function wallSolidInputs(walls: DetectedWallSegment[], doors: DetectedDoor[], windows: DetectedWindow[],
  defaultHeight: number, pw: number, ph: number): WallSolidInput[] {
  return walls.map(wall => {
    const length = wallFrame(wall, pw, ph).length;
    const height = finiteHeight(wall.wallHeight, defaultHeight);
    return { wall, thickness: getWallThicknessM(wall, pw, ph),
      solids: computeSolidSegments(length, height, computeGapIntervals(wall, length, height, doors, windows, walls, pw, ph)) };
  });
}

/** Orthographic projection of all solid height bands, not a horizontal opening section.
 * Multiple projected cells form one nonzero-filled path per wall; never stroke their edges.
 */
export function wallFootprintPaths(inputs: WallSolidInput[], pw: number, ph: number): Map<string, string> {
  const paths = new Map<string, string>();
  for (const cell of buildWallPrisms(inputs, pw, ph)) {
    const path = cell.polygon.map((p, index) =>
      `${index ? "L" : "M"}${(p.x + pw / 2) / pw},${(p.z + ph / 2) / ph}`).join(" ") + " Z";
    paths.set(cell.wallId, (paths.get(cell.wallId) ?? "") + path + " ");
  }
  return paths;
}
