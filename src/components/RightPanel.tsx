import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { Box } from "lucide-react";
import type { Room } from "@/types/floorplan";

interface RightPanelProps {
  rooms: Room[];
  generated: boolean;
  scale: number;
}

function RoomMesh({ room, position }: { room: Room; position: [number, number, number] }) {
  const w = room.width;
  const d = room.height;
  const h = 2.8;
  const wallThickness = 0.08;

  // Four walls as thin boxes
  const walls = [
    { pos: [0, h / 2, -d / 2] as [number, number, number], size: [w, h, wallThickness] as [number, number, number] },
    { pos: [0, h / 2, d / 2] as [number, number, number], size: [w, h, wallThickness] as [number, number, number] },
    { pos: [-w / 2, h / 2, 0] as [number, number, number], size: [wallThickness, h, d] as [number, number, number] },
    { pos: [w / 2, h / 2, 0] as [number, number, number], size: [wallThickness, h, d] as [number, number, number] },
  ];

  // Floor
  return (
    <group position={position}>
      {walls.map((wall, i) => (
        <mesh key={i} position={wall.pos}>
          <boxGeometry args={wall.size} />
          <meshStandardMaterial color="hsl(215, 20%, 35%)" transparent opacity={0.85} />
        </mesh>
      ))}
      <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color="hsl(215, 15%, 18%)" />
      </mesh>
    </group>
  );
}

function Scene({ rooms, scale }: { rooms: Room[]; scale: number }) {
  // Lay rooms out in a row for demo
  let offsetX = 0;
  const positions: [number, number, number][] = rooms.map((room) => {
    const x = offsetX + (room.width * scale) / 2;
    offsetX += room.width * scale + 0.5;
    return [x - offsetX / 2, 0, 0];
  });

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[8, 12, 8]} intensity={0.7} />
      <pointLight position={[-5, 8, -5]} intensity={0.3} color="hsl(210, 100%, 70%)" />
      <Grid
        infiniteGrid
        cellSize={1}
        sectionSize={5}
        cellColor="hsl(215, 15%, 18%)"
        sectionColor="hsl(215, 15%, 25%)"
        fadeDistance={30}
        position={[0, 0, 0]}
      />
      {rooms.map((room, i) => (
        <RoomMesh
          key={room.id}
          room={{ ...room, width: room.width * scale, height: room.height * scale }}
          position={positions[i]}
        />
      ))}
      <OrbitControls
        enablePan
        enableZoom
        enableRotate
        maxPolarAngle={Math.PI / 2.05}
        minDistance={3}
        maxDistance={40}
      />
    </>
  );
}

const RightPanel = ({ rooms, generated, scale }: RightPanelProps) => {
  return (
    <div className="flex-1 flex items-center justify-center bg-background relative">
      {!generated ? (
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-surface-raised border border-border flex items-center justify-center">
            <Box className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="text-center space-y-1">
            <p className="text-sm font-medium text-foreground font-sans">3D Preview</p>
            <p className="text-xs text-muted-foreground max-w-[240px]">
              Upload a floor plan & click Generate 3D
            </p>
          </div>
        </div>
      ) : (
        <Canvas
          camera={{ position: [10, 8, 10], fov: 45 }}
          style={{ width: "100%", height: "100%" }}
        >
          <Scene rooms={rooms} scale={scale} />
        </Canvas>
      )}
    </div>
  );
};

export default RightPanel;
