import { useState, useCallback } from "react";
import { ChevronLeft, Key, Loader2, X } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import RightPanel from "@/components/RightPanel";
import WallReview from "@/components/WallReview";
import SplashScreen from "@/components/SplashScreen";
import { detectFloorPlan } from "@/services/floorplanAI";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import type { Room, FloorPlanData, DimensionUnit } from "@/types/floorplan";

const HAS_API_KEY = !!(import.meta.env.VITE_GEMINI_API_KEY as string);

const Index = () => {
  const [showSplash, setShowSplash] = useState(true);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [walls, setWalls] = useState<DetectedWallSegment[]>([]);
  const [doors, setDoors] = useState<DetectedDoor[]>([]);
  const [windows, setWindows] = useState<DetectedWindow[]>([]);

  const [detected, setDetected] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [usedMock, setUsedMock] = useState(false);

  const [generated, setGenerated] = useState(false);
  const [scale, setScale] = useState(1.0);
  const [unit, setUnit] = useState<DimensionUnit>("m");

  // ─────────────────────────────────────────────────────────────

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
    if (!imageUrl && !imageFile) return;

    setDetecting(true);
    setDetectError(null);
    setUsedMock(false);

    try {
      const result = await detectFloorPlan(imageFile ?? imageUrl!);
      setRooms(result.rooms);
      setWalls(result.walls);
      setDoors(result.doors);
      setWindows(result.windows);
      setUsedMock(result.usedMock ?? false);
      setDetected(true);
      setGenerated(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "NO_API_KEY") {
        setDetectError("กรุณาเพิ่ม VITE_GEMINI_API_KEY ใน .env แล้ว restart server");
      } else {
        setDetectError(`เกิดข้อผิดพลาด: ${msg}`);
      }
    } finally {
      setDetecting(false);
    }
  }, [imageUrl, imageFile]);

  const handleRoomUpdate = useCallback(
    (id: string, field: keyof Room, value: number | string) => {
      setRooms((prev) =>
        prev.map((r) =>
          r.id === id
            ? {
                ...r,
                [field]: value,
                confidence:
                  field === "width" || field === "height" ? "manual" : r.confidence,
              }
            : r
        )
      );
    },
    []
  );

  const handleWallUpdate = useCallback(
    (id: string, field: keyof DetectedWallSegment, value: number | string) => {
      setWalls((prev) => prev.map((w) => (w.id === id ? { ...w, [field]: value } : w)));
    },
    []
  );

  const handleGenerate = useCallback(() => {
    setGenerated(true);
  }, []);

  const floorPlanData: FloorPlanData = {
    meta: { unit, scale },
    rooms,
  };

  // ─────────────────────────────────────────────────────────────

  return (
    <>
      {showSplash && <SplashScreen onComplete={() => setShowSplash(false)} />}

      <div className="h-screen flex flex-col bg-background overflow-hidden">
        {/* Header */}
        <header className="shrink-0 border-b border-border bg-card/50 backdrop-blur-sm">
          <div className="px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {generated && (
                <button
                  onClick={() => setGenerated(false)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group mr-1"
                >
                  <ChevronLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
                  Back to Review
                </button>
              )}
              {generated && <div className="h-4 w-px bg-border" />}
              <h1 className="text-sm font-semibold text-foreground tracking-tight">
                Floor Plan → 3D
              </h1>
              <div className="h-4 w-px bg-border" />
              <span className="text-xs text-muted-foreground font-mono hidden sm:block">
                {generated ? "3D Preview" : "Upload → Detect → Adjust → Generate"}
              </span>
            </div>

            <span className="text-[10px] text-white/20 font-mono tracking-widest">
              v2.0
            </span>
          </div>
        </header>

        {/* API key warning */}
        {!HAS_API_KEY && (
          <div className="shrink-0 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2">
            <Key className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-[11px] text-amber-300">
              <strong>VITE_GEMINI_API_KEY</strong> ยังไม่ได้ตั้งค่า — ใส่ key ใน{" "}
              <code className="bg-white/10 px-1 rounded">.env</code> แล้ว restart server
            </span>
          </div>
        )}

        {/* Mock banner */}
        {usedMock && (
          <div className="shrink-0 px-4 py-2 bg-blue-500/10 border-b border-blue-500/20 flex items-center justify-between gap-2">
            <span className="text-[11px] text-blue-300">
              API quota เต็ม — แสดงข้อมูล demo แทน
            </span>
            <button onClick={() => setUsedMock(false)}>
              <X className="w-3.5 h-3.5 text-blue-400" />
            </button>
          </div>
        )}

        {/* Main */}
        <div className="flex-1 flex min-h-0">
          <Sidebar
            imageUrl={imageUrl}
            rooms={rooms}
            detected={detected}
            detecting={detecting}
            onImageUpload={handleImageUpload}
            onClear={handleClear}
            onDetect={handleDetect}
            onGenerate={handleGenerate}
            floorPlanData={floorPlanData}
          />

          {detecting ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-10 h-10 text-primary animate-spin" />
            </div>
          ) : detectError ? (
            <div className="flex-1 flex items-center justify-center text-sm text-red-400">
              {detectError}
            </div>
          ) : detected && !generated ? (
            <WallReview
              rooms={rooms}
              unit={unit}
              imageUrl={imageUrl}
              walls={walls}
              doors={doors}
              windows={windows}
              onRoomUpdate={handleRoomUpdate}
              onWallUpdate={handleWallUpdate}
              onGenerate={handleGenerate}
            />
          ) : (
            <RightPanel
              rooms={rooms}
              generated={generated}
              scale={scale}
              walls={walls}
              doors={doors}
              windows={windows}
              onBack={() => setGenerated(false)}
            />
          )}
        </div>
      </div>
    </>
  );
};

export default Index;