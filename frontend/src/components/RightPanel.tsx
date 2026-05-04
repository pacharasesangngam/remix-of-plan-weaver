import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Grid, PointerLockControls, Text } from "@react-three/drei";
import * as THREE from "three";
import { Box, ChevronLeft, Info, Move3D, Palette, Plus, Trash2 } from "lucide-react";
import type { BBox, NormalizedPoint, Room } from "@/types/floorplan";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";

interface RightPanelProps {
  rooms: Room[];
  generated: boolean;
  walls?: DetectedWallSegment[];
  doors?: DetectedDoor[];
  windows?: DetectedWindow[];
  onRoomUpdate?: (id: string, field: keyof Room, value: number | string) => void;
  onRoomPatch?: (id: string, patch: Partial<Room>) => void;
  onRoomDelete?: (id: string) => void;
  onWallUpdate?: (id: string, field: keyof DetectedWallSegment, value: number | string) => void;
  onWallAdd?: (wall: DetectedWallSegment) => void;
  onWallDelete?: (id: string) => void;
  onDoorAdd?: (door: DetectedDoor) => void;
  onDoorDelete?: (id: string) => void;
  onWindowAdd?: (win: DetectedWindow) => void;
  onWindowDelete?: (id: string) => void;
  onBack?: () => void;
}

type ViewPreset = "perspective" | "top" | "front" | "side";
type BuildMode = "select" | "wall" | "door" | "window" | "delete";
type Selection =
  | { type: "room"; id: string }
  | { type: "wall"; id: string; point?: NormalizedPoint }
  | { type: "door"; id: string }
  | { type: "window"; id: string }
  | null;
type PlacementPreview = { wallId: string; point: NormalizedPoint } | null;
type WallDraft = { start: NormalizedPoint; end: NormalizedPoint } | null;

const ROOM_PALETTE = [
  { wall: "#e8d5b7", floor: "#d4b896" },
  { wall: "#dce8d5", floor: "#b8d4ae" },
  { wall: "#d5dce8", floor: "#aebcd4" },
  { wall: "#e8d5e0", floor: "#d4aec0" },
  { wall: "#e8e5d5", floor: "#d4ceae" },
];
const FLOOR_HOVER_COLOR = "#f5e6c8";
const PLAN_SIZE = 20;

// ── Utilities ─────────────────────────────────────────────────────────────────

const safeNum = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
};

const toPlanPoint = (point: NormalizedPoint): [number, number] => [
  point.x * PLAN_SIZE - PLAN_SIZE / 2,
  -(point.y * PLAN_SIZE - PLAN_SIZE / 2),
];

const bboxToPolygon = (bbox?: BBox | null): NormalizedPoint[] | null => {
  if (!bbox) return null;
  return [
    { x: bbox.x, y: bbox.y },
    { x: bbox.x + bbox.w, y: bbox.y },
    { x: bbox.x + bbox.w, y: bbox.y + bbox.h },
    { x: bbox.x, y: bbox.y + bbox.h },
  ];
};

const getRoomPolygon = (room: Room): NormalizedPoint[] | null => {
  if (room.wallPolygon && room.wallPolygon.length >= 3) return room.wallPolygon;
  if (room.polygon && room.polygon.length >= 3) return room.polygon;
  return bboxToPolygon(room.bbox);
};

const getRoomBounds = (room: Room): BBox | null => {
  if (room.bbox) return room.bbox;
  const polygon = getRoomPolygon(room);
  if (!polygon || polygon.length === 0) return null;

  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
  };
};

const polygonArea = (polygon?: NormalizedPoint[] | null): number => {
  if (!polygon || polygon.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(area) * 0.5 * PLAN_SIZE * PLAN_SIZE;
};

const polygonCentroid = (polygon?: NormalizedPoint[] | null): NormalizedPoint | null => {
  if (!polygon || polygon.length < 3) return null;

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < polygon.length; i += 1) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    const cross = p1.x * p2.y - p2.x * p1.y;
    twiceArea += cross;
    cx += (p1.x + p2.x) * cross;
    cy += (p1.y + p2.y) * cross;
  }

  if (Math.abs(twiceArea) < 1e-8) {
    const sum = polygon.reduce(
      (acc, point) => {
        acc.x += point.x;
        acc.y += point.y;
        return acc;
      },
      { x: 0, y: 0 },
    );
    return { x: sum.x / polygon.length, y: sum.y / polygon.length };
  }

  const factor = 1 / (3 * twiceArea);
  return { x: cx * factor, y: cy * factor };
};

const getRoomCenter = (room: Room): NormalizedPoint | null =>
  room.center ??
  polygonCentroid(getRoomPolygon(room)) ??
  (room.bbox
    ? { x: room.bbox.x + room.bbox.w / 2, y: room.bbox.y + room.bbox.h / 2 }
    : null);

// ── Wall thickness helper ─────────────────────────────────────────────────────

const getWallThicknessM = (wall: DetectedWallSegment): number => {
  if (typeof wall.thickness === "number" && wall.thickness > 0) return wall.thickness;
  if (typeof wall.thicknessRatio === "number" && wall.thicknessRatio > 0) {
    return wall.thicknessRatio * PLAN_SIZE;
  }
  return wall.type === "exterior" ? 0.3 : 0.18;
};

// ── Opening width helper ──────────────────────────────────────────────────────

