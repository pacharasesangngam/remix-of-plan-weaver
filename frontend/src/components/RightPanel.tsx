import { useProjectActions } from "@/components/ProjectActionContext";
import { Component, Suspense, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Grid, PointerLockControls, Text, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { AppWindow, Box, ChevronDown, ChevronLeft, DoorOpen, Download, Image as ImageIcon, Info, Maximize2, MousePointer2, Move3D, Palette, Pencil, Plus, RotateCcw, Trash2, X, ZoomIn, ZoomOut } from "lucide-react";
import type { BBox, NormalizedPoint, Room } from "@/types/floorplan";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import { buildWallSolidGeometries } from "@/lib/wallSolidGeometry";
import { computeGapIntervals, computeSolidSegments, projectOpeningEdgesOntoWall, defaultRenderWallHeight, wallSolidInputs } from "@/lib/wallRenderGeometry";
import WallMeshHighlight from "./WallMeshHighlight";
import MaterialSwatches from "./MaterialSwatches";
import { targetPreviewShowsOutline } from "./wallHighlightState";
import { exportFloorPlanGlb } from "@/lib/blenderExport";
import {
  SCG_DOOR_CATALOG,
  SCG_PAINT_CATALOG,
  SCG_TILE_CATALOG,
  SCG_WINDOW_CATALOG,
  WALL_TEXTURE_CATALOG,
  findScgDoor,
  findScgPaint,
  findScgTile,
  findScgWindow,
  type ScgTileOption,
} from "@/types/materialCatalog";
import { createWallTexture } from "@/lib/wallTextures";
import { createStoneBlockSpecs } from "@/lib/stoneWallPanels";
import { DEFAULT_WALL_THICKNESS_M, getWallThicknessM, resolvePlanDimensions } from "@/lib/wallMetrics";
import { createOpeningBboxFromWallPoints } from "@/lib/openingPlacement";
import { advanceOpeningDraft, cancelOpeningDraft, isValidOpeningTarget, openingPreviewIsOnWall, type OpeningDraftState } from "@/lib/openingInteraction";
import { capturesThreeTargetPointer, nextThreeSelection, nextThreeToolAfterCreation, type ThreeToolMode } from "@/lib/threeInteraction";
import { resolveOpeningWall } from "@/lib/openingAttachment";

import { getMeasuredRoomArea, hasCalibration, type CalibrationStatus } from "@/lib/wallMetrics";

interface RightPanelProps {
  calibrationStatus?: CalibrationStatus;
  scale?: number;
  rooms: Room[];
  generated: boolean;
  walls?: DetectedWallSegment[];
  doors?: DetectedDoor[];
  windows?: DetectedWindow[];
  planWidth?: number;
  planHeight?: number;
  originalPlanUrl?: string | null;
  originalPlanName?: string | null;
  originalPlanIsPdf?: boolean;
  onRoomUpdate?: (id: string, field: keyof Room, value: number | string) => void;
  onRoomPatch?: (id: string, patch: Partial<Room>) => void;
  onRoomDelete?: (id: string) => void;
  onWallUpdate?: (id: string, field: keyof DetectedWallSegment, value: number | string) => void;
  onWallAdd?: (wall: DetectedWallSegment) => void;
  onWallDelete?: (id: string) => void;
  onDoorAdd?: (door: DetectedDoor) => void;
  onDoorUpdate?: (id: string, field: keyof DetectedDoor, value: DetectedDoor[keyof DetectedDoor]) => void;
  onDoorDelete?: (id: string) => void;
  onWindowAdd?: (win: DetectedWindow) => void;
  onWindowUpdate?: (id: string, field: keyof DetectedWindow, value: DetectedWindow[keyof DetectedWindow]) => void;
  onWindowDelete?: (id: string) => void;
  onBack?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

type ViewPreset = "perspective" | "top" | "front" | "side";
type BuildMode = ThreeToolMode;
type Selection =
  | { type: "room"; id: string }
  | { type: "wall"; id: string; point?: NormalizedPoint }
  | { type: "door"; id: string }
  | { type: "window"; id: string }
  | null;
type PlacementPreview = { wallId: string; point: NormalizedPoint } | null;
type WallDraft = { start: NormalizedPoint; end: NormalizedPoint } | null;
type OpeningDraft = OpeningDraftState | null;
type WallGizmoPointerEvent = ThreeEvent<PointerEvent>;
type R3FPointerCaptureTarget = {
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
};

const supportsR3FPointerCapture = (target: EventTarget): target is EventTarget & R3FPointerCaptureTarget =>
  typeof Reflect.get(target, "setPointerCapture") === "function"
  && typeof Reflect.get(target, "releasePointerCapture") === "function";

const ROOM_PALETTE = [
  { wall: "#e8d5b7", floor: "#d4b896" },
  { wall: "#dce8d5", floor: "#b8d4ae" },
  { wall: "#d5dce8", floor: "#aebcd4" },
  { wall: "#e8d5e0", floor: "#d4aec0" },
  { wall: "#e8e5d5", floor: "#d4ceae" },
];
const FLOOR_HOVER_COLOR = "#f5e6c8";
const PLAN_SIZE = 20;

const createTileTexture = (tile: ScgTileOption): THREE.CanvasTexture => {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.CanvasTexture(canvas);

  ctx.fillStyle = tile.baseHex;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (tile.pattern === "marble") {
    ctx.strokeStyle = tile.accentHex;
    ctx.globalAlpha = 0.45;
    for (let i = 0; i < 7; i += 1) {
      ctx.beginPath();
      const y = 20 + i * 34;
      ctx.moveTo(-20, y);
      ctx.bezierCurveTo(70, y - 45, 120, y + 55, 276, y - 18);
      ctx.lineWidth = i % 2 === 0 ? 3 : 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  if (tile.pattern === "terrazzo") {
    const chips = [tile.accentHex, "#f3f0e8", "#9b8f83", "#6f777c"];
    for (let i = 0; i < 90; i += 1) {
      const x = (i * 47) % 256;
      const y = (i * 83) % 256;
      ctx.fillStyle = chips[i % chips.length];
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.ellipse(x, y, 2 + (i % 5), 1.5 + (i % 4), (i * 17) % 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  if (tile.pattern === "stone") {
    ctx.fillStyle = tile.accentHex;
    ctx.globalAlpha = 0.18;
    for (let i = 0; i < 14; i += 1) {
      ctx.fillRect((i * 31) % 256, (i * 53) % 256, 90, 18);
    }
    ctx.globalAlpha = 1;
  }

  const grid = tile.sizeCm === "30x30" ? 64 : tile.sizeCm === "60x90" ? 128 : 96;
  ctx.strokeStyle = tile.groutHex;
  ctx.lineWidth = 3;
  for (let x = 0; x <= 256; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  for (let y = 0; y <= 256; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

// Plan scale context — provides real-world metres per normalised unit.
// Falls back to PLAN_SIZE (20 m) when calibration hasn't been applied.
const PlanScaleCtx = createContext({ pw: PLAN_SIZE, ph: PLAN_SIZE, calibrated: false });
const usePlanScale = () => useContext(PlanScaleCtx);

// ── Utilities ─────────────────────────────────────────────────────────────────

const safeNum = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
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

// For 3D floor mesh & bounds: outer boundary so adjacent rooms stay flush.
const getRoomPolygon = (room: Room): NormalizedPoint[] | null => {
  if (room.wallPolygon && room.wallPolygon.length >= 3) return room.wallPolygon;
  if (room.polygon && room.polygon.length >= 3) return room.polygon;
  return bboxToPolygon(room.bbox);
};

// For area calculations: inner polygon (wall thickness subtracted by backend).
const getRoomFloorPolygon = (room: Room): NormalizedPoint[] | null => {
  if (room.polygon && room.polygon.length >= 3) return room.polygon;
  if (room.wallPolygon && room.wallPolygon.length >= 3) return room.wallPolygon;
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

const polygonArea = (polygon?: NormalizedPoint[] | null, pw = PLAN_SIZE, ph = PLAN_SIZE): number => {
  if (!polygon || polygon.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(area) * 0.5 * pw * ph;
};

const parseTileSizeM = (sizeCm: string): { width: number; height: number } | null => {
  const match = sizeCm.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const width = Number(match[1]) / 100;
  const height = Number(match[2]) / 100;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  return { width, height };
};

const estimateTileCount = (areaM2: number, tile: ScgTileOption, wasteRate = 0.1): number | null => {
  const size = parseTileSizeM(tile.sizeCm);
  if (!size) return null;

  const tileArea = size.width * size.height;
  if (tileArea <= 0) return null;

  return Math.ceil((areaM2 / tileArea) * (1 + wasteRate));
};

function OriginalPlanWallOverlay({
  wall,
  imageAspect,
}: {
  wall: DetectedWallSegment | null;
  imageAspect: number | null;
}) {
  const overlayRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = overlayRef.current;
    if (!element) return;
    const updateSize = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!wall || !imageAspect || size.width === 0 || size.height === 0) {
    return <svg ref={overlayRef} className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden="true" />;
  }

  const containerAspect = size.width / size.height;
  const renderedWidth = containerAspect > imageAspect ? size.height * imageAspect : size.width;
  const renderedHeight = containerAspect > imageAspect ? size.height : size.width / imageAspect;
  const offsetX = (size.width - renderedWidth) / 2;
  const offsetY = (size.height - renderedHeight) / 2;
  const x1 = offsetX + wall.x1 * renderedWidth;
  const y1 = offsetY + wall.y1 * renderedHeight;
  const x2 = offsetX + wall.x2 * renderedWidth;
  const y2 = offsetY + wall.y2 * renderedHeight;

  return (
    <svg ref={overlayRef} className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-label="Selected wall on original plan">
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(15, 23, 42, 0.9)" strokeWidth="7" strokeLinecap="round" />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#22d3ee" strokeWidth="3" strokeLinecap="round" />
      <circle cx={x1} cy={y1} r="4" fill="#22d3ee" stroke="#0f172a" strokeWidth="2" />
      <circle cx={x2} cy={y2} r="4" fill="#22d3ee" stroke="#0f172a" strokeWidth="2" />
    </svg>
  );
}

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

/** Room floor shape in plan coordinates; enclosed islands are punched out as holes. */
const getRoomShape = (room: Room, pw: number, ph: number): THREE.Shape | null => {
  const polygon = getRoomPolygon(room);
  if (!polygon || polygon.length < 3) return null;
  const shape = new THREE.Shape();
  [polygon, ...(room.holes ?? []).filter((hole) => hole.length >= 3)].forEach((ring, index) => {
    const points = ring.map((point) => toPlanPoint(point, pw, ph));
    const target = index ? new THREE.Path() : shape;
    target.moveTo(points[0][0], points[0][1]);
    for (const point of points.slice(1)) target.lineTo(point[0], point[1]);
    target.closePath();
    if (target !== shape) shape.holes.push(target);
  });
  return shape;
};

// ── Wall thickness helper ─────────────────────────────────────────────────────

// ── Opening width helper ──────────────────────────────────────────────────────

const getWidthM = (bboxW?: number, real?: number, pw = PLAN_SIZE): number => {
  if (typeof real === "number" && real > 0) return real;
  if (typeof bboxW === "number" && bboxW > 0) return bboxW * pw;
  return 0;
};

const boundsFromPolygon = (polygon: NormalizedPoint[]): BBox => {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

const getWallLengthM = (wall: DetectedWallSegment, pw: number, ph: number): number =>
  Math.sqrt(
    Math.pow((wall.x2 - wall.x1) * pw, 2) +
      Math.pow((wall.y2 - wall.y1) * ph, 2),
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

// ── Opening gap types & projection ───────────────────────────────────────────

class DoorModelBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function BlenderDoorModel({
  modelUrl,
  doorW,
  doorH,
  slabDepth,
}: {
  modelUrl: string;
  doorW: number;
  doorH: number;
  slabDepth: number;
}) {
  const gltf = useGLTF(modelUrl);
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);

  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const scaleX = size.x > 0 ? doorW / size.x : 1;
    const scaleY = size.y > 0 ? doorH / size.y : 1;
    const scaleZ = size.z > 0 ? slabDepth / size.z : 1;
    scene.scale.set(scaleX, scaleY, scaleZ);
    const scaledBox = new THREE.Box3().setFromObject(scene);
    const center = new THREE.Vector3();
    scaledBox.getCenter(center);
    scene.position.set(-center.x, -scaledBox.min.y, -center.z);
  }, [doorH, doorW, scene, slabDepth]);

  return <primitive object={scene} />;
}

function BlenderWindowModel({
  modelUrl,
  winW,
  winH,
  winD,
}: {
  modelUrl: string;
  winW: number;
  winH: number;
  winD: number;
}) {
  const gltf = useGLTF(modelUrl);
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);

  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const scaleX = size.x > 0 ? winW / size.x : 1;
    const scaleY = size.y > 0 ? winH / size.y : 1;
    const scaleZ = size.z > 0 ? winD / size.z : 1;
    scene.scale.set(scaleX, scaleY, scaleZ);
    const scaledBox = new THREE.Box3().setFromObject(scene);
    const center = new THREE.Vector3();
    scaledBox.getCenter(center);
    scene.position.set(-center.x, -scaledBox.min.y, -center.z);
  }, [scene, winD, winH, winW]);

  return <primitive object={scene} />;
}

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
  pw = PLAN_SIZE,
  ph = PLAN_SIZE,
): OpeningTransform | null {
  const x1 = wall.x1 * pw - pw / 2;
  const z1 = wall.y1 * ph - ph / 2;
  const x2 = wall.x2 * pw - pw / 2;
  const z2 = wall.y2 * ph - ph / 2;

  const dx = x2 - x1;
  const dz = z2 - z1;
  const wallLengthM = Math.sqrt(
    Math.pow((wall.x2 - wall.x1) * pw, 2) +
    Math.pow((wall.y2 - wall.y1) * ph, 2),
  );

  if (wallLengthM <= 1e-9) return null;

  const angle = Math.atan2(dz, dx);

  const proj = projectOpeningEdgesOntoWall(bbox, wall, wallLengthM, pw, ph);
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
  pw = PLAN_SIZE,
  ph = PLAN_SIZE,
): DetectedWallSegment | null {
  return resolveOpeningWall(bbox, walls, pw, ph).wall;
  /* Legacy nearest-wall implementation retained below for reference. */
  let best: DetectedWallSegment | null = null;
  let bestPerp = Infinity;

  for (const wall of walls) {
    const wx1 = wall.x1 * pw;
    const wz1 = wall.y1 * ph;
    const wx2 = wall.x2 * pw;
    const wz2 = wall.y2 * ph;

    const ddx = wx2 - wx1;
    const ddz = wz2 - wz1;
    const wallLen = Math.sqrt(ddx * ddx + ddz * ddz);
    if (wallLen < 0.001) continue;

    const ux = ddx / wallLen;
    const uz = ddz / wallLen;

    const cx = (bbox.x + bbox.w / 2) * pw;
    const cz = (bbox.y + bbox.h / 2) * ph;

    const vx = cx - wx1;
    const vz = cz - wz1;

    const t = vx * ux + vz * uz;
    const perp = Math.abs(vx * (-uz) + vz * ux);

    const thickness = getWallThicknessM(wall, pw, ph);
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

function FirstPersonController({ enabled, onExit }: { enabled: boolean; onExit: () => void }) {
  const { camera } = useThree();
  const { pw, ph } = usePlanScale();
  const controlsRef = useRef<React.ComponentRef<typeof PointerLockControls>>(null);
  const keysRef = useRef({
    KeyW: false,
    KeyA: false,
    KeyS: false,
    KeyD: false,
  });

  useLayoutEffect(() => {
    const controls = controlsRef.current;
    if (!enabled) {
      keysRef.current = { KeyW: false, KeyA: false, KeyS: false, KeyD: false };
      if (controls?.isLocked) controls.unlock();
      return;
    }

    camera.position.set(0, 1.7, Math.max(Math.max(pw, ph) * 0.65, 8));
    camera.lookAt(0, 1.7, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code in keysRef.current)
        keysRef.current[event.code as keyof typeof keysRef.current] = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code in keysRef.current)
        keysRef.current[event.code as keyof typeof keysRef.current] = false;
    };
    const onKeyDownExit = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (controls?.isLocked) controls.unlock();
      onExit();
    };
    const onUnlock = () => onExit();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKeyDownExit);
    controls?.addEventListener("unlock", onUnlock);
    // useLayoutEffect keeps this in the same user-activation turn as the button click.
    controls?.lock();
    return () => {
      controls?.removeEventListener("unlock", onUnlock);
      if (controls?.isLocked) controls.unlock();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onKeyDownExit);
    };
  }, [camera, enabled, onExit, ph, pw]);

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
  controlsRef: React.MutableRefObject<React.ComponentRef<typeof OrbitControls> | null>;
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
  onSelect?: (id: string) => void;
  onTargetHover?: (selection: Selection) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const floorMatRef = useRef<THREE.MeshStandardMaterial>(null);

  const pal = ROOM_PALETTE[index % ROOM_PALETTE.length];
  const selectedTile = useMemo(() => findScgTile(room.tileCode), [room.tileCode]);
  const floorColor = room.floorColor ?? selectedTile.baseHex ?? pal.floor;
  const floorTexture = useMemo(() => createTileTexture(selectedTile), [selectedTile]);
  const baseColorRef = useRef(new THREE.Color(floorColor));
  const hoverColorRef = useRef(new THREE.Color(FLOOR_HOVER_COLOR));

  const { pw, ph, calibrated } = usePlanScale();

  const shape = useMemo(() => getRoomShape(room, pw, ph), [room, pw, ph]);

  const labelPoint = useMemo(() => {
    const center = getRoomCenter(room);
    if (!center) return [0, 0] as [number, number];
    return toPlanPoint(center, pw, ph);
  }, [room, pw, ph]);

  const sizeHint = useMemo(() => {
    const bounds = getRoomBounds(room);
    if (!bounds) return { w: 0, d: 0 };
    return {
      w: Math.max(bounds.w * pw, 0.5),
      d: Math.max(bounds.h * ph, 0.5),
    };
  }, [room, pw, ph]);

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

  useEffect(() => () => floorTexture.dispose(), [floorTexture]);

  if (!shape) return null;

  return (
    <group
      ref={groupRef}
      position={[0, 0, 0]}
      {...(onSelect ? {
        onPointerEnter: () => {
          onHover(room.id);
          onTargetHover?.({ type: "room", id: room.id });
        },
        onPointerLeave: () => {
          onHover(null);
          onTargetHover?.(null);
        },
        onClick: (e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect(room.id);
        },
      } : {})}
    >
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial
          ref={floorMatRef}
          color={floorColor}
          map={floorTexture}
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
        {calibrated ? `${sizeHint.w.toFixed(1)}m` : "—"}
      </Text>

      <Text
        position={[labelPoint[0] + sizeHint.w / 2 + 0.3, 0.05, labelPoint[1]]}
        rotation={[-Math.PI / 2, 0, Math.PI / 2]}
        fontSize={0.18}
        color="#6b7280"
        anchorX="center"
        anchorY="middle"
      >
        {calibrated ? `${sizeHint.d.toFixed(1)}m` : "—"}
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
  walls,
  geometry,
  onSelect,
  onPlacementHover,
  onPlacementLeave,
  onTargetHover,
}: {
  wall: DetectedWallSegment;
  wallHeight: number;
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  walls: DetectedWallSegment[];
  geometry: THREE.BufferGeometry;
  onSelect?: (id: string, point?: NormalizedPoint) => void;
  onPlacementHover?: (wallId: string, point: NormalizedPoint) => void;
  onPlacementLeave?: () => void;
  onTargetHover?: (selection: Selection) => void;
}) {
  const { pw, ph } = usePlanScale();
  const resolvedHeight = safeNum(wall.wallHeight, wallHeight);
  const thickness = getWallThicknessM(wall, pw, ph);
  const paint = findScgPaint(wall.scgPaintCode);
  const wallColor = wall.wallColor ?? paint.hex;
  const wallTexture = useMemo(() => createWallTexture(wall.wallTexture, wallColor), [wall.wallTexture, wallColor]);

  useEffect(() => () => wallTexture?.dispose(), [wallTexture]);

  const x1 = wall.x1 * pw - pw / 2;
  const z1 = wall.y1 * ph - ph / 2;
  const x2 = wall.x2 * pw - pw / 2;
  const z2 = wall.y2 * ph - ph / 2;

  const dx = x2 - x1;
  const dz = z2 - z1;
  const wallLengthM = Math.sqrt(
    Math.pow((wall.x2 - wall.x1) * pw, 2) +
    Math.pow((wall.y2 - wall.y1) * ph, 2),
  );

  if (wallLengthM < 0.001) return null;

  const angle = Math.atan2(dz, dx);
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;

  const gaps = computeGapIntervals(wall, wallLengthM, resolvedHeight, doors, windows, walls, pw, ph);
  const solids = computeSolidSegments(wallLengthM, resolvedHeight, gaps);

  const getEventPoint = (point: THREE.Vector3): NormalizedPoint => ({
    x: clamp01((point.x + pw / 2) / pw),
    y: clamp01((point.z + ph / 2) / ph),
  });

  return (
    <group position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
      <mesh geometry={geometry}
        {...((onPlacementHover || onTargetHover || onSelect) ? {
          onPointerMove: (e: ThreeEvent<PointerEvent>) => {
            const point = getEventPoint(e.point);
            onPlacementHover?.(wall.id, point);
            onTargetHover?.({ type: "wall", id: wall.id, point });
            e.stopPropagation();
          },
          onPointerLeave: () => {
            onPlacementLeave?.();
            onTargetHover?.(null);
          },
          onClick: (e: ThreeEvent<MouseEvent>) => {
            if (!onSelect) return;
            e.stopPropagation();
            onSelect(wall.id, getEventPoint(e.point));
          },
        } : {})}
      >
        <meshStandardMaterial
          color={wallColor}
          map={wallTexture ?? undefined}
          roughness={0.72}
          metalness={0.03}
        />
      </mesh>

      {solids.map((seg, i) => {
        const segLen = seg.tEnd - seg.tStart;
        const segH = seg.yEnd - seg.yStart;
        if (segLen < 0.001 || segH < 0.001) return null;

        const localX = seg.tStart + segLen / 2 - wallLengthM / 2;
        const localY = seg.yStart + segH / 2;


        return (
          <group
            key={i}
            position={[localX, localY, 0]}
          >
            {wall.wallTexture === "stone-block-panel" &&
              createStoneBlockSpecs(segLen, segH).map((block, blockIndex) => (
                <mesh
                  key={blockIndex}
                  position={[block.x, block.y - segH / 2, thickness / 2 + block.depth / 2 + 0.002]}
                  raycast={() => null}
                >
                  <boxGeometry args={[block.w, block.h, block.depth]} />
                  <meshStandardMaterial color={block.color} roughness={0.92} metalness={0.01} />
                </mesh>
              ))}
          </group>
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
  onSelect?: (id: string) => void;
  onHover?: (selection: Selection) => void;
}) {
  const { pw, ph, calibrated } = usePlanScale();
  if (!door.bbox) return null;

  const wall = door.wallId
    ? walls.find((item) => item.id === door.wallId)
    : findBestWall(door.bbox, walls, pw, ph);
  if (!wall) return null;

  const transform = getOpeningTransform(door.bbox, wall, pw, ph);
  if (!transform) return null;

  const { center, angle, localX, projectedWidth } = transform;

  const doorW = projectedWidth > 0.05 ? projectedWidth : Math.max(getWidthM(door.bbox.w, door.widthM, pw), 0.8);
  const doorH = Math.min(wallHeight * 0.9, 2.2);
  const wallThickness = getWallThicknessM(wall, pw, ph);
  const frameDepth = wallThickness + 0.08;
  const slabDepth = Math.min(wallThickness + 0.03, 0.24);
  const faceOffsets = [-(slabDepth / 2 + 0.004), slabDepth / 2 + 0.004];
  const slabW = doorW;
  const slabH = doorH;
  const knobX = slabW * 0.36;
  const doorOption = findScgDoor(door.scgDoorCode);
  const doorColor = door.doorColor ?? doorOption.doorHex;
  const panelColor = doorOption.panelHex;
  const frameColor = door.frameColor ?? doorOption.frameHex;
  const isFlatDoor = doorOption.style === "flat";
  const isGrooveDoor = doorOption.style === "groove" || doorOption.style === "modern";

  return (
    <group
      position={[center[0], 0, center[1]]}
      rotation={[0, -angle, 0]}
      {...(onSelect ? {
        onPointerEnter: (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover?.({ type: "door", id: door.id });
        },
        onPointerLeave: (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover?.(null);
        },
        onClick: (e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect(door.id);
        },
      } : {})}
    >
      <group position={[localX, 0, 0]}>
        {door.useBlenderModel === "true" && doorOption.modelUrl ? (
          <DoorModelBoundary fallback={null}>
            <Suspense fallback={null}>
              <BlenderDoorModel
                modelUrl={doorOption.modelUrl}
                doorW={slabW}
                doorH={slabH}
                slabDepth={slabDepth}
              />
            </Suspense>
          </DoorModelBoundary>
        ) : (
          <>
        <mesh position={[-doorW / 2 - 0.04, doorH / 2, 0]}>
          <boxGeometry args={[0.08, doorH + 0.08, frameDepth]} />
          <meshStandardMaterial color={frameColor} roughness={0.52} metalness={0.04} />
        </mesh>
        <mesh position={[doorW / 2 + 0.04, doorH / 2, 0]}>
          <boxGeometry args={[0.08, doorH + 0.08, frameDepth]} />
          <meshStandardMaterial color={frameColor} roughness={0.52} metalness={0.04} />
        </mesh>
        <mesh position={[0, doorH + 0.04, 0]}>
          <boxGeometry args={[doorW + 0.16, 0.08, frameDepth]} />
          <meshStandardMaterial color={frameColor} roughness={0.52} metalness={0.04} />
        </mesh>
        <mesh position={[0, 0.035, 0]}>
          <boxGeometry args={[doorW + 0.18, 0.07, frameDepth + 0.04]} />
          <meshStandardMaterial color={frameColor} roughness={0.58} metalness={0.04} />
        </mesh>
        <mesh position={[0, slabH / 2, 0]} castShadow>
          <boxGeometry args={[slabW, slabH, slabDepth]} />
          <meshStandardMaterial
            color={doorColor}
            roughness={doorOption.material === "UPVC" || doorOption.material === "PVC" ? 0.68 : 0.5}
            metalness={0.02}
          />
        </mesh>
        {!isFlatDoor && faceOffsets.map((offset) => (
          <group key={offset} position={[0, 0, offset]}>
            <mesh position={[0, slabH * 0.63, 0]}>
              <boxGeometry args={[slabW * 0.56, slabH * 0.32, 0.014]} />
              <meshStandardMaterial color={panelColor} roughness={0.52} metalness={0.02} />
            </mesh>
            <mesh position={[0, slabH * 0.29, 0]}>
              <boxGeometry args={[slabW * 0.56, slabH * 0.22, 0.014]} />
              <meshStandardMaterial color={panelColor} roughness={0.52} metalness={0.02} />
            </mesh>
            {isGrooveDoor && [-0.24, 0, 0.24].map((x) => (
              <mesh key={x} position={[x * slabW, slabH * 0.5, 0.002]}>
                <boxGeometry args={[0.018, slabH * 0.72, 0.016]} />
                <meshStandardMaterial color={frameColor} roughness={0.56} metalness={0.02} />
              </mesh>
            ))}
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
          {calibrated ? `D ${doorW.toFixed(1)}m` : "—"}
        </Text>
          </>
        )}
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
  onSelect?: (id: string) => void;
  onHover?: (selection: Selection) => void;
}) {
  const { pw, ph, calibrated } = usePlanScale();
  if (!win.bbox) return null;

  const wall = win.wallId
    ? walls.find((item) => item.id === win.wallId)
    : findBestWall(win.bbox, walls, pw, ph);
  if (!wall) return null;

  const transform = getOpeningTransform(win.bbox, wall, pw, ph);
  if (!transform) return null;

  const { center, angle, localX, projectedWidth } = transform;

  const winW = projectedWidth > 0.05 ? projectedWidth : Math.max(getWidthM(win.bbox.w, win.widthM, pw), 0.6);
  // Height & sill: must exactly mirror computeGapIntervals window values
  const winH = Math.min(wallHeight * 0.45, 1.2);
  const winD = 0.08;
  const sillY = wallHeight * 0.35;
  const windowOption = findScgWindow(win.scgWindowCode);
  const frameColor = win.frameColor ?? windowOption.frameHex;
  const glassColor = win.glassColor ?? windowOption.glassHex;

  if (win.useBlenderModel === "true" && windowOption.modelUrl) {
    return (
      <group
        position={[center[0], 0, center[1]]}
        rotation={[0, -angle, 0]}
        {...(onSelect ? {
          onPointerEnter: (e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation();
            onHover?.({ type: "window", id: win.id });
          },
          onPointerLeave: (e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation();
            onHover?.(null);
          },
          onClick: (e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            onSelect(win.id);
          },
        } : {})}
      >
        <group position={[localX, sillY, 0]}>
          <DoorModelBoundary fallback={null}>
            <Suspense fallback={null}>
              <BlenderWindowModel modelUrl={windowOption.modelUrl} winW={winW} winH={winH} winD={winD} />
            </Suspense>
          </DoorModelBoundary>
        </group>
      </group>
    );
  }

  // All child Y positions are relative to sillY (bottom of gap).
  // BoxGeometry centres are at Y=half-height so we add winH/2 to side frames,
  // winH to the top frame, and 0 to the bottom frame — matching gap exactly.
  return (
    <group
      position={[center[0], 0, center[1]]}
      rotation={[0, -angle, 0]}
      {...(onSelect ? {
        onPointerEnter: (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover?.({ type: "window", id: win.id });
        },
        onPointerLeave: (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover?.(null);
        },
        onClick: (e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect(win.id);
        },
      } : {})}
    >
      <group position={[localX, sillY, 0]}>
        {/* Left frame — bottom-anchored: centre at winH/2 */}
        <mesh position={[-winW / 2, winH / 2, 0]}>
          <boxGeometry args={[0.05, winH, winD]} />
          <meshStandardMaterial color={frameColor} />
        </mesh>
        {/* Right frame — bottom-anchored */}
        <mesh position={[winW / 2, winH / 2, 0]}>
          <boxGeometry args={[0.05, winH, winD]} />
          <meshStandardMaterial color={frameColor} />
        </mesh>
        {/* Top frame — sits at gap top edge (winH) */}
        <mesh position={[0, winH, 0]}>
          <boxGeometry args={[winW, 0.05, winD]} />
          <meshStandardMaterial color={frameColor} />
        </mesh>
        {/* Bottom frame — sits at gap bottom edge (sill, Y=0 relative) */}
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[winW, 0.05, winD]} />
          <meshStandardMaterial color={frameColor} />
        </mesh>
        {/* Glass — centre at winH/2 */}
        <mesh position={[0, winH / 2, 0]}>
          <planeGeometry args={[winW - 0.1, winH - 0.1]} />
          <meshStandardMaterial
            color={glassColor}
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
          {calibrated ? `W ${winW.toFixed(1)}m` : "—"}
        </Text>
      </group>
    </group>
  );
}

// ── Info overlay ──────────────────────────────────────────────────────────────

function PlacementPreviewMesh({
  preview,
  draft,
  walls,
  wallHeight,
}: {
  preview: PlacementPreview;
  draft: OpeningDraft;
  walls: DetectedWallSegment[];
  wallHeight: number;
}) {
  const { pw, ph } = usePlanScale();
  if (!preview || !draft || !openingPreviewIsOnWall(draft, preview.wallId)) return null;
  const wall = walls.find((item) => item.id === preview.wallId);
  if (!wall) return null;
  const bbox = createOpeningBboxFromWallPoints(wall, draft.start, preview.point, pw, ph);
  if (!bbox) return null;
  const transform = getOpeningTransform(bbox, wall, pw, ph);
  if (!transform) return null;
  const color = draft.kind === "door" ? "#f59e0b" : "#06b6d4";
  const height = draft.kind === "door" ? Math.min(wallHeight * 0.9, 2.2) : Math.min(wallHeight * 0.45, 1.2);
  const bottom = draft.kind === "door" ? 0 : wallHeight * 0.35;
  const thickness = getWallThicknessM(wall, pw, ph);

  return (
    <group position={[transform.center[0], 0, transform.center[1]]} rotation={[0, -transform.angle, 0]} userData={{ openingPreview: draft.kind }}>
      <group position={[transform.localX, bottom + height / 2, 0]}>
        <mesh raycast={() => null}>
          <boxGeometry args={[transform.projectedWidth, height, thickness + 0.02]} />
          <meshBasicMaterial color={color} transparent opacity={draft.kind === "door" ? 0.16 : 0.12} depthWrite={false} />
        </mesh>
        <lineSegments raycast={() => null}>
          <edgesGeometry args={[new THREE.BoxGeometry(transform.projectedWidth, height, thickness + 0.025)]} />
          <lineBasicMaterial color={color} transparent opacity={0.95} />
        </lineSegments>
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
  wallGeometries,
  showOutline = true,
  color = "#ef4444",
}: {
  target: Selection;
  rooms: Room[];
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  wallHeight: number;
  wallGeometries: Map<string, THREE.BufferGeometry>;
  showOutline?: boolean;
  color?: string;
}) {
  const { pw, ph } = usePlanScale();
  if (!target) return null;

  if (target.type === "room") {
    const room = rooms.find((item) => item.id === target.id);
    const shape = room ? getRoomShape(room, pw, ph) : null;
    if (!shape) return null;

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
    const geometry = wallGeometries.get(target.id);
    if (!wall || !geometry) return null;

    const x1 = wall.x1 * pw - pw / 2;
    const z1 = wall.y1 * ph - ph / 2;
    const x2 = wall.x2 * pw - pw / 2;
    const z2 = wall.y2 * ph - ph / 2;
    const length = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
    if (length < 0.001) return null;

    const angle = Math.atan2(z2 - z1, x2 - x1);
    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    return (
      <group position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
        <WallMeshHighlight geometry={geometry} color={color} showOutline={showOutline} />
      </group>
    );
  }

  const opening =
    target.type === "door"
      ? doors.find((item) => item.id === target.id)
      : windows.find((item) => item.id === target.id);
  if (!opening?.bbox) return null;

  const wall = opening.wallId
    ? walls.find((item) => item.id === opening.wallId)
    : findBestWall(opening.bbox, walls, pw, ph);
  if (!wall) return null;

  const transform = getOpeningTransform(opening.bbox, wall, pw, ph);
  if (!transform) return null;

  const { center, angle, localX, projectedWidth } = transform;
  const isDoor = target.type === "door";
  const width = Math.max(projectedWidth, isDoor ? 0.75 : 0.9);
  const height = isDoor ? Math.min(wallHeight * 0.9, 2.2) : Math.min(wallHeight * 0.45, 1.2);
  const bottomY = isDoor ? 0 : wallHeight * 0.35;
  const depth = getWallThicknessM(wall, pw, ph) + 0.16;

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
  const { pw, ph } = usePlanScale();
  if (!draft) return null;

  const wall: DetectedWallSegment = {
    id: "wall-draft-preview",
    x1: draft.start.x,
    y1: draft.start.y,
    x2: draft.end.x,
    y2: draft.end.y,
    type: "interior",
    thickness: DEFAULT_WALL_THICKNESS_M,
    wallHeight,
  };

  const x1 = wall.x1 * pw - pw / 2;
  const z1 = wall.y1 * ph - ph / 2;
  const x2 = wall.x2 * pw - pw / 2;
  const z2 = wall.y2 * ph - ph / 2;
  const length = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
  if (length < 0.05) return null;

  const angle = Math.atan2(z2 - z1, x2 - x1);
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;
  const thickness = getWallThicknessM(wall, pw, ph);

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
  const { pw, ph } = usePlanScale();
  if (!enabled) return null;

  const toNormalized = (point: THREE.Vector3): NormalizedPoint => ({
    x: clamp01((point.x + pw / 2) / pw),
    y: clamp01((point.z + ph / 2) / ph),
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
      <planeGeometry args={[pw, ph]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

function WallEditGizmo({
  wall,
  wallHeight,
  geometry,
  onEndpointDrag,
  onMoveDrag,
  onHeightDrag,
  onDragStateChange,
  onDragCancel,
}: {
  wall: DetectedWallSegment;
  wallHeight: number;
  geometry: THREE.BufferGeometry;
  onEndpointDrag: (id: string, endpoint: "start" | "end", point: NormalizedPoint) => void;
  onMoveDrag: (id: string, center: NormalizedPoint) => void;
  onHeightDrag: (id: string, deltaM: number) => void;
  onDragStateChange: (dragging: boolean) => void;
  onDragCancel: () => void;
}) {
  const { pw, ph } = usePlanScale();
  const [dragMode, setDragMode] = useState<"start" | "end" | "move" | "height" | null>(null);
  const pointerCaptureRef = useRef<{ target: R3FPointerCaptureTarget; pointerId: number } | null>(null);

  const x1 = wall.x1 * pw - pw / 2;
  const z1 = wall.y1 * ph - ph / 2;
  const x2 = wall.x2 * pw - pw / 2;
  const z2 = wall.y2 * ph - ph / 2;
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;
  const length = getWallLengthM(wall, pw, ph);
  const height = safeNum(wall.wallHeight, wallHeight);
  const angle = Math.atan2(z2 - z1, x2 - x1);
  const thickness = getWallThicknessM(wall, pw, ph);
  const faceOffset = thickness / 2 + 0.18;

  const toNormalized = (point: THREE.Vector3): NormalizedPoint => ({
    x: clamp01((point.x + pw / 2) / pw),
    y: clamp01((point.z + ph / 2) / ph),
  });

  const beginDrag = (
    mode: "start" | "end" | "move" | "height",
    event?: WallGizmoPointerEvent,
  ) => {
    event?.stopPropagation();
    if (event && supportsR3FPointerCapture(event.currentTarget)) {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerCaptureRef.current = { target: event.currentTarget, pointerId: event.pointerId };
    }
    setDragMode(mode);
    onDragStateChange(true);
  };

  const finishDrag = (event?: WallGizmoPointerEvent) => {
    event?.stopPropagation();
    const capture = pointerCaptureRef.current;
    if (capture) capture.target.releasePointerCapture(capture.pointerId);
    pointerCaptureRef.current = null;
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
          onPointerCancel={(e) => {
            e.stopPropagation();
            onDragCancel();
            finishDrag(e);
          }}
        >
          <planeGeometry args={[pw, ph]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      <group position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
        <WallMeshHighlight geometry={geometry} color="#38bdf8" outlineOnly />
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
  const { pw, ph, calibrated } = usePlanScale();
  const bounds = getRoomBounds(room);
  const w = Math.max(safeNum(bounds?.w) * pw, 0);
  const d = Math.max(safeNum(bounds?.h) * ph, 0);
  const h = safeNum(room.wallHeight, 2.8);
  const area = getMeasuredRoomArea(room, pw, ph, calibrated);

  return (
    <div className="absolute bottom-16 left-4 z-20 px-4 py-2.5 rounded-2xl bg-card/90 backdrop-blur-md border border-border shadow-2xl flex items-center gap-4 min-w-[280px] pointer-events-none">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-foreground truncate">{room.name}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
          {calibrated ? w.toFixed(2) : "—"}m × {calibrated ? d.toFixed(2) : "—"}m · H: {h.toFixed(2)}m
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-[11px] font-mono text-primary">{area?.toFixed(1) ?? "—"} m²</p>
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
  openingDraft,
  selectedTarget,
  hoverTarget,
  onHoverChange,
  onSelect,
  onHoverTargetChange,
  onPlacementHover,
  onWallAdd,
  onToolComplete,
  onWallEndpointDrag,
  onWallMoveDrag,
  onWallHeightDrag,
  onDragStart,
  onDragEnd,
  onDragCancel,
  onWalkExit,
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
  openingDraft: OpeningDraft;
  selectedTarget: Selection;
  hoverTarget: Selection;
  onHoverChange: (id: string | null) => void;
  onSelect: (selection: Selection) => void;
  onHoverTargetChange: (selection: Selection) => void;
  onPlacementHover: (preview: PlacementPreview) => void;
  onWallAdd?: (wall: DetectedWallSegment) => void;
  onToolComplete: () => void;
  onWallEndpointDrag: (id: string, endpoint: "start" | "end", point: NormalizedPoint) => void;
  onWallMoveDrag: (id: string, center: NormalizedPoint) => void;
  onWallHeightDrag: (id: string, deltaM: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragCancel: () => void;
  onWalkExit: () => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [wallDragging, setWallDragging] = useState(false);
  const [wallDraft, setWallDraft] = useState<WallDraft>(null);
  const orbitControlsRef = useRef<React.ComponentRef<typeof OrbitControls>>(null);

  const renderWalls = walls;
  const { pw, ph } = usePlanScale();

  const defaultWallHeight = defaultRenderWallHeight(rooms);
  const wallGeometries = useMemo(() => buildWallSolidGeometries(
    wallSolidInputs(renderWalls, doors, windows, defaultWallHeight, pw, ph), pw, ph),
    [renderWalls, doors, windows, defaultWallHeight, pw, ph]);
  useEffect(() => () => wallGeometries.forEach(geometry => geometry.dispose()), [wallGeometries]);

  const handleHover = (id: string | null) => {
    setHoveredId(id);
    onHoverChange(id);
  };

  useEffect(() => {
    if (buildMode !== "select") onHoverTargetChange(null);
    if (buildMode !== "wall") setWallDraft(null);
  }, [buildMode, onHoverTargetChange]);

  const canPreviewTarget = capturesThreeTargetPointer(buildMode, "room");
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
      thickness: DEFAULT_WALL_THICKNESS_M,
      wallHeight: defaultWallHeight,
    });
    onSelect({ type: "wall", id, point: snappedPoint });
    setWallDraft(null);
    onToolComplete();
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
        cellColor="#26313d"
        sectionColor="#3b4654"
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
          onSelect={canPreviewTarget ? (id) => onSelect({ type: "room", id }) : undefined}
          onTargetHover={canPreviewTarget ? onHoverTargetChange : undefined}
        />
      ))}

      {/* ── Walls — split into sub-segments around door/window openings ── */}
      {renderWalls.map((wall) => {
        return (
          <WallSegmentMesh
            key={wall.id}
            wall={wall}
            wallHeight={defaultWallHeight}
            doors={doors}
            windows={windows}
            walls={renderWalls}
            geometry={wallGeometries.get(wall.id)!}
            onSelect={capturesThreeTargetPointer(buildMode, "wall") ? (id, point) => onSelect({ type: "wall", id, point }) : undefined}
            onPlacementHover={
              isPlacementMode
                ? (id, point) => onPlacementHover({ wallId: id, point })
                : undefined
            }
            onPlacementLeave={isPlacementMode ? () => onPlacementHover(null) : undefined}
            onTargetHover={canPreviewTarget ? onHoverTargetChange : undefined}
          />
        );
      })}

      {selectedWallForEdit && (
        <WallEditGizmo
          wall={selectedWallForEdit}
          geometry={wallGeometries.get(selectedWallForEdit.id)!}
          wallHeight={defaultWallHeight}
          onEndpointDrag={onWallEndpointDrag}
          onMoveDrag={onWallMoveDrag}
          onHeightDrag={onWallHeightDrag}
          onDragStateChange={(dragging) => {
            setWallDragging(dragging);
            if (dragging) onDragStart();
            else onDragEnd();
          }}
          onDragCancel={onDragCancel}
        />
      )}

      {isPlacementMode && (
        <PlacementPreviewMesh
          preview={placementPreview}
          draft={openingDraft}
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
          onSelect={capturesThreeTargetPointer(buildMode, "door") ? (id) => onSelect({ type: "door", id }) : undefined}
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
          onSelect={capturesThreeTargetPointer(buildMode, "window") ? (id) => onSelect({ type: "window", id }) : undefined}
          onHover={canPreviewTarget ? onHoverTargetChange : undefined}
        />
      ))}

      {canPreviewTarget && (
        <DeletePreviewMesh
          target={activeTargetPreview}
          wallGeometries={wallGeometries}
          showOutline={targetPreviewShowsOutline(activeTargetPreview, selectedTarget)}
          rooms={rooms}
          walls={renderWalls}
          doors={doors}
          windows={windows}
          wallHeight={defaultWallHeight}
            color="#3b82f6"
        />
      )}

      <CameraPresetController
        preset={viewPreset}
        walkMode={walkMode}
        distance={cameraDistance}
        controlsRef={orbitControlsRef}
      />

      {walkMode ? (
        <FirstPersonController enabled={walkMode} onExit={onWalkExit} />
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
  calibrationStatus = "uncalibrated",
  scale = 0,
  planWidth = 0,
  planHeight = 0,
  originalPlanUrl = null,
  originalPlanName = null,
  originalPlanIsPdf = false,
  onRoomUpdate,
  onRoomPatch,
  onRoomDelete,
  onWallUpdate,
  onWallAdd,
  onWallDelete,
  onDoorAdd,
  onDoorUpdate,
  onDoorDelete,
  onWindowAdd,
  onWindowUpdate,
  onWindowDelete,
  onBack,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
}: RightPanelProps) => {
  // Preserve rendering dimensions; measurements require explicit calibration below.
  const planDimensions = resolvePlanDimensions(planWidth, planHeight);
  const { width: pw, height: ph } = planDimensions;
  const calibrated = hasCalibration(calibrationStatus, scale, planWidth, planHeight);
  const planScale = useMemo(() => ({ pw, ph, calibrated }), [pw, ph, calibrated]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [walkMode, setWalkMode] = useState(false);
  const exitWalkMode = useCallback(() => setWalkMode(false), []);
  const toggleWalkMode = useCallback(() => {
    setWalkMode((enabled) => !enabled);
  }, []);
  const [viewPreset, setViewPreset] = useState<ViewPreset>("perspective");
  const [buildMode, setBuildMode] = useState<BuildMode>("select");
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
    const projectActions = useProjectActions();
  const [hoverTarget, setHoverTarget] = useState<Selection>(null);
  const [placementPreview, setPlacementPreview] = useState<PlacementPreview>(null);
  const [openingDraft, setOpeningDraft] = useState<OpeningDraft>(null);
  const hasValidOpeningTarget = (buildMode === "door" || buildMode === "window")
    && isValidOpeningTarget(openingDraft, placementPreview?.wallId ?? null);
  const [showPlanReference, setShowPlanReference] = useState(true);
  // Temporarily retained for later restoration; the compact 3D workspace hides it.
  const showOriginalPlanWidget = false;
  const [isDecorateOpen, setIsDecorateOpen] = useState(true);
  const [isPlanViewerOpen, setIsPlanViewerOpen] = useState(false);
  const [planZoom, setPlanZoom] = useState(1);
  const [originalPlanAspect, setOriginalPlanAspect] = useState<number | null>(null);
  const [planWidgetPosition, setPlanWidgetPosition] = useState<{ left: number; top: number } | null>(null);
  const [planWidgetSize, setPlanWidgetSize] = useState<{ width: number; height: number } | null>(null);
  const planWidgetRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const planWidgetDragRef = useRef<{ offsetX: number; offsetY: number; parent: DOMRect } | null>(null);
  const planWidgetResizeRef = useRef<{
    corner: "nw" | "ne" | "sw" | "se";
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    startWidth: number;
    startHeight: number;
    parent: DOMRect;
  } | null>(null);
  const hoveredRoom = rooms.find((r) => r.id === hoveredId) ?? null;
  const selectedRoom = selection?.type === "room" ? rooms.find((r) => r.id === selection.id) : null;
  const selectedWall = selection?.type === "wall" ? walls.find((w) => w.id === selection.id) : null;
  const selectedDoor = selection?.type === "door" ? doors.find((d) => d.id === selection.id) : null;
  const selectedWindow = selection?.type === "window" ? windows.find((w) => w.id === selection.id) : null;

  useEffect(() => {
    const closeAddMenuOnOutsideClick = (event: PointerEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) setIsAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeAddMenuOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeAddMenuOnOutsideClick);
  }, []);

  const maxH =
    rooms.length > 0
      ? Math.max(...rooms.map((r) => safeNum(r.wallHeight, 2.8)), 3)
      : 3;

  const planSpan = rooms.reduce((max, room) => {
    const bounds = getRoomBounds(room);
    if (!bounds) return max;
    return Math.max(max, bounds.w * pw, bounds.h * ph);
  }, Math.max(pw, ph));

  const camDist = Math.max(planSpan * 1.15, 12);

  const totalArea = rooms.reduce(
    (s, room) => s + (getMeasuredRoomArea(room, pw, ph, calibrated) ?? 0),
    0,
  );

  const buildOptions: { id: BuildMode; label: string; hint: string }[] = [
    { id: "select", label: "Select", hint: "Hover previews, click selects, click empty space clears" },
    { id: "wall", label: "+ Wall", hint: "Click floor start point, move, then click end point" },
    { id: "door", label: "+ Door", hint: "Click the opening start and end on the same wall" },
    { id: "window", label: "+ Window", hint: "Click the opening start and end on the same wall" },
  ];

  const selectedRoomTile = findScgTile(selectedRoom?.tileCode);
  const selectedWallPaint = findScgPaint(selectedWall?.scgPaintCode);
  const selectedDoorOption = findScgDoor(selectedDoor?.scgDoorCode);
  const selectedWindowOption = findScgWindow(selectedWindow?.scgWindowCode);
  const selectedRoomFloorArea = selectedRoom ? getMeasuredRoomArea(selectedRoom, pw, ph, calibrated) : null;
  const selectedRoomTileCount = selectedRoomFloorArea != null ? estimateTileCount(selectedRoomFloorArea, selectedRoomTile) : null;
  const materialSummary = useMemo(() => {
    const unique = (items: string[]) => [...new Set(items.filter(Boolean))];
    return {
      walls: unique(walls.map((wall) => {
        const paint = findScgPaint(wall.scgPaintCode);
        return wall.scgPaintCode ? `${paint.name} · ${paint.finish}` : "No finish assigned";
      })),
      floors: unique(rooms.map((room) => {
        const tile = findScgTile(room.tileCode);
        return room.tileCode ? `${tile.name} · ${tile.sizeCm} cm` : "No floor finish assigned";
      })),
      openings: unique([
        ...doors.map((door) => door.scgDoorCode ? `${findScgDoor(door.scgDoorCode).name} · ${findScgDoor(door.scgDoorCode).material}` : "Door product not assigned"),
        ...windows.map((windowItem) => windowItem.scgWindowCode ? `${findScgWindow(windowItem.scgWindowCode).name} · ${findScgWindow(windowItem.scgWindowCode).material}` : "Window product not assigned"),
      ]),
    };
  }, [doors, rooms, walls, windows]);
  const hasAssignedMaterials = walls.some((wall) => Boolean(wall.scgPaintCode))
    || rooms.some((room) => Boolean(room.tileCode))
    || doors.some((door) => Boolean(door.scgDoorCode))
    || windows.some((windowItem) => Boolean(windowItem.scgWindowCode));

  const applyPaintToWall = (wallId: string, code: string) => {
    const paint = findScgPaint(code);
    projectActions.run({ label: "wall color change", threeOnly: true }, () => {
      onWallUpdate?.(wallId, "scgPaintCode", paint.code);
      onWallUpdate?.(wallId, "wallColor", paint.hex);
      onWallUpdate?.(wallId, "wallFinish", paint.finish);
    });
  };

  const applyPaintToAllWalls = (code: string) => {
    const paint = findScgPaint(code);
    projectActions.run({ label: "wall color change", threeOnly: true }, () => {
      walls.forEach((wall) => {
        onWallUpdate?.(wall.id, "scgPaintCode", paint.code);
        onWallUpdate?.(wall.id, "wallColor", paint.hex);
        onWallUpdate?.(wall.id, "wallFinish", paint.finish);
      });
    });
  };

  const applyTileToRoom = (roomId: string, code: string) => {
    const tile = findScgTile(code);
    projectActions.run({ label: "floor tile change", threeOnly: true }, () => {
      onRoomPatch?.(roomId, {
        tileCode: tile.code,
        tileName: tile.name,
        floorColor: tile.baseHex,
        material: "tile",
      });
    });
  };

  const applyTileToAllRooms = (code: string) => {
    const tile = findScgTile(code);
    projectActions.run({ label: "floor tile change", threeOnly: true }, () => {
      rooms.forEach((room) => {
        onRoomPatch?.(room.id, {
          tileCode: tile.code,
          tileName: tile.name,
          floorColor: tile.baseHex,
          material: "tile",
        });
      });
    });
  };

  const applyDoorProduct = (doorId: string, code: string) => {
    const product = findScgDoor(code);
    projectActions.run({ label: "door product change", threeOnly: true }, () => {
      onDoorUpdate?.(doorId, "scgDoorCode", product.code);
      onDoorUpdate?.(doorId, "doorName", product.name);
      onDoorUpdate?.(doorId, "doorMaterial", product.material);
      onDoorUpdate?.(doorId, "doorColor", product.doorHex);
      onDoorUpdate?.(doorId, "frameColor", product.frameHex);
    });
  };

  const applyWindowProduct = (windowId: string, code: string) => {
    const product = findScgWindow(code);
    projectActions.run({ label: "window product change", threeOnly: true }, () => {
      onWindowUpdate?.(windowId, "scgWindowCode", product.code);
      onWindowUpdate?.(windowId, "windowName", product.name);
      onWindowUpdate?.(windowId, "windowMaterial", product.material);
      onWindowUpdate?.(windowId, "frameColor", product.frameHex);
      onWindowUpdate?.(windowId, "glassColor", product.glassHex);
    });
  };

  useEffect(() => {
    setPlacementPreview(null);
    setHoverTarget(null);
    setOpeningDraft(null);
  }, [buildMode]);

  useEffect(() => {
    if (!openingDraft) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpeningDraft(cancelOpeningDraft());
      setPlacementPreview(null);
      setBuildMode("select");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openingDraft]);

  const addOpeningToWall = (
    wall: DetectedWallSegment,
    kind: "door" | "window",
    start: NormalizedPoint,
    end: NormalizedPoint,
  ): boolean => {
    const bbox = createOpeningBboxFromWallPoints(wall, start, end, pw, ph);
    if (!bbox) return false;
    if (kind === "door" && onDoorAdd) {
      const id = `manual-door-${Date.now()}`;
      onDoorAdd({ id, bbox, wallId: wall.id });
      setSelection({ type: "door", id });
      return true;
    }
    if (kind === "window" && onWindowAdd) {
      const id = `manual-window-${Date.now()}`;
      onWindowAdd({ id, bbox, wallId: wall.id });
      setSelection({ type: "window", id });
      return true;
    }
    return false;
  };

  const deleteSelection = () => {
    if (!selection) return;
    if (selection.type === "room") onRoomDelete?.(selection.id);
    if (selection.type === "wall") onWallDelete?.(selection.id);
    if (selection.type === "door") onDoorDelete?.(selection.id);
    if (selection.type === "window") onWindowDelete?.(selection.id);
    setSelection(null);
  };

  const handleSceneSelect = (target: Selection) => {
    if (!target) return;

    if (buildMode === "wall") return;

    if ((buildMode === "door" || buildMode === "window") && target.type === "wall") {
      const wall = walls.find((item) => item.id === target.id);
      if (!wall || !target.point) return;
      const transition = advanceOpeningDraft(openingDraft, buildMode, wall.id, target.point);
      if (transition.confirms) {
        if (!openingDraft) return;
        if (addOpeningToWall(wall, buildMode, openingDraft.start, target.point)) {
          setOpeningDraft(null);
          setBuildMode((current) => nextThreeToolAfterCreation(current));
        }
      } else {
        setOpeningDraft(transition.draft);
      }
      setPlacementPreview(null);
      setHoverTarget(null);
      return;
    }

    if (buildMode === "select") {
      setSelection((current) => nextThreeSelection(current, buildMode, "target", target));
      setHoverTarget(null);
    }
  };

  const clearSelect = () => {
    if (buildMode !== "select") return;
    setSelection((current) => nextThreeSelection(current, buildMode, "empty"));
    setHoverTarget(null);
  };

  const updateSelectedWallLength = (lengthM: number) => {
    if (!selectedWall || !onWallUpdate) return;
    const dx = selectedWall.x2 - selectedWall.x1;
    const dy = selectedWall.y2 - selectedWall.y1;
    const currentLength = Math.sqrt(dx * dx + dy * dy);
    if (currentLength < 1e-6) return;

    const ux = dx / currentLength;
    const uy = dy / currentLength;
    // metric scale factor for this direction given non-uniform pw/ph
    const metricScale = Math.sqrt((ux * pw) ** 2 + (uy * ph) ** 2);
    const cx = (selectedWall.x1 + selectedWall.x2) / 2;
    const cy = (selectedWall.y1 + selectedWall.y2) / 2;
    const half = Math.max(0.1, lengthM) / (2 * metricScale);

    projectActions.run({ label: "wall length change" }, () => {
      onWallUpdate(selectedWall.id, "x1", clamp01(cx - ux * half));
      onWallUpdate(selectedWall.id, "y1", clamp01(cy - uy * half));
      onWallUpdate(selectedWall.id, "x2", clamp01(cx + ux * half));
      onWallUpdate(selectedWall.id, "y2", clamp01(cy + uy * half));
    });
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

  const handleExportGlb = async () => {
    await exportFloorPlanGlb({
      rooms,
      walls,
      doors,
      windows,
      planWidth: pw,
      planHeight: ph,
      wallHeight: rooms.length ? Math.max(...rooms.map(room => safeNum(room.wallHeight, 2.8)), 2.8) : 2.8,
    });
  };

  const startPlanWidgetDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const widget = planWidgetRef.current;
    const parent = widget?.parentElement;
    if (!widget || !parent) return;
    const widgetRect = widget.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    planWidgetDragRef.current = {
      offsetX: event.clientX - widgetRect.left,
      offsetY: event.clientY - widgetRect.top,
      parent: parentRect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePlanWidget = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = planWidgetDragRef.current;
    const widget = planWidgetRef.current;
    if (!drag || !widget) return;
    const maxLeft = Math.max(0, drag.parent.width - widget.offsetWidth);
    const maxTop = Math.max(0, drag.parent.height - widget.offsetHeight);
    setPlanWidgetPosition({
      left: Math.max(0, Math.min(maxLeft, event.clientX - drag.parent.left - drag.offsetX)),
      top: Math.max(0, Math.min(maxTop, event.clientY - drag.parent.top - drag.offsetY)),
    });
  };

  const stopPlanWidgetDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    planWidgetDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const startPlanWidgetResize = (event: ReactPointerEvent<HTMLDivElement>, corner: "nw" | "ne" | "sw" | "se") => {
    event.preventDefault();
    event.stopPropagation();
    const widget = planWidgetRef.current;
    const parent = widget?.parentElement;
    if (!widget || !parent) return;
    const rect = widget.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    planWidgetResizeRef.current = {
      corner,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left - parentRect.left,
      startTop: rect.top - parentRect.top,
      startWidth: rect.width,
      startHeight: rect.height,
      parent: parentRect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const resizePlanWidget = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = planWidgetResizeRef.current;
    if (!resize) return;
    const dx = event.clientX - resize.startX;
    const dy = event.clientY - resize.startY;
    const movesLeft = resize.corner === "nw" || resize.corner === "sw";
    const movesTop = resize.corner === "nw" || resize.corner === "ne";
    const width = Math.max(220, movesLeft ? resize.startWidth - dx : resize.startWidth + dx);
    const height = Math.max(140, movesTop ? resize.startHeight - dy : resize.startHeight + dy);
    const left = movesLeft ? resize.startLeft + resize.startWidth - width : resize.startLeft;
    const top = movesTop ? resize.startTop + resize.startHeight - height : resize.startTop;
    const boundedWidth = Math.min(width, resize.parent.width - Math.max(0, left));
    const boundedHeight = Math.min(height, resize.parent.height - Math.max(0, top));
    setPlanWidgetPosition({ left: Math.max(0, left), top: Math.max(0, top) });
    setPlanWidgetSize({ width: boundedWidth, height: boundedHeight });
  };

  const stopPlanWidgetResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    planWidgetResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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
        <PlanScaleCtx.Provider value={planScale}>
          <Canvas
            camera={{
              position: [camDist * 0.7, camDist * 0.5, camDist * 0.7],
              fov: 45,
            }}
            style={{ width: "100%", height: "100%", cursor: buildMode === "wall" || hasValidOpeningTarget ? "cell" : "default" }}
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
              openingDraft={openingDraft}
              selectedTarget={selection}
              hoverTarget={hoverTarget}
              onHoverChange={setHoveredId}
              onSelect={handleSceneSelect}
              onHoverTargetChange={setHoverTarget}
              onPlacementHover={setPlacementPreview}
              onWallAdd={onWallAdd}
              onToolComplete={() => setBuildMode((current) => nextThreeToolAfterCreation(current))}
              onWallEndpointDrag={dragSelectedWallEndpoint}
              onWallMoveDrag={moveSelectedWall}
              onWallHeightDrag={resizeSelectedWallHeight}
              onDragStart={() => projectActions.begin({ label: "wall geometry change" })}
              onDragEnd={() => projectActions.commit()}
              onDragCancel={() => projectActions.cancel()}
              onWalkExit={exitWalkMode}
            />
          </Canvas>

          {showOriginalPlanWidget && originalPlanUrl && (
            <div
              ref={planWidgetRef}
              className={`absolute z-20 min-h-[48px] min-w-[220px] max-w-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-border bg-card/95 shadow-xl backdrop-blur-md ${planWidgetPosition ? "" : "right-4 top-20"} ${showPlanReference ? "h-64 w-72" : "w-64"}`}
              style={{
                ...(planWidgetPosition ?? {}),
                ...(showPlanReference && planWidgetSize ? planWidgetSize : {}),
              }}
            >
              <div
                onPointerDown={startPlanWidgetDrag}
                onPointerMove={movePlanWidget}
                onPointerUp={stopPlanWidgetDrag}
                onPointerCancel={stopPlanWidgetDrag}
                className="flex cursor-grab touch-none items-center justify-between border-b border-border px-3 py-2 active:cursor-grabbing"
                title="Drag to move this widget"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ImageIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-foreground">Original plan</p>
                    <p className="truncate text-[9px] text-muted-foreground">{originalPlanName ?? "Source drawing"}</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowPlanReference((value) => !value)}
                  className="rounded-md px-1.5 py-1 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {showPlanReference ? "Hide" : "Show"}
                </button>
              </div>
              {showPlanReference && (
                <button
                  type="button"
                  onClick={() => { setPlanZoom(1); setIsPlanViewerOpen(true); }}
                  className="group relative block h-[calc(100%-43px)] w-full overflow-hidden bg-muted/40 text-left"
                  title="Open original plan"
                >
                  {originalPlanIsPdf ? (
                    <iframe src={originalPlanUrl} title="Original floor plan" className="h-full w-full border-0" />
                  ) : (
                    <img
                      src={originalPlanUrl}
                      alt="Original floor plan"
                      className="h-full w-full object-contain"
                      onLoad={(event) => setOriginalPlanAspect(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)}
                    />
                  )}
                  {!originalPlanIsPdf && <OriginalPlanWallOverlay wall={selectedWall ?? null} imageAspect={originalPlanAspect} />}
                  <div className="absolute inset-0 flex items-center justify-center bg-foreground/0 transition-colors group-hover:bg-foreground/15">
                    <span className="flex items-center gap-1.5 rounded-lg bg-background/90 px-2.5 py-1.5 text-[10px] font-semibold text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                      <Maximize2 className="h-3 w-3" /> Open & zoom
                    </span>
                  </div>
                  <span className="absolute bottom-2 left-2 z-20 rounded-md bg-background/90 px-2 py-1 text-[9px] font-medium text-foreground shadow-sm">
                    {selectedWall ? "Selected wall highlighted" : "Reference only · Click to inspect"}
                  </span>
                </button>
              )}
              {showPlanReference && ([
                ["nw", "left-0 top-0 cursor-nwse-resize"],
                ["ne", "right-0 top-0 cursor-nesw-resize"],
                ["sw", "bottom-0 left-0 cursor-nesw-resize"],
                ["se", "bottom-0 right-0 cursor-nwse-resize"],
              ] as const).map(([corner, position]) => (
                <div
                  key={corner}
                  onPointerDown={(event) => startPlanWidgetResize(event, corner)}
                  onPointerMove={resizePlanWidget}
                  onPointerUp={stopPlanWidgetResize}
                  onPointerCancel={stopPlanWidgetResize}
                  className={`absolute z-30 h-4 w-4 ${position}`}
                  aria-label={`Resize original plan widget from ${corner}`}
                />
              ))}
            </div>
          )}

          {isPlanViewerOpen && originalPlanUrl && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
              <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
                <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <ImageIcon className="h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">Original floor plan</p>
                      <p className="truncate text-[11px] text-muted-foreground">{originalPlanName ?? "Source drawing"}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {!originalPlanIsPdf && (
                      <>
                        <button onClick={() => setPlanZoom((zoom) => Math.max(0.5, Number((zoom - 0.25).toFixed(2))))} className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground" title="Zoom out"><ZoomOut className="h-4 w-4" /></button>
                        <button onClick={() => setPlanZoom(1)} className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground" title="Reset zoom"><RotateCcw className="mr-1 inline h-3.5 w-3.5" />{Math.round(planZoom * 100)}%</button>
                        <button onClick={() => setPlanZoom((zoom) => Math.min(3, Number((zoom + 0.25).toFixed(2))))} className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground" title="Zoom in"><ZoomIn className="h-4 w-4" /></button>
                      </>
                    )}
                    <button onClick={() => setIsPlanViewerOpen(false)} className="ml-1 rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground" title="Close"><X className="h-4 w-4" /></button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/40 p-5">
                  {originalPlanIsPdf ? (
                    <iframe src={originalPlanUrl} title="Original floor plan large preview" className="h-full w-full rounded-lg bg-white" />
                  ) : (
                    <img
                      src={originalPlanUrl}
                      alt="Original floor plan enlarged"
                      className="max-h-full max-w-full origin-center object-contain transition-transform duration-200"
                      style={{ transform: `scale(${planZoom})` }}
                    />
                  )}
                </div>
              </div>
            </div>
          )}

          {onBack && !generated && (
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

          <div className="hidden">
            {buildOptions.map((option) => (
              <button
                key={option.id}
                onClick={() => setBuildMode(option.id)}
                className={`rounded-2xl px-3 py-2 text-[11px] font-semibold transition-all ${
                  buildMode === option.id
                    ? "bg-blue-600 text-white shadow-lg"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                title={option.hint}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="hidden">
            {buildOptions.find((option) => option.id === buildMode)?.hint}
          </div>

          <div className="hidden">
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
              <span className="pl-3 text-muted-foreground">{calibrated ? totalArea.toFixed(1) : "—"} m²</span>
              <span className="pl-3 text-muted-foreground">H: {maxH.toFixed(1)}m</span>
              <span className="pl-3 text-amber-400">{calibrated ? "Measured scale" : "Uncalibrated"}</span>
            </div>
            <button
              onClick={() => setWalkMode((prev) => !prev)}
              className={`ml-2 flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold transition-all duration-200 ${
                walkMode
                  ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-500 shadow-[0_0_0_3px_rgba(37,99,235,0.12)]"
                  : "bg-foreground text-background border-foreground hover:opacity-90"
              }`}
            >
              <Move3D className="w-3.5 h-3.5" />
              {walkMode ? "Walk Mode On" : "Walk Mode"}
            </button>
            <button
              onClick={handleExportGlb}
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-accent"
              title="Export a .glb file for Blender"
            >
              <Download className="h-3.5 w-3.5" />
              Export GLB
            </button>
          </div>

          <div className="absolute inset-x-0 top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-card/30 px-5 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Box className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0"><p className="text-sm font-semibold text-foreground">3D View</p><p className="text-[11px] text-muted-foreground">Explore and edit your space in 3D</p></div>
            </div>
            <div className="flex items-center gap-3 whitespace-nowrap">
              <button onClick={() => { setBuildMode("select"); setIsAddMenuOpen(false); }} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-medium transition-colors ${buildMode === "select" ? "border-blue-600 bg-blue-600 text-white shadow-sm" : "border-border bg-background text-foreground hover:bg-accent"}`}><MousePointer2 className="h-3.5 w-3.5" />Select</button>
              <div ref={addMenuRef} className={`relative flex items-center gap-2 rounded-lg border px-3 py-1.5 transition-all duration-200 ${buildMode !== "select" ? "border-blue-500/60 bg-blue-500/10" : "border-border bg-card/80"}`}>
                {buildMode === "select" ? <>
                  <button onClick={() => setIsAddMenuOpen(open => !open)} aria-expanded={isAddMenuOpen} className="flex items-center gap-1.5 text-[11px] font-medium text-blue-500 transition-colors hover:text-blue-400"><Plus className="h-3.5 w-3.5" />Add Element <ChevronDown className={`h-3 w-3 transition-transform ${isAddMenuOpen ? "rotate-180" : ""}`} /></button>
                  {isAddMenuOpen && <div className="absolute left-0 top-full z-50 mt-2 w-36 rounded-lg border border-border bg-card p-1 shadow-xl">
                    {([{ id: "wall", label: "Wall", Icon: Pencil }, { id: "door", label: "Door", Icon: DoorOpen }, { id: "window", label: "Window", Icon: AppWindow }] as const).map(({ id, label, Icon }) => <button key={id} onClick={() => { setBuildMode(id); setIsAddMenuOpen(false); }} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-accent"><Icon className="h-3.5 w-3.5" />{label}</button>)}
                  </div>}
                </> : <>
                  {buildMode === "wall" ? <Pencil className="h-3.5 w-3.5 shrink-0 animate-pulse text-blue-400" /> : buildMode === "door" ? <DoorOpen className="h-3.5 w-3.5 shrink-0 animate-pulse text-blue-400" /> : <AppWindow className="h-3.5 w-3.5 shrink-0 animate-pulse text-blue-400" />}
                  <span className="whitespace-nowrap text-[11px] font-medium text-blue-300">{buildMode === "wall" ? "Click start and end point" : openingDraft ? "Click opening end on the same wall" : "Click opening start on a wall"}</span>
                  <button onClick={() => { setBuildMode("select"); setIsAddMenuOpen(false); }} aria-label="Cancel Add Element" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                </>}
              </div>
              <button onClick={toggleWalkMode} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-medium transition-colors ${walkMode ? "border-blue-600 bg-blue-600 text-white" : "border-border bg-background text-foreground hover:bg-accent"}`}><Move3D className="h-3.5 w-3.5" />{walkMode ? "Walk Mode On" : "Walk Mode"}</button>
              <span className="mx-1 h-4 w-px bg-border" />
              <div className="flex overflow-hidden rounded-lg border border-border bg-card/80"><button onClick={onUndo} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl/Cmd + Z)" className="p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35"><RotateCcw className="h-3.5 w-3.5" /></button><button onClick={onRedo} disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl/Cmd + Shift + Z)" className="border-l border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35"><RotateCcw className="h-3.5 w-3.5 -scale-x-100" /></button></div>
            </div>
            <button onClick={handleExportGlb} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent" title="Export a .glb file for Blender"><Download className="h-3.5 w-3.5" />Export GLB</button>
          </div>

          <div className="absolute bottom-5 left-5 z-20 flex h-28 w-28 items-center justify-center rounded-full border border-border bg-card/95 text-[10px] font-semibold text-slate-500 shadow-lg backdrop-blur-md" aria-label="View cube orientation">
            <button onClick={() => setViewPreset("top")} title="Top view" className="absolute top-2 rounded px-2 py-1 hover:bg-accent">N</button><button onClick={() => setViewPreset("front")} title="Front view" className="absolute bottom-2 rounded px-2 py-1 hover:bg-accent">S</button><button onClick={() => setViewPreset("side")} title="Side view" className="absolute left-1 rounded px-2 py-1 hover:bg-accent">W</button><button onClick={() => setViewPreset("side")} title="Side view" className="absolute right-1 rounded px-2 py-1 hover:bg-accent">E</button>
            <button onClick={() => setViewPreset("perspective")} title="Perspective view" className="h-8 w-8 rotate-[30deg] transform rounded-sm border border-slate-300 bg-gradient-to-br from-white via-slate-100 to-slate-300 shadow-sm transition-transform hover:scale-110 dark:border-slate-600 dark:from-slate-200 dark:to-slate-400" />
          </div>

          <div className="absolute bottom-4 right-4 top-20 z-20 flex w-[320px] max-w-[calc(100%-2rem)] flex-col gap-3 pointer-events-none">
          <div className="pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card/95 p-4 shadow-xl backdrop-blur-md">
            <div className={`flex shrink-0 items-center justify-between gap-2 ${isDecorateOpen ? "mb-3" : ""}`}>
              <div className="flex min-w-0 items-center gap-2">
                <Palette className="h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0 break-words">
                  <div className="text-sm font-semibold text-foreground">Decoration</div>
                  <div className="text-xs text-muted-foreground" role="status" aria-live="polite">
                    {selection ? `${({ room: "ห้อง", wall: "ผนัง", door: "ประตู", window: "หน้าต่าง" })[selection.type]} · ${selectedRoom?.name ?? selection.id}` : "Select an object to start decorating."}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {selection && (
                  <button onClick={() => setSelection(null)} className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground" title="ยกเลิกการเลือก" aria-label="ยกเลิกการเลือก">
                    <X className="h-4 w-4" />
                  </button>
                )}
                <button
                  onClick={() => setIsDecorateOpen((open) => !open)}
                  className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-expanded={isDecorateOpen}
                  aria-controls="decorate-content"
                  title={isDecorateOpen ? "Minimize Decorate" : "Expand Decorate"}
                  aria-label={isDecorateOpen ? "Minimize Decorate" : "Expand Decorate"}
                >
                  <ChevronDown className={`h-4 w-4 transition-transform ${isDecorateOpen ? "" : "-rotate-90"}`} />
                </button>
              </div>
            </div>

            {isDecorateOpen && <div id="decorate-content" className="min-h-0 overflow-y-auto overscroll-contain pr-2 space-y-4 [&_label]:text-[13px] [&_input]:text-sm [&_select]:text-sm">
            {!calibrated && <p className="rounded-xl bg-primary/10 p-3 text-xs text-muted-foreground">Calibrate scale in Review to estimate quantities</p>}
            {/* {selection && <p className="rounded-xl bg-primary/10 p-3 text-xs leading-5 text-muted-foreground">ปรับแล้วเห็นผลทันทีในฉาก · ใช้ปุ่มย้อนกลับเพื่อเลิกทำ</p>} */}
            {!selection && (
              <div className="space-y-3">
                {/* <div className="rounded-2xl border border-dashed border-border p-3 text-[11px] leading-5 text-muted-foreground">
                  Select a room, wall, door, or window in the 3D view to edit it.
                </div> */}
                <label className="block text-[11px] text-muted-foreground">
                  Paint all walls
                  <select
                    onChange={(e) => applyPaintToAllWalls(e.target.value)}
                    defaultValue=""
                    className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs text-foreground"
                  >
                    <option value="" disabled>Choose SCG paint code</option>
                    {SCG_PAINT_CATALOG.map((paint) => (
                      <option key={paint.code} value={paint.code}>
                        {paint.code} - {paint.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-[11px] text-muted-foreground">
                  Tile all rooms
                  <select
                    onChange={(e) => applyTileToAllRooms(e.target.value)}
                    defaultValue=""
                    className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs text-foreground"
                  >
                    <option value="" disabled>Choose tile code</option>
                    {SCG_TILE_CATALOG.map((tile) => (
                      <option key={tile.code} value={tile.code}>
                        {tile.code} - {tile.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {selectedRoom && (
              <div className="space-y-3">
                <fieldset className="space-y-3 rounded-xl border border-border p-3">
                <legend className="px-1 text-sm font-semibold">Meterials</legend>
                <MaterialSwatches label="Tiles" value={selectedRoom.tileCode ?? selectedRoomTile.code}
                  onChange={code => applyTileToRoom(selectedRoom.id, code)}
                  options={SCG_TILE_CATALOG.map(tile => ({ id: tile.code, name: tile.name, detail: `${tile.code} · ${tile.sizeCm} cm`, style: {
                    backgroundColor: tile.baseHex,
                    backgroundImage: tile.pattern === "marble" ? `repeating-linear-gradient(135deg, transparent 0 14px, ${tile.accentHex} 15px, transparent 17px 29px)` : tile.pattern === "terrazzo" ? `radial-gradient(${tile.accentHex} 1px, transparent 2px)` : tile.pattern === "stone" ? `repeating-linear-gradient(25deg, transparent 0 4px, ${tile.accentHex}55 5px 7px)` : `linear-gradient(${tile.groutHex} 1px, transparent 1px), linear-gradient(90deg, ${tile.groutHex} 1px, transparent 1px)`,
                    backgroundSize: tile.pattern === "terrazzo" ? "9px 11px" : tile.pattern === "plain" ? "24px 24px" : undefined,
                  } }))} />
                <label className="block text-[11px] text-muted-foreground">
                  Floor tile code
                  <select
                    value={selectedRoom.tileCode ?? selectedRoomTile.code}
                    onChange={(e) => applyTileToRoom(selectedRoom.id, e.target.value)}
                    className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs text-foreground"
                  >
                    {SCG_TILE_CATALOG.map((tile) => (
                      <option key={tile.code} value={tile.code}>
                        {tile.code} - {tile.sizeCm}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[10px] text-muted-foreground/70">
                    {selectedRoom.tileName ?? selectedRoomTile.name}
                  </span>
                </label>
                <div className="rounded-2xl border border-border bg-background/70 p-3 space-y-1.5 text-[11px] font-mono">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Area</span>
                    <span className="text-foreground">{selectedRoomFloorArea?.toFixed(2) ?? "—"} m²</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Tile size</span>
                    <span className="text-foreground">{selectedRoomTile.sizeCm} cm</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Needed</span>
                    <span className="text-foreground font-semibold">
                      {selectedRoomTileCount != null ? `${selectedRoomTileCount.toLocaleString()} แผ่น` : "—"}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground/70">
                    Includes 10% waste for cuts and breakage
                  </div>
                </div>
                <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                  Floor color
                  <input
                    type="color"
                    value={selectedRoom.floorColor ?? selectedRoomTile.baseHex}
                    onChange={(e) => onRoomUpdate?.(selectedRoom.id, "floorColor", e.target.value)}
                    className="h-8 w-12 rounded border border-border bg-transparent"
                  />
                </label>
                </fieldset>
                <fieldset className="space-y-3 rounded-xl border border-border p-3">
                <legend className="px-1 text-sm font-semibold">size</legend>
                <label className="block text-[11px] text-muted-foreground">
                  height (m)
                  <input
                    type="number"
                    min={1.8}
                    step={0.1}
                    value={safeNum(selectedRoom.wallHeight, 2.8)}
                    onChange={(e) => onRoomUpdate?.(selectedRoom.id, "wallHeight", parseFloat(e.target.value) || 2.8)}
                    className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs text-foreground"
                  />
                </label>
                </fieldset>
              </div>
            )}

            {selectedWall && (
              <div className="space-y-3">
                <fieldset className="space-y-3 rounded-xl border border-border p-3">
                <legend className="px-1 text-sm font-semibold">สีและวัสดุผนัง</legend>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-foreground">Wall</span>
                  <button
                    onClick={() => onWallUpdate?.(selectedWall.id, "type", selectedWall.type === "exterior" ? "interior" : "exterior")}
                    className="rounded-lg bg-primary/10 px-2 py-1 text-[10px] font-mono text-primary"
                  >
                    {selectedWall.type}
                  </button>
                </div>
                <MaterialSwatches label="สีทาผนัง" value={selectedWall.wallColor && selectedWall.wallColor !== selectedWallPaint.hex ? undefined : selectedWall.scgPaintCode ?? selectedWallPaint.code}
                  onChange={code => applyPaintToWall(selectedWall.id, code)}
                  options={SCG_PAINT_CATALOG.map(paint => ({ id: paint.code, name: paint.name, detail: paint.code, style: { backgroundColor: paint.hex } }))} />
                <MaterialSwatches label="พื้นผิวผนัง" value={selectedWall.wallTexture ?? "painted"}
                  onChange={id => onWallUpdate?.(selectedWall.id, "wallTexture", id)}
                  options={WALL_TEXTURE_CATALOG.map(texture => ({ id: texture.id, name: texture.name, style: {
                    backgroundColor: selectedWall.wallColor ?? selectedWallPaint.hex,
                    backgroundImage: ({
                      painted: "none",
                      plaster: "radial-gradient(#0002 0.5px, transparent 1px)",
                      concrete: "radial-gradient(ellipse at 25% 40%, #0003, transparent 65%), radial-gradient(#0002 1px, transparent 2px)",
                      brick: "linear-gradient(#0004 2px, transparent 2px), repeating-linear-gradient(90deg, #0003 0 2px, transparent 2px 32px)",
                      "vertical-panel": "repeating-linear-gradient(90deg, #0003 0 2px, #fff3 2px 4px, transparent 4px 16px)",
                      "stone-block-panel": "repeating-linear-gradient(0deg, #0003 0 3px, transparent 3px 17px), repeating-linear-gradient(90deg, #fff5 0 3px, #0002 3px 25px, transparent 25px 47px)",
                    })[texture.id],
                    backgroundSize: texture.id === "plaster" ? "4px 4px" : texture.id === "brick" ? "32px 16px" : undefined,
                  } }))} />
                <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                  Wall color
                  <input
                    type="color"
                    value={selectedWall.wallColor ?? selectedWallPaint.hex}
                    onChange={(e) => onWallUpdate?.(selectedWall.id, "wallColor", e.target.value)}
                    className="h-8 w-12 rounded border border-border bg-transparent"
                  />
                </label>
                </fieldset>
                <div className="space-y-2 rounded-xl border border-border p-3 text-xs">
                  <div>Length (m) <output aria-label="Length (m)">{calibrated ? getWallLengthM(selectedWall, pw, ph).toFixed(2) : "—"}</output></div>
                  <div>Width / thickness (m) <output>{calibrated || selectedWall.thickness > 0 ? getWallThicknessM(selectedWall, pw, ph).toFixed(2) : "—"}</output></div>
                  <div>Height (m) <output>{safeNum(selectedWall.wallHeight, maxH)}</output></div>
                  <button onClick={onBack} className="text-primary underline">Edit wall dimensions in Review</button>
                </div>
                {/* <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setBuildMode("door")} className="inline-flex items-center justify-center gap-1 rounded-xl border border-border bg-background px-3 py-2 text-[11px] text-foreground hover:bg-accent">
                    <Plus className="h-3 w-3" /> Door
                  </button>
                  <button onClick={() => setBuildMode("window")} className="inline-flex items-center justify-center gap-1 rounded-xl border border-border bg-background px-3 py-2 text-[11px] text-foreground hover:bg-accent">
                    <Plus className="h-3 w-3" /> Window
                  </button>
                </div> */}
              </div>
            )}

            {(selectedDoor || selectedWindow) && (
              <fieldset className="space-y-3 rounded-xl border border-border p-3">
                <legend className="px-1 text-sm font-semibold">รุ่นและสีวัสดุ</legend>
                {selectedDoor ? (
                  <>
                    <label className="block text-[11px] text-muted-foreground">
                      SCG door product
                      <select
                        value={selectedDoor.scgDoorCode ?? selectedDoorOption.code}
                        onChange={(e) => applyDoorProduct(selectedDoor.id, e.target.value)}
                        className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs text-foreground"
                      >
                        {SCG_DOOR_CATALOG.map((product) => (
                          <option key={product.code} value={product.code}>
                            {product.code}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[10px] text-muted-foreground/70">
                        {selectedDoor.doorName ?? selectedDoorOption.name} / {selectedDoor.doorMaterial ?? selectedDoorOption.material} / {selectedDoorOption.usage}
                      </span>
                    </label>
                    <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                      Door color
                      <input
                        type="color"
                        value={selectedDoor.doorColor ?? selectedDoorOption.doorHex}
                        onChange={(e) => onDoorUpdate?.(selectedDoor.id, "doorColor", e.target.value)}
                        className="h-8 w-12 rounded border border-border bg-transparent"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                      Frame color
                      <input
                        type="color"
                        value={selectedDoor.frameColor ?? selectedDoorOption.frameHex}
                        onChange={(e) => onDoorUpdate?.(selectedDoor.id, "frameColor", e.target.value)}
                        className="h-8 w-12 rounded border border-border bg-transparent"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground">
                      ใช้โมเดลรายละเอียดสูง
                      <input
                        type="checkbox"
                        checked={selectedDoor.useBlenderModel === "true"}
                        onChange={(e) => onDoorUpdate?.(selectedDoor.id, "useBlenderModel", e.target.checked ? "true" : "false")}
                        className="h-4 w-4"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="block text-[11px] text-muted-foreground">
                      SCG window product
                      <select
                        value={selectedWindow?.scgWindowCode ?? selectedWindowOption.code}
                        onChange={(e) => selectedWindow && applyWindowProduct(selectedWindow.id, e.target.value)}
                        className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs text-foreground"
                      >
                        {SCG_WINDOW_CATALOG.map((product) => (
                          <option key={product.code} value={product.code}>
                            {product.code}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[10px] text-muted-foreground/70">
                        {selectedWindow?.windowName ?? selectedWindowOption.name} / {selectedWindow?.windowMaterial ?? selectedWindowOption.material} / {selectedWindowOption.usage}
                      </span>
                    </label>
                    <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                      Frame color
                      <input
                        type="color"
                        value={selectedWindow?.frameColor ?? selectedWindowOption.frameHex}
                        onChange={(e) => selectedWindow && onWindowUpdate?.(selectedWindow.id, "frameColor", e.target.value)}
                        className="h-8 w-12 rounded border border-border bg-transparent"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                      Glass color
                      <input
                        type="color"
                        value={selectedWindow?.glassColor ?? selectedWindowOption.glassHex}
                        onChange={(e) => selectedWindow && onWindowUpdate?.(selectedWindow.id, "glassColor", e.target.value)}
                        className="h-8 w-12 rounded border border-border bg-transparent"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground">
                      ใช้โมเดลรายละเอียดสูง
                      <input
                        type="checkbox"
                        checked={selectedWindow?.useBlenderModel === "true"}
                        onChange={(e) => selectedWindow && onWindowUpdate?.(selectedWindow.id, "useBlenderModel", e.target.checked ? "true" : "false")}
                        className="h-4 w-4"
                      />
                    </label>
                  </>
                )}
              </fieldset>
            )}

            {selection && !selectedRoom && (
              <button
                onClick={deleteSelection}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/15"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete selected
              </button>
            )}
            </div>}
          </div>

          <details className="pointer-events-auto shrink-0 rounded-2xl border border-border bg-card/95 p-3 shadow-xl backdrop-blur-md">
            <summary className="cursor-pointer text-sm font-medium">วัสดุในโปรเจกต์</summary>
            <div className="mb-2 flex items-center gap-2">
              <div>
                <p className="text-[11px] font-semibold text-foreground">Material schedule</p>
                <p className="text-[9px] text-muted-foreground">Assigned finishes in this 3D model</p>
              </div>
            </div>
            {!hasAssignedMaterials && (
              <p className="rounded-xl border border-dashed border-border px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
                No materials assigned yet. Select an object to start decorating.
              </p>
            )}
            <div className={hasAssignedMaterials ? "space-y-2 text-[10px]" : "hidden"}>
              {[
                ["Walls", materialSummary.walls],
                ["Floors", materialSummary.floors],
                ["Openings", materialSummary.openings],
              ].map(([label, items]) => (
                <div key={label as string} className="grid grid-cols-[56px_1fr] gap-2">
                  <span className="font-medium text-muted-foreground">{label}</span>
                  <span className="line-clamp-2 leading-4 text-foreground">{(items as string[]).join(" · ") || "Not assigned"}</span>
                </div>
              ))}
            </div>
          </details>

          </div>

        </PlanScaleCtx.Provider>
      )}
    </div>
  );
};

export default RightPanel;
