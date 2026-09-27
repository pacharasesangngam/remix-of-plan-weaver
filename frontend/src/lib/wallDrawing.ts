import { endpointPoint, findWallSnap, projectToWall, screenDistance, wallSnapTargets, validWall, SNAP_PX, type Endpoint } from "./wallGeometry";
import { APPROXIMATE_PLAN_SIZE_M } from "./wallMetrics";
import type { DetectedWallSegment as Wall } from "@/types/detection";
import type { NormalizedPoint as Point } from "@/types/floorplan";

export interface PlanSize {
  width: number;
  height: number;
  /** Camera projection in CSS pixels, with an inverse on the drawing plane. */
  project?: (point: Point) => Point;
  unproject?: (point: Point) => Point;
}

/**
 * Wall drawing rules shared by Review and 3D. Both workspaces snap in the same
 * screen-space radius as endpoint dragging, preview the same connections, and
 * commit the exact stored coordinates, so a drawn junction never depends on
 * how precisely the pointer was placed.
 */
export const DRAFT_WALL_ID = "__wall-draft__";
/** Shorter than this in metres and the two clicks were meant to be one point. */
export const MIN_WALL_LENGTH_M = 0.05;
/** Connections that must coincide exactly; this only absorbs floating-point roundoff. */
const COINCIDENT_EPS = 1e-7;
/** The same normalized tolerance Review always used to spot a repeated wall. */
const DUPLICATE_TOLERANCE = 0.02;

/** Screen-space snap range, identical to wall endpoint dragging. */
export const WALL_DRAW_SNAP_PX = SNAP_PX;

export interface WallDrawSnap extends Point {
  /** "endpoint" joins a stored endpoint; "junction" lands on a wall interior. */
  kind: "endpoint" | "junction";
  wallId: string;
  /** The host endpoint a junction-free connection uses; undefined on a T-junction. */
  end?: Endpoint;
  /** Fraction along the host wall from its stored start endpoint. */
  t: number;
  key: string;
}

export interface WallDrawDraft {
  start: Point;
  end: Point;
}

export interface WallDrawSnapResult {
  point: Point;
  snap: WallDrawSnap | null;
}

/** The preview wall used for connection feedback; it is never stored. */
export const wallDraftGeometry = (draft: WallDrawDraft, id = DRAFT_WALL_ID): Wall => ({
  id, x1: draft.start.x, y1: draft.start.y, x2: draft.end.x, y2: draft.end.y, type: "interior",
});

const endOfKey = (key: string): { wallId: string; end: Endpoint } => {
  const separator = key.lastIndexOf(":");
  return { wallId: key.slice(0, separator), end: key.slice(separator + 1) as Endpoint };
};
const endpointSnap = (wall: Wall, end: Endpoint): WallDrawSnap => ({ ...endpointPoint(wall, end),
  kind: "endpoint", wallId: wall.id, end, t: end === "start" ? 0 : 1, key: `${wall.id}:${end}` });

/**
 * Snap a drafted endpoint to the exact coordinates it will connect to.
 * Endpoints win over wall interiors; a T-junction snaps onto the host
 * centerline, which is what the stored wall and the 3D junction then share.
 */
