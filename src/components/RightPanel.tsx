import { useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Text } from "@react-three/drei";
import * as THREE from "three";
import { Box, ChevronLeft, Info } from "lucide-react";
import type { Room } from "@/types/floorplan";

interface RightPanelProps {
  rooms: Room[];
  generated: boolean;
  scale: number;
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

// ── Compute positions from bbox if available, else auto-layout ────────────────
function computePositions(
  rooms: Room[],
  scale: number,
): [number, number, number][] {
  // Check if rooms have bbox (from AI detection)
  const hasBbox = rooms.every((r) => (r as Room & { bbox?: object }).bbox);

  if (hasBbox) {
    // Use bbox x/y → 3D x/z, scaled to meters
    // bbox is 0-1, we map onto a ~20m × 20m plan area
    const PLAN_SIZE = 20;
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
    const xOffset = rooms
      .slice(0, col)
      .filter((_, j) => j % cols === col || true)
      .reduce((acc, _, j2) => acc + (j2 % cols === col ? rooms[j2].width * scale + 0.8 : 0), 0);
    // Simpler grid
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
function Scene({ rooms, scale, onHoverChange }: {
  rooms: Room[];
  scale: number;
  onHoverChange: (id: string | null) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const positions = computePositions(rooms, scale);

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
const RightPanel = ({ rooms, generated, scale, onBack }: RightPanelProps) => {
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
            <Scene rooms={rooms} scale={scale} onHoverChange={setHoveredId} />
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