const getWidthM = (bboxW?: number, real?: number): number => {
  if (typeof real === "number" && real > 0) return real;
  if (typeof bboxW === "number" && bboxW > 0) return bboxW * PLAN_SIZE;
  return 0;
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const createOpeningBboxOnWall = (
  wall: DetectedWallSegment,
  kind: "door" | "window",
  point?: NormalizedPoint,
): BBox => {
  const horizontal = isHorizontalSegment(wall);
  const ax = wall.x1;
  const ay = wall.y1;
  const bx = wall.x2;
  const by = wall.y2;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy || 1;
  const rawT = point
    ? ((point.x - ax) * dx + (point.y - ay) * dy) / lenSq
    : 0.5;
  const t = Math.min(0.95, Math.max(0.05, rawT));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  const along = kind === "door" ? 0.055 : 0.075;
  const cross = kind === "door" ? 0.026 : 0.018;
  const w = horizontal ? along : cross;
  const h = horizontal ? cross : along;

  return {
    x: clamp01(cx - w / 2),
    y: clamp01(cy - h / 2),
    w,
    h,
  };
};

const boundsFromPolygon = (polygon: NormalizedPoint[]): BBox => {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

const getWallLengthM = (wall: DetectedWallSegment): number =>
  Math.sqrt(
    Math.pow((wall.x2 - wall.x1) * PLAN_SIZE, 2) +
      Math.pow((wall.y2 - wall.y1) * PLAN_SIZE, 2),
  );

const snapPointToWalls = (
  point: NormalizedPoint,
  walls: DetectedWallSegment[],
  threshold = 0.018,
): NormalizedPoint => {
  let best = point;
  let bestDistSq = threshold * threshold;

  for (const wall of walls) {
    const endpoints = [
      { x: wall.x1, y: wall.y1 },
      { x: wall.x2, y: wall.y2 },
    ];

    for (const endpoint of endpoints) {
      const distSq = (point.x - endpoint.x) ** 2 + (point.y - endpoint.y) ** 2;
      if (distSq < bestDistSq) {
        best = endpoint;
        bestDistSq = distSq;
      }
    }

    const dx = wall.x2 - wall.x1;
    const dy = wall.y2 - wall.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-8) continue;

    const t = Math.max(
      0,
      Math.min(1, ((point.x - wall.x1) * dx + (point.y - wall.y1) * dy) / lenSq),
    );
    const projected = {
      x: wall.x1 + dx * t,
      y: wall.y1 + dy * t,
    };
    const distSq = (point.x - projected.x) ** 2 + (point.y - projected.y) ** 2;
    if (distSq < bestDistSq) {
      best = projected;
      bestDistSq = distSq;
    }
  }

  return best;
};

// ── Wall junction snapping ────────────────────────────────────────────────────

const isHorizontalSegment = (wall: DetectedWallSegment): boolean =>
  Math.abs(wall.x2 - wall.x1) >= Math.abs(wall.y2 - wall.y1);

const normalizeRenderWall = (wall: DetectedWallSegment): DetectedWallSegment => {
  if (isHorizontalSegment(wall)) {
    const x1 = Math.min(wall.x1, wall.x2);
    const x2 = Math.max(wall.x1, wall.x2);
    const y = (wall.y1 + wall.y2) / 2;
    return { ...wall, x1, x2, y1: y, y2: y };
  }
  const y1 = Math.min(wall.y1, wall.y2);
  const y2 = Math.max(wall.y1, wall.y2);
  const x = (wall.x1 + wall.x2) / 2;
  return { ...wall, x1: x, x2: x, y1, y2 };
};

const snapAxisGroup = (
  walls: DetectedWallSegment[],
  axisKey: "x1" | "y1",
  threshold = 0.003,
) => {
  if (walls.length === 0) return;
  walls.sort((a, b) => a[axisKey] - b[axisKey]);
  let cluster = [walls[0]];

  const flush = () => {
    const snapped =
      cluster.reduce((sum, wall) => sum + wall[axisKey], 0) / cluster.length;
    for (const wall of cluster) {
      wall[axisKey] = snapped;
      if (axisKey === "x1") wall.x2 = snapped;
      else wall.y2 = snapped;
    }
  };

  for (const wall of walls.slice(1)) {
    if (Math.abs(wall[axisKey] - cluster[cluster.length - 1][axisKey]) <= threshold) {
      cluster.push(wall);
      continue;
    }
    flush();
    cluster = [wall];
  }
  flush();
};

const snapRenderedWallJunctions = (
  walls: DetectedWallSegment[],
  threshold = 0.004,
): DetectedWallSegment[] => {
  const normalized = walls.map(normalizeRenderWall);
  const horizontals = normalized.filter(isHorizontalSegment);
  const verticals = normalized.filter((wall) => !isHorizontalSegment(wall));

  snapAxisGroup(horizontals, "y1");
  snapAxisGroup(verticals, "x1");

  for (const horizontal of horizontals) {
    for (const vertical of verticals) {
      const x = vertical.x1;
      const y = horizontal.y1;
      const withinHorizontal =
        x >= horizontal.x1 - threshold && x <= horizontal.x2 + threshold;
      const withinVertical =
        y >= vertical.y1 - threshold && y <= vertical.y2 + threshold;
      if (!withinHorizontal || !withinVertical) continue;

      if (Math.abs(horizontal.x1 - x) <= threshold) horizontal.x1 = x;
      if (Math.abs(horizontal.x2 - x) <= threshold) horizontal.x2 = x;
      if (Math.abs(vertical.y1 - y) <= threshold) vertical.y1 = y;
      if (Math.abs(vertical.y2 - y) <= threshold) vertical.y2 = y;
    }
  }

  return normalized.map(normalizeRenderWall);
};

// ── Opening gap types & projection ───────────────────────────────────────────

/**
 * A gap interval in the wall's local axis space.
 * t values are world-metres measured from the wall's start endpoint.
 */
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
const projectOpeningEdgesOntoWall = (
  bbox: BBox,
  wall: DetectedWallSegment,
  wallLengthM: number
): { tStart: number; tEnd: number } | null => {
  // ── World wall vector ──
  const wx1 = wall.x1 * PLAN_SIZE;
  const wz1 = wall.y1 * PLAN_SIZE;
  const wx2 = wall.x2 * PLAN_SIZE;
  const wz2 = wall.y2 * PLAN_SIZE;

  const dx = wx2 - wx1;
  const dz = wz2 - wz1;
  const wallLen = Math.sqrt(dx * dx + dz * dz);
  if (wallLen < 1e-6) return null;

  const ux = dx / wallLen;
  const uz = dz / wallLen;

  // ── BBOX edges (world space) ──
  const leftX = bbox.x * PLAN_SIZE;
  const rightX = (bbox.x + bbox.w) * PLAN_SIZE;
  const topZ = bbox.y * PLAN_SIZE;
  const bottomZ = (bbox.y + bbox.h) * PLAN_SIZE;

  // 4 corners
  const points = [
    [leftX, topZ],
    [rightX, topZ],
    [rightX, bottomZ],
    [leftX, bottomZ],
  ];

  // project all points → take min/max
  let minT = Infinity;
  let maxT = -Infinity;

  for (const [px, pz] of points) {
    const vx = px - wx1;
    const vz = pz - wz1;
    const t = vx * ux + vz * uz;
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
  }

  // reject if not on wall
  const thickness = getWallThicknessM(wall);
  const tolerance = Math.max(thickness, 0.2);

  // check perpendicular distance using center
  const cx = (bbox.x + bbox.w / 2) * PLAN_SIZE;
  const cz = (bbox.y + bbox.h / 2) * PLAN_SIZE;

  const vx = cx - wx1;
  const vz = cz - wz1;

  const perp = Math.abs(vx * (-uz) + vz * ux);
  if (perp > tolerance) return null;

  // clamp
  if (maxT < 0 || minT > wallLengthM) return null;

  return {
    tStart: Math.max(0, minT),
    tEnd: Math.min(wallLengthM, maxT),
  };
};

/**
 * Collect all gap intervals for a wall from doors + windows.
 * Sorts and merges overlapping intervals.
 */
const computeGapIntervals = (
  wall: DetectedWallSegment,
  wallLengthM: number,
  wallHeightM: number,
  doors: DetectedDoor[],
  windows: DetectedWindow[],
): GapInterval[] => {
  const raw: GapInterval[] = [];

  for (const door of doors) {
    if (!door.bbox) continue;
    const proj = projectOpeningEdgesOntoWall(door.bbox, wall, wallLengthM);
    if (!proj) continue;
    raw.push({
      ...proj,
      yStart: 0,
      height: Math.min(wallHeightM * 0.9, 2.2),
    });
  }

  for (const win of windows) {
    if (!win.bbox) continue;
    const proj = projectOpeningEdgesOntoWall(win.bbox, wall, wallLengthM);
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

const computeSolidSegments = (
  wallLengthM: number,
  wallHeightM: number,
  gaps: GapInterval[],
): SolidSegment[] => {
  const solids: SolidSegment[] = [];

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

// ── Shared opening transform ──────────────────────────────────────────────────

/**
 * Unified transform for doors and windows.
 *
 * Uses the same projection logic as the gap system so that door/window meshes
 * are placed in exactly the same wall-local coordinate space as the wall holes.
 *
 * Returns:
 *   center  – world XZ position of the wall's midpoint
 *   angle   – wall rotation angle (Y axis, radians) — same as WallSegmentMesh
 *   localX  – X offset within the wall-aligned group (measured from group origin)
 *
 * Returns null when the opening cannot be projected onto this wall.
 */
interface OpeningTransform {
  center: [number, number]; // [worldX, worldZ] of wall midpoint
  angle: number;            // wall rotation (radians)
  localX: number;           // local X within wall group (opening centre)
  wallLengthM: number;
  projectedWidth: number;   // opening width measured along wall axis (= gap width)
}

function getOpeningTransform(
  bbox: BBox,
  wall: DetectedWallSegment,
): OpeningTransform | null {
  // World-space wall endpoints (same coordinate transforms as WallSegmentMesh)
  const x1 = wall.x1 * PLAN_SIZE - PLAN_SIZE / 2;
  const z1 = wall.y1 * PLAN_SIZE - PLAN_SIZE / 2;
  const x2 = wall.x2 * PLAN_SIZE - PLAN_SIZE / 2;
  const z2 = wall.y2 * PLAN_SIZE - PLAN_SIZE / 2;

  const dx = x2 - x1;
  const dz = z2 - z1;
  const wallLengthM = Math.sqrt(
    Math.pow((wall.x2 - wall.x1) * PLAN_SIZE, 2) +
    Math.pow((wall.y2 - wall.y1) * PLAN_SIZE, 2),
  );

  if (wallLengthM < 0.001) return null;

  const angle = Math.atan2(dz, dx);

  // Project opening bbox onto wall axis — identical to the gap system
  const proj = projectOpeningEdgesOntoWall(bbox, wall, wallLengthM);
  if (!proj) return null;

  // Width along the wall axis = exactly the gap width the wall uses
  const projectedWidth = proj.tEnd - proj.tStart;

  // Centre of the opening in wall-local space (t from wall start)
  const tCenter = (proj.tStart + proj.tEnd) / 2;

  // Wall group origin is the wall midpoint → local X offset from midpoint
  const localX = tCenter - wallLengthM / 2;

  const wallCenterX = (x1 + x2) / 2;
  const wallCenterZ = (z1 + z2) / 2;

  return {
    center: [wallCenterX, wallCenterZ],
    angle,
    localX,
    wallLengthM,
    projectedWidth,
  };
}

/**
 * Find the best matching wall for a given bbox.
 * Returns the wall whose axis the bbox projects onto with the smallest
 * perpendicular distance. Falls back to null if no wall accepts the opening.
 */
function findBestWall(
  bbox: BBox,
  walls: DetectedWallSegment[],
): DetectedWallSegment | null {
  let best: DetectedWallSegment | null = null;
  let bestPerp = Infinity;

  for (const wall of walls) {
    const wx1 = wall.x1 * PLAN_SIZE;
    const wz1 = wall.y1 * PLAN_SIZE;
    const wx2 = wall.x2 * PLAN_SIZE;
    const wz2 = wall.y2 * PLAN_SIZE;

    const ddx = wx2 - wx1;
    const ddz = wz2 - wz1;
    const wallLen = Math.sqrt(ddx * ddx + ddz * ddz);
    if (wallLen < 0.001) continue;

    const ux = ddx / wallLen;
    const uz = ddz / wallLen;

    const cx = (bbox.x + bbox.w / 2) * PLAN_SIZE;
    const cz = (bbox.y + bbox.h / 2) * PLAN_SIZE;

    const vx = cx - wx1;
    const vz = cz - wz1;

    const t = vx * ux + vz * uz;
    const perp = Math.abs(vx * (-uz) + vz * ux);

    const thickness = getWallThicknessM(wall);
    const tolerance = Math.max(thickness, 0.2);

    if (perp > tolerance) continue;
    if (t < 0 || t > wallLen) continue;

    if (perp < bestPerp) {
      bestPerp = perp;
      best = wall;
    }
  }

  return best;
}

// ── First-person controller ───────────────────────────────────────────────────

function FirstPersonController({ enabled }: { enabled: boolean }) {
  const { camera } = useThree();
  const controlsRef = useRef<any>(null);
  const keysRef = useRef({
    KeyW: false,
    KeyA: false,
    KeyS: false,
    KeyD: false,
  });

  useEffect(() => {
    if (!enabled) {
      keysRef.current = { KeyW: false, KeyA: false, KeyS: false, KeyD: false };
      if (controlsRef.current?.isLocked) controlsRef.current.unlock();
      return;
    }

    camera.position.set(0, 1.7, Math.max(PLAN_SIZE * 0.65, 8));
    camera.lookAt(0, 1.7, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code in keysRef.current)
        keysRef.current[event.code as keyof typeof keysRef.current] = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code in keysRef.current)
        keysRef.current[event.code as keyof typeof keysRef.current] = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      if (controlsRef.current?.isLocked) controlsRef.current.unlock();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [camera, enabled]);

  useFrame((_, delta) => {
    if (!enabled || !controlsRef.current?.isLocked) return;

    const speed = 4 * delta;
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() > 0) forward.normalize();
    right.crossVectors(forward, up).normalize();

    if (keysRef.current.KeyW) camera.position.addScaledVector(forward, speed);
    if (keysRef.current.KeyS) camera.position.addScaledVector(forward, -speed);
    if (keysRef.current.KeyA) camera.position.addScaledVector(right, -speed);
    if (keysRef.current.KeyD) camera.position.addScaledVector(right, speed);

    camera.position.y = 1.7;
  });

  return enabled ? <PointerLockControls ref={controlsRef} /> : null;
}

// ── Camera preset controller ──────────────────────────────────────────────────

function CameraPresetController({
  preset,
  walkMode,
  distance,
  controlsRef,
}: {
  preset: ViewPreset;
  walkMode: boolean;
  distance: number;
  controlsRef: React.MutableRefObject<any>;
}) {
  const { camera } = useThree();

  useEffect(() => {
    if (walkMode) return;

    const nextPosition = new THREE.Vector3();
    const target = new THREE.Vector3(0, 0, 0);

    if (preset === "top") {
      nextPosition.set(0, distance * 1.45, 0.01);
    } else if (preset === "front") {
      nextPosition.set(0, distance * 0.45, distance * 1.35);
    } else if (preset === "side") {
      nextPosition.set(distance * 1.35, distance * 0.45, 0.01);
    } else {
      nextPosition.set(distance * 0.7, distance * 0.5, distance * 0.7);
    }

    camera.position.copy(nextPosition);
    camera.lookAt(target);
    camera.updateProjectionMatrix();

    if (controlsRef.current) {
      controlsRef.current.target.copy(target);
      controlsRef.current.update();
    }
  }, [camera, controlsRef, distance, preset, walkMode]);

  return null;
}

// ── Room Polygon Mesh ─────────────────────────────────────────────────────────

function RoomPolygonMesh({
  room,
  index,
  hovered,
  onHover,
  onSelect,
  onTargetHover,
}: {
  room: Room;
  index: number;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onTargetHover?: (selection: Selection) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const floorMatRef = useRef<THREE.MeshStandardMaterial>(null);

  const pal = ROOM_PALETTE[index % ROOM_PALETTE.length];
  const floorColor = room.floorColor ?? pal.floor;
  const baseColorRef = useRef(new THREE.Color(floorColor));
  const hoverColorRef = useRef(new THREE.Color(FLOOR_HOVER_COLOR));

  const polygon = useMemo(() => getRoomPolygon(room), [room]);

  const shape = useMemo(() => {
    if (!polygon || polygon.length < 3) return null;
    const pts = polygon.map(toPlanPoint);
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    s.closePath();
    return s;
  }, [polygon]);

  const labelPoint = useMemo(() => {
    const center = getRoomCenter(room);
    if (!center) return [0, 0] as [number, number];
    return toPlanPoint(center);
  }, [room]);

  const sizeHint = useMemo(() => {
    const bounds = getRoomBounds(room);
    if (!bounds) return { w: 0, d: 0 };
    return {
      w: Math.max(bounds.w * PLAN_SIZE, 0.5),
      d: Math.max(bounds.h * PLAN_SIZE, 0.5),
    };
  }, [room]);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const targetY = hovered ? 0.04 : 0;
    groupRef.current.position.y = THREE.MathUtils.lerp(
      groupRef.current.position.y,
      targetY,
      delta * 6,
    );
    if (floorMatRef.current) {
      const targetColor = hovered ? hoverColorRef.current : baseColorRef.current;
      floorMatRef.current.color.lerp(targetColor, delta * 8);
    }
  });

  useEffect(() => {
    baseColorRef.current.set(floorColor);
    if (floorMatRef.current) floorMatRef.current.color.set(floorColor);
  }, [floorColor]);

  if (!shape) return null;

  return (
    <group
      ref={groupRef}
      position={[0, 0, 0]}
      onPointerEnter={() => {
        onHover(room.id);
        onTargetHover?.({ type: "room", id: room.id });
      }}
      onPointerLeave={() => {
        onHover(null);
        onTargetHover?.(null);
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(room.id);
      }}
    >
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial
          ref={floorMatRef}
          color={floorColor}
          roughness={0.85}
          metalness={0.02}
          side={THREE.DoubleSide}
        />
      </mesh>

      <Text
        position={[labelPoint[0], 0.3, labelPoint[1]]}
        fontSize={0.26}
        color="#374151"
        anchorX="center"
        anchorY="middle"
      >
        {room.name ?? "Room"}
      </Text>

      <Text
        position={[labelPoint[0], 0.05, labelPoint[1] + sizeHint.d / 2 + 0.3]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.18}
        color="#6b7280"
        anchorX="center"
        anchorY="middle"
      >
        {`${sizeHint.w.toFixed(1)}m`}
      </Text>

      <Text
        position={[labelPoint[0] + sizeHint.w / 2 + 0.3, 0.05, labelPoint[1]]}
        rotation={[-Math.PI / 2, 0, Math.PI / 2]}
        fontSize={0.18}
        color="#6b7280"
        anchorX="center"
        anchorY="middle"
      >
        {`${sizeHint.d.toFixed(1)}m`}
      </Text>
    </group>
  );
}

// ── Wall Segment Mesh ─────────────────────────────────────────────────────────

function WallSegmentMesh({
  wall,
  wallHeight,
  doors,
  windows,
  onSelect,
  onPlacementHover,
  onPlacementLeave,
  onTargetHover,
}: {
  wall: DetectedWallSegment;
  wallHeight: number;
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  onSelect: (id: string, point?: NormalizedPoint) => void;
  onPlacementHover?: (wallId: string, point: NormalizedPoint) => void;
  onPlacementLeave?: () => void;
  onTargetHover?: (selection: Selection) => void;
}) {
  const resolvedHeight = safeNum(wall.wallHeight, wallHeight);
  const thickness = getWallThicknessM(wall);

  const x1 = wall.x1 * PLAN_SIZE - PLAN_SIZE / 2;
  const z1 = wall.y1 * PLAN_SIZE - PLAN_SIZE / 2;
  const x2 = wall.x2 * PLAN_SIZE - PLAN_SIZE / 2;
  const z2 = wall.y2 * PLAN_SIZE - PLAN_SIZE / 2;

  const dx = x2 - x1;
  const dz = z2 - z1;
  const wallLengthM = Math.sqrt(
    Math.pow((wall.x2 - wall.x1) * PLAN_SIZE, 2) +
    Math.pow((wall.y2 - wall.y1) * PLAN_SIZE, 2),
  );

  if (wallLengthM < 0.001) return null;

  const angle = Math.atan2(dz, dx);
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;

  const gaps = computeGapIntervals(wall, wallLengthM, resolvedHeight, doors, windows);
  const solids = computeSolidSegments(wallLengthM, resolvedHeight, gaps);

  return (
    <group position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
      {solids.map((seg, i) => {
        const segLen = seg.tEnd - seg.tStart;
        const segH = seg.yEnd - seg.yStart;
        if (segLen < 0.001 || segH < 0.001) return null;

        const localX = seg.tStart + segLen / 2 - wallLengthM / 2;
        const localY = seg.yStart + segH / 2;

        const getEventPoint = (point: THREE.Vector3): NormalizedPoint => ({
          x: clamp01((point.x + PLAN_SIZE / 2) / PLAN_SIZE),
          y: clamp01((point.z + PLAN_SIZE / 2) / PLAN_SIZE),
        });

        return (
          <mesh
            key={i}
            position={[localX, localY, 0]}
            onPointerMove={(e) => {
              if (!onPlacementHover && !onTargetHover) return;
              e.stopPropagation();
              const point = getEventPoint(e.point);
              onPlacementHover?.(wall.id, point);
              onTargetHover?.({ type: "wall", id: wall.id, point });
            }}
            onPointerLeave={() => {
              onPlacementLeave?.();
              onTargetHover?.(null);
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(wall.id, getEventPoint(e.point));
            }}
          >
            <boxGeometry args={[segLen, segH, thickness]} />
            <meshStandardMaterial color="#e5e7eb" roughness={0.7} metalness={0.05} />
          </mesh>
        );
      })}
    </group>
  );
}

// ── Door Mesh ─────────────────────────────────────────────────────────────────
/**
 * Positioned using getOpeningTransform() so that the door mesh sits in the
 * same wall-local coordinate space as the gap cut in WallSegmentMesh.
 *
 * Group hierarchy (mirrors WallSegmentMesh):
 *   <group position={wallCenter} rotation={[0, -angle, 0]}>   ← wall space
 *     <group position={[localX, 0, 0]}>                        ← opening centre
 *       {door geometry}
 *     </group>
 *   </group>
 */
function DoorMesh({
  door,
  wallHeight,
  walls,
  onSelect,
  onHover,
}: {
  door: DetectedDoor;
  wallHeight: number;
  walls: DetectedWallSegment[];
  onSelect: (id: string) => void;
  onHover?: (selection: Selection) => void;
}) {
  if (!door.bbox) return null;

  const wall = findBestWall(door.bbox, walls);
  if (!wall) return null;

  const transform = getOpeningTransform(door.bbox, wall);
  if (!transform) return null;

  const { center, angle, localX, projectedWidth } = transform;

  // Use the projected wall-axis width (same value the gap system cuts) so the
  // door frame exactly matches the hole. Fall back to bbox-derived width only
  // when projection returns zero (shouldn't happen in practice).
  const doorW = projectedWidth > 0.05 ? projectedWidth : Math.max(getWidthM(door.bbox.w, door.widthM), 0.8);
  // Match gap height: Math.min(wallHeightM * 0.9, 2.2)
  const doorH = Math.min(wallHeight * 0.9, 2.2);
  const wallThickness = getWallThicknessM(wall);
  const frameDepth = wallThickness + 0.08;
  const slabDepth = Math.min(wallThickness + 0.03, 0.24);
  const faceOffsets = [-(slabDepth / 2 + 0.004), slabDepth / 2 + 0.004];
  const slabW = doorW;
  const slabH = doorH;
  const knobX = slabW * 0.36;

  return (
    <group
      position={[center[0], 0, center[1]]}
      rotation={[0, -angle, 0]}
      onPointerEnter={(e) => {
        e.stopPropagation();
        onHover?.({ type: "door", id: door.id });
      }}
      onPointerLeave={(e) => {
        e.stopPropagation();
        onHover?.(null);
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(door.id);
      }}
    >
      <group position={[localX, 0, 0]}>
        <mesh position={[-doorW / 2 - 0.04, doorH / 2, 0]}>
          <boxGeometry args={[0.08, doorH + 0.08, frameDepth]} />
          <meshStandardMaterial color="#7c2d12" roughness={0.48} metalness={0.08} />
        </mesh>
        <mesh position={[doorW / 2 + 0.04, doorH / 2, 0]}>
          <boxGeometry args={[0.08, doorH + 0.08, frameDepth]} />
          <meshStandardMaterial color="#7c2d12" roughness={0.48} metalness={0.08} />
        </mesh>
        <mesh position={[0, doorH + 0.04, 0]}>
          <boxGeometry args={[doorW + 0.16, 0.08, frameDepth]} />
          <meshStandardMaterial color="#7c2d12" roughness={0.48} metalness={0.08} />
        </mesh>
        <mesh position={[0, 0.035, 0]}>
          <boxGeometry args={[doorW + 0.18, 0.07, frameDepth + 0.04]} />
          <meshStandardMaterial color="#92400e" roughness={0.55} metalness={0.08} />
        </mesh>
        <mesh position={[0, slabH / 2, 0]} castShadow>
          <boxGeometry args={[slabW, slabH, slabDepth]} />
          <meshStandardMaterial
            color="#d9a75f"
            emissive="#b45309"
            emissiveIntensity={0.035}
            roughness={0.5}
            metalness={0.04}
          />
        </mesh>
        {faceOffsets.map((offset) => (
          <group key={offset} position={[0, 0, offset]}>
            <mesh position={[0, slabH * 0.63, 0]}>
              <boxGeometry args={[slabW * 0.56, slabH * 0.32, 0.014]} />
              <meshStandardMaterial color="#c69049" roughness={0.52} metalness={0.03} />
            </mesh>
            <mesh position={[0, slabH * 0.29, 0]}>
              <boxGeometry args={[slabW * 0.56, slabH * 0.22, 0.014]} />
              <meshStandardMaterial color="#c69049" roughness={0.52} metalness={0.03} />
            </mesh>
            <mesh position={[knobX, slabH * 0.5, 0.026 * Math.sign(offset)]}>
              <sphereGeometry args={[0.038, 16, 16]} />
              <meshStandardMaterial color="#5b260c" roughness={0.28} metalness={0.42} />
            </mesh>
          </group>
        ))}
        <Text
          position={[0, doorH + 0.3, 0]}
          fontSize={0.15}
          color="#f59e0b"
          anchorX="center"
          anchorY="middle"
        >
          {`D ${doorW.toFixed(1)}m`}
        </Text>
      </group>
    </group>
  );
}

// ── Window Mesh ───────────────────────────────────────────────────────────────
/**
 * Same coordinate-system unification as DoorMesh.
 */
function WindowMesh({
  win,
  wallHeight,
  walls,
  onSelect,
  onHover,
}: {
  win: DetectedWindow;
  wallHeight: number;
  walls: DetectedWallSegment[];
  onSelect: (id: string) => void;
  onHover?: (selection: Selection) => void;
}) {
  if (!win.bbox) return null;

  const wall = findBestWall(win.bbox, walls);
  if (!wall) return null;

  const transform = getOpeningTransform(win.bbox, wall);
  if (!transform) return null;

  const { center, angle, localX, projectedWidth } = transform;

  // Width: use the projected wall-axis span — identical to gap tEnd-tStart
  const winW = projectedWidth > 0.05 ? projectedWidth : Math.max(getWidthM(win.bbox.w, win.widthM), 0.6);
  // Height & sill: must exactly mirror computeGapIntervals window values
  const winH = Math.min(wallHeight * 0.45, 1.2);
  const winD = 0.08;
  const sillY = wallHeight * 0.35;

  // All child Y positions are relative to sillY (bottom of gap).
  // BoxGeometry centres are at Y=half-height so we add winH/2 to side frames,
  // winH to the top frame, and 0 to the bottom frame — matching gap exactly.
  return (
    <group
      position={[center[0], 0, center[1]]}
      rotation={[0, -angle, 0]}
      onPointerEnter={(e) => {
        e.stopPropagation();
        onHover?.({ type: "window", id: win.id });
      }}
      onPointerLeave={(e) => {
        e.stopPropagation();
        onHover?.(null);
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(win.id);
      }}
    >
      <group position={[localX, sillY, 0]}>
        {/* Left frame — bottom-anchored: centre at winH/2 */}
        <mesh position={[-winW / 2, winH / 2, 0]}>
          <boxGeometry args={[0.05, winH, winD]} />
          <meshStandardMaterial color="#94a3b8" />
        </mesh>
        {/* Right frame — bottom-anchored */}
        <mesh position={[winW / 2, winH / 2, 0]}>
          <boxGeometry args={[0.05, winH, winD]} />
          <meshStandardMaterial color="#94a3b8" />
        </mesh>
        {/* Top frame — sits at gap top edge (winH) */}
        <mesh position={[0, winH, 0]}>
          <boxGeometry args={[winW, 0.05, winD]} />
          <meshStandardMaterial color="#94a3b8" />
        </mesh>
        {/* Bottom frame — sits at gap bottom edge (sill, Y=0 relative) */}
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[winW, 0.05, winD]} />
          <meshStandardMaterial color="#94a3b8" />
        </mesh>
        {/* Glass — centre at winH/2 */}
        <mesh position={[0, winH / 2, 0]}>
          <planeGeometry args={[winW - 0.1, winH - 0.1]} />
          <meshStandardMaterial
            color="#7dd3fc"
            transparent
            opacity={0.35}
            side={THREE.DoubleSide}
          />
        </mesh>
        <Text
          position={[0, winH + 0.25, 0]}
          fontSize={0.13}
          color="#06b6d4"
          anchorX="center"
          anchorY="middle"
        >
          {`W ${winW.toFixed(1)}m`}
        </Text>
      </group>
    </group>
  );
}

// ── Info overlay ──────────────────────────────────────────────────────────────

function PlacementPreviewMesh({
  preview,
  kind,
  walls,
  wallHeight,
}: {
  preview: PlacementPreview;
  kind: "door" | "window";
  walls: DetectedWallSegment[];
  wallHeight: number;
}) {
  if (!preview) return null;

  const wall = walls.find((item) => item.id === preview.wallId);
  if (!wall) return null;

  const bbox = createOpeningBboxOnWall(wall, kind, preview.point);
  const transform = getOpeningTransform(bbox, wall);
  if (!transform) return null;

  const { center, angle, localX, projectedWidth } = transform;
  const width = Math.max(projectedWidth, kind === "door" ? 0.75 : 0.9);
  const height =
    kind === "door"
      ? Math.min(wallHeight * 0.9, 2.2)
      : Math.min(wallHeight * 0.45, 1.2);
  const bottomY = kind === "door" ? 0 : wallHeight * 0.35;
  const color = kind === "door" ? "#f59e0b" : "#06b6d4";
  const wallThickness = getWallThicknessM(wall);
  const faceOffsets = [-(wallThickness / 2 + 0.04), wallThickness / 2 + 0.04];

  return (
    <group position={[center[0], 0, center[1]]} rotation={[0, -angle, 0]}>
      <group position={[localX, bottomY + height / 2, 0]}>
        {faceOffsets.map((offset) => (
          <group key={offset} position={[0, 0, offset]}>
            <mesh raycast={() => null}>
              <boxGeometry args={[width, height, 0.03]} />
              <meshBasicMaterial color={color} transparent opacity={0.2} />
            </mesh>
            <lineSegments raycast={() => null}>
              <edgesGeometry args={[new THREE.BoxGeometry(width, height, 0.035)]} />
              <lineBasicMaterial color={color} transparent opacity={0.98} />
            </lineSegments>
          </group>
        ))}
        <mesh raycast={() => null}>
          <boxGeometry args={[width, height, wallThickness + 0.08]} />
          <meshBasicMaterial color={color} transparent opacity={0.06} />
        </mesh>
        <Text
          position={[0, height / 2 + 0.22, 0]}
          fontSize={0.14}
          color={color}
          anchorX="center"
          anchorY="middle"
        >
          {kind === "door" ? "Place door" : "Place window"}
        </Text>
      </group>
    </group>
  );
}

function DeletePreviewMesh({
  target,
  rooms,
  walls,
  doors,
  windows,
  wallHeight,
  color = "#ef4444",
}: {
  target: Selection;
  rooms: Room[];
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  wallHeight: number;
  color?: string;
}) {
  if (!target) return null;

  if (target.type === "room") {
    const room = rooms.find((item) => item.id === target.id);
    const polygon = room ? getRoomPolygon(room) : null;
    if (!polygon || polygon.length < 3) return null;

    const shape = new THREE.Shape();
    const points = polygon.map(toPlanPoint);
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i][0], points[i][1]);
    shape.closePath();

    return (
      <group>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.08, 0]} renderOrder={20} raycast={() => null}>
          <shapeGeometry args={[shape]} />
          <meshBasicMaterial color={color} transparent opacity={0.32} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      </group>
    );
  }

  if (target.type === "wall") {
    const wall = walls.find((item) => item.id === target.id);
    if (!wall) return null;

    const x1 = wall.x1 * PLAN_SIZE - PLAN_SIZE / 2;
    const z1 = wall.y1 * PLAN_SIZE - PLAN_SIZE / 2;
    const x2 = wall.x2 * PLAN_SIZE - PLAN_SIZE / 2;
    const z2 = wall.y2 * PLAN_SIZE - PLAN_SIZE / 2;
    const length = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
    if (length < 0.001) return null;

    const angle = Math.atan2(z2 - z1, x2 - x1);
    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    const thickness = getWallThicknessM(wall) + 0.08;
    const height = safeNum(wall.wallHeight, wallHeight);

    return (
      <group position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
        <mesh position={[0, height / 2, 0]} renderOrder={20} raycast={() => null}>
          <boxGeometry args={[length, height, thickness]} />
          <meshBasicMaterial color={color} transparent opacity={0.24} depthWrite={false} />
        </mesh>
        <lineSegments position={[0, height / 2, 0]} raycast={() => null}>
          <edgesGeometry args={[new THREE.BoxGeometry(length, height, thickness)]} />
          <lineBasicMaterial color={color} transparent opacity={1} />
        </lineSegments>
      </group>
    );
  }

  const opening =
    target.type === "door"
      ? doors.find((item) => item.id === target.id)
      : windows.find((item) => item.id === target.id);
  if (!opening?.bbox) return null;

  const wall = findBestWall(opening.bbox, walls);
  if (!wall) return null;

  const transform = getOpeningTransform(opening.bbox, wall);
  if (!transform) return null;

  const { center, angle, localX, projectedWidth } = transform;
  const isDoor = target.type === "door";
  const width = Math.max(projectedWidth, isDoor ? 0.75 : 0.9);
  const height = isDoor ? Math.min(wallHeight * 0.9, 2.2) : Math.min(wallHeight * 0.45, 1.2);
  const bottomY = isDoor ? 0 : wallHeight * 0.35;
  const depth = getWallThicknessM(wall) + 0.16;

  return (
    <group position={[center[0], 0, center[1]]} rotation={[0, -angle, 0]}>
      <mesh position={[localX, bottomY + height / 2, 0]} renderOrder={20} raycast={() => null}>
        <boxGeometry args={[width, height, depth]} />
        <meshBasicMaterial color={color} transparent opacity={0.28} depthWrite={false} />
      </mesh>
      <lineSegments position={[localX, bottomY + height / 2, 0]} raycast={() => null}>
        <edgesGeometry args={[new THREE.BoxGeometry(width, height, depth)]} />
        <lineBasicMaterial color={color} transparent opacity={1} />
      </lineSegments>
    </group>
  );
}

