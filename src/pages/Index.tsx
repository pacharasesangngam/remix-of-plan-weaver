import { useState, useCallback } from "react";
import LeftPanel from "@/components/LeftPanel";
import RightPanel from "@/components/RightPanel";
import SplashScreen from "@/components/SplashScreen";
import type { Room, FloorPlanData } from "@/types/floorplan";

const MOCK_ROOMS: Room[] = [
  { id: "room_1", name: "Bedroom 1", width: 3.5, height: 3.0, confidence: "high" },
  { id: "room_2", name: "Bedroom 2", width: 4.0, height: 3.2, confidence: "high" },
  { id: "room_3", name: "Living Room", width: 5.5, height: 4.0, confidence: "high" },
  { id: "room_4", name: "Kitchen", width: 3.0, height: 2.8, confidence: "low" },
  { id: "room_5", name: "Bathroom", width: 2.0, height: 2.5, confidence: "manual" },
];

const Index = () => {
  const [showSplash, setShowSplash] = useState(true);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [detected, setDetected] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [scale, setScale] = useState(1.0);

  const handleImageUpload = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setDetected(false);
    setGenerated(false);
    setRooms([]);
  }, []);

  const handleClear = useCallback(() => {
    setImageUrl(null);
    setRooms([]);
    setDetected(false);
    setGenerated(false);
  }, []);

  const handleDetect = useCallback(() => {
    setRooms(MOCK_ROOMS);
    setDetected(true);
    setGenerated(false);
  }, []);

  const handleRoomUpdate = useCallback((id: string, field: "width" | "height", value: number) => {
    setRooms((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value, confidence: "manual" as const } : r))
    );
  }, []);

  const handleGenerate = useCallback(() => {
    setGenerated(true);
  }, []);

  const floorPlanData: FloorPlanData = {
    meta: { unit: "meter", scale },
    rooms,
  };

  return (
    <>
      {showSplash && <SplashScreen onComplete={() => setShowSplash(false)} />}
      <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <header className="shrink-0 border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold text-foreground tracking-tight font-sans">
              Floor Plan → 3D
            </h1>
            <div className="h-4 w-px bg-border" />
            <span className="text-xs text-muted-foreground font-mono">
              Upload → Detect & Calibrate → Generate
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground font-mono">v2.0 demo</span>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex min-h-0">
        <LeftPanel
          imageUrl={imageUrl}
          rooms={rooms}
          detected={detected}
          scale={scale}
          onImageUpload={handleImageUpload}
          onClear={handleClear}
          onDetect={handleDetect}
          onRoomUpdate={handleRoomUpdate}
          onScaleChange={setScale}
          onGenerate={handleGenerate}
          floorPlanData={floorPlanData}
        />
        <RightPanel rooms={rooms} generated={generated} scale={scale} />
      </div>
    </div>
    </>
  );
};

export default Index;
