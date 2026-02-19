import { useState, useCallback } from "react";
import { User, HardHat } from "lucide-react";
import Sidebar from "@/components/Sidebar";
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
            <div className="flex items-center gap-3">
              <div className="relative flex items-center rounded-xl bg-black/50 border border-white/[0.08] p-1 gap-0.5 shadow-[0_4px_24px_rgba(0,0,0,0.4)] backdrop-blur-xl">
                {/* Sliding background pill */}
                <div
                  className={`absolute top-1 bottom-1 rounded-lg transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] pointer-events-none ${mode === "simple"
                    ? "left-1 w-[62px] bg-gradient-to-br from-slate-600/80 to-slate-700/60 border border-white/10 shadow-[0_2px_12px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.08)]"
                    : "left-[67px] w-[62px] bg-gradient-to-br from-amber-500/80 to-orange-600/70 border border-amber-400/30 shadow-[0_2px_16px_rgba(245,158,11,0.35),0_0_32px_rgba(245,158,11,0.15),inset_0_1px_0_rgba(255,255,255,0.15)]"
                    }`}
                />

                {/* Simple (Person) */}
                <button
                  onClick={() => setMode("simple")}
                  className="relative z-10 flex flex-col items-center gap-0.5 w-[62px] py-1.5 rounded-lg select-none transition-all duration-300 group"
                >
                  <User
                    className={`w-3.5 h-3.5 transition-all duration-300 ${mode === "simple"
                      ? "text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.4)]"
                      : "text-white/30 group-hover:text-white/50"
                      }`}
                  />
                  <span
                    className={`text-[9px] font-semibold tracking-wider uppercase transition-all duration-300 ${mode === "simple" ? "text-white" : "text-white/25 group-hover:text-white/45"
                      }`}
                  >
                    Normal
                  </span>
                </button>

                {/* Pro (HardHat) */}
                <button
                  onClick={() => setMode("pro")}
                  className="relative z-10 flex flex-col items-center gap-0.5 w-[62px] py-1.5 rounded-lg select-none transition-all duration-300 group"
                >
                  <HardHat
                    className={`w-3.5 h-3.5 transition-all duration-300 ${mode === "pro"
                      ? "text-white drop-shadow-[0_0_8px_rgba(245,158,11,0.7)]"
                      : "text-white/30 group-hover:text-white/50"
                      }`}
                  />
                  <span
                    className={`text-[9px] font-semibold tracking-wider uppercase transition-all duration-300 ${mode === "pro" ? "text-white" : "text-white/25 group-hover:text-white/45"
                      }`}
                  >
                    Pro
                  </span>
                </button>
              </div>

              <span className="text-[10px] text-white/20 font-mono tracking-widest">v2.0</span>
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
          <Sidebar
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
