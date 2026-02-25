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

// ── Per-room colour palette based on confidence ───────────────────────────────
const CONF_COLORS: Record<Room["confidence"], { wall: string; floor: string; emissive: string }> = {
  high: { wall: "#2d4a6b", floor: "#1a2f42", emissive: "#0d2035" },
  low: { wall: "#4a3b20", floor: "#2d2410", emissive: "#20180a" },
  manual: { wall: "#2d3545", floor: "#1a2030", emissive: "#10141e" },
};

// Room index colours for variety
const ROOM_PALETTE = [
  { wall: "#1e3a5f", floor: "#0f2035" },
  { wall: "#1f3d35", floor: "#0f2018" },
  { wall: "#3d2050", floor: "#200f2d" },
  { wall: "#3d2a15", floor: "#201508" },
  { wall: "#1a3550", floor: "#0d1e30" },
];

// Plan size constant — maps normalised 0-1 bbox to world units
const PLAN_SIZE = 20;

// ── Animated room mesh ────────────────────────────────────────────────────────
function RoomMesh({
  room,
  position,
  index,
  hovered,
  onHover,
}: {
  room: Room;
  position: [number, number, number];
  index: number;
  hovered: boolean;
  onHover: (id: string | null) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const w = room.width;
  const d = room.height;           // depth (floor plan "height")
  const h = room.wallHeight ?? 2.8; // ACTUAL wall height from detection
  const t = 0.12;                  // wall thickness

  const pal = ROOM_PALETTE[index % ROOM_PALETTE.length];
  const wallColor = hovered ? "#3a6fa8" : pal.wall;
  const floorColor = pal.floor;

  // Gentle float on hover
  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const target = hovered ? 0.08 : 0;
    groupRef.current.position.y = THREE.MathUtils.lerp(
      groupRef.current.position.y,
      target,
      delta * 6,
    );
  });

  const walls = [
    // Front
    { pos: [0, h / 2, d / 2] as [number, number, number], size: [w, h, t] as [number, number, number] },
    // Back
    { pos: [0, h / 2, -d / 2] as [number, number, number], size: [w, h, t] as [number, number, number] },
    // Left
    { pos: [-w / 2, h / 2, 0] as [number, number, number], size: [t, h, d] as [number, number, number] },
    // Right
    { pos: [w / 2, h / 2, 0] as [number, number, number], size: [t, h, d] as [number, number, number] },
  ];

  return (
    <group
      ref={groupRef}
      position={position}
      onPointerEnter={() => onHover(room.id)}
      onPointerLeave={() => onHover(null)}
    >
      {/* Floor tile */}
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[w - t, d - t]} />
        <meshStandardMaterial color={floorColor} roughness={0.8} metalness={0.1} />
      </mesh>

      {/* Ceiling edge glow (thin plane at top) */}
      <mesh position={[0, h, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial
          color={hovered ? "#60a5fa" : "#1e3a5f"}
          emissive={hovered ? "#1e4a8f" : "#0a1828"}
          emissiveIntensity={0.8}
          transparent
          opacity={0.2}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Walls */}
      {walls.map((wall, i) => (
        <mesh key={i} position={wall.pos} castShadow receiveShadow>
          <boxGeometry args={wall.size} />
          <meshStandardMaterial
            color={wallColor}
            roughness={0.6}
            metalness={0.05}
            transparent
            opacity={hovered ? 0.95 : 0.88}
          />
        </mesh>
      ))}

      {/* Room label */}
      <Text
        position={[0, h + 0.25, 0]}
        fontSize={0.28}
        color={hovered ? "#93c5fd" : "#64748b"}
        anchorX="center"
        anchorY="middle"
        font={undefined}
      >
        {room.name}
      </Text>

      {/* Dimension labels on floor */}
      <Text
        position={[0, 0.05, d / 2 + 0.3]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.18}
        color="#475569"
        anchorX="center"
        anchorY="middle"
      >
        {room.width.toFixed(1)}m
      </Text>
      <Text
        position={[w / 2 + 0.3, 0.05, 0]}
        rotation={[-Math.PI / 2, 0, Math.PI / 2]}
        fontSize={0.18}
        color="#475569"
        anchorX="center"
        anchorY="middle"
      >
        {room.height.toFixed(1)}m
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
  // Convert normalised coords to world coords
  const x1 = wall.x1 * PLAN_SIZE - PLAN_SIZE / 2;
  const z1 = wall.y1 * PLAN_SIZE - PLAN_SIZE / 2;
  const x2 = wall.x2 * PLAN_SIZE - PLAN_SIZE / 2;
  const z2 = wall.y2 * PLAN_SIZE - PLAN_SIZE / 2;

  const dx = x2 - x1;
  const dz = z2 - z1;
  const rawLength = Math.sqrt(dx * dx + dz * dz);
  const angle = Math.atan2(dz, dx);

  const wallHeight = wall.wallHeight ?? defaultWallHeight;
  const thickness = wall.thickness ?? (wall.type === "exterior" ? 0.25 : 0.15);

  // ── Miter compensation ──────────────────────────────────────────────────────
  // Shorten each wall by half its own thickness on both ends so adjacent
  // walls that meet at a T-junction or corner no longer overlap.
  // The half-thickness "ear" is donated to the wall running perpendicular.
  const halfT = thickness / 2;
  const effectiveLength = Math.max(0.01, rawLength - halfT * 2);

  // Midpoint of the trimmed segment (same as original mid — trimming is symmetric)
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;

  const isExterior = wall.type === "exterior";
  const color = isExterior ? "#4a5568" : "#6b7280";
  const emissive = isExterior ? "#1a2332" : "#1f2937";
  const typeColor = isExterior ? "#e2e8f0" : "#94a3b8";

  return (
    <group position={[cx, 0, cz]} rotation={[0, -angle, 0]}>
      {/* Wall body — shortened by half-thickness on each end */}
      <mesh
        position={[0, wallHeight / 2, 0]}
        castShadow
        receiveShadow
      >
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

      {/* Length label — on top of wall */}
      <Text
        position={[0, wallHeight + 0.2, 0]}
        fontSize={0.16}
        color={typeColor}
        anchorX="center"
        anchorY="middle"
      >
        {`${rawLength.toFixed(1)}m`}
      </Text>

      {/* Height label — side of wall */}
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

      {/* Type + thickness label — below length */}
      <Text
        position={[0, wallHeight + 0.4, 0]}
        fontSize={0.11}
        color={wall.type === "exterior" ? "#cbd5e1" : "#9ca3af"}
        anchorX="center"
        anchorY="middle"
      >
        {`${isExterior ? "EXT" : "INT"} · ${(thickness * 100).toFixed(0)}cm`}
      </Text>
    </group>
  );
}

