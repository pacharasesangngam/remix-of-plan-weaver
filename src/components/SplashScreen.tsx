import { useEffect, useState, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

// Rotating 3D floor plan building model
function BuildingModel() {
  const groupRef = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.6;
    }
  });

  const wallColor = "#3b82f6";
  const floorColor = "#1e293b";
  const wallOpacity = 0.75;
  const h = 1.4; // wall height
  const wt = 0.06; // wall thickness

  // Rooms layout
  const rooms = [
    { w: 1.6, d: 1.4, x: -0.9, z: -0.7 }, // bedroom 1
    { w: 1.6, d: 1.4, x: 0.9,  z: -0.7 }, // bedroom 2
    { w: 3.4, d: 1.6, x: 0,    z: 0.8  }, // living room
  ];

  return (
    <group ref={groupRef} position={[0, -0.5, 0]}>
      {rooms.map((room, ri) => {
        const walls = [
          { pos: [room.x, h / 2, room.z - room.d / 2] as [number,number,number], size: [room.w, h, wt] as [number,number,number] },
          { pos: [room.x, h / 2, room.z + room.d / 2] as [number,number,number], size: [room.w, h, wt] as [number,number,number] },
          { pos: [room.x - room.w / 2, h / 2, room.z] as [number,number,number], size: [wt, h, room.d] as [number,number,number] },
          { pos: [room.x + room.w / 2, h / 2, room.z] as [number,number,number], size: [wt, h, room.d] as [number,number,number] },
        ];
        return (
          <group key={ri}>
            {walls.map((wall, wi) => (
              <mesh key={wi} position={wall.pos}>
                <boxGeometry args={wall.size} />
                <meshStandardMaterial
                  color={wallColor}
                  transparent
                  opacity={wallOpacity}
                  roughness={0.3}
                  metalness={0.1}
                />
              </mesh>
            ))}
            {/* Floor */}
            <mesh position={[room.x, 0.01, room.z]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[room.w, room.d]} />
              <meshStandardMaterial color={floorColor} roughness={0.8} />
            </mesh>
          </group>
        );
      })}

      {/* Base slab */}
      <mesh position={[0, -0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[4, 3.6]} />
        <meshStandardMaterial color="#0f172a" roughness={0.9} />
      </mesh>
    </group>
  );
}

interface SplashScreenProps {
  onComplete: () => void;
}

const SplashScreen = ({ onComplete }: SplashScreenProps) => {
  const [phase, setPhase] = useState<"enter" | "idle" | "exit">("enter");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // Trigger enter animation
    const enterTimer = setTimeout(() => setPhase("idle"), 50);

    // Progress bar
    const progressInterval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) { clearInterval(progressInterval); return 100; }
        return prev + 1.8;
      });
    }, 30);

    // Fade out
    const exitTimer = setTimeout(() => setPhase("exit"), 3000);

    // Complete
    const completeTimer = setTimeout(() => onComplete(), 3700);

    return () => {
      clearTimeout(enterTimer);
      clearInterval(progressInterval);
      clearTimeout(exitTimer);
      clearTimeout(completeTimer);
    };
  }, [onComplete]);

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-background transition-opacity duration-700 ${
        phase === "exit" ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage: `
            linear-gradient(hsl(var(--border)) 1px, transparent 1px),
            linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)
          `,
          backgroundSize: "40px 40px",
        }}
      />

      {/* Glow */}
      <div
        className="absolute w-[500px] h-[500px] rounded-full opacity-10 blur-[140px] pointer-events-none"
        style={{ background: "hsl(var(--primary))" }}
      />

      {/* Content */}
      <div
        className={`relative flex flex-col items-center gap-6 transition-all duration-700 ${
          phase === "enter" ? "translate-y-4 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        {/* 3D Canvas */}
        <div className="w-64 h-48 rounded-2xl overflow-hidden border border-border"
          style={{ background: "hsl(var(--surface-raised))" }}
        >
          <Canvas camera={{ position: [4, 3, 4], fov: 40 }}>
            <ambientLight intensity={0.5} />
            <directionalLight position={[5, 8, 5]} intensity={0.8} />
            <pointLight position={[-3, 5, -3]} intensity={0.4} color="#3b82f6" />
            <BuildingModel />
          </Canvas>
        </div>

        {/* Text */}
        <div className="text-center space-y-1.5">
          <h1 className="text-2xl font-semibold text-foreground tracking-tight font-sans">
            Floor Plan → 3D
          </h1>
          <p className="text-sm text-muted-foreground font-mono">
            Upload · Detect · Generate
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-48 h-px bg-border rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-75"
            style={{
              width: `${progress}%`,
              background: "hsl(var(--primary))",
              boxShadow: "0 0 8px hsl(var(--primary) / 0.6)",
            }}
          />
        </div>

        <span className="text-[10px] text-muted-foreground font-mono opacity-50">v2.0 demo</span>
      </div>
    </div>
  );
};

export default SplashScreen;
