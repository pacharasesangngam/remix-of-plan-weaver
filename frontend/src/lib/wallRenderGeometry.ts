import { resolveOpenings } from "./openingModel";
import type { BBox, Room } from "@/types/floorplan";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import { resolveOpeningWall } from "./openingAttachment";
import { APPROXIMATE_PLAN_SIZE_M as PLAN_SIZE, DEFAULT_WALL_HEIGHT_M, getWallThicknessM } from "./wallMetrics";
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
export { projectOpeningEdgesOntoWall } from "./openingProjection";

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
  return resolveOpenings(doors, windows, allWalls, pw, ph, wallHeightM).active
    .filter(item => item.geometry.wall.id === wall.id)
    .map(({ geometry }) => ({ tStart: geometry.tStart, tEnd: geometry.tEnd, yStart: geometry.sill, height: geometry.height }))
    .sort((a, b) => a.tStart - b.tStart);

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
export const defaultRenderWallHeight = (rooms: Room[], fallback = DEFAULT_WALL_HEIGHT_M): number =>
  rooms.length ? Math.max(...rooms.map(room => finiteHeight(room.wallHeight, fallback)), fallback) : fallback;

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
