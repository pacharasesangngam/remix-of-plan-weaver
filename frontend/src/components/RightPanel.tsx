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
  return {
    x: cx * factor,
    y: cy * factor,
  };
};

const getRoomCenter = (room: Room): NormalizedPoint | null =>
  room.center ?? polygonCentroid(getRoomPolygon(room)) ?? (room.bbox
    ? { x: room.bbox.x + room.bbox.w / 2, y: room.bbox.y + room.bbox.h / 2 }
    : null);

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
      if (event.code in keysRef.current) keysRef.current[event.code as keyof typeof keysRef.current] = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code in keysRef.current) keysRef.current[event.code as keyof typeof keysRef.current] = false;
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

const getWidthM = (bboxW?: number, real?: number, planSize = PLAN_SIZE): number => {
  if (typeof real === "number" && real > 0) return real;
  if (typeof bboxW === "number" && bboxW > 0) return bboxW * planSize;
  return 0;
};

const getWallThicknessM = (wall: DetectedWallSegment): number => {
  if (typeof wall.thickness === "number" && wall.thickness > 0) return wall.thickness;
  if (typeof wall.thicknessRatio === "number" && wall.thicknessRatio > 0) {
    return wall.thicknessRatio * PLAN_SIZE;
  }
  return wall.type === "exterior" ? 0.25 : 0.15;
};

const isHorizontalSegment = (wall: DetectedWallSegment): boolean =>
  Math.abs(wall.x2 - wall.x1) >= Math.abs(wall.y2 - wall.y1);

const getWallEndpointAdjustment = (
  wall: DetectedWallSegment,
  walls: DetectedWallSegment[],
  endpointValue: number,
): number => {
  const horizontal = isHorizontalSegment(wall);
  const constantAxis = horizontal ? wall.y1 : wall.x1;
  let adjustment = 0;

  for (const candidate of walls) {
    if (candidate.id === wall.id || isHorizontalSegment(candidate) === horizontal) continue;

    const candidateAxis = horizontal ? candidate.x1 : candidate.y1;
    const rangeMin = horizontal ? Math.min(candidate.y1, candidate.y2) : Math.min(candidate.x1, candidate.x2);
    const rangeMax = horizontal ? Math.max(candidate.y1, candidate.y2) : Math.max(candidate.x1, candidate.x2);
    const touchesEndpoint =
      Math.abs(candidateAxis - endpointValue) <= 0.0015 &&
      constantAxis >= rangeMin - 0.0015 &&
      constantAxis <= rangeMax + 0.0015;

    if (!touchesEndpoint) continue;

    const candidateThicknessHalf = getWallThicknessM(candidate) / 2;
    const candidateStartsHere = horizontal
      ? Math.abs(candidate.y1 - constantAxis) <= 0.0015 || Math.abs(candidate.y2 - constantAxis) <= 0.0015
      : Math.abs(candidate.x1 - constantAxis) <= 0.0015 || Math.abs(candidate.x2 - constantAxis) <= 0.0015;

    if (candidateStartsHere) {
      adjustment = Math.max(adjustment, candidateThicknessHalf);
    } else {
      adjustment = Math.min(adjustment, -candidateThicknessHalf);
    }
  }

  return adjustment;
};

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

// ── Animated room mesh ────────────────────────────────────────────────────────
function RoomMesh({ room, position, index, hovered, onHover }) {
  const groupRef = useRef<THREE.Group>(null);
  // ใช้ ref เก็บ material เพื่อ mutate color โดยไม่ trigger re-render
  const floorMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const isHoveredRef = useRef(false);

  const w = Math.max(safeNum(room.bbox?.w) * PLAN_SIZE, 0.5);
  const d = Math.max(safeNum(room.bbox?.h) * PLAN_SIZE, 0.5);
  const floorThickness = 0.15;

  const pal = ROOM_PALETTE[index % ROOM_PALETTE.length];

  // สีพื้นฐานเป็น THREE.Color object — สร้างครั้งเดียวใน ref
  const baseColorRef = useRef(new THREE.Color(pal.floor));
  const hoverColorRef = useRef(new THREE.Color(FLOOR_HOVER_COLOR));

  useFrame((_, delta) => {
    if (!groupRef.current) return;

    // Animate Y position
    const targetY = hovered ? 0.04 : 0;
    groupRef.current.position.y = THREE.MathUtils.lerp(
      groupRef.current.position.y,
      targetY,
      delta * 6,
    );

    // Lerp color โดยตรงบน material — ไม่ trigger React re-render
    if (floorMatRef.current) {
      const targetColor = hovered ? hoverColorRef.current : baseColorRef.current;
      floorMatRef.current.color.lerp(targetColor, delta * 8);
    }

    isHoveredRef.current = hovered;
  });

  return (
    <group
      ref={groupRef}
      position={position}
      onPointerEnter={() => onHover(room.id)}
      onPointerLeave={() => onHover(null)}
    >
      <mesh position={[0, -floorThickness / 2, 0]}>
        <boxGeometry args={[w, floorThickness, d]} />
        {/* ref material เพื่อ mutate color ใน useFrame */}
        <meshStandardMaterial
          ref={floorMatRef}
          color={pal.floor}
          roughness={0.85}
          metalness={0.02}
        />
      </mesh>

      <Text
        position={[0, 0.3, 0]}
        fontSize={0.26}
        color="#374151"
        anchorX="center"
        anchorY="middle"
      >
        {room.name ?? "Room"}
      </Text>

      <Text
        position={[0, 0.05, d / 2 + 0.3]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.18}
        color="#6b7280"
        anchorX="center"
        anchorY="middle"
      >
        {`${w.toFixed(1)}m`}
      </Text>
      <Text
        position={[w / 2 + 0.3, 0.05, 0]}
        rotation={[-Math.PI / 2, 0, Math.PI / 2]}
        fontSize={0.18}
        color="#6b7280"
        anchorX="center"
        anchorY="middle"
      >
        {`${d.toFixed(1)}m`}
      </Text>
    </group>
  );
}