// ── Detected Door as 3D opening ──────────────────────────────────────────────
function DoorMesh({
  door,
  wallHeight,
}: {
  door: DetectedDoor;
  wallHeight: number;
}) {
  // Door position from bbox (normalised)
  const cx = (door.bbox.x + door.bbox.w / 2) * PLAN_SIZE - PLAN_SIZE / 2;
  const cz = (door.bbox.y + door.bbox.h / 2) * PLAN_SIZE - PLAN_SIZE / 2;
  const doorW = Math.max(door.widthM, 0.8);
  const doorH = Math.min(wallHeight * 0.85, 2.1);
  const doorD = 0.12;

  // Determine door orientation from bbox aspect ratio
  const bboxW = door.bbox.w * PLAN_SIZE;
  const bboxH = door.bbox.h * PLAN_SIZE;
  const isHorizontal = bboxW > bboxH;
  const rotY = isHorizontal ? 0 : Math.PI / 2;

  return (
    <group position={[cx, 0, cz]} rotation={[0, rotY, 0]}>
      {/* Door frame — left */}
      <mesh position={[-doorW / 2 - 0.04, doorH / 2, 0]} castShadow>
        <boxGeometry args={[0.08, doorH, doorD + 0.06]} />
        <meshStandardMaterial color="#92400e" roughness={0.5} metalness={0.1} />
      </mesh>
      {/* Door frame — right */}
      <mesh position={[doorW / 2 + 0.04, doorH / 2, 0]} castShadow>
        <boxGeometry args={[0.08, doorH, doorD + 0.06]} />
        <meshStandardMaterial color="#92400e" roughness={0.5} metalness={0.1} />
      </mesh>
      {/* Door frame — top */}
      <mesh position={[0, doorH + 0.04, 0]} castShadow>
        <boxGeometry args={[doorW + 0.16, 0.08, doorD + 0.06]} />
        <meshStandardMaterial color="#92400e" roughness={0.5} metalness={0.1} />
      </mesh>
      {/* Door panel (slightly open) */}
      <mesh position={[doorW / 4, doorH / 2, doorD / 2 + 0.02]} castShadow>
        <boxGeometry args={[doorW * 0.48, doorH - 0.05, 0.05]} />
        <meshStandardMaterial
          color="#b45309"
          emissive="#451a03"
          emissiveIntensity={0.2}
          roughness={0.4}
          metalness={0.08}
          transparent
          opacity={0.9}
        />
      </mesh>
      {/* Door label */}
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
  );
}

