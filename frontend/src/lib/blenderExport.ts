import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { BBox, NormalizedPoint, Room } from "@/types/floorplan";
import type { DetectedDoor, DetectedWallSegment, DetectedWindow } from "@/types/detection";
import { findScgDoor, findScgPaint, findScgTile, findScgWindow } from "@/types/materialCatalog";
import { createWallTexture } from "@/lib/wallTextures";
import { createStoneBlockSpecs, createStoneMaterial } from "@/lib/stoneWallPanels";

const PLAN_SIZE = 20;

interface ExportFloorPlanGlbOptions {
  rooms: Room[];
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  planWidth?: number;
  planHeight?: number;
  wallHeight?: number;
  filename?: string;
}

interface GapInterval {
  tStart: number;
  tEnd: number;
  yStart: number;
  height: number;
}

interface SolidSegment {
  tStart: number;
  tEnd: number;
  yStart: number;
  yEnd: number;
}

interface OpeningTransform {
  center: [number, number];
  angle: number;
  localX: number;
  projectedWidth: number;
}

interface WallEndpointConnection {
  id: string;
  connectsStart: boolean;
  connectsEnd: boolean;
}

interface CornerJoint {
  key: string;
  x: number;
  z: number;
  height: number;
  sizeX: number;
  sizeZ: number;
  wallIds: string[];
}

const safeNum = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const toPlanPoint = (point: NormalizedPoint, pw = PLAN_SIZE, ph = PLAN_SIZE): [number, number] => [
  point.x * pw - pw / 2,
  -(point.y * ph - ph / 2),
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

const getWallThicknessM = (wall: DetectedWallSegment, pw = PLAN_SIZE): number => {
  if (typeof wall.thickness === "number" && wall.thickness > 0) return wall.thickness;
  if (typeof wall.thicknessRatio === "number" && wall.thicknessRatio > 0) {
    return wall.thicknessRatio * pw;
  }
  return wall.type === "exterior" ? 0.3 : 0.18;
};

const getWallLengthM = (wall: DetectedWallSegment, pw = PLAN_SIZE, ph = PLAN_SIZE): number =>
  Math.sqrt(((wall.x2 - wall.x1) * pw) ** 2 + ((wall.y2 - wall.y1) * ph) ** 2);

const getWidthM = (bboxW?: number, real?: number, pw = PLAN_SIZE): number => {
  if (typeof real === "number" && real > 0) return real;
  if (typeof bboxW === "number" && bboxW > 0) return bboxW * pw;
  return 0;
};

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
): void => {
  if (walls.length === 0) return;
  walls.sort((a, b) => a[axisKey] - b[axisKey]);
  let cluster = [walls[0]];

  const flush = () => {
    const snapped = cluster.reduce((sum, wall) => sum + wall[axisKey], 0) / cluster.length;
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
  threshold = 0.012,
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
      const withinHorizontal = x >= horizontal.x1 - threshold && x <= horizontal.x2 + threshold;
      const withinVertical = y >= vertical.y1 - threshold && y <= vertical.y2 + threshold;
      if (!withinHorizontal || !withinVertical) continue;

      if (Math.abs(horizontal.x1 - x) <= threshold) horizontal.x1 = x;
      if (Math.abs(horizontal.x2 - x) <= threshold) horizontal.x2 = x;
      if (Math.abs(vertical.y1 - y) <= threshold) vertical.y1 = y;
      if (Math.abs(vertical.y2 - y) <= threshold) vertical.y2 = y;
    }
  }

  return normalized.map(normalizeRenderWall);
};

