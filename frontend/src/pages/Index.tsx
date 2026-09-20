import { useState, useCallback, useEffect } from "react";
import { ChevronLeft, Loader2, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import Sidebar from "@/components/Sidebar";
import RightPanel from "@/components/RightPanel";
import WallReview from "@/components/WallReview";
import SplashScreen from "@/components/SplashScreen";
import { detectFloorPlan } from "@/services/floorplanAI";
import type { FloorPlanProject } from "@/lib/projectIO";
import { createFloorPlanProject } from "@/lib/projectIO";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import type { Room, FloorPlanData, AppMode, DimensionUnit } from "@/types/floorplan";

type EditorSnapshot = {
  rooms: Room[];
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
};

const Index = () => {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted]           = useState(false);
  const [showSplash, setShowSplash]   = useState(true);
  const [mode, setMode]               = useState<AppMode>("simple");
  const [imageUrl, setImageUrl]       = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageName, setImageName]     = useState<string | null>(null);
  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);
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
  const [wallHeightMeter, setWallHeightMeter] = useState(2.8);
  const [unit, setUnit]               = useState<DimensionUnit>("m");
  const [debugMode, setDebugMode]     = useState(true);
  const [debugImages, setDebugImages] = useState<Record<string, string> | null>(null);
  const [cleanImageUrl, setCleanImageUrl] = useState<string | null>(null);
  const [planW, setPlanW]             = useState(0);
  const [planH, setPlanH] = useState(0);
  const [screenPpm, setScreenPpm] = useState(0)
  const [editorHistory, setEditorHistory] = useState<{ past: EditorSnapshot[]; future: EditorSnapshot[] }>({ past: [], future: [] });

  const currentEditorSnapshot = useCallback((): EditorSnapshot => ({ rooms, walls, doors, windows }), [doors, rooms, walls, windows]);
  const recordEditorAction = useCallback(() => {
    setEditorHistory(history => ({ past: [...history.past.slice(-49), currentEditorSnapshot()], future: [] }));
  }, [currentEditorSnapshot]);
  const undoEditorAction = useCallback(() => {
    setEditorHistory(history => {
      const previous = history.past.at(-1);
      if (!previous) return history;
      const current = currentEditorSnapshot();
      setRooms(previous.rooms); setWalls(previous.walls); setDoors(previous.doors); setWindows(previous.windows);
      return { past: history.past.slice(0, -1), future: [current, ...history.future] };
    });
  }, [currentEditorSnapshot]);
  const redoEditorAction = useCallback(() => {
    setEditorHistory(history => {
      const next = history.future[0];
      if (!next) return history;
      const current = currentEditorSnapshot();
      setRooms(next.rooms); setWalls(next.walls); setDoors(next.doors); setWindows(next.windows);
      return { past: [...history.past, current], future: history.future.slice(1) };
    });
  }, [currentEditorSnapshot]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleImageUpload = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setOriginalImageUrl(url);
    setFileType(file.type || null);
    setImageFile(file);
    setImageName(file.name || null);
    setImageDataUrl(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setImageDataUrl(reader.result);
    };
    reader.readAsDataURL(file);
    setDetected(false);
    setGenerated(false);
    setDetectError(null);
    setRooms([]);
    setWalls([]);
    setDoors([]);
    setWindows([]);
    setDebugImages(null);
    setCleanImageUrl(null);
    setScale(0);
    setPlanW(0);
    setPlanH(0);
    setEditorHistory({ past: [], future: [] });
  }, []);

  const handleClear = useCallback(() => {
    setImageUrl(null);
    setImageDataUrl(null);
    setImageName(null);
    setFileType(null);
    setImageFile(null);
    setOriginalImageUrl(null);
    setRooms([]);
    setWalls([]);
    setDoors([]);
    setWindows([]);
    setDetected(false);
    setDetecting(false);
    setDetectError(null);
    setGenerated(false);
    setDebugImages(null);
    setCleanImageUrl(null);
    setScale(0);
    setPlanW(0);
    setPlanH(0);
    setEditorHistory({ past: [], future: [] });
  }, []);

  const handleWallHeightChange = useCallback((height: number) => {
    setWallHeightMeter(height);
    setRooms(prev => prev.map(r => ({ ...r, wallHeight: height })));
    setWalls(prev => prev.map(w => ({ ...w, wallHeight: height })));
  }, []);

  const handleDetect = useCallback(async () => {
    if (!imageFile) return;
    setDetecting(true);
    setDetectError(null);
    try {
      const result = await detectFloorPlan(imageFile, debugMode, undefined, wallHeightMeter);
      if (result.cleanImage) {
        setCleanImageUrl(result.cleanImage);
      }
      setRooms(result.rooms);
      setWalls(result.walls);
      setDoors(result.doors);
      setWindows(result.windows);
      setDebugImages(result.debugImages ?? null);
      setDetected(true);
      setGenerated(false);
      setEditorHistory({ past: [], future: [] });
    } catch (err: unknown) {
      setDetectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  }, [imageFile, debugMode, wallHeightMeter]);

  const handleRoomUpdate = useCallback((id: string, field: keyof Room, value: number | string) => {
    recordEditorAction();
    setRooms(prev =>
      prev.map(r => r.id === id
        ? {
            ...r,
            [field]: value,
            confidence: (field === "width" || field === "height") ? "manual" : r.confidence,
            ...(field === "width" || field === "height" ? { areaSqm: undefined } : {}),
          }
        : r
      )
    );
  }, [recordEditorAction]);

  const handleRoomPatch = useCallback((id: string, patch: Partial<Room>) => {
    recordEditorAction();
    setRooms(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  }, [recordEditorAction]);

  const handleRoomDelete = useCallback((id: string) => {
    recordEditorAction();
    setRooms(prev => prev.filter(r => r.id !== id));
  }, [recordEditorAction]);

  const handleWallUpdate = useCallback((id: string, field: keyof DetectedWallSegment, value: number | string) => {
    recordEditorAction();
    setWalls(prev => prev.map(w => w.id === id ? { ...w, [field]: value } : w));
  }, [recordEditorAction]);

  const handleWallGeometryCommit = useCallback((updatedWall: DetectedWallSegment) => {
    recordEditorAction();
    setWalls(previous => previous.map(wall => wall.id === updatedWall.id ? updatedWall : wall));
  }, [recordEditorAction]);

  const handleWallAdd = useCallback((wall: DetectedWallSegment) => {
    recordEditorAction();
    setWalls(prev => [...prev, wall]);
  }, [recordEditorAction]);

  const handleWallDelete = useCallback((id: string) => {
    recordEditorAction();
    setWalls(prev => prev.filter(w => w.id !== id));
  }, [recordEditorAction]);

  const handleDoorAdd = useCallback((door: DetectedDoor) => {
    recordEditorAction();
    setDoors(prev => [...prev, door]);
  }, [recordEditorAction]);

  const handleDoorUpdate = useCallback((id: string, field: keyof DetectedDoor, value: number | string) => {
    recordEditorAction();
    setDoors(prev => prev.map(d => d.id === id ? { ...d, [field]: value } : d));
  }, [recordEditorAction]);

  const handleDoorDelete = useCallback((id: string) => {
    recordEditorAction();
    setDoors(prev => prev.filter(d => d.id !== id));
  }, [recordEditorAction]);

  const handleWindowAdd = useCallback((windowItem: DetectedWindow) => {
    recordEditorAction();
    setWindows(prev => [...prev, windowItem]);
  }, [recordEditorAction]);

  const handleWindowUpdate = useCallback((id: string, field: keyof DetectedWindow, value: number | string) => {
    recordEditorAction();
    setWindows(prev => prev.map(w => w.id === id ? { ...w, [field]: value } : w));
  }, [recordEditorAction]);

  const handleWindowDelete = useCallback((id: string) => {
    recordEditorAction();
    setWindows(prev => prev.filter(w => w.id !== id));
  }, [recordEditorAction]);

  const handleGenerate = useCallback(() => setGenerated(true), []);

  const handleProjectImport = useCallback((project: FloorPlanProject) => {
    const importedImageUrl = project.image?.dataUrl ?? null;
    setImageUrl(importedImageUrl);
    setImageDataUrl(importedImageUrl);
    setImageName(project.image?.name ?? null);
    setOriginalImageUrl(importedImageUrl);
    setFileType(project.image?.fileType ?? null);
    setImageFile(null);
    setRooms(project.rooms);
    setWalls(project.walls);
    setDoors(project.doors);
    setWindows(project.windows);
    setUnit(project.meta.unit);
    setScale(project.meta.scale);
    setPlanW(project.meta.planWidth);
    setPlanH(project.meta.planHeight);
    setDetected(true);
    setDetecting(false);
    setDetectError(null);
    setDebugImages(null);
    setCleanImageUrl(project.image?.cleanDataUrl ?? null);
    setGenerated(true);
    setEditorHistory({ past: [], future: [] });
  }, []);

  const floorPlanData: FloorPlanData = { meta: { unit, scale }, rooms };
  const projectData = createFloorPlanProject({
    unit,
    scale,
    planWidth: planW,
    planHeight: planH,
    rooms,
    walls,
    doors,
    windows,
    image: imageDataUrl
      ? {
          dataUrl: imageDataUrl,
          cleanDataUrl: cleanImageUrl,
          fileType,
          name: imageName ?? undefined,
        }
      : null,
  });
  // Use the clean preprocessed image (same coordinate space as detected walls/rooms).
  // Falls back to the annotated preview, then the original uploaded image.
  const wallReviewBackgroundUrl = cleanImageUrl ?? imageUrl;
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
              <h1 className="text-sm font-semibold text-foreground tracking-tight font-sans">Sketch to Spec</h1>
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
            fileName={imageName}
            fileSize={imageFile?.size ?? null}
            rooms={rooms}
            detected={detected}
            detecting={detecting}
            scale={scale}
            debugMode={debugMode}
            debugImages={debugImages}
            onImageUpload={handleImageUpload}
            onClear={handleClear}
            onDetect={handleDetect}
            onRoomUpdate={handleRoomUpdate}
            onScaleChange={setScale}
            onUnitChange={setUnit}
            onGenerate={handleGenerate}
            onDebugToggle={() => setDebugMode((value) => !value)}
            floorPlanData={floorPlanData}
            projectData={projectData}
            onProjectImport={handleProjectImport}
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
              backgroundImageUrl={wallReviewBackgroundUrl}
              walls={walls}
              doors={doors}
              windows={windows}
              scale={scale}
              onScaleChange={setScale}
              onPlanSizeChange={(w, h) => { setPlanW(w); setPlanH(h); }}
              onPpmChange={setScreenPpm}
              wallHeightMeter={wallHeightMeter}
              onWallHeightChange={handleWallHeightChange}
              onRoomUpdate={handleRoomUpdate}
              onRoomDelete={handleRoomDelete}
              onWallUpdate={handleWallUpdate}
              onWallGeometryCommit={handleWallGeometryCommit}
              onWallAdd={handleWallAdd}
              onWallDelete={handleWallDelete}
              onDoorDelete={handleDoorDelete}
              onWindowDelete={handleWindowDelete}
              canUndo={editorHistory.past.length > 0}
              canRedo={editorHistory.future.length > 0}
              onUndo={undoEditorAction}
              onRedo={redoEditorAction}
              onGenerate={handleGenerate}            />
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
              planWidth={planW}
              planHeight={planH}
              onRoomUpdate={handleRoomUpdate}
              onRoomPatch={handleRoomPatch}
              onRoomDelete={handleRoomDelete}
              onWallUpdate={handleWallUpdate}
              onWallAdd={handleWallAdd}
              onWallDelete={handleWallDelete}
              onDoorAdd={handleDoorAdd}
              onDoorUpdate={handleDoorUpdate}
              onDoorDelete={handleDoorDelete}
              onWindowAdd={handleWindowAdd}
              onWindowUpdate={handleWindowUpdate}
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