// ── Detected Window as 3D glass pane ─────────────────────────────────────────
function WindowMesh({
  win,
  wallHeight,
}: {
  win: DetectedWindow;
  wallHeight: number;
}) {
  const cx = (win.bbox.x + win.bbox.w / 2) * PLAN_SIZE - PLAN_SIZE / 2;
  const cz = (win.bbox.y + win.bbox.h / 2) * PLAN_SIZE - PLAN_SIZE / 2;
  const winW = Math.max(win.widthM, 0.6);
  const winH = Math.min(wallHeight * 0.45, 1.2);
  const winD = 0.08;
  const sillY = wallHeight * 0.35; // window sill height

  // Determine orientation
  const bboxW = win.bbox.w * PLAN_SIZE;
  const bboxH = win.bbox.h * PLAN_SIZE;
  const isHorizontal = bboxW > bboxH;
  const rotY = isHorizontal ? 0 : Math.PI / 2;

  return (
    <group position={[cx, sillY, cz]} rotation={[0, rotY, 0]}>
      {/* Window frame */}
      <mesh castShadow>
        <boxGeometry args={[winW + 0.1, winH + 0.1, winD + 0.04]} />
        <meshStandardMaterial color="#64748b" roughness={0.4} metalness={0.3} />
      </mesh>
      {/* Glass pane — left */}
      <mesh position={[-winW / 4, 0, 0]}>
        <boxGeometry args={[winW / 2 - 0.04, winH - 0.06, winD - 0.02]} />
        <meshStandardMaterial
          color="#67e8f9"
          emissive="#06b6d4"
          emissiveIntensity={0.15}
          roughness={0.1}
          metalness={0.5}
          transparent
          opacity={0.35}
        />
      </mesh>
      {/* Glass pane — right */}
      <mesh position={[winW / 4, 0, 0]}>
        <boxGeometry args={[winW / 2 - 0.04, winH - 0.06, winD - 0.02]} />
        <meshStandardMaterial
          color="#67e8f9"
          emissive="#06b6d4"
          emissiveIntensity={0.15}
          roughness={0.1}
          metalness={0.5}
          transparent
          opacity={0.35}
        />
      </mesh>
      {/* Cross bar (vertical divider) */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.04, winH - 0.06, winD]} />
        <meshStandardMaterial color="#94a3b8" roughness={0.4} metalness={0.3} />
      </mesh>
      {/* Cross bar (horizontal divider) */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[winW - 0.06, 0.04, winD]} />
        <meshStandardMaterial color="#94a3b8" roughness={0.4} metalness={0.3} />
      </mesh>
      {/* Window label */}
      <Text
        position={[0, winH / 2 + 0.25, 0]}
        fontSize={0.13}
        color="#06b6d4"
        anchorX="center"
        anchorY="middle"
      >
        {`W ${winW.toFixed(1)}m`}
      </Text>
    </group>
  );
}

// ── Compute positions from bbox if available, else auto-layout ────────────────
function computePositions(
  rooms: Room[],
  scale: number,
): [number, number, number][] {
  // Check if rooms have bbox (from AI detection)
  const hasBbox = rooms.every((r) => (r as Room & { bbox?: object }).bbox);

  if (hasBbox) {
    // Use bbox x/y → 3D x/z, scaled to meters
    return rooms.map((r) => {
      const bbox = (r as Room & { bbox: { x: number; y: number; w: number; h: number } }).bbox;
      const cx = (bbox.x + bbox.w / 2) * PLAN_SIZE - PLAN_SIZE / 2;
      const cz = (bbox.y + bbox.h / 2) * PLAN_SIZE - PLAN_SIZE / 2;
      return [cx * scale, 0, cz * scale];
    });
  }

  // Fallback: arrange in a smart grid
  const cols = Math.ceil(Math.sqrt(rooms.length));
  return rooms.map((room, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    let x = 0, z = 0;
    let ox = 0;
    for (let j = 0; j < rooms.length; j++) {
      if (j % cols === 0 && j > 0) ox = 0;
      if (j === i) {
        x = ox + (rooms[j].width * scale) / 2;
        z = row * 8;
        break;
      }
      ox += rooms[j].width * scale + 0.8;
    }
    return [x - 5, 0, z - (Math.floor(rooms.length / cols) * 4)] as [number, number, number];
  });
}

