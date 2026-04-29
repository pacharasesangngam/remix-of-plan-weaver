import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Grid, PointerLockControls, Text } from "@react-three/drei";
import * as THREE from "three";
import { Box, ChevronLeft, Info, Move3D } from "lucide-react";
import type { BBox, NormalizedPoint, Room } from "@/types/floorplan";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";

interface RightPanelProps {
  rooms: Room[];
  generated: boolean;
  scale: number;
  walls?: DetectedWallSegment[];
  doors?: DetectedDoor[];
  windows?: DetectedWindow[];
  onBack?: () => void;
}

type ViewPreset = "perspective" | "top" | "front" | "side";

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
}: {
  room: Room;
  index: number;
  hovered: boolean;
  onHover: (id: string | null) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const floorMatRef = useRef<THREE.MeshStandardMaterial>(null);

  const pal = ROOM_PALETTE[index % ROOM_PALETTE.length];
  const baseColorRef = useRef(new THREE.Color(pal.floor));
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

  if (!shape) return null;

  return (
    <group
      ref={groupRef}
      position={[0, 0, 0]}
      onPointerEnter={() => onHover(room.id)}
      onPointerLeave={() => onHover(null)}
    >
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial
          ref={floorMatRef}
          color={pal.floor}
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
}: {
  wall: DetectedWallSegment;
  wallHeight: number;
  doors: DetectedDoor[];
  windows: DetectedWindow[];
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

        return (
          <mesh key={i} position={[localX, localY, 0]}>
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
}: {
  door: DetectedDoor;
  wallHeight: number;
  walls: DetectedWallSegment[];
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
  const doorD = 0.12;

  return (
    <group position={[center[0], 0, center[1]]} rotation={[0, -angle, 0]}>
      <group position={[localX, 0, 0]}>
        {/* Left jamb */}
        <mesh position={[-doorW / 2 - 0.04, doorH / 2, 0]}>
          <boxGeometry args={[0.08, doorH, doorD + 0.06]} />
          <meshStandardMaterial color="#78350f" roughness={0.5} metalness={0.1} />
        </mesh>
        {/* Right jamb */}
        <mesh position={[doorW / 2 + 0.04, doorH / 2, 0]}>
          <boxGeometry args={[0.08, doorH, doorD + 0.06]} />
          <meshStandardMaterial color="#78350f" roughness={0.5} metalness={0.1} />
        </mesh>
        {/* Header */}
        <mesh position={[0, doorH + 0.04, 0]}>
          <boxGeometry args={[doorW + 0.16, 0.08, doorD + 0.06]} />
          <meshStandardMaterial color="#78350f" roughness={0.5} metalness={0.1} />
        </mesh>
        {/* Panel */}
        <mesh position={[doorW / 4, doorH / 2, doorD / 2 + 0.02]} castShadow>
          <boxGeometry args={[doorW * 0.48, doorH - 0.05, 0.05]} />
          <meshStandardMaterial
            color="#fef3c7"
            emissive="#f59e0b"
            emissiveIntensity={0.15}
            roughness={0.4}
            metalness={0.08}
            transparent
            opacity={0.6}
          />
        </mesh>
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
}: {
  win: DetectedWindow;
  wallHeight: number;
  walls: DetectedWallSegment[];
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
    <group position={[center[0], 0, center[1]]} rotation={[0, -angle, 0]}>
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

function RoomInfoCard({ room }: { room: Room }) {
  const bounds = getRoomBounds(room);
  const w = Math.max(safeNum(bounds?.w) * PLAN_SIZE, 0);
  const d = Math.max(safeNum(bounds?.h) * PLAN_SIZE, 0);
  const h = safeNum(room.wallHeight, 2.8);
  const area = polygonArea(getRoomPolygon(room));

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-2xl bg-card/90 backdrop-blur-md border border-border shadow-2xl flex items-center gap-4 min-w-[280px] pointer-events-none">
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
  scale,
  walls,
  doors,
  windows,
  walkMode,
  viewPreset,
  cameraDistance,
  onHoverChange,
}: {
  rooms: Room[];
  scale: number;
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  walkMode: boolean;
  viewPreset: ViewPreset;
  cameraDistance: number;
  onHoverChange: (id: string | null) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
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

      {/* ── Rooms — ShapeGeometry flat tiles ── */}
      {rooms.map((room, i) => (
        <RoomPolygonMesh
          key={room.id}
          room={room}
          index={i}
          hovered={hoveredId === room.id}
          onHover={handleHover}
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
        />
      ))}

      {/* ── Doors — wall-aligned via getOpeningTransform ── */}
      {doors.map((door) => (
        <DoorMesh
          key={door.id}
          door={door}
          wallHeight={defaultWallHeight}
          walls={renderWalls}
        />
      ))}

      {/* ── Windows — wall-aligned via getOpeningTransform ── */}
      {windows.map((win) => (
        <WindowMesh
          key={win.id}
          win={win}
          wallHeight={defaultWallHeight}
          walls={renderWalls}
        />
      ))}

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
          enablePan
          enableZoom
          enableRotate
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
  scale,
  walls = [],
  doors = [],
  windows = [],
  onBack,
}: RightPanelProps) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [walkMode, setWalkMode] = useState(false);
  const [viewPreset, setViewPreset] = useState<ViewPreset>("perspective");
  const hoveredRoom = rooms.find((r) => r.id === hoveredId) ?? null;

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
          >
            <Scene
              rooms={rooms}
              scale={scale}
              walls={walls}
              doors={doors}
              windows={windows}
              walkMode={walkMode}
              viewPreset={viewPreset}
              cameraDistance={camDist}
              onHoverChange={setHoveredId}
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

          <div className="absolute top-16 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-border bg-card/90 p-1.5 shadow-lg backdrop-blur-md">
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

          <div className="absolute top-4 right-4 flex items-center gap-3 bg-card/90 border border-border backdrop-blur-md rounded-xl px-3 py-2 z-10 shadow-lg">
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

          {hoveredRoom && <RoomInfoCard room={hoveredRoom} />}
        </>
      )}
    </div>
  );
};

export default RightPanel;