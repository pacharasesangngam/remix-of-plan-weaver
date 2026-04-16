import { useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Text } from "@react-three/drei";
import * as THREE from "three";
import { Box, ChevronLeft, Info } from "lucide-react";
import type { Room } from "@/types/floorplan";
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

const getWidthM = (bboxW?: number, real?: number, planSize = PLAN_SIZE): number => {
  if (typeof real === "number" && real > 0) return real;
  if (typeof bboxW === "number" && bboxW > 0) return bboxW * planSize;
  return 0;
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
      <mesh position={[0, -floorThickness / 2, 0]} castShadow receiveShadow>
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
function WallSegmentMesh({
  wall,
  wallHeight: defaultWallHeight,
}: {
  wall: DetectedWallSegment;
  wallHeight: number;
}) {
  const x1 = wall.x1 * PLAN_SIZE - PLAN_SIZE / 2;
  const z1 = wall.y1 * PLAN_SIZE - PLAN_SIZE / 2;
  const x2 = wall.x2 * PLAN_SIZE - PLAN_SIZE / 2;
  const z2 = wall.y2 * PLAN_SIZE - PLAN_SIZE / 2;

  const dx = x2 - x1;
  const dz = z2 - z1;
  const rawLength = Math.sqrt(dx * dx + dz * dz);
  const angle = Math.atan2(dz, dx);

  const wallHeight = safeNum(wall.wallHeight, defaultWallHeight);
  const thickness = safeNum(wall.thickness, wall.type === "exterior" ? 0.25 : 0.15);

  const halfT = thickness / 2;
  const effectiveLength = Math.max(0.01, rawLength - halfT * 2);

  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;

  const isExterior = wall.type === "exterior";
  const color = isExterior ? "#d1d5db" : "#e5e7eb";
  const emissive = isExterior ? "#6b7280" : "#9ca3af";
  const typeColor = isExterior ? "#e2e8f0" : "#94a3b8";

  return (
    <group position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
      <mesh position={[0, wallHeight / 2, 0]} castShadow receiveShadow>
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
      <mesh position={[-doorW / 2 - 0.04, doorH / 2, 0]} castShadow>
        <boxGeometry args={[0.08, doorH, doorD + 0.06]} />
        <meshStandardMaterial color="#78350f" roughness={0.5} metalness={0.1} />
      </mesh>
      <mesh position={[doorW / 2 + 0.04, doorH / 2, 0]} castShadow>
        <boxGeometry args={[0.08, doorH, doorD + 0.06]} />
        <meshStandardMaterial color="#78350f" roughness={0.5} metalness={0.1} />
      </mesh>
      <mesh position={[0, doorH + 0.04, 0]} castShadow>
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
  const w = safeNum(room.bbox?.w) * PLAN_SIZE;
  const d = safeNum(room.bbox?.h) * PLAN_SIZE;
  const h = safeNum(room.wallHeight, 2.8);
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-2xl bg-black/70 backdrop-blur-md border border-white/10 shadow-2xl flex items-center gap-4 min-w-[280px] pointer-events-none">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-foreground truncate">{room.name}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
          {w.toFixed(2)}m × {d.toFixed(2)}m · H: {h.toFixed(2)}m
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-[11px] font-mono text-primary">{(w * d).toFixed(1)} m²</p>
        <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">{room.confidence}</p>
      </div>
    </div>
  );
}

// ── Scene ─────────────────────────────────────────────────────────────────────
function Scene({
  rooms, scale, walls, doors, windows, onHoverChange,
}: {
  rooms: Room[];
  scale: number;
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  onHoverChange: (id: string | null) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const positions = computePositions(rooms);

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
      <directionalLight position={[10, 16, 10]} intensity={1.2} castShadow shadow-mapSize={[2048, 2048]} />
      <pointLight position={[-8, 10, -8]} intensity={0.5} color="#60a5fa" />
      <pointLight position={[8, 6, 8]} intensity={0.3} color="#a78bfa" />

      <Grid
        infiniteGrid
        cellSize={1}
        sectionSize={5}
        cellColor="#374151"
        sectionColor="#6b7280"
        fadeDistance={40}
      />

      {rooms.map((room, i) => (
        <RoomMesh
          key={room.id}
          room={room}
          position={positions[i]}
          index={i}
          hovered={hoveredId === room.id}
          onHover={handleHover}
        />
      ))}

      {walls.map((wall) => (
        <WallSegmentMesh key={wall.id} wall={wall} wallHeight={defaultWallHeight} />
      ))}

      {doors.map((door) => (
        <DoorMesh key={door.id} door={door} wallHeight={defaultWallHeight} />
      ))}

      {windows.map((win) => (
        <WindowMesh key={win.id} win={win} wallHeight={defaultWallHeight} />
      ))}

      <OrbitControls
        enablePan
        enableZoom
        enableRotate
        maxPolarAngle={Math.PI / 2.05}
        minDistance={3}
        maxDistance={60}
        makeDefault
      />
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
const RightPanel = ({
  rooms, generated, scale, walls = [], doors = [], windows = [], onBack,
}: RightPanelProps) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoveredRoom = rooms.find((r) => r.id === hoveredId) ?? null;

  const totalW = rooms.reduce((s, r) => s + safeNum(r.bbox?.w) * PLAN_SIZE, 0);
  const maxH = rooms.length > 0 ? Math.max(...rooms.map((r) => safeNum(r.wallHeight, 2.8)), 3) : 3;
  const camDist = Math.max(totalW * 0.8, 15);

  const totalArea = rooms.reduce((s, r) => {
    const w = safeNum(r.bbox?.w) * PLAN_SIZE;
    const d = safeNum(r.bbox?.h) * PLAN_SIZE;
    return s + w * d;
  }, 0);

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
            shadows
          >
            <Scene
              rooms={rooms}
              scale={scale}
              walls={walls}
              doors={doors}
              windows={windows}
              onHoverChange={setHoveredId}
            />
          </Canvas>

          {onBack && (
            <div className="absolute top-4 left-4 flex items-center gap-2 z-10">
              <button
                onClick={onBack}
                className="flex items-center gap-2 px-3 py-2 rounded-xl bg-black/60 hover:bg-black/80 border border-white/10 hover:border-white/20 backdrop-blur-md text-xs text-white/80 hover:text-white transition-all duration-200 shadow-lg group"
              >
                <ChevronLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
                Back to Review
              </button>
              <div className="px-2 py-1 rounded-lg bg-black/40 border border-white/[0.06] backdrop-blur-md text-[10px] text-white/40 font-mono">
                Drag · Scroll · Right-click pan
              </div>
            </div>
          )}

          <div className="absolute top-4 right-4 flex items-center gap-3 bg-black/50 border border-white/[0.07] backdrop-blur-md rounded-xl px-3 py-2 z-10">
            <Info className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <div className="flex items-center gap-3 text-[10px] font-mono divide-x divide-white/10">
              <span className="text-muted-foreground">{rooms.length} rooms</span>
              {walls.length > 0   && <span className="pl-3 text-slate-400">{walls.length} walls</span>}
              {doors.length > 0   && <span className="pl-3 text-amber-400">{doors.length} doors</span>}
              {windows.length > 0 && <span className="pl-3 text-cyan-400">{windows.length} windows</span>}
              <span className="pl-3 text-muted-foreground">{totalArea.toFixed(1)} m²</span>
              <span className="pl-3 text-muted-foreground">H: {maxH.toFixed(1)}m</span>
            </div>
          </div>

          {hoveredRoom && <RoomInfoCard room={hoveredRoom} />}
        </>
      )}
    </div>
  );
};

export default RightPanel;