// ── Info overlay ──────────────────────────────────────────────────────────────
function RoomInfoCard({ room }: { room: Room }) {
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-2xl bg-black/70 backdrop-blur-md border border-white/10 shadow-2xl flex items-center gap-4 min-w-[280px] pointer-events-none">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-foreground truncate">{room.name}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
          {room.width.toFixed(2)}m × {room.height.toFixed(2)}m · H: {(room.wallHeight ?? 2.8).toFixed(2)}m
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-[11px] font-mono text-primary">{(room.width * room.height).toFixed(1)} m²</p>
        <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">{room.confidence}</p>
      </div>
    </div>
  );
}

// ── Scene ─────────────────────────────────────────────────────────────────────
function Scene({ rooms, scale, walls, doors, windows, onHoverChange }: {
  rooms: Room[];
  scale: number;
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  onHoverChange: (id: string | null) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const positions = computePositions(rooms, scale);

  // Default wall height — max from rooms or 2.8
  const defaultWallHeight = Math.max(...rooms.map((r) => r.wallHeight ?? 2.8), 2.8);

  const handleHover = (id: string | null) => {
    setHoveredId(id);
    onHoverChange(id);
  };

  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[10, 16, 10]}
        intensity={0.8}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      <pointLight position={[-8, 10, -8]} intensity={0.3} color="#60a5fa" />
      <pointLight position={[8, 6, 8]} intensity={0.2} color="#a78bfa" />

      <Grid
        infiniteGrid
        cellSize={1}
        sectionSize={5}
        cellColor="#0f1929"
        sectionColor="#1a2d44"
        fadeDistance={40}
      />

      {/* Room meshes */}
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

      {/* Detected wall segments */}
      {walls.map((wall) => (
        <WallSegmentMesh
          key={wall.id}
          wall={wall}
          wallHeight={defaultWallHeight}
        />
      ))}

      {/* Detected doors */}
      {doors.map((door) => (
        <DoorMesh
          key={door.id}
          door={door}
          wallHeight={defaultWallHeight}
        />
      ))}

      {/* Detected windows */}
      {windows.map((win) => (
        <WindowMesh
          key={win.id}
          win={win}
          wallHeight={defaultWallHeight}
        />
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
const RightPanel = ({ rooms, generated, scale, walls = [], doors = [], windows = [], onBack }: RightPanelProps) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoveredRoom = rooms.find((r) => r.id === hoveredId) ?? null;

  // Camera position based on total plan size
  const totalW = rooms.reduce((s, r) => s + r.width, 0);
  const maxH = Math.max(...rooms.map((r) => r.wallHeight ?? 2.8), 3);
  const camDist = Math.max(totalW * 0.8, 15);

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

          {/* Floating back button */}
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

          {/* Stats bar top-right */}
          <div className="absolute top-4 right-4 flex items-center gap-3 bg-black/50 border border-white/[0.07] backdrop-blur-md rounded-xl px-3 py-2 z-10">
            <Info className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <div className="flex items-center gap-3 text-[10px] font-mono divide-x divide-white/10">
              <span className="text-muted-foreground">{rooms.length} rooms</span>
              {walls.length > 0 && (
                <span className="pl-3 text-slate-400">{walls.length} walls</span>
              )}
              {doors.length > 0 && (
                <span className="pl-3 text-amber-400">{doors.length} doors</span>
              )}
              {windows.length > 0 && (
                <span className="pl-3 text-cyan-400">{windows.length} windows</span>
              )}
              <span className="pl-3 text-muted-foreground">
                {rooms.reduce((s, r) => s + r.width * r.height, 0).toFixed(1)} m²
              </span>
              <span className="pl-3 text-muted-foreground">
                H: {Math.max(...rooms.map((r) => r.wallHeight ?? 2.8)).toFixed(1)}m
              </span>
            </div>
          </div>

          {/* Hover info card */}
          {hoveredRoom && <RoomInfoCard room={hoveredRoom} />}
        </>
      )}
    </div>
  );
};

export default RightPanel;