export function snapWallDrawPoint(point: Point, walls: Wall[], size: PlanSize,
  excluded: Set<string> = new Set()): WallDrawSnapResult {
  const projected = !!(size.project && size.unproject);
  const screenWalls = projected ? walls.map(wall => {
    const a = size.project!({ x: wall.x1, y: wall.y1 }), b = size.project!({ x: wall.x2, y: wall.y2 });
    return { ...wall, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }) : walls;
  const screenPoint = projected ? size.project!(point) : point;
  const screenSize = projected ? { width: 1, height: 1 } : size;
  const targets = wallSnapTargets(screenPoint, screenWalls, excluded, screenSize);
  const hit = findWallSnap(screenPoint, targets, screenSize, new Set());
  if (!hit) return { point, snap: null };
  if (hit.kind === "endpoint") {
    const { wallId, end } = endOfKey(hit.key);
    const wall = walls.find(item => item.id === wallId);
    return wall ? { point: endpointPoint(wall, end), snap: endpointSnap(wall, end) } : { point, snap: null };
  }
  const host = walls.find(item => hit.key === `${item.id}:segment`);
  if (!host) return { point, snap: null };
  const projection = projectToWall(projected ? size.unproject!(hit) : point, host, size);
  const atStoredEnd = (["start", "end"] as const).find(end => screenDistance(projection, endpointPoint(host, end), size) <= COINCIDENT_EPS);
  if (atStoredEnd) return { point: endpointPoint(host, atStoredEnd), snap: endpointSnap(host, atStoredEnd) };
  const exact = { x: projection.x, y: projection.y };
  return { point: exact, snap: { ...exact, kind: "junction", wallId: host.id, t: projection.t, key: `${host.id}:junction` } };
}

/**
 * Every connection the stored geometry of `draft` really creates. Release
 * previews exactly this list and nothing more.
 */
export function wallDrawConnections(draft: Wall, walls: Wall[], size: PlanSize): WallDrawSnap[] {
  const others = walls.filter(other => other.id !== draft.id && validWall(other));
  const connections = new Map<string, WallDrawSnap>();
  const add = (snap: WallDrawSnap) => connections.set(snap.key, snap);
  for (const end of ["start", "end"] as const) {
    const point = endpointPoint(draft, end);
    for (const host of others) {
      if (screenDistance(point, projectToWall(point, host, size), size) > COINCIDENT_EPS) continue;
      const storedEnd = (["start", "end"] as const).find(hostEnd => screenDistance(point, endpointPoint(host, hostEnd), size) <= COINCIDENT_EPS);
      if (storedEnd) add(endpointSnap(host, storedEnd));
      else {
        const projected = projectToWall(point, host, size);
        add({ x: projected.x, y: projected.y, kind: "junction", wallId: host.id, t: projected.t, key: `${host.id}:junction:${end}` });
      }
    }
  }
  // A stored endpoint that lands on this draft's interior is an endpoint connection too.
  for (const host of others) for (const hostEnd of ["start", "end"] as const) {
    const point = endpointPoint(host, hostEnd);
    if (screenDistance(point, projectToWall(point, draft, size), size) <= COINCIDENT_EPS) add(endpointSnap(host, hostEnd));
  }
  // Crossings also become topology vertices and must be visible before commit.
  const dx = draft.x2 - draft.x1, dy = draft.y2 - draft.y1;
  for (const host of others) {
    const hx = host.x2 - host.x1, hy = host.y2 - host.y1, det = dx * hy - dy * hx;
    if (Math.abs(det) < 1e-12) continue;
    const x = host.x1 - draft.x1, y = host.y1 - draft.y1;
    const t = (x * hy - y * hx) / det, u = (x * dy - y * dx) / det;
    if (t > 1e-8 && t < 1 - 1e-8 && u > 1e-8 && u < 1 - 1e-8)
      add({ x: host.x1 + hx * u, y: host.y1 + hy * u, kind: "junction", wallId: host.id, t: u, key: `${host.id}:crossing` });
  }
  return [...connections.values()];
}

/** A repeated draft would overlap the wall it copies, so it is never stored. */
export function duplicateWall(wall: Wall, walls: Wall[], tolerance = DUPLICATE_TOLERANCE): boolean {
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const start = { x: wall.x1, y: wall.y1 }, end = { x: wall.x2, y: wall.y2 };
  return walls.some(other =>
    (distance(start, { x: other.x1, y: other.y1 }) < tolerance && distance(end, { x: other.x2, y: other.y2 }) < tolerance) ||
    (distance(start, { x: other.x2, y: other.y2 }) < tolerance && distance(end, { x: other.x1, y: other.y1 }) < tolerance));
}

export interface NewWallSpec {
  id: string;
  thickness: number;
  wallHeight: number;
  type: Wall["type"];
}

export interface WallDrawResult {
  wall: Wall;
  /** Previewed as temporary endpoint/junction highlights before release. */
  connections: WallDrawSnap[];
}

/** Physical length of a draft; both workspaces measure it the same way. */
export const wallDrawLengthM = (start: Point, end: Point, planWidth: number, planHeight: number): number =>
  Math.hypot((end.x - start.x) * (planWidth || APPROXIMATE_PLAN_SIZE_M),
    (end.y - start.y) * (planHeight || APPROXIMATE_PLAN_SIZE_M));

/**
 * Snapped, measured and duplicate-checked wall for a finished two-click draft.
 * Returns null exactly when no wall may be stored.
 */
export function finishWallDraw(start: Point, end: Point, walls: Wall[], size: PlanSize,
  planWidth: number, planHeight: number, spec: NewWallSpec): WallDrawResult | null {
  const from = snapWallDrawPoint(start, walls, size).point;
  const to = snapWallDrawPoint(end, walls, size).point;
  const wall: Wall = { id: spec.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y, type: spec.type,
    thickness: spec.thickness, wallHeight: spec.wallHeight };
  if (!validWall(wall)) return null;
  if (wallDrawLengthM(from, to, planWidth, planHeight) < MIN_WALL_LENGTH_M) return null;
  if (duplicateWall(wall, walls)) return null;
  return { wall, connections: wallDrawConnections(wall, walls, size) };
}
