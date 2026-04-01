import { useState, useCallback } from "react";
import { ChevronLeft, User, HardHat, Key, Loader2, X } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import RightPanel from "@/components/RightPanel";
import WallReview from "@/components/WallReview";
import SplashScreen from "@/components/SplashScreen";
import { detectFloorPlan } from "@/services/floorplanAI";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import type { Room, FloorPlanData, AppMode, DimensionUnit } from "@/types/floorplan";

const HAS_API_KEY = !!(import.meta.env.VITE_GEMINI_API_KEY as string);

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
  const [usedMock, setUsedMock] = useState(false);
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

  const handleRoomUpdate = useCallback((id: string, field: keyof Room, value: number | string) => {
    setRooms((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value, confidence: field === "width" || field === "height" ? ("manual" as const) : r.confidence } : r))
    );
  }, []);

  const handleWallUpdate = useCallback((id: string, field: keyof DetectedWallSegment, value: number | string) => {
    setWalls((prev) =>
      prev.map((w) => (w.id === id ? { ...w, [field]: value } : w))
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
              <h1 className="text-sm font-semibold text-foreground tracking-tight font-sans">
                Floor Plan → 3D
              </h1>
              <div className="h-4 w-px bg-border" />
              <span className="text-xs text-muted-foreground font-mono hidden sm:block">
                {generated ? "3D Preview" : "Upload → Detect & Calibrate → Generate"}
              </span>
            </div>

            {/* Mode Toggle */}
              </div>
        </header>

        {/* API key warning */}
        {!HAS_API_KEY && (
          <div className="shrink-0 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2">
            <Key className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-[11px] text-amber-300">
              <strong>VITE_GEMINI_API_KEY</strong> ยังไม่ได้ตั้งค่า — ใส่ key ใน <code className="bg-white/10 px-1 rounded">.env</code> แล้ว restart server เพื่อใช้ AI Detection จริง
            </span>
          </div>
        )}
        {/* Mock data banner */}
        {usedMock && (
          <div className="shrink-0 px-4 py-2 bg-blue-500/10 border-b border-blue-500/20 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">DEMO</span>
              <span className="text-[11px] text-blue-300">
                API quota เต็ม — แสดงข้อมูล demo แทน · เติม billing ที่ <a href="https://ai.dev" target="_blank" rel="noreferrer" className="underline hover:text-blue-200">ai.dev</a> หรือรอ quota reset
              </span>
            </div>
            <button onClick={() => setUsedMock(false)} className="text-blue-400/60 hover:text-blue-400 transition-colors shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {mode === "pro" && (
          <div className="shrink-0 px-6 py-1.5 bg-primary/10 border-b border-primary/20 flex items-center gap-2">
            <span className="text-[10px] font-mono text-primary">PRO MODE</span>
            <span className="text-[10px] text-muted-foreground">— dimension ละเอียด · วัสดุ &amp; ราคา · Export · JSON</span>
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
            /* Detecting state — loading overlay on image */
            <div className="flex-1 flex flex-col items-center justify-center bg-background relative overflow-hidden gap-5">
              <div className="absolute inset-0 opacity-[0.03]" style={{
                backgroundImage: "linear-gradient(hsl(215,20%,40%) 1px,transparent 1px),linear-gradient(90deg,hsl(215,20%,40%) 1px,transparent 1px)",
                backgroundSize: "40px 40px",
              }} />
              {imageUrl && (
                <div className="relative max-w-xl w-full mx-4 rounded-2xl overflow-hidden border border-white/10 shadow-2xl">
                  <img src={imageUrl} alt="Analyzing" className="w-full object-contain" style={{ filter: "brightness(0.4) blur(1px)" }} />
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                    <Loader2 className="w-10 h-10 text-primary animate-spin" />
                    <p className="text-sm font-medium text-white">AI กำลังวิเคราะห์แปลนผัง…</p>
                    <p className="text-[11px] text-white/50">ตรวจหาห้อง ผนัง ประตู หน้าต่าง</p>
                  </div>
                </div>
              )}
            </div>
          ) : detectError ? (
            /* Error state */
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                <Key className="w-6 h-6 text-red-400" />
              </div>
              <div className="text-center space-y-2 max-w-sm">
                <p className="text-sm font-semibold text-foreground">Detection ล้มเหลว</p>
                <p className="text-xs text-muted-foreground">{detectError}</p>
              </div>
              <button
                onClick={() => setDetectError(null)}
                className="text-xs text-primary hover:underline"
              >
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
              onRoomUpdate={handleRoomUpdate}
              onWallUpdate={handleWallUpdate}
              onGenerate={handleGenerate}
            />
          ) : imageUrl && !generated ? (
            /* Floor plan image preview — shown after upload, before detect */
            <div className="flex-1 flex flex-col items-center justify-center bg-background relative overflow-hidden p-6 gap-4">
              {/* Subtle grid bg */}
              <div className="absolute inset-0 opacity-[0.03]" style={{
                backgroundImage: "linear-gradient(hsl(215,20%,40%) 1px, transparent 1px), linear-gradient(90deg, hsl(215,20%,40%) 1px, transparent 1px)",
                backgroundSize: "40px 40px",
              }} />
              {/* Label */}
              <div className="relative z-10 flex items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-widest font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-pulse" />
                Floor Plan Preview
              </div>
              {/* Image */}
              <div className="relative z-10 flex-1 w-full max-w-3xl max-h-[calc(100%-80px)] rounded-2xl border border-white/10 overflow-hidden bg-black/30 shadow-[0_8px_64px_rgba(0,0,0,0.6)] backdrop-blur-sm flex items-center justify-center">
                <img
                  src={imageUrl}
                  alt="Floor plan preview"
                  className="max-w-full max-h-full object-contain p-4"
                  style={{ filter: "brightness(1.05) contrast(1.05)" }}
                />
              </div>
              {/* Hint */}
              <p className="relative z-10 text-[11px] text-muted-foreground/50">
                กดปุ่ม <span className="text-primary/70 font-medium">Detect Rooms</span> ใน sidebar เพื่อวิเคราะห์ผนังและห้อง
              </p>
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
