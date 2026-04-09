import { useState, useCallback } from "react";
import { ChevronLeft, Key, Loader2, X } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import RightPanel from "@/components/RightPanel";
import WallReview from "@/components/WallReview";
import SplashScreen from "@/components/SplashScreen";
import { detectFloorPlan } from "@/services/floorplanAI";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import type { Room, FloorPlanData, AppMode, DimensionUnit } from "@/types/floorplan";

const Index = () => {
  const [showSplash, setShowSplash] = useState(true);
  const [mode, setMode] = useState<AppMode>("simple");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [walls, setWalls] = useState<DetectedWallSegment[]>([]);
  const [doors, setDoors] = useState<DetectedDoor[]>([]);
  const [windows, setWindows] = useState<DetectedWindow[]>([]);
  const [detected, setDetected] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [generated, setGenerated] = useState(false);
  const [scale, setScale] = useState(1.0);
  const [unit, setUnit] = useState<DimensionUnit>("m");

  const handleImageUpload = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setImageFile(file);
    setDetected(false);
    setGenerated(false);
    setDetectError(null);
    setRooms([]);
    setWalls([]);
    setDoors([]);
    setWindows([]);
  }, []);

  const handleClear = useCallback(() => {
    setImageUrl(null);
    setImageFile(null);
    setRooms([]);
    setWalls([]);
    setDoors([]);
    setWindows([]);
    setDetected(false);
    setDetecting(false);
    setDetectError(null);
    setGenerated(false);
  }, []);

const handleDetect = useCallback(async () => {
  if (!imageFile) return;

  setDetecting(true);
  setDetectError(null);

  try {
    const result = await detectFloorPlan(imageFile);

    setRooms(result.rooms);
    setWalls(result.walls);
    setDoors(result.doors);
    setWindows(result.windows);


    setDetected(true);
    setGenerated(false);
  } catch (err: unknown) {
    setDetectError(err instanceof Error ? err.message : String(err));
  } finally {
    setDetecting(false);
  }
}, [imageFile]);

  const handleRoomUpdate = useCallback((id: string, field: keyof Room, value: number | string) => {
    setRooms(prev =>
      prev.map(r => r.id === id ? { ...r, [field]: value, confidence: field === "width" || field === "height" ? "manual" : r.confidence } : r)
    );
  }, []);

  const handleWallUpdate = useCallback((id: string, field: keyof DetectedWallSegment, value: number | string) => {
    setWalls(prev =>
      prev.map(w => w.id === id ? { ...w, [field]: value } : w)
    );
  }, []);

  const handleGenerate = useCallback(() => setGenerated(true), []);

  const floorPlanData: FloorPlanData = { meta: { unit, scale }, rooms };

  return (
    <>
      {showSplash && <SplashScreen onComplete={() => setShowSplash(false)} />}
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        <header className="shrink-0 border-b border-border bg-card/50 backdrop-blur-sm">
          <div className="px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {generated && (
                <button onClick={() => setGenerated(false)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group mr-1">
                  <ChevronLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" /> Back to Review
                </button>
              )}
              <h1 className="text-sm font-semibold text-foreground tracking-tight font-sans">Floor Plan → 3D</h1>
            </div>
          </div>
        </header>

        <div className="flex-1 flex min-h-0">
          <Sidebar
            mode={mode}
            unit={unit}
            imageUrl={imageUrl}
            rooms={rooms}
            detected={detected}
            detecting={detecting}
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

          {detecting ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-5">
              <Loader2 className="w-10 h-10 text-primary animate-spin" />
              <p className="text-sm text-muted-foreground">AI กำลังวิเคราะห์แปลนผัง…</p>
            </div>
          ) : detectError ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <p className="text-sm font-semibold text-foreground">Detection ล้มเหลว</p>
              <p className="text-xs text-muted-foreground">{detectError}</p>
              <button onClick={() => setDetectError(null)} className="text-xs text-primary hover:underline">ลองอีกครั้ง</button>
            </div>
          ) : detected && !generated ? (
            <WallReview
              rooms={rooms}
              unit={unit}
              imageUrl={imageUrl}
              walls={walls}
              doors={doors}
              windows={windows}
              scale={scale}                 // 🔥 เพิ่ม
              onScaleChange={setScale}  
              onRoomUpdate={handleRoomUpdate}
              onWallUpdate={handleWallUpdate}
              onGenerate={handleGenerate}
            />
          ) : imageUrl && !generated ? (
            <div className="flex-1 flex flex-col items-center justify-center bg-background relative overflow-hidden p-6 gap-4">
              <img src={imageUrl} alt="Floor plan preview" className="max-w-full max-h-full object-contain" />
            </div>
          ) : (
            <RightPanel rooms={rooms} generated={generated} scale={scale} walls={walls} doors={doors} windows={windows} onBack={() => setGenerated(false)} />
          )}
        </div>
      </div>
    </>
  );
};

export default Index;