// ── Detected Wall Segment as 3D box ──────────────────────────────────────────
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
    const points = polygon.map((p) => toPlanPoint(p));
    const nextShape = new THREE.Shape();
    nextShape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      nextShape.lineTo(points[i][0], points[i][1]);
    }
    nextShape.closePath();
    return nextShape;
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
    groupRef.current.position.y = THREE.MathUtils.lerp(groupRef.current.position.y, targetY, delta * 6);

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
      <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
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

function WallSegmentMesh({
  wall,
  walls,
  wallHeight: defaultWallHeight,
}: {
  wall: DetectedWallSegment;
  walls: DetectedWallSegment[];
  wallHeight: number;
}) {
  const wallHeight = safeNum(wall.wallHeight, defaultWallHeight);
  const thickness = getWallThicknessM(wall);
  const horizontal = isHorizontalSegment(wall);

  let startX = wall.x1;
  let startY = wall.y1;
  let endX = wall.x2;
  let endY = wall.y2;

  if (horizontal) {
    const leftToRight = wall.x1 <= wall.x2;
    const leftAdjust = getWallEndpointAdjustment(wall, walls, leftToRight ? wall.x1 : wall.x2) / PLAN_SIZE;
    const rightAdjust = getWallEndpointAdjustment(wall, walls, leftToRight ? wall.x2 : wall.x1) / PLAN_SIZE;

    if (leftToRight) {
      startX -= leftAdjust;
      endX += rightAdjust;
    } else {
      startX += leftAdjust;
      endX -= rightAdjust;
    }
  } else {
    const topToBottom = wall.y1 <= wall.y2;
    const topAdjust = getWallEndpointAdjustment(wall, walls, topToBottom ? wall.y1 : wall.y2) / PLAN_SIZE;
    const bottomAdjust = getWallEndpointAdjustment(wall, walls, topToBottom ? wall.y2 : wall.y1) / PLAN_SIZE;

    if (topToBottom) {
      startY -= topAdjust;
      endY += bottomAdjust;
    } else {
      startY += topAdjust;
      endY -= bottomAdjust;
    }
  }

  const x1 = startX * PLAN_SIZE - PLAN_SIZE / 2;
  const z1 = startY * PLAN_SIZE - PLAN_SIZE / 2;
  const x2 = endX * PLAN_SIZE - PLAN_SIZE / 2;
  const z2 = endY * PLAN_SIZE - PLAN_SIZE / 2;

  const dx = x2 - x1;
  const dz = z2 - z1;
  const rawLength = Math.sqrt(dx * dx + dz * dz);
  const angle = Math.atan2(dz, dx);

  const effectiveLength = Math.max(0.01, rawLength);

  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;

  const isExterior = wall.type === "exterior";
  const color = isExterior ? "#d1d5db" : "#e5e7eb";
  const emissive = isExterior ? "#6b7280" : "#9ca3af";
  const typeColor = isExterior ? "#e2e8f0" : "#94a3b8";

  return (
    <group position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
      <mesh position={[0, wallHeight / 2, 0]}>
        <boxGeometry args={[effectiveLength, wallHeight, thickness]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={0.3}
          roughness={0.7}
          metalness={0.05}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>

      <Text position={[0, wallHeight + 0.2, 0]} fontSize={0.16} color={typeColor} anchorX="center" anchorY="middle">
        {`${rawLength.toFixed(1)}m`}
      </Text>
      <Text
        position={[effectiveLength / 2 + 0.15, wallHeight / 2, thickness / 2 + 0.05]}
        fontSize={0.12}
        color="#94a3b8"
        anchorX="left"
        anchorY="middle"
        rotation={[0, 0, Math.PI / 2]}
      >
        {`H ${wallHeight.toFixed(1)}m`}
      </Text>
      <Text position={[0, wallHeight + 0.4, 0]} fontSize={0.11} color={typeColor} anchorX="center" anchorY="middle">
        {`${isExterior ? "EXT" : "INT"} · ${(thickness * 100).toFixed(0)}cm`}
      </Text>
    </group>
  );
}

// ── Detected Door as 3D opening ──────────────────────────────────────────────
function DoorMesh({ door, wallHeight }: { door: DetectedDoor; wallHeight: number }) {
  if (!door.bbox) return null;
  const cx = (door.bbox.x + door.bbox.w / 2) * PLAN_SIZE - PLAN_SIZE / 2;
  const cz = (door.bbox.y + door.bbox.h / 2) * PLAN_SIZE - PLAN_SIZE / 2;
  const doorW = Math.max(getWidthM(door.bbox.w, door.widthM), 0.8);
  const doorH = Math.min(wallHeight * 0.85, 2.1);
  const doorD = 0.12;

  const bboxW = door.bbox.w * PLAN_SIZE;
  const bboxH = door.bbox.h * PLAN_SIZE;
  const isHorizontal = bboxW > bboxH;
  const rotY = isHorizontal ? 0 : Math.PI / 2;

  return (
    <group position={[cx, 0, cz]} rotation={[0, rotY, 0]}>
      <mesh position={[-doorW / 2 - 0.04, doorH / 2, 0]}>
        <boxGeometry args={[0.08, doorH, doorD + 0.06]} />
        <meshStandardMaterial color="#78350f" roughness={0.5} metalness={0.1} />
      </mesh>
      <mesh position={[doorW / 2 + 0.04, doorH / 2, 0]}>
        <boxGeometry args={[0.08, doorH, doorD + 0.06]} />
        <meshStandardMaterial color="#78350f" roughness={0.5} metalness={0.1} />
      </mesh>
      <mesh position={[0, doorH + 0.04, 0]}>
        <boxGeometry args={[doorW + 0.16, 0.08, doorD + 0.06]} />
        <meshStandardMaterial color="#78350f" roughness={0.5} metalness={0.1} />
      </mesh>
      <mesh position={[doorW / 4, doorH / 2, doorD / 2 + 0.02]} castShadow>
        <boxGeometry args={[doorW * 0.48, doorH - 0.05, 0.05]} />
        <meshStandardMaterial color="#fef3c7" emissive="#f59e0b" emissiveIntensity={0.15} roughness={0.4} metalness={0.08} transparent opacity={0.9} />
      </mesh>
      <Text position={[0, doorH + 0.3, 0]} fontSize={0.15} color="#f59e0b" anchorX="center" anchorY="middle">
        {`D ${doorW.toFixed(1)}m`}
      </Text>
    </group>
  );
}

// ── Detected Window as 3D glass pane ─────────────────────────────────────────
function WindowMesh({ win, wallHeight }: { win: DetectedWindow; wallHeight: number }) {
  if (!win.bbox) return null;
  const cx = (win.bbox.x + win.bbox.w / 2) * PLAN_SIZE - PLAN_SIZE / 2;
  const cz = (win.bbox.y + win.bbox.h / 2) * PLAN_SIZE - PLAN_SIZE / 2;
  const winW = Math.max(getWidthM(win.bbox.w, win.widthM), 0.6);
  const winH = Math.min(wallHeight * 0.45, 1.2);
  const winD = 0.08;
  const sillY = wallHeight * 0.35;

  const bboxW = win.bbox.w * PLAN_SIZE;
  const bboxH = win.bbox.h * PLAN_SIZE;
  const isHorizontal = bboxW > bboxH;
  const rotY = isHorizontal ? 0 : Math.PI / 2;

  return (
    <group position={[cx, sillY, cz]} rotation={[0, rotY, 0]}>
      <mesh castShadow>
        <boxGeometry args={[winW + 0.1, winH + 0.1, winD + 0.04]} />
        <meshStandardMaterial color="#cbd5e1" roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[-winW / 4, 0, 0]}>
        <boxGeometry args={[winW / 2 - 0.04, winH - 0.06, winD - 0.02]} />
        <meshStandardMaterial color="#bae6fd" emissive="#38bdf8" emissiveIntensity={0.4} roughness={0.1} metalness={0.5} transparent opacity={0.55} />
      </mesh>
      <mesh position={[winW / 4, 0, 0]}>
        <boxGeometry args={[winW / 2 - 0.04, winH - 0.06, winD - 0.02]} />
        <meshStandardMaterial color="#67e8f9" emissive="#06b6d4" emissiveIntensity={0.15} roughness={0.1} metalness={0.5} transparent opacity={0.35} />
      </mesh>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.04, winH - 0.06, winD]} />
        <meshStandardMaterial color="#94a3b8" roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[winW - 0.06, 0.04, winD]} />
        <meshStandardMaterial color="#94a3b8" roughness={0.4} metalness={0.3} />
      </mesh>
      <Text position={[0, winH / 2 + 0.25, 0]} fontSize={0.13} color="#06b6d4" anchorX="center" anchorY="middle">
        {`W ${winW.toFixed(1)}m`}
      </Text>
    </group>
  );
}

// ── Compute 3D positions from room bbox ───────────────────────────────────────
function computePositions(rooms: Room[]): [number, number, number][] {
  const hasBbox = rooms.every((r) => r.bbox);

  if (hasBbox) {
    return rooms.map((r) => {
      const bbox = r.bbox!;
      const cx = (bbox.x + bbox.w / 2) * PLAN_SIZE - PLAN_SIZE / 2;
      const cz = (bbox.y + bbox.h / 2) * PLAN_SIZE - PLAN_SIZE / 2;
      return [cx, 0, cz];
    });
  }

  const cols = Math.ceil(Math.sqrt(rooms.length));
  return rooms.map((_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return [col * 8 - cols * 4, 0, row * 8 - Math.floor(rooms.length / cols) * 4] as [number, number, number];
  });
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
        <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">{room.confidence}</p>
      </div>
    </div>
  );
}

// ── Scene ─────────────────────────────────────────────────────────────────────
function Scene({
  rooms, scale, walls, doors, windows, walkMode, viewPreset, cameraDistance, onHoverChange,
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
  const renderWalls = snapRenderedWallJunctions(walls);

  const defaultWallHeight = rooms.length > 0
    ? Math.max(...rooms.map((r) => safeNum(r.wallHeight, 2.8)), 2.8)
    : 2.8;

  const handleHover = (id: string | null) => {
    setHoveredId(id);
    onHoverChange(id);
  };

  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[10, 16, 10]} intensity={1.2} />
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

      {rooms.map((room, i) => (
        <RoomPolygonMesh
          key={room.id}
          room={room}
          index={i}
          hovered={hoveredId === room.id}
          onHover={handleHover}
        />
      ))}

      {renderWalls.map((wall) => (
        <WallSegmentMesh key={wall.id} wall={wall} walls={renderWalls} wallHeight={defaultWallHeight} />
      ))}

      {doors.map((door) => (
        <DoorMesh key={door.id} door={door} wallHeight={defaultWallHeight} />
      ))}

      {windows.map((win) => (
        <WindowMesh key={win.id} win={win} wallHeight={defaultWallHeight} />
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
  rooms, generated, scale, walls = [], doors = [], windows = [], onBack,
}: RightPanelProps) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [walkMode, setWalkMode] = useState(false);
  const [viewPreset, setViewPreset] = useState<ViewPreset>("perspective");
  const hoveredRoom = rooms.find((r) => r.id === hoveredId) ?? null;

  const maxH = rooms.length > 0 ? Math.max(...rooms.map((r) => safeNum(r.wallHeight, 2.8)), 3) : 3;
  const planSpan = rooms.reduce((max, room) => {
    const bounds = getRoomBounds(room);
    if (!bounds) return max;
    return Math.max(max, Math.max(bounds.w, bounds.h) * PLAN_SIZE);
  }, PLAN_SIZE);
  const camDist = Math.max(planSpan * 1.4, 15);

  const totalArea = rooms.reduce((s, room) => s + polygonArea(getRoomPolygon(room)), 0);

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
            camera={{ position: [camDist * 0.7, camDist * 0.5, camDist * 0.7], fov: 45 }}
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
                {walkMode ? "Click scene · WASD move · Mouse look · Esc unlock" : "Drag · Scroll · Right-click pan"}
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
              {walls.length > 0   && <span className="pl-3 text-muted-foreground">{walls.length} walls</span>}
              {doors.length > 0   && <span className="pl-3 text-amber-400">{doors.length} doors</span>}
              {windows.length > 0 && <span className="pl-3 text-cyan-400">{windows.length} windows</span>}
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