const mergeCollinearWalls = (
  walls: DetectedWallSegment[],
  threshold = 0.012,
): DetectedWallSegment[] => {
  const normalized = walls.map(normalizeRenderWall);
  const result: DetectedWallSegment[] = [];
  const horizontals = normalized.filter(isHorizontalSegment);
  const verticals = normalized.filter((wall) => !isHorizontalSegment(wall));

  const mergeGroup = (
    group: DetectedWallSegment[],
    axis: "h" | "v",
  ) => {
    const fixedKey = axis === "h" ? "y1" : "x1";
    const startKey = axis === "h" ? "x1" : "y1";
    const endKey = axis === "h" ? "x2" : "y2";
    const sorted = [...group].sort((a, b) =>
      Math.abs(a[fixedKey] - b[fixedKey]) > threshold
        ? a[fixedKey] - b[fixedKey]
        : a[startKey] - b[startKey],
    );

    let current: DetectedWallSegment | null = null;
    for (const wall of sorted) {
      if (!current) {
        current = { ...wall };
        continue;
      }

      const sameAxis = Math.abs(current[fixedKey] - wall[fixedKey]) <= threshold;
      const overlaps = wall[startKey] <= current[endKey] + threshold;
      if (sameAxis && overlaps) {
        const currentLength = Math.max(0, current[endKey] - current[startKey]);
        const wallLength = Math.max(0, wall[endKey] - wall[startKey]);
        const keepBase = currentLength >= wallLength ? current : wall;
        current[startKey] = Math.min(current[startKey], wall[startKey]);
        current[endKey] = Math.max(current[endKey], wall[endKey]);
        current.type = current.type === "exterior" || wall.type === "exterior" ? "exterior" : "interior";
        current.thickness = Math.max(safeNum(current.thickness, 0), safeNum(wall.thickness, 0)) || current.thickness || wall.thickness;
        current.wallHeight = Math.max(safeNum(current.wallHeight, 0), safeNum(wall.wallHeight, 0)) || current.wallHeight || wall.wallHeight;
        current.wallColor = keepBase.wallColor ?? current.wallColor ?? wall.wallColor;
        current.scgPaintCode = keepBase.scgPaintCode ?? current.scgPaintCode ?? wall.scgPaintCode;
        current.wallFinish = keepBase.wallFinish ?? current.wallFinish ?? wall.wallFinish;
        current.wallTexture = keepBase.wallTexture ?? current.wallTexture ?? wall.wallTexture;
        continue;
      }

      result.push(normalizeRenderWall(current));
      current = { ...wall };
    }

    if (current) result.push(normalizeRenderWall(current));
  };

  mergeGroup(horizontals, "h");
  mergeGroup(verticals, "v");
  return result;
};

const removeShortWallArtifacts = (
  walls: DetectedWallSegment[],
  pw = PLAN_SIZE,
  ph = PLAN_SIZE,
): DetectedWallSegment[] => {
  const MIN_EXPORT_WALL_LENGTH_M = 0.22;
  return walls.filter((wall) => getWallLengthM(wall, pw, ph) >= MIN_EXPORT_WALL_LENGTH_M);
};

const removeContainedWallDuplicates = (
  walls: DetectedWallSegment[],
  threshold = 0.018,
): DetectedWallSegment[] => {
  const sorted = [...walls].sort((a, b) => {
    const lenA = Math.abs(a.x2 - a.x1) + Math.abs(a.y2 - a.y1);
    const lenB = Math.abs(b.x2 - b.x1) + Math.abs(b.y2 - b.y1);
    return lenB - lenA;
  });
  const kept: DetectedWallSegment[] = [];

  for (const wall of sorted) {
    const horizontal = isHorizontalSegment(wall);
    const contained = kept.some((other) => {
      if (isHorizontalSegment(other) !== horizontal) return false;
      if (horizontal) {
        const sameAxis = Math.abs(wall.y1 - other.y1) <= threshold;
        const inside =
          wall.x1 >= other.x1 - threshold &&
          wall.x2 <= other.x2 + threshold;
        return sameAxis && inside;
      }
      const sameAxis = Math.abs(wall.x1 - other.x1) <= threshold;
      const inside =
        wall.y1 >= other.y1 - threshold &&
        wall.y2 <= other.y2 + threshold;
      return sameAxis && inside;
    });

    if (!contained) kept.push(wall);
  }

  return kept;
};

const cleanupOverlappingWalls = (
  walls: DetectedWallSegment[],
  pw: number,
  ph: number,
): DetectedWallSegment[] => {
  let cleaned = snapRenderedWallJunctions(walls);
  for (let i = 0; i < 3; i += 1) {
    const before = cleaned.length;
    cleaned = removeContainedWallDuplicates(mergeCollinearWalls(cleaned));
    cleaned = removeShortWallArtifacts(cleaned, pw, ph);
    if (cleaned.length === before) break;
  }
  return cleaned;
};