function WallDraftPreviewMesh({
  draft,
  wallHeight,
}: {
  draft: WallDraft;
  wallHeight: number;
}) {
  if (!draft) return null;

  const wall: DetectedWallSegment = {
    id: "wall-draft-preview",
    x1: draft.start.x,
    y1: draft.start.y,
    x2: draft.end.x,
    y2: draft.end.y,
    type: "interior",
    thickness: 0.16,
    wallHeight,
  };

  const x1 = wall.x1 * PLAN_SIZE - PLAN_SIZE / 2;
  const z1 = wall.y1 * PLAN_SIZE - PLAN_SIZE / 2;
  const x2 = wall.x2 * PLAN_SIZE - PLAN_SIZE / 2;
  const z2 = wall.y2 * PLAN_SIZE - PLAN_SIZE / 2;
  const length = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
  if (length < 0.05) return null;

  const angle = Math.atan2(z2 - z1, x2 - x1);
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;
  const thickness = getWallThicknessM(wall);

  return (
    <group position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
      <mesh position={[0, wallHeight / 2, 0]} raycast={() => null}>
        <boxGeometry args={[length, wallHeight, thickness]} />
        <meshBasicMaterial color="#22c55e" transparent opacity={0.22} depthWrite={false} />
      </mesh>
      <lineSegments position={[0, wallHeight / 2, 0]} raycast={() => null}>
        <edgesGeometry args={[new THREE.BoxGeometry(length, wallHeight, thickness)]} />
        <lineBasicMaterial color="#22c55e" transparent opacity={1} />
      </lineSegments>
    </group>
  );
}

