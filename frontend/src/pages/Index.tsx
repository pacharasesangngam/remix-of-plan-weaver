import { useState, useCallback, useEffect } from "react";
import { ChevronLeft, Loader2, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import Sidebar from "@/components/Sidebar";
import RightPanel from "@/components/RightPanel";
import WallReview from "@/components/WallReview";
import SplashScreen from "@/components/SplashScreen";
import { detectFloorPlan } from "@/services/floorplanAI";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import type { Room, FloorPlanData, AppMode, DimensionUnit } from "@/types/floorplan";

const Index = () => {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted]           = useState(false);
  const [showSplash, setShowSplash]   = useState(true);
  const [mode, setMode]               = useState<AppMode>("simple");
  const [imageUrl, setImageUrl]       = useState<string | null>(null);
  const [fileType, setFileType]       = useState<string | null>(null);
  const [imageFile, setImageFile]     = useState<File | null>(null);
  const [rooms, setRooms]             = useState<Room[]>([]);
  const [walls, setWalls]             = useState<DetectedWallSegment[]>([]);
  const [doors, setDoors]             = useState<DetectedDoor[]>([]);
  const [windows, setWindows]         = useState<DetectedWindow[]>([]);
  const [detected, setDetected]       = useState(false);
  const [detecting, setDetecting]     = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [generated, setGenerated]     = useState(false);
  // FIX: เริ่มต้น scale = 0 เพื่อให้ WallReview รู้ว่ายังไม่ calibrate
  // scale จะถูก set จริงเมื่อผู้ใช้กด Apply ใน calibration flow เท่านั้น
  const [scale, setScale]             = useState(0);
  const [unit, setUnit]               = useState<DimensionUnit>("m");

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleImageUpload = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setFileType(file.type || null);
    setImageFile(file);
    setDetected(false);
    setGenerated(false);
    setDetectError(null);
    setRooms([]);
    setWalls([]);
    setDoors([]);
    setWindows([]);
    // FIX: reset scale ทุกครั้งที่อัปโหลดรูปใหม่
    setScale(0);
  }, []);

  const handleClear = useCallback(() => {
    setImageUrl(null);
    setFileType(null);
    setImageFile(null);
    setRooms([]);
    setWalls([]);
    setDoors([]);
    setWindows([]);
    setDetected(false);
    setDetecting(false);
    setDetectError(null);
    setGenerated(false);
    setScale(0);
  }, []);

  const handleDetect = useCallback(async () => {
    if (!imageFile) return;
    setDetecting(true);
    setDetectError(null);
    try {
      const result = await detectFloorPlan(imageFile);
      if (result.image) {
        setImageUrl(result.image);
        setFileType("image/png");
      }
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
      prev.map(r => r.id === id
        ? { ...r, [field]: value, confidence: (field === "width" || field === "height") ? "manual" : r.confidence }
        : r
      )
    );
  }, []);

  const handleRoomPatch = useCallback((id: string, patch: Partial<Room>) => {
    setRooms(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  }, []);

  const handleRoomDelete = useCallback((id: string) => {
    setRooms(prev => prev.filter(r => r.id !== id));
  }, []);

  const handleWallUpdate = useCallback((id: string, field: keyof DetectedWallSegment, value: number | string) => {
    setWalls(prev => prev.map(w => w.id === id ? { ...w, [field]: value } : w));
  }, []);

  const handleWallAdd = useCallback((wall: DetectedWallSegment) => {
    setWalls(prev => [...prev, wall]);
  }, []);

  const handleWallDelete = useCallback((id: string) => {
    setWalls(prev => prev.filter(w => w.id !== id));
  }, []);

  const handleDoorAdd = useCallback((door: DetectedDoor) => {
    setDoors(prev => [...prev, door]);
  }, []);

  const handleDoorDelete = useCallback((id: string) => {
    setDoors(prev => prev.filter(d => d.id !== id));
  }, []);

  const handleWindowAdd = useCallback((windowItem: DetectedWindow) => {
    setWindows(prev => [...prev, windowItem]);
  }, []);

  const handleWindowDelete = useCallback((id: string) => {
    setWindows(prev => prev.filter(w => w.id !== id));
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
                <button
                  onClick={() => setGenerated(false)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group mr-1"
                >
                  <ChevronLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
                  Back to Review
                </button>
              )}
              <h1 className="text-sm font-semibold text-foreground tracking-tight font-sans">Floor Plan → 3D</h1>
            </div>
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Toggle theme"
            >
              {mounted && theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              {mounted && theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        </header>

        <div className="flex-1 flex min-h-0">
          <Sidebar
            mode={mode}
            unit={unit}
            imageUrl={imageUrl}
            fileType={fileType}
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
              <button onClick={() => setDetectError(null)} className="text-xs text-primary hover:underline">
                ลองอีกครั้ง
              </button>
            </div>
          ) : detected && !generated ? (
            <WallReview
              rooms={rooms}
              unit={unit}
              imageUrl={imageUrl}
              walls={walls}
              doors={doors}
              windows={windows}
              scale={scale}
              onScaleChange={setScale}
              onRoomUpdate={handleRoomUpdate}
              onWallUpdate={handleWallUpdate}
              onWallAdd={handleWallAdd}
              onWallDelete={handleWallDelete}
              onGenerate={handleGenerate}
            />
          ) : imageUrl && !generated ? (
            <div className="flex-1 flex flex-col items-center justify-center bg-background relative overflow-hidden p-6 gap-4">
              {fileType === "application/pdf" ? (
                <iframe src={imageUrl} title="Floor plan PDF preview" className="h-full w-full rounded-2xl border border-border bg-card" />
              ) : (
                <img src={imageUrl} alt="Floor plan preview" className="max-w-full max-h-full object-contain" />
              )}
            </div>
          ) : (
            <RightPanel
              rooms={rooms}
              generated={generated}
              walls={walls}
              doors={doors}
              windows={windows}
              onRoomUpdate={handleRoomUpdate}
              onRoomPatch={handleRoomPatch}
              onRoomDelete={handleRoomDelete}
              onWallUpdate={handleWallUpdate}
              onWallAdd={handleWallAdd}
              onWallDelete={handleWallDelete}
              onDoorAdd={handleDoorAdd}
              onDoorDelete={handleDoorDelete}
              onWindowAdd={handleWindowAdd}
              onWindowDelete={handleWindowDelete}
              onBack={() => setGenerated(false)}
            />
          )}
        </div>
      </div>
    </>
  );
};

export default Index;