const pointToSegmentDistance = (
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.sqrt((px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2);
};

const getWallEndpointConnections = (
  walls: DetectedWallSegment[],
  threshold = 0.02,
): WallEndpointConnection[] =>
  walls.map((wall) => ({
    id: wall.id,
    connectsStart: walls.some(
      (other) =>
        other.id !== wall.id &&
        pointToSegmentDistance(wall.x1, wall.y1, other.x1, other.y1, other.x2, other.y2) < threshold,
    ),
    connectsEnd: walls.some(
      (other) =>
        other.id !== wall.id &&
        pointToSegmentDistance(wall.x2, wall.y2, other.x1, other.y1, other.x2, other.y2) < threshold,
    ),
  }));

const collectCornerJoints = (
  walls: DetectedWallSegment[],
  defaultWallHeight: number,
  pw: number,
  ph: number,
): CornerJoint[] => {
  const threshold = 0.02;
  const joints = new Map<string, CornerJoint>();

  const addJoint = (xNorm: number, yNorm: number, wall: DetectedWallSegment, other: DetectedWallSegment) => {
    const x = xNorm * pw - pw / 2;
    const z = yNorm * ph - ph / 2;
    const key = `${Math.round(xNorm / threshold)}:${Math.round(yNorm / threshold)}`;
    const wallThickness = getWallThicknessM(wall, pw);
    const otherThickness = getWallThicknessM(other, pw);
    const next: CornerJoint = joints.get(key) ?? {
      key,
      x,
      z,
      height: 0,
      sizeX: 0,
      sizeZ: 0,
      wallIds: [],
    };

    next.height = Math.max(
      next.height,
      safeNum(wall.wallHeight, defaultWallHeight),
      safeNum(other.wallHeight, defaultWallHeight),
    );
    next.sizeX = Math.max(next.sizeX, wallThickness, otherThickness);
    next.sizeZ = Math.max(next.sizeZ, wallThickness, otherThickness);
    for (const id of [wall.id, other.id]) {
      if (!next.wallIds.includes(id)) next.wallIds.push(id);
    }
    joints.set(key, next);
  };

  for (const wall of walls) {
    const endpoints = [
      { x: wall.x1, y: wall.y1 },
      { x: wall.x2, y: wall.y2 },
    ];

    for (const endpoint of endpoints) {
      for (const other of walls) {
        if (other.id === wall.id) continue;
        const otherEndpointConnects = (
          Math.sqrt((endpoint.x - other.x1) ** 2 + (endpoint.y - other.y1) ** 2) < threshold ||
          Math.sqrt((endpoint.x - other.x2) ** 2 + (endpoint.y - other.y2) ** 2) < threshold
        );
        if (!otherEndpointConnects) continue;
        if (pointToSegmentDistance(endpoint.x, endpoint.y, other.x1, other.y1, other.x2, other.y2) >= threshold) {
          continue;
        }
        addJoint(endpoint.x, endpoint.y, wall, other);
      }
    }
  }

  return [...joints.values()].filter((joint) => joint.wallIds.length >= 2);
};

const projectOpeningEdgesOntoWall = (
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
  const corners = [
    [bbox.x * pw, bbox.y * ph],
    [(bbox.x + bbox.w) * pw, bbox.y * ph],
    [(bbox.x + bbox.w) * pw, (bbox.y + bbox.h) * ph],
    [bbox.x * pw, (bbox.y + bbox.h) * ph],
  ];
  let minT = Infinity;
  let maxT = -Infinity;

  for (const [px, pz] of corners) {
    const t = (px - wx1) * ux + (pz - wz1) * uz;
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
  }

  const thickness = getWallThicknessM(wall, pw);
  const tolerance = Math.max(thickness, 0.2);
  const cx = (bbox.x + bbox.w / 2) * pw;
  const cz = (bbox.y + bbox.h / 2) * ph;
  const perp = Math.abs((cx - wx1) * (-uz) + (cz - wz1) * ux);
  if (perp > tolerance) return null;
  if (maxT < 0 || minT > wallLengthM) return null;

  return { tStart: Math.max(0, minT), tEnd: Math.min(wallLengthM, maxT) };
};

const computeGapIntervals = (
  wall: DetectedWallSegment,
  wallLengthM: number,
  wallHeightM: number,
  doors: DetectedDoor[],
  windows: DetectedWindow[],
  pw = PLAN_SIZE,
  ph = PLAN_SIZE,
): GapInterval[] => {
  const raw: GapInterval[] = [];

  for (const door of doors) {
    if (!door.bbox) continue;
    const proj = projectOpeningEdgesOntoWall(door.bbox, wall, wallLengthM, pw, ph);
    if (!proj) continue;
    raw.push({ ...proj, yStart: 0, height: Math.min(wallHeightM * 0.9, 2.2) });
  }

  for (const win of windows) {
    if (!win.bbox) continue;
    const proj = projectOpeningEdgesOntoWall(win.bbox, wall, wallLengthM, pw, ph);
    if (!proj) continue;
    raw.push({ ...proj, yStart: wallHeightM * 0.35, height: Math.min(wallHeightM * 0.45, 1.2) });
  }

  if (raw.length === 0) return [];
  raw.sort((a, b) => a.tStart - b.tStart);

  const merged: GapInterval[] = [{ ...raw[0] }];
  for (const cur of raw.slice(1)) {
    const prev = merged[merged.length - 1];
    if (cur.tStart <= prev.tEnd + 0.05) {
      const newYStart = Math.min(prev.yStart, cur.yStart);
      const top = Math.max(prev.yStart + prev.height, cur.yStart + cur.height);
      prev.tEnd = Math.max(prev.tEnd, cur.tEnd);
      prev.yStart = newYStart;
      prev.height = top - newYStart;
    } else {
      merged.push({ ...cur });
    }
  }

  return merged;
};

const computeSolidSegments = (wallLengthM: number, wallHeightM: number, gaps: GapInterval[]): SolidSegment[] => {
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

const findBestWall = (
  bbox: BBox,
  walls: DetectedWallSegment[],
  pw = PLAN_SIZE,
  ph = PLAN_SIZE,
): DetectedWallSegment | null => {
  let best: DetectedWallSegment | null = null;
  let bestPerp = Infinity;

  for (const wall of walls) {
    const wx1 = wall.x1 * pw;
    const wz1 = wall.y1 * ph;
    const wx2 = wall.x2 * pw;
    const wz2 = wall.y2 * ph;
    const dx = wx2 - wx1;
    const dz = wz2 - wz1;
    const wallLen = Math.sqrt(dx * dx + dz * dz);
    if (wallLen < 0.001) continue;

    const ux = dx / wallLen;
    const uz = dz / wallLen;
    const cx = (bbox.x + bbox.w / 2) * pw;
    const cz = (bbox.y + bbox.h / 2) * ph;
    const vx = cx - wx1;
    const vz = cz - wz1;
    const t = vx * ux + vz * uz;
    const perp = Math.abs(vx * (-uz) + vz * ux);
    const tolerance = Math.max(getWallThicknessM(wall, pw), 0.2);

    if (perp > tolerance || t < 0 || t > wallLen) continue;
    if (perp < bestPerp) {
      bestPerp = perp;
      best = wall;
    }
  }

  return best;
};

const getOpeningTransform = (
  bbox: BBox,
  wall: DetectedWallSegment,
  pw = PLAN_SIZE,
  ph = PLAN_SIZE,
): OpeningTransform | null => {
  const x1 = wall.x1 * pw - pw / 2;
  const z1 = wall.y1 * ph - ph / 2;
  const x2 = wall.x2 * pw - pw / 2;
  const z2 = wall.y2 * ph - ph / 2;
  const wallLengthM = getWallLengthM(wall, pw, ph);
  if (wallLengthM < 0.001) return null;

  const proj = projectOpeningEdgesOntoWall(bbox, wall, wallLengthM, pw, ph);
  if (!proj) return null;

  return {
    center: [(x1 + x2) / 2, (z1 + z2) / 2],
    angle: Math.atan2(z2 - z1, x2 - x1),
    localX: (proj.tStart + proj.tEnd) / 2 - wallLengthM / 2,
    projectedWidth: proj.tEnd - proj.tStart,
  };
};

const addBox = (
  parent: THREE.Object3D,
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
};

const addFloorMeshes = (scene: THREE.Scene, rooms: Room[], pw: number, ph: number): void => {
  const floors = new THREE.Group();
  floors.name = "Floors";
  scene.add(floors);

  rooms.forEach((room, index) => {
    const polygon = getRoomPolygon(room);
    if (!polygon || polygon.length < 3) return;

    const points = polygon.map((p) => toPlanPoint(p, pw, ph));
    const shape = new THREE.Shape();
    shape.moveTo(points[0][0], points[0][1]);
    for (const point of points.slice(1)) shape.lineTo(point[0], point[1]);
    shape.closePath();

    const tile = findScgTile(room.tileCode);
    const material = new THREE.MeshStandardMaterial({
      color: room.floorColor ?? tile.baseHex,
      roughness: 0.85,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
    mesh.name = room.name || `Room ${index + 1}`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.userData = {
      kind: "room",
      id: room.id,
      tileCode: room.tileCode,
      tileName: room.tileName,
    };
    floors.add(mesh);
  });
};

const addWallMeshes = (
  scene: THREE.Scene,
  walls: DetectedWallSegment[],
  doors: DetectedDoor[],
  windows: DetectedWindow[],
  defaultWallHeight: number,
  pw: number,
  ph: number,
  endpointConnections: WallEndpointConnection[],
): void => {
  const group = new THREE.Group();
  group.name = "Walls";
  scene.add(group);

  walls.forEach((wall, index) => {
    const wallLengthM = getWallLengthM(wall, pw, ph);
    if (wallLengthM < 0.001) return;

    const x1 = wall.x1 * pw - pw / 2;
    const z1 = wall.y1 * ph - ph / 2;
    const x2 = wall.x2 * pw - pw / 2;
    const z2 = wall.y2 * ph - ph / 2;
    const angle = Math.atan2(z2 - z1, x2 - x1);
    const wallHeight = safeNum(wall.wallHeight, defaultWallHeight);
    const thickness = getWallThicknessM(wall, pw);
    const endpointConnection = endpointConnections.find((item) => item.id === wall.id);
    const trim = thickness / 2;
    const paint = findScgPaint(wall.scgPaintCode);
    const wallColor = wall.wallColor ?? paint.hex;
    const wallTexture = createWallTexture(wall.wallTexture, wallColor);
    const material = new THREE.MeshStandardMaterial({
      color: wallColor,
      map: wallTexture ?? undefined,
      roughness: 0.72,
      metalness: 0.03,
    });

    const wallGroup = new THREE.Group();
    wallGroup.name = wall.id || `Wall ${index + 1}`;
    wallGroup.position.set((x1 + x2) / 2, 0, (z1 + z2) / 2);
    wallGroup.rotation.y = -angle;
    wallGroup.userData = {
      kind: "wall",
      id: wall.id,
      type: wall.type,
      scgPaintCode: wall.scgPaintCode,
      wallFinish: wall.wallFinish,
      wallTexture: wall.wallTexture,
    };
    group.add(wallGroup);

    const gaps = computeGapIntervals(wall, wallLengthM, wallHeight, doors, windows, pw, ph);
    const solids = computeSolidSegments(wallLengthM, wallHeight, gaps);
    solids.forEach((seg, segIndex) => {
      const tStart = seg.tStart < 0.001 && endpointConnection?.connectsStart
        ? Math.min(seg.tEnd, seg.tStart + trim)
        : seg.tStart;
      const tEnd = seg.tEnd > wallLengthM - 0.001 && endpointConnection?.connectsEnd
        ? Math.max(tStart, seg.tEnd - trim)
        : seg.tEnd;
      const segLen = tEnd - tStart;
      const segH = seg.yEnd - seg.yStart;
      if (segLen < 0.001 || segH < 0.001) return;
      addBox(
        wallGroup,
        `${wallGroup.name} Segment ${segIndex + 1}`,
        [segLen, segH, thickness],
        [tStart + segLen / 2 - wallLengthM / 2, seg.yStart + segH / 2, 0],
        material,
      );
      if (wall.wallTexture === "stone-block-panel") {
        const segmentCenterX = tStart + segLen / 2 - wallLengthM / 2;
        for (const [faceName, faceSign] of [["Front", 1], ["Back", -1]] as const) {
          for (const [blockIndex, block] of createStoneBlockSpecs(segLen, segH).entries()) {
            addBox(
              wallGroup,
              `${wallGroup.name} ${faceName} Stone ${segIndex + 1}-${blockIndex + 1}`,
              [block.w, block.h, block.depth],
              [
                segmentCenterX + block.x,
                seg.yStart + block.y,
                faceSign * (thickness / 2 + block.depth / 2 + 0.002),
              ],
              createStoneMaterial(block.color),
            );
          }
        }
      }
    });
  });
};

const addCornerJointMeshes = (
  scene: THREE.Scene,
  joints: CornerJoint[],
): void => {
  if (joints.length === 0) return;

  const group = new THREE.Group();
  group.name = "Wall Corner Joints";
  scene.add(group);

  const material = new THREE.MeshStandardMaterial({
    color: "#8a8c84",
    roughness: 0.72,
    metalness: 0.03,
  });

  joints.forEach((joint, index) => {
    const mesh = addBox(
      group,
      `Corner Joint ${index + 1}`,
      [Math.max(joint.sizeX, 0.08), Math.max(joint.height, 0.1), Math.max(joint.sizeZ, 0.08)],
      [joint.x, joint.height / 2, joint.z],
      material,
    );
    mesh.userData = {
      kind: "wall-corner-joint",
      wallIds: joint.wallIds,
    };
  });
};

const addDoorMeshes = (
  scene: THREE.Scene,
  doors: DetectedDoor[],
  walls: DetectedWallSegment[],
  defaultWallHeight: number,
  pw: number,
  ph: number,
): void => {
  const group = new THREE.Group();
  group.name = "Doors";
  scene.add(group);

  doors.forEach((door, index) => {
    if (!door.bbox) return;
    const wall = findBestWall(door.bbox, walls, pw, ph);
    if (!wall) return;
    const transform = getOpeningTransform(door.bbox, wall, pw, ph);
    if (!transform) return;

    const wallHeight = safeNum(wall.wallHeight, defaultWallHeight);
    const option = findScgDoor(door.scgDoorCode);
    const doorW = transform.projectedWidth > 0.05 ? transform.projectedWidth : Math.max(getWidthM(door.bbox.w, door.widthM, pw), 0.8);
    const doorH = Math.min(wallHeight * 0.9, 2.2);
    const wallThickness = getWallThicknessM(wall, pw);
    const frameDepth = wallThickness + 0.08;
    const slabDepth = Math.min(wallThickness + 0.03, 0.24);
    const frameMaterial = new THREE.MeshStandardMaterial({ color: door.frameColor ?? option.frameHex, roughness: 0.52, metalness: 0.04 });
    const doorMaterial = new THREE.MeshStandardMaterial({ color: door.doorColor ?? option.doorHex, roughness: 0.55, metalness: 0.02 });
    const knobMaterial = new THREE.MeshStandardMaterial({ color: "#5b260c", roughness: 0.28, metalness: 0.42 });

    const doorGroup = new THREE.Group();
    doorGroup.name = door.id || `Door ${index + 1}`;
    doorGroup.position.set(transform.center[0], 0, transform.center[1]);
    doorGroup.rotation.y = -transform.angle;
    doorGroup.userData = {
      kind: "door",
      id: door.id,
      scgDoorCode: door.scgDoorCode,
      doorName: door.doorName,
      doorMaterial: door.doorMaterial,
    };
    group.add(doorGroup);

    const local = new THREE.Group();
    local.position.x = transform.localX;
    doorGroup.add(local);

    addBox(local, "Left Frame", [0.08, doorH + 0.08, frameDepth], [-doorW / 2 - 0.04, doorH / 2, 0], frameMaterial);
    addBox(local, "Right Frame", [0.08, doorH + 0.08, frameDepth], [doorW / 2 + 0.04, doorH / 2, 0], frameMaterial);
    addBox(local, "Top Frame", [doorW + 0.16, 0.08, frameDepth], [0, doorH + 0.04, 0], frameMaterial);
    addBox(local, "Threshold", [doorW + 0.18, 0.07, frameDepth + 0.04], [0, 0.035, 0], frameMaterial);
    addBox(local, "Door Slab", [doorW, doorH, slabDepth], [0, doorH / 2, 0], doorMaterial);

    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.038, 16, 16), knobMaterial);
    knob.name = "Door Knob";
    knob.position.set(doorW * 0.36, doorH * 0.5, slabDepth / 2 + 0.026);
    local.add(knob);
  });
};

const addWindowMeshes = (
  scene: THREE.Scene,
  windows: DetectedWindow[],
  walls: DetectedWallSegment[],
  defaultWallHeight: number,
  pw: number,
  ph: number,
): void => {
  const group = new THREE.Group();
  group.name = "Windows";
  scene.add(group);

  windows.forEach((win, index) => {
    if (!win.bbox) return;
    const wall = findBestWall(win.bbox, walls, pw, ph);
    if (!wall) return;
    const transform = getOpeningTransform(win.bbox, wall, pw, ph);
    if (!transform) return;

    const wallHeight = safeNum(wall.wallHeight, defaultWallHeight);
    const option = findScgWindow(win.scgWindowCode);
    const winW = transform.projectedWidth > 0.05 ? transform.projectedWidth : Math.max(getWidthM(win.bbox.w, win.widthM, pw), 0.6);
    const winH = Math.min(wallHeight * 0.45, 1.2);
    const sillY = wallHeight * 0.35;
    const winD = 0.08;
    const frameMaterial = new THREE.MeshStandardMaterial({ color: win.frameColor ?? option.frameHex, roughness: 0.45, metalness: 0.08 });
    const glassMaterial = new THREE.MeshStandardMaterial({
      color: win.glassColor ?? option.glassHex,
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });

    const winGroup = new THREE.Group();
    winGroup.name = win.id || `Window ${index + 1}`;
    winGroup.position.set(transform.center[0], 0, transform.center[1]);
    winGroup.rotation.y = -transform.angle;
    winGroup.userData = {
      kind: "window",
      id: win.id,
      scgWindowCode: win.scgWindowCode,
      windowName: win.windowName,
      windowMaterial: win.windowMaterial,
    };
    group.add(winGroup);

    const local = new THREE.Group();
    local.position.set(transform.localX, sillY, 0);
    winGroup.add(local);

    addBox(local, "Left Frame", [0.05, winH, winD], [-winW / 2, winH / 2, 0], frameMaterial);
    addBox(local, "Right Frame", [0.05, winH, winD], [winW / 2, winH / 2, 0], frameMaterial);
    addBox(local, "Top Frame", [winW, 0.05, winD], [0, winH, 0], frameMaterial);
    addBox(local, "Bottom Frame", [winW, 0.05, winD], [0, 0, 0], frameMaterial);

    const glass = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(0.05, winW - 0.1), Math.max(0.05, winH - 0.1)), glassMaterial);
    glass.name = "Glass";
    glass.position.set(0, winH / 2, 0);
    local.add(glass);
  });
};

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const exportSceneToGlb = (scene: THREE.Scene): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
          return;
        }
        const json = JSON.stringify(result);
        resolve(new TextEncoder().encode(json).buffer);
      },
      (error) => reject(error),
      { binary: true },
    );
  });