function WallBuildPlane({
  enabled,
  onPointMove,
  onPointClick,
}: {
  enabled: boolean;
  onPointMove: (point: NormalizedPoint) => void;
  onPointClick: (point: NormalizedPoint) => void;
}) {
  if (!enabled) return null;

  const toNormalized = (point: THREE.Vector3): NormalizedPoint => ({
    x: clamp01((point.x + PLAN_SIZE / 2) / PLAN_SIZE),
    y: clamp01((point.z + PLAN_SIZE / 2) / PLAN_SIZE),
  });

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.06, 0]}
      onPointerMove={(e) => {
        e.stopPropagation();
        onPointMove(toNormalized(e.point));
      }}
      onClick={(e) => {
        e.stopPropagation();
        onPointClick(toNormalized(e.point));
      }}
    >
      <planeGeometry args={[PLAN_SIZE, PLAN_SIZE]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

function WallEditGizmo({
  wall,
  wallHeight,
  onEndpointDrag,
  onMoveDrag,
  onHeightDrag,
  onDragStateChange,
}: {
  wall: DetectedWallSegment;
  wallHeight: number;
  onEndpointDrag: (id: string, endpoint: "start" | "end", point: NormalizedPoint) => void;
  onMoveDrag: (id: string, center: NormalizedPoint) => void;
  onHeightDrag: (id: string, deltaM: number) => void;
  onDragStateChange: (dragging: boolean) => void;
}) {
  const [dragMode, setDragMode] = useState<"start" | "end" | "move" | "height" | null>(null);

  const x1 = wall.x1 * PLAN_SIZE - PLAN_SIZE / 2;
  const z1 = wall.y1 * PLAN_SIZE - PLAN_SIZE / 2;
  const x2 = wall.x2 * PLAN_SIZE - PLAN_SIZE / 2;
  const z2 = wall.y2 * PLAN_SIZE - PLAN_SIZE / 2;
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;
  const length = getWallLengthM(wall);
  const height = safeNum(wall.wallHeight, wallHeight);
  const angle = Math.atan2(z2 - z1, x2 - x1);
  const thickness = getWallThicknessM(wall);
  const faceOffset = thickness / 2 + 0.18;

  const toNormalized = (point: THREE.Vector3): NormalizedPoint => ({
    x: clamp01((point.x + PLAN_SIZE / 2) / PLAN_SIZE),
    y: clamp01((point.z + PLAN_SIZE / 2) / PLAN_SIZE),
  });

  const beginDrag = (
    mode: "start" | "end" | "move" | "height",
    event?: { stopPropagation: () => void; target: { setPointerCapture?: (pointerId: number) => void }; pointerId: number },
  ) => {
    event?.stopPropagation();
    event?.target.setPointerCapture?.(event.pointerId);
    setDragMode(mode);
    onDragStateChange(true);
  };

  const finishDrag = (event?: { stopPropagation: () => void; target: { releasePointerCapture?: (pointerId: number) => void }; pointerId: number }) => {
    event?.stopPropagation();
    event?.target.releasePointerCapture?.(event.pointerId);
    setDragMode(null);
    onDragStateChange(false);
  };

  return (
    <group>
      {dragMode && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.1, 0]}
          onPointerMove={(e) => {
            e.stopPropagation();
            if (dragMode === "height") {
              const movementY = "movementY" in e.nativeEvent ? e.nativeEvent.movementY : 0;
              onHeightDrag(wall.id, -movementY * 0.025);
              return;
            }
            const point = toNormalized(e.point);
            if (dragMode === "move") onMoveDrag(wall.id, point);
            else onEndpointDrag(wall.id, dragMode, point);
          }}
          onPointerUp={(e) => {
            finishDrag(e);
          }}
        >
          <planeGeometry args={[PLAN_SIZE, PLAN_SIZE]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      <group position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
        <lineSegments position={[0, height / 2, 0]} raycast={() => null}>
          <edgesGeometry args={[new THREE.BoxGeometry(Math.max(length, 0.1), height, thickness + 0.08)]} />
          <lineBasicMaterial color="#38bdf8" transparent opacity={0.95} />
        </lineSegments>
        <mesh position={[0, height + 0.035, 0]} raycast={() => null}>
          <boxGeometry args={[Math.max(length, 0.1), 0.035, thickness + 0.12]} />
          <meshBasicMaterial color="#38bdf8" transparent opacity={0.45} />
        </mesh>
      </group>

      {[
        { mode: "start" as const, localX: -length / 2, label: "Start" },
        { mode: "end" as const, localX: length / 2, label: "End" },
      ].map((handle) => (
        <group key={handle.mode} position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
          <group position={[handle.localX, height + 0.18, faceOffset]}>
            <mesh
              onPointerDown={(e) => {
                beginDrag(handle.mode, e);
              }}
              rotation={[Math.PI / 2, 0, 0]}
            >
              <torusGeometry args={[0.13, 0.025, 10, 24]} />
              <meshStandardMaterial color="#22c55e" emissive="#16a34a" emissiveIntensity={0.2} roughness={0.3} />
            </mesh>
            <mesh
              onPointerDown={(e) => {
                beginDrag(handle.mode, e);
              }}
              rotation={[0, 0, handle.mode === "start" ? Math.PI / 2 : -Math.PI / 2]}
            >
              <coneGeometry args={[0.075, 0.18, 16]} />
              <meshStandardMaterial color="#bbf7d0" emissive="#22c55e" emissiveIntensity={0.1} roughness={0.28} />
            </mesh>
          </group>
        </group>
      ))}

      <group position={[cx, height * 0.52, cz]} rotation={[0, -angle, 0]}>
        <group position={[0, 0, faceOffset]}>
          <mesh
            onPointerDown={(e) => {
              beginDrag("move", e);
            }}
          >
            <boxGeometry args={[0.34, 0.34, 0.045]} />
            <meshStandardMaterial color="#3b82f6" emissive="#2563eb" emissiveIntensity={0.18} roughness={0.3} />
          </mesh>
        </group>
        <Text position={[0, 0.34, faceOffset]} fontSize={0.11} color="#bfdbfe" anchorX="center" anchorY="middle">
          Move
        </Text>
      </group>

      <group position={[cx, height + 0.42, cz]} rotation={[0, -angle, 0]}>
        <mesh position={[0, -0.2, faceOffset]} raycast={() => null}>
          <boxGeometry args={[0.035, 0.4, 0.035]} />
          <meshBasicMaterial color="#f59e0b" transparent opacity={0.72} />
        </mesh>
        <mesh
          position={[0, 0, faceOffset]}
          onPointerDown={(e) => {
            beginDrag("height", e);
          }}
        >
          <coneGeometry args={[0.18, 0.34, 24]} />
          <meshStandardMaterial color="#f59e0b" emissive="#d97706" emissiveIntensity={0.24} roughness={0.3} metalness={0.06} />
        </mesh>
        <Text position={[0, 0.32, faceOffset]} fontSize={0.11} color="#fde68a" anchorX="center" anchorY="middle">
          Height
        </Text>
      </group>
    </group>
  );
}

function RoomInfoCard({ room }: { room: Room }) {
  const bounds = getRoomBounds(room);
  const w = Math.max(safeNum(bounds?.w) * PLAN_SIZE, 0);
  const d = Math.max(safeNum(bounds?.h) * PLAN_SIZE, 0);
  const h = safeNum(room.wallHeight, 2.8);
  const area = polygonArea(getRoomPolygon(room));

  return (
    <div className="absolute bottom-16 left-4 z-20 px-4 py-2.5 rounded-2xl bg-card/90 backdrop-blur-md border border-border shadow-2xl flex items-center gap-4 min-w-[280px] pointer-events-none">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-foreground truncate">{room.name}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
          {w.toFixed(2)}m × {d.toFixed(2)}m · H: {h.toFixed(2)}m
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-[11px] font-mono text-primary">{area.toFixed(1)} m²</p>
        <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">
          {room.confidence}
        </p>
      </div>
    </div>
  );
}

// ── Scene ─────────────────────────────────────────────────────────────────────

function Scene({
  rooms,
  walls,
  doors,
  windows,
  walkMode,
  viewPreset,
  cameraDistance,
  buildMode,
  placementPreview,
  selectedTarget,
  hoverTarget,
  onHoverChange,
  onSelect,
  onHoverTargetChange,
  onPlacementHover,
  onWallAdd,
  onWallEndpointDrag,
  onWallMoveDrag,
  onWallHeightDrag,
}: {
  rooms: Room[];
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  walkMode: boolean;
  viewPreset: ViewPreset;
  cameraDistance: number;
  buildMode: BuildMode;
  placementPreview: PlacementPreview;
  selectedTarget: Selection;
  hoverTarget: Selection;
  onHoverChange: (id: string | null) => void;
  onSelect: (selection: Selection) => void;
  onHoverTargetChange: (selection: Selection) => void;
  onPlacementHover: (preview: PlacementPreview) => void;
  onWallAdd?: (wall: DetectedWallSegment) => void;
  onWallEndpointDrag: (id: string, endpoint: "start" | "end", point: NormalizedPoint) => void;
  onWallMoveDrag: (id: string, center: NormalizedPoint) => void;
  onWallHeightDrag: (id: string, deltaM: number) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [wallDragging, setWallDragging] = useState(false);
  const [wallDraft, setWallDraft] = useState<WallDraft>(null);
  const orbitControlsRef = useRef<any>(null);

  const renderWalls = useMemo(() => snapRenderedWallJunctions(walls), [walls]);

  const defaultWallHeight =
    rooms.length > 0
      ? Math.max(...rooms.map((r) => safeNum(r.wallHeight, 2.8)), 2.8)
      : 2.8;

  const handleHover = (id: string | null) => {
    setHoveredId(id);
    onHoverChange(id);
  };

  useEffect(() => {
    if (buildMode !== "delete" && buildMode !== "select") onHoverTargetChange(null);
    if (buildMode !== "wall") setWallDraft(null);
  }, [buildMode, onHoverTargetChange]);

  const canPreviewTarget = buildMode === "delete" || buildMode === "select";
  const isPlacementMode = buildMode === "door" || buildMode === "window";
  const activeTargetPreview =
    buildMode === "select" ? hoverTarget ?? selectedTarget : hoverTarget;
  const selectedWallForEdit =
    buildMode === "select" && selectedTarget?.type === "wall"
      ? renderWalls.find((wall) => wall.id === selectedTarget.id) ?? null
      : null;

  const handleWallBuildPoint = (point: NormalizedPoint) => {
    const snappedPoint = snapPointToWalls(point, renderWalls);
    if (!wallDraft) {
      setWallDraft({ start: snappedPoint, end: snappedPoint });
      return;
    }

    const length = Math.sqrt(
      (wallDraft.start.x - snappedPoint.x) ** 2 + (wallDraft.start.y - snappedPoint.y) ** 2,
    );
    if (length < 0.005) return;

    const id = `manual-wall-${Date.now()}`;
    onWallAdd?.({
      id,
      x1: wallDraft.start.x,
      y1: wallDraft.start.y,
      x2: snappedPoint.x,
      y2: snappedPoint.y,
      type: "interior",
      thickness: 0.16,
      wallHeight: defaultWallHeight,
    });
    onSelect({ type: "wall", id, point: snappedPoint });
    setWallDraft(null);
  };

  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[10, 16, 10]} intensity={1.2} castShadow />
      <pointLight position={[-8, 10, -8]} intensity={0.5} color="#60a5fa" />
      <pointLight position={[8, 6, 8]} intensity={0.3} color="#a78bfa" />

      <Grid
        infiniteGrid
        cellSize={1}
        sectionSize={5}
        cellColor="#cbd5e1"
        sectionColor="#94a3b8"
        fadeDistance={40}
      />

      <WallBuildPlane
        enabled={buildMode === "wall"}
        onPointMove={(point) => {
          const snappedPoint = snapPointToWalls(point, renderWalls);
          setWallDraft((prev) => (prev ? { ...prev, end: snappedPoint } : prev));
        }}
        onPointClick={handleWallBuildPoint}
      />

      <WallDraftPreviewMesh draft={wallDraft} wallHeight={defaultWallHeight} />

      {/* ── Rooms — ShapeGeometry flat tiles ── */}
      {rooms.map((room, i) => (
        <RoomPolygonMesh
          key={room.id}
          room={room}
          index={i}
          hovered={hoveredId === room.id}
          onHover={handleHover}
          onSelect={(id) => onSelect({ type: "room", id })}
          onTargetHover={canPreviewTarget ? onHoverTargetChange : undefined}
        />
      ))}

      {/* ── Walls — split into sub-segments around door/window openings ── */}
      {renderWalls.map((wall) => (
        <WallSegmentMesh
          key={wall.id}
          wall={wall}
          wallHeight={defaultWallHeight}
          doors={doors}
          windows={windows}
          onSelect={(id, point) => {
            if (buildMode !== "wall") onSelect({ type: "wall", id, point });
          }}
          onPlacementHover={
            isPlacementMode
              ? (id, point) => onPlacementHover({ wallId: id, point })
              : undefined
          }
          onPlacementLeave={() => onPlacementHover(null)}
          onTargetHover={canPreviewTarget ? onHoverTargetChange : undefined}
        />
      ))}

      {selectedWallForEdit && (
        <WallEditGizmo
          wall={selectedWallForEdit}
          wallHeight={defaultWallHeight}
          onEndpointDrag={onWallEndpointDrag}
          onMoveDrag={onWallMoveDrag}
          onHeightDrag={onWallHeightDrag}
          onDragStateChange={setWallDragging}
        />
      )}

      {isPlacementMode && (
        <PlacementPreviewMesh
          preview={placementPreview}
          kind={buildMode}
          walls={renderWalls}
          wallHeight={defaultWallHeight}
        />
      )}

      {/* ── Doors — wall-aligned via getOpeningTransform ── */}
      {doors.map((door) => (
        <DoorMesh
          key={door.id}
          door={door}
          wallHeight={defaultWallHeight}
          walls={renderWalls}
          onSelect={(id) => onSelect({ type: "door", id })}
          onHover={canPreviewTarget ? onHoverTargetChange : undefined}
        />
      ))}

      {/* ── Windows — wall-aligned via getOpeningTransform ── */}
      {windows.map((win) => (
        <WindowMesh
          key={win.id}
          win={win}
          wallHeight={defaultWallHeight}
          walls={renderWalls}
          onSelect={(id) => onSelect({ type: "window", id })}
          onHover={canPreviewTarget ? onHoverTargetChange : undefined}
        />
      ))}

      {canPreviewTarget && (
        <DeletePreviewMesh
          target={activeTargetPreview}
          rooms={rooms}
          walls={renderWalls}
          doors={doors}
          windows={windows}
          wallHeight={defaultWallHeight}
          color={buildMode === "delete" ? "#ef4444" : "#3b82f6"}
        />
      )}

      <CameraPresetController
        preset={viewPreset}
        walkMode={walkMode}
        distance={cameraDistance}
        controlsRef={orbitControlsRef}
      />

      {walkMode ? (
        <FirstPersonController enabled={walkMode} />
      ) : (
        <OrbitControls
          ref={orbitControlsRef}
          enablePan={!wallDragging}
          enableZoom={!wallDragging}
          enableRotate={!wallDragging}
          enabled={!wallDragging}
          maxPolarAngle={Math.PI / 2.05}
          minDistance={3}
          maxDistance={60}
          makeDefault
        />
      )}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const RightPanel = ({
  rooms,
  generated,
  walls = [],
  doors = [],
  windows = [],
  onRoomUpdate,
  onRoomPatch,
  onRoomDelete,
  onWallUpdate,
  onWallAdd,
  onWallDelete,
  onDoorAdd,
  onDoorDelete,
  onWindowAdd,
  onWindowDelete,
  onBack,
}: RightPanelProps) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [walkMode, setWalkMode] = useState(false);
  const [viewPreset, setViewPreset] = useState<ViewPreset>("perspective");
  const [buildMode, setBuildMode] = useState<BuildMode>("select");
  const [selection, setSelection] = useState<Selection>(null);
  const [hoverTarget, setHoverTarget] = useState<Selection>(null);
  const [placementPreview, setPlacementPreview] = useState<PlacementPreview>(null);
  const hoveredRoom = rooms.find((r) => r.id === hoveredId) ?? null;
  const selectedRoom = selection?.type === "room" ? rooms.find((r) => r.id === selection.id) : null;
  const selectedWall = selection?.type === "wall" ? walls.find((w) => w.id === selection.id) : null;
  const selectedDoor = selection?.type === "door" ? doors.find((d) => d.id === selection.id) : null;
  const selectedWindow = selection?.type === "window" ? windows.find((w) => w.id === selection.id) : null;

  const maxH =
    rooms.length > 0
      ? Math.max(...rooms.map((r) => safeNum(r.wallHeight, 2.8)), 3)
      : 3;

  const planSpan = rooms.reduce((max, room) => {
    const bounds = getRoomBounds(room);
    if (!bounds) return max;
    return Math.max(max, Math.max(bounds.w, bounds.h) * PLAN_SIZE);
  }, PLAN_SIZE);

  const camDist = Math.max(planSpan * 1.4, 15);

  const totalArea = rooms.reduce(
    (s, room) => s + polygonArea(getRoomPolygon(room)),
    0,
  );

  const viewOptions: { id: ViewPreset; label: string }[] = [
    { id: "perspective", label: "Perspective" },
    { id: "top", label: "Top" },
    { id: "front", label: "Front" },
    { id: "side", label: "Side" },
  ];

  const buildOptions: { id: BuildMode; label: string; hint: string }[] = [
    { id: "select", label: "Select", hint: "Hover previews, click selects, click empty space clears" },
    { id: "wall", label: "Wall", hint: "Click floor start point, move, then click end point" },
    { id: "door", label: "Door", hint: "Click the exact spot on a wall to place a door" },
    { id: "window", label: "Window", hint: "Click the exact spot on a wall to place a window" },
    { id: "delete", label: "Delete", hint: "Click object to remove" },
  ];

  useEffect(() => {
    setPlacementPreview(null);
    setHoverTarget(null);
  }, [buildMode]);

  const addOpeningToWall = (
    wall: DetectedWallSegment,
    kind: "door" | "window",
    point?: NormalizedPoint,
  ) => {
    const bbox = createOpeningBboxOnWall(wall, kind, point);
    if (kind === "door" && onDoorAdd) {
      const id = `manual-door-${Date.now()}`;
      onDoorAdd({ id, bbox, widthPx: undefined, widthM: 0.9 });
      setSelection({ type: "door", id });
    }
    if (kind === "window" && onWindowAdd) {
      const id = `manual-window-${Date.now()}`;
      onWindowAdd({ id, bbox, widthPx: undefined, widthM: 1.2 });
      setSelection({ type: "window", id });
    }
  };

  const addOpeningToSelectedWall = (kind: "door" | "window") => {
    if (!selectedWall) return;
    addOpeningToWall(selectedWall, kind, selection?.type === "wall" ? selection.point : undefined);
  };

  const deleteSelection = () => {
    if (!selection) return;
    if (selection.type === "room") onRoomDelete?.(selection.id);
    if (selection.type === "wall") onWallDelete?.(selection.id);
    if (selection.type === "door") onDoorDelete?.(selection.id);
    if (selection.type === "window") onWindowDelete?.(selection.id);
    setSelection(null);
  };

  const deleteBySelection = (target: Selection) => {
    if (!target) return;
    if (target.type === "room") onRoomDelete?.(target.id);
    if (target.type === "wall") onWallDelete?.(target.id);
    if (target.type === "door") onDoorDelete?.(target.id);
    if (target.type === "window") onWindowDelete?.(target.id);
    setSelection(null);
  };

  const handleSceneSelect = (target: Selection) => {
    if (!target) return;

    if (buildMode === "wall") return;

    if (buildMode === "delete") {
      deleteBySelection(target);
      setHoverTarget(null);
      return;
    }

    if ((buildMode === "door" || buildMode === "window") && target.type === "wall") {
      const wall = walls.find((item) => item.id === target.id);
      if (wall) addOpeningToWall(wall, buildMode, target.point);
      setPlacementPreview(null);
      setHoverTarget(null);
      return;
    }

    if (buildMode === "select") {
      setSelection(target);
      setHoverTarget(null);
    }
  };

  const clearSelect = () => {
    if (buildMode !== "select") return;
    setSelection(null);
    setHoverTarget(null);
  };

  const resizeSelectedRoom = (factor: number) => {
    if (!selectedRoom || !onRoomPatch) return;
    const polygon = getRoomPolygon(selectedRoom);
    const center = getRoomCenter(selectedRoom);
    if (!polygon || !center) return;

    const nextPolygon = polygon.map((point) => ({
      x: clamp01(center.x + (point.x - center.x) * factor),
      y: clamp01(center.y + (point.y - center.y) * factor),
    }));
    const bbox = boundsFromPolygon(nextPolygon);

    onRoomPatch(selectedRoom.id, {
      polygon: selectedRoom.wallPolygon ? selectedRoom.polygon : nextPolygon,
      wallPolygon: selectedRoom.wallPolygon ? nextPolygon : selectedRoom.wallPolygon,
      bbox,
      width: bbox.w,
      height: bbox.h,
      confidence: "manual",
    });
  };

  const updateSelectedWallLength = (lengthM: number) => {
    if (!selectedWall || !onWallUpdate) return;
    const nextLength = Math.max(0.1, lengthM) / PLAN_SIZE;
    const dx = selectedWall.x2 - selectedWall.x1;
    const dy = selectedWall.y2 - selectedWall.y1;
    const currentLength = Math.sqrt(dx * dx + dy * dy);
    if (currentLength < 1e-6) return;

    const ux = dx / currentLength;
    const uy = dy / currentLength;
    const cx = (selectedWall.x1 + selectedWall.x2) / 2;
    const cy = (selectedWall.y1 + selectedWall.y2) / 2;
    const half = nextLength / 2;

    onWallUpdate(selectedWall.id, "x1", clamp01(cx - ux * half));
    onWallUpdate(selectedWall.id, "y1", clamp01(cy - uy * half));
    onWallUpdate(selectedWall.id, "x2", clamp01(cx + ux * half));
    onWallUpdate(selectedWall.id, "y2", clamp01(cy + uy * half));
  };

  const dragSelectedWallEndpoint = (
    id: string,
    endpoint: "start" | "end",
    point: NormalizedPoint,
  ) => {
    if (!onWallUpdate) return;
    const wall = walls.find((item) => item.id === id);
    if (!wall) return;

    const anchor =
      endpoint === "start"
        ? { x: wall.x2, y: wall.y2 }
        : { x: wall.x1, y: wall.y1 };
    const current =
      endpoint === "start"
        ? { x: wall.x1, y: wall.y1 }
        : { x: wall.x2, y: wall.y2 };
    const axisX = current.x - anchor.x;
    const axisY = current.y - anchor.y;
    const axisLength = Math.sqrt(axisX * axisX + axisY * axisY);
    if (axisLength < 1e-6) return;

    const ux = axisX / axisLength;
    const uy = axisY / axisLength;
    const rawDistance = (point.x - anchor.x) * ux + (point.y - anchor.y) * uy;
    const distance = Math.max(0.01, rawDistance);
    const projected = {
      x: clamp01(anchor.x + ux * distance),
      y: clamp01(anchor.y + uy * distance),
    };

    if (endpoint === "start") {
      onWallUpdate(id, "x1", projected.x);
      onWallUpdate(id, "y1", projected.y);
      return;
    }
    onWallUpdate(id, "x2", projected.x);
    onWallUpdate(id, "y2", projected.y);
  };

  const moveSelectedWall = (id: string, center: NormalizedPoint) => {
    if (!onWallUpdate) return;
    const wall = walls.find((item) => item.id === id);
    if (!wall) return;

    const dx = wall.x2 - wall.x1;
    const dy = wall.y2 - wall.y1;
    const halfDx = dx / 2;
    const halfDy = dy / 2;
    onWallUpdate(id, "x1", clamp01(center.x - halfDx));
    onWallUpdate(id, "y1", clamp01(center.y - halfDy));
    onWallUpdate(id, "x2", clamp01(center.x + halfDx));
    onWallUpdate(id, "y2", clamp01(center.y + halfDy));
  };

  const resizeSelectedWallHeight = (id: string, deltaM: number) => {
    if (!onWallUpdate) return;
    const wall = walls.find((item) => item.id === id);
    if (!wall) return;
    const current = safeNum(wall.wallHeight, maxH);
    onWallUpdate(id, "wallHeight", Math.max(1.2, Math.min(8, current + deltaM)));
  };

  return (
    <div className="flex-1 flex items-center justify-center bg-background relative overflow-hidden">
      {!generated ? (
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-surface-raised border border-border flex items-center justify-center">
            <Box className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="text-center space-y-1">
            <p className="text-sm font-medium text-foreground font-sans">3D Preview</p>
            <p className="text-xs text-muted-foreground max-w-[240px]">
              Upload a floor plan &amp; click Generate 3D
            </p>
          </div>
        </div>
      ) : (
        <>
          <Canvas
            camera={{
              position: [camDist * 0.7, camDist * 0.5, camDist * 0.7],
              fov: 45,
            }}
            style={{ width: "100%", height: "100%" }}
            onPointerMissed={clearSelect}
          >
              <Scene
                rooms={rooms}
                walls={walls}
              doors={doors}
              windows={windows}
              walkMode={walkMode}
              viewPreset={viewPreset}
              cameraDistance={camDist}
              buildMode={buildMode}
              placementPreview={placementPreview}
              selectedTarget={selection}
              hoverTarget={hoverTarget}
              onHoverChange={setHoveredId}
              onSelect={handleSceneSelect}
              onHoverTargetChange={setHoverTarget}
              onPlacementHover={setPlacementPreview}
              onWallAdd={onWallAdd}
              onWallEndpointDrag={dragSelectedWallEndpoint}
              onWallMoveDrag={moveSelectedWall}
              onWallHeightDrag={resizeSelectedWallHeight}
            />
          </Canvas>

          {onBack && (
            <div className="absolute top-4 left-4 flex items-center gap-2 z-10">
              <button
                onClick={onBack}
                className="flex items-center gap-2 px-3 py-2 rounded-xl bg-card/90 hover:bg-accent border border-border backdrop-blur-md text-xs text-muted-foreground hover:text-foreground transition-all duration-200 shadow-lg group"
              >
                <ChevronLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
                Back to Review
              </button>
              <div className="px-2 py-1 rounded-lg bg-card/80 border border-border backdrop-blur-md text-[10px] text-muted-foreground font-mono">
                {walkMode
                  ? "Click scene · WASD move · Mouse look · Esc unlock"
                  : "Drag · Scroll · Right-click pan"}
              </div>
            </div>
          )}

          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-border bg-card/92 p-1.5 shadow-2xl backdrop-blur-md">
            {viewOptions.map((option) => (
              <button
                key={option.id}
                onClick={() => setViewPreset(option.id)}
                disabled={walkMode}
                className={`rounded-xl px-3 py-2 text-[11px] font-medium transition-colors ${
                  viewPreset === option.id
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                } disabled:cursor-not-allowed disabled:opacity-45`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="absolute left-1/2 top-20 z-20 flex -translate-x-1/2 items-center gap-1 rounded-3xl border border-border bg-card/95 p-1.5 shadow-2xl backdrop-blur-md">
            {buildOptions.map((option) => (
              <button
                key={option.id}
                onClick={() => setBuildMode(option.id)}
                className={`rounded-2xl px-3 py-2 text-[11px] font-semibold transition-all ${
                  buildMode === option.id
                    ? option.id === "delete"
                      ? "bg-red-500 text-white shadow-lg"
                      : "bg-blue-600 text-white shadow-lg"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                title={option.hint}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="absolute left-1/2 top-[132px] z-20 -translate-x-1/2 rounded-full border border-border bg-card/85 px-3 py-1.5 text-[10px] font-mono text-muted-foreground shadow-lg backdrop-blur-md">
            {buildOptions.find((option) => option.id === buildMode)?.hint}
          </div>

          <div className="absolute top-4 left-1/2 flex -translate-x-1/2 items-center gap-3 bg-card/90 border border-border backdrop-blur-md rounded-2xl px-3 py-2 z-20 shadow-lg">
            <Info className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <div className="flex items-center gap-3 text-[10px] font-mono divide-x divide-border">
              <span className="text-muted-foreground">{rooms.length} rooms</span>
              {walls.length > 0 && (
                <span className="pl-3 text-muted-foreground">{walls.length} walls</span>
              )}
              {doors.length > 0 && (
                <span className="pl-3 text-amber-400">{doors.length} doors</span>
              )}
              {windows.length > 0 && (
                <span className="pl-3 text-cyan-400">{windows.length} windows</span>
              )}
              <span className="pl-3 text-muted-foreground">{totalArea.toFixed(1)} m²</span>
              <span className="pl-3 text-muted-foreground">H: {maxH.toFixed(1)}m</span>
            </div>
            <button
              onClick={() => setWalkMode((prev) => !prev)}
              className={`ml-2 flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-all duration-200 ${
                walkMode
                  ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-500 shadow-[0_0_0_3px_rgba(37,99,235,0.12)]"
                  : "bg-foreground text-background border-foreground hover:opacity-90"
              }`}
            >
              <Move3D className="w-3.5 h-3.5" />
              {walkMode ? "Walk Mode On" : "Walk Mode"}
            </button>
          </div>

          <div className="absolute bottom-20 right-4 z-20 w-[280px] rounded-3xl border border-border bg-card/92 p-4 shadow-2xl backdrop-blur-md">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Palette className="h-4 w-4 text-primary" />
                <div>
                  <div className="text-xs font-semibold text-foreground">Decorate</div>
                  <div className="text-[10px] text-muted-foreground">
                    {selection ? `${selection.type} selected` : "Click an object"}
                  </div>
                </div>
              </div>
              {selection && (
                <button onClick={() => setSelection(null)} className="rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                  x
                </button>
              )}
            </div>

            {!selection && (
              <div className="rounded-2xl border border-dashed border-border p-3 text-[11px] leading-5 text-muted-foreground">
                Select a room, wall, door, or window in the 3D view to edit it.
              </div>
            )}

            {selectedRoom && (
              <div className="space-y-3">
                <div className="text-[11px] font-medium text-foreground">{selectedRoom.name}</div>
                <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                  Floor color
                  <input
                    type="color"
                    value={selectedRoom.floorColor ?? ROOM_PALETTE[0].floor}
                    onChange={(e) => onRoomUpdate?.(selectedRoom.id, "floorColor", e.target.value)}
                    className="h-8 w-12 rounded border border-border bg-transparent"
                  />
                </label>
                <label className="block text-[11px] text-muted-foreground">
                  Room height
                  <input
                    type="number"
                    min={1.8}
                    step={0.1}
                    value={safeNum(selectedRoom.wallHeight, 2.8)}
                    onChange={(e) => onRoomUpdate?.(selectedRoom.id, "wallHeight", parseFloat(e.target.value) || 2.8)}
                    className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs text-foreground"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => resizeSelectedRoom(0.94)} className="rounded-xl border border-border bg-background px-3 py-2 text-[11px] text-foreground hover:bg-accent">
                    Shrink floor
                  </button>
                  <button onClick={() => resizeSelectedRoom(1.06)} className="rounded-xl border border-border bg-background px-3 py-2 text-[11px] text-foreground hover:bg-accent">
                    Expand floor
                  </button>
                </div>
              </div>
            )}

            {selectedWall && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-foreground">Wall</span>
                  <button
                    onClick={() => onWallUpdate?.(selectedWall.id, "type", selectedWall.type === "exterior" ? "interior" : "exterior")}
                    className="rounded-lg bg-primary/10 px-2 py-1 text-[10px] font-mono text-primary"
                  >
                    {selectedWall.type}
                  </button>
                </div>
                <label className="block text-[11px] text-muted-foreground">
                  Width / thickness (m)
                  <input
                    type="number"
                    min={0.05}
                    step={0.01}
                    value={getWallThicknessM(selectedWall).toFixed(2)}
                    onChange={(e) => onWallUpdate?.(selectedWall.id, "thickness", parseFloat(e.target.value) || 0.15)}
                    className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs text-foreground"
                  />
                </label>
                <label className="block text-[11px] text-muted-foreground">
                  Length (m)
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={getWallLengthM(selectedWall).toFixed(2)}
                    onChange={(e) => updateSelectedWallLength(parseFloat(e.target.value) || getWallLengthM(selectedWall))}
                    className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs text-foreground"
                  />
                </label>
                <label className="block text-[11px] text-muted-foreground">
                  Height (m)
                  <input
                    type="number"
                    min={1.8}
                    step={0.1}
                    value={safeNum(selectedWall.wallHeight, maxH)}
                    onChange={(e) => onWallUpdate?.(selectedWall.id, "wallHeight", parseFloat(e.target.value) || maxH)}
                    className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs text-foreground"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => addOpeningToSelectedWall("door")} className="inline-flex items-center justify-center gap-1 rounded-xl border border-border bg-background px-3 py-2 text-[11px] text-foreground hover:bg-accent">
                    <Plus className="h-3 w-3" /> Door
                  </button>
                  <button onClick={() => addOpeningToSelectedWall("window")} className="inline-flex items-center justify-center gap-1 rounded-xl border border-border bg-background px-3 py-2 text-[11px] text-foreground hover:bg-accent">
                    <Plus className="h-3 w-3" /> Window
                  </button>
                </div>
              </div>
            )}

            {(selectedDoor || selectedWindow) && (
              <div className="space-y-3">
                <div className="text-[11px] font-medium text-foreground">
                  {selectedDoor ? "Door" : "Window"}
                </div>
                <div className="rounded-2xl border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground">
                  Delete is available now. Drag/resize handles can be added next.
                </div>
              </div>
            )}

            {selection && (
              <button
                onClick={deleteSelection}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/15"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete selected
              </button>
            )}
          </div>

          {hoveredRoom && <RoomInfoCard room={hoveredRoom} />}
        </>
      )}
    </div>
  );
};

export default RightPanel;
