import { useState, useCallback } from "react";
import LeftPanel from "@/components/LeftPanel";
import RightPanel from "@/components/RightPanel";
import SplashScreen from "@/components/SplashScreen";
import type { Room, FloorPlanData, AppMode, DimensionUnit } from "@/types/floorplan";

const MOCK_ROOMS: Room[] = [
  { id: "room_1", name: "Bedroom 1", width: 3.5, height: 3.0, confidence: "high", wallHeight: 2.8 },
  { id: "room_2", name: "Bedroom 2", width: 4.0, height: 3.2, confidence: "high", wallHeight: 2.8 },
  { id: "room_3", name: "Living Room", width: 5.5, height: 4.0, confidence: "high", wallHeight: 2.8 },
  { id: "room_4", name: "Kitchen", width: 3.0, height: 2.8, confidence: "low", wallHeight: 2.8 },
  { id: "room_5", name: "Bathroom", width: 2.0, height: 2.5, confidence: "manual", wallHeight: 2.8 },
];

const Index = () => {
  const [showSplash, setShowSplash] = useState(true);
  const [mode, setMode] = useState<AppMode>("simple");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [detected, setDetected] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [scale, setScale] = useState(1.0);
  const [unit, setUnit] = useState<DimensionUnit>("m");

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

  const handleRoomUpdate = useCallback((id: string, field: keyof Room, value: number | string) => {
    setRooms((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value, confidence: field === "width" || field === "height" ? ("manual" as const) : r.confidence } : r))
    );
  }, []);

  const handleGenerate = useCallback(() => {
    setGenerated(true);
  }, []);

  const floorPlanData: FloorPlanData = {
    meta: { unit, scale },
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
              <span className="text-xs text-muted-foreground font-mono hidden sm:block">
                Upload → Detect & Calibrate → Generate
              </span>
            </div>

            {/* Mode Toggle */}
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-lg border border-border bg-surface p-0.5 gap-0.5">
                <button
                  onClick={() => setMode("simple")}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-all font-sans ${
                    mode === "simple"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Simple
                </button>
                <button
                  onClick={() => setMode("pro")}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-all font-sans flex items-center gap-1.5 ${
                    mode === "pro"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="text-[9px] font-bold tracking-wide">⚙</span>
                  Pro
                </button>
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">v2.0</span>
            </div>
          </div>
        </header>

        {/* Mode banner */}
        {mode === "pro" && (
          <div className="shrink-0 px-6 py-1.5 bg-primary/10 border-b border-primary/20 flex items-center gap-2">
            <span className="text-[10px] font-mono text-primary">PRO MODE</span>
            <span className="text-[10px] text-muted-foreground">— dimension ละเอียด · วัสดุ & ราคา · Export · JSON</span>
          </div>
        )}

        {/* Main content */}
        <div className="flex-1 flex min-h-0">
          <LeftPanel
            mode={mode}
            unit={unit}
            imageUrl={imageUrl}
            rooms={rooms}
            detected={detected}
            scale={scale}
            onImageUpload={handleImageUpload}
            onClear={handleClear}
            onDetect={handleDetect}
            onRoomUpdate={handleRoomUpdate}
            onScaleChange={setScale}
            onUnitChange={setUnit}
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