export const exportFloorPlanGlb = async ({
  rooms,
  walls,
  doors,
  windows,
  planWidth = 0,
  planHeight = 0,
  wallHeight = 2.8,
  filename = "floorplan-blender.glb",
}: ExportFloorPlanGlbOptions): Promise<void> => {
  const pw = planWidth > 0 ? planWidth : PLAN_SIZE;
  const ph = planHeight > 0 ? planHeight : PLAN_SIZE;
  const defaultWallHeight =
    rooms.length > 0
      ? Math.max(...rooms.map((room) => safeNum(room.wallHeight, wallHeight)))
      : wallHeight;

  const scene = new THREE.Scene();
  scene.name = "Floor Plan 3D";
  scene.userData = {
    app: "remix-of-plan-weaver",
    exportType: "blender-glb",
    planWidth: pw,
    planHeight: ph,
  };

  const exportWalls = cleanupOverlappingWalls(walls, pw, ph);
  const endpointConnections = getWallEndpointConnections(exportWalls);
  const cornerJoints = collectCornerJoints(exportWalls, defaultWallHeight, pw, ph);

  addFloorMeshes(scene, rooms, pw, ph);
  addWallMeshes(scene, exportWalls, doors, windows, defaultWallHeight, pw, ph, endpointConnections);
  addCornerJointMeshes(scene, cornerJoints);
  addDoorMeshes(scene, doors, exportWalls, defaultWallHeight, pw, ph);
  addWindowMeshes(scene, windows, exportWalls, defaultWallHeight, pw, ph);

  const ambient = new THREE.AmbientLight("#ffffff", 1.2);
  ambient.name = "Export Ambient Light";
  scene.add(ambient);

  const result = await exportSceneToGlb(scene);
  downloadBlob(new Blob([result], { type: "model/gltf-binary" }), filename);
};
