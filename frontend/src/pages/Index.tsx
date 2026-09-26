import { useState, useCallback, useEffect, useReducer, useMemo } from "react";
import { ChevronLeft, Loader2, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import Sidebar from "@/components/Sidebar";
import RightPanel from "@/components/RightPanel";
import WallReview from "@/components/WallReview";
import SplashScreen from "@/components/SplashScreen";
import StartScreen from "@/components/StartScreen";
import DrawPlan from "@/components/DrawPlan";
import { DRAW_PLAN_SIZE } from "@/lib/manualPlan";
import { detectFloorPlan } from "@/services/floorplanAI";
import type { FloorPlanProject } from "@/lib/projectIO";
import { createFloorPlanProject, downloadProjectJson } from "@/lib/projectIO";
import { initialHistory, projectHistoryReducer, emptyProject, type ProjectState, type ActionInfo } from "@/lib/projectHistory";
import { ProjectActionContext, ProjectInputActions, isNativeUndoTarget } from "@/components/ProjectActionContext";
import { toast } from "@/hooks/use-toast";
import { geometryChanged, validWall } from "@/lib/wallGeometry";
import { rescalePlanDimensions } from "@/lib/wallMetrics";
import { initializeDetectedWalls } from "@/lib/wallMetrics";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import type { Room, FloorPlanData, AppMode, DimensionUnit } from "@/types/floorplan";

const Index = () => {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted]           = useState(false);
  const [showSplash, setShowSplash]   = useState(true);
  const [workflow, setWorkflow] = useState<"upload" | "draw" | null>(null);
  const [showStart, setShowStart] = useState(true);
  const [mode, setMode]               = useState<AppMode>("simple");
  const [imageUrl, setImageUrl]       = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageName, setImageName]     = useState<string | null>(null);
  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);
  const [fileType, setFileType]       = useState<string | null>(null);
  const [imageFile, setImageFile]     = useState<File | null>(null);
  const [detected, setDetected]       = useState(false);
  const [detecting, setDetecting]     = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [generated, setGenerated]     = useState(false);
  // FIX: เริ่มต้น scale = 0 เพื่อให้ WallReview รู้ว่ายังไม่ calibrate
  // scale จะถูก set จริงเมื่อผู้ใช้กด Apply ใน calibration flow เท่านั้น
  const [debugMode, setDebugMode]     = useState(true);
  const [debugImages, setDebugImages] = useState<Record<string, string> | null>(null);
  const [cleanImageUrl, setCleanImageUrl] = useState<string | null>(null);
  const [editorHistory, dispatch] = useReducer(projectHistoryReducer, undefined, () => initialHistory());
  const { rooms, walls, doors, windows, scale, unit, planW, planH, screenPpm, wallHeightMeter } = editorHistory.present;
  const editProject = useCallback((update: (project: ProjectState) => ProjectState, info: ActionInfo) => dispatch({ type: "edit", update, info }), []);
  const actions = useMemo(() => ({
    active: !!editorHistory.pending,
    begin: (info?: ActionInfo) => dispatch({ type: "begin", info }),
    commit: () => dispatch({ type: "commit" }),
    cancel: () => dispatch({ type: "cancel" }),
    run: (info: ActionInfo, update: () => void) => {
      dispatch({ type: "begin", info });
      try { update(); dispatch({ type: "commit" }); }
      catch (error) { dispatch({ type: "cancel" }); throw error; }
    },
  }), [editorHistory.pending]);
  const undoEditorAction = useCallback((source: "review" | "3d" = "3d") => {
    const entry = editorHistory.past.at(-1);
    if (source === "review" && entry?.threeOnly) toast({ description: `Undid ${entry.label}` });
    dispatch({ type: "undo" });
  }, [editorHistory.past]);
  const redoEditorAction = useCallback((source: "review" | "3d" = "3d") => {
    const entry = editorHistory.future[0];
    if (source === "review" && entry?.threeOnly) toast({ description: `Redid ${entry.label}` });
    dispatch({ type: "redo" });
  }, [editorHistory.future]);
  const setScale = useCallback((nextScale: number) => editProject(p => ({
    ...p,
    scale: nextScale,
    ...rescalePlanDimensions(p.planW, p.planH, p.scale, nextScale),
  }), { label: "calibration change" }), [editProject]);
  const setUnit = useCallback((unit: DimensionUnit) => editProject(p => ({ ...p, unit }), { label: "unit change" }), [editProject]);
  const setPlanSize = useCallback((planW: number, planH: number) => editProject(p => ({ ...p, planW, planH }), { label: "calibration change" }), [editProject]);
  const setScreenPpm = useCallback((screenPpm: number) => editProject(p => ({ ...p, screenPpm }), { label: "calibration change" }), [editProject]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z" || isNativeUndoTarget(event.target)) return;
      event.preventDefault();
      const source = generated ? "3d" : "review";
      if (event.shiftKey) redoEditorAction(source); else undoEditorAction(source);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undoEditorAction, redoEditorAction, generated]);

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
    dispatch({ type: "reset", project: { ...emptyProject(), unit, wallHeightMeter } });
    setDebugImages(null);
    setCleanImageUrl(null);

  }, [unit, wallHeightMeter]);

  const handleClear = useCallback(() => {
    setImageUrl(null);
    setImageDataUrl(null);
    setImageName(null);
    setFileType(null);
    setImageFile(null);
    setOriginalImageUrl(null);
    dispatch({ type: "reset", project: { ...emptyProject(), unit, wallHeightMeter } });
    setDetected(false);
    setDetecting(false);
    setDetectError(null);
    setGenerated(false);
    setDebugImages(null);
    setCleanImageUrl(null);

  }, [unit, wallHeightMeter]);

  const handleWallHeightChange = useCallback((height: number) => {
    editProject(p => ({ ...p, wallHeightMeter: height, rooms: p.rooms.map(r => ({ ...r, wallHeight: height })),
      walls: p.walls.map(w => ({ ...w, wallHeight: height })) }), { label: "wall height change" });
  }, [editProject]);

  const handleDetect = useCallback(async () => {
    if (!imageFile) return;
    setDetecting(true);
    setDetectError(null);
    try {
      const result = await detectFloorPlan(imageFile, debugMode, undefined, wallHeightMeter);
      if (result.cleanImage) {
        setCleanImageUrl(result.cleanImage);
      }
      dispatch({ type: "reset", project: { ...editorHistory.present, rooms: result.rooms,
        walls: initializeDetectedWalls(result.walls),
        doors: result.doors, windows: result.windows } });
      setDebugImages(result.debugImages ?? null);
      setDetected(true);
      setGenerated(false);
    } catch (err: unknown) {
      setDetectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  }, [imageFile, debugMode, wallHeightMeter, editorHistory.present]);

  const fieldInfo = (kind: string, field: string): ActionInfo => {
    const names: Record<string, string> = { wallColor: "color", floorColor: "floor color", wallHeight: "height", wallTexture: "texture", scgPaintCode: "paint", wallFinish: "finish", tileCode: "tile", frameColor: "frame color", glassColor: "glass color", doorColor: "color", useBlenderModel: "model" };
    const threeOnly = /Color|Texture|Paint|Finish|tile|material|Material|scg|Name|Blender/.test(field);
    return { label: `${kind} ${names[field] ?? field} change`, threeOnly };
  };
  const handleRoomUpdate = useCallback((id: string, field: keyof Room, value: number | string) => {
    editProject(p => ({ ...p, rooms: p.rooms.map(r => r.id === id ? { ...r, [field]: value,
      confidence: field === "width" || field === "height" ? "manual" : r.confidence,
      ...(field === "width" || field === "height" ? { areaSqm: undefined } : {}),
    } : r) }), fieldInfo("room", field));
  }, [editProject]);
  const handleRoomPatch = useCallback((id: string, patch: Partial<Room>) => {
    editProject(p => ({ ...p, rooms: p.rooms.map(r => r.id === id ? { ...r, ...patch } : r) }), { label: "room material change", threeOnly: true });
  }, [editProject]);
  const handleWallGeometryCommit = useCallback((updatedWalls: DetectedWallSegment[]) => {
    editProject(p => {
      if (updatedWalls.length !== p.walls.length || updatedWalls.some((wall, index) => wall.id !== p.walls[index].id || (geometryChanged(p.walls[index], wall) && !validWall(wall)))) return p;
      return { ...p, walls: updatedWalls };
    }, { label: "wall geometry change" });
  }, [editProject]);
  const handleWallUpdate = useCallback((id: string, field: keyof DetectedWallSegment, value: number | string) => {
    editProject(p => ({ ...p, walls: p.walls.map(item => item.id === id ? { ...item, [field]: value } : item) }), fieldInfo("wall", field));
  }, [editProject]);
  const handleWallAdd = useCallback((item: DetectedWallSegment) => {
    editProject(p => ({ ...p, walls: [...p.walls, item] }), { label: "wall creation" });
  }, [editProject]);
  const handleDoorUpdate = useCallback((id: string, field: keyof DetectedDoor, value: DetectedDoor[keyof DetectedDoor]) => {
    editProject(p => ({ ...p, doors: p.doors.map(item => item.id === id ? { ...item, [field]: value } : item) }), fieldInfo("door", field));
  }, [editProject]);
  const handleDoorAdd = useCallback((item: DetectedDoor) => {
    editProject(p => ({ ...p, doors: [...p.doors, item] }), { label: "door creation" });
  }, [editProject]);
  const handleWindowUpdate = useCallback((id: string, field: keyof DetectedWindow, value: DetectedWindow[keyof DetectedWindow]) => {
    editProject(p => ({ ...p, windows: p.windows.map(item => item.id === id ? { ...item, [field]: value } : item) }), fieldInfo("window", field));
  }, [editProject]);
  const handleWindowAdd = useCallback((item: DetectedWindow) => {
    editProject(p => ({ ...p, windows: [...p.windows, item] }), { label: "window creation" });
  }, [editProject]);
  const handleRoomDelete = useCallback((id: string) => {
    editProject(p => ({ ...p, rooms: p.rooms.filter(item => item.id !== id) }), { label: "room deletion" });
  }, [editProject]);
  const handleWallDelete = useCallback((id: string) => {
    editProject(p => ({ ...p, walls: p.walls.filter(item => item.id !== id) }), { label: "wall deletion" });
  }, [editProject]);
  const handleDoorDelete = useCallback((id: string) => {
    editProject(p => ({ ...p, doors: p.doors.filter(item => item.id !== id) }), { label: "door deletion" });
  }, [editProject]);
  const handleWindowDelete = useCallback((id: string) => {
    editProject(p => ({ ...p, windows: p.windows.filter(item => item.id !== id) }), { label: "window deletion" });
  }, [editProject]);

  const handleGenerate = useCallback(() => { dispatch({ type: "commit" }); setGenerated(true); }, []);

  const handleProjectImport = useCallback((project: FloorPlanProject) => {
    setWorkflow(project.meta.editorMode ?? "upload");
    setShowStart(false);
    const importedImageUrl = project.image?.dataUrl ?? null;
    setImageUrl(importedImageUrl);
    setImageDataUrl(importedImageUrl);
    setImageName(project.image?.name ?? null);
    setOriginalImageUrl(importedImageUrl);
    setFileType(project.image?.fileType ?? null);
    setImageFile(null);
    dispatch({ type: "reset", project: { ...emptyProject(), furniture: project.furniture ?? [], rooms: project.rooms, walls: project.walls,
      doors: project.doors, windows: project.windows, unit: project.meta.unit, scale: project.meta.scale,
      planW: project.meta.planWidth, planH: project.meta.planHeight } });
    setDetected(true);
    setDetecting(false);
    setDetectError(null);
    setDebugImages(null);
    setCleanImageUrl(project.image?.cleanDataUrl ?? null);
    setGenerated(true);
  }, []);

  const floorPlanData: FloorPlanData = { meta: { unit, scale }, rooms };
  const projectData = createFloorPlanProject({
    furniture: editorHistory.present.furniture,
    editorMode: workflow ?? "upload",
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
  const chooseWorkflow = (next: "upload" | "draw") => {
    if (workflow === next) { setShowStart(false); return; }
    if (workflow && (imageUrl || walls.length || rooms.length) && !window.confirm("เริ่มโหมดใหม่จะล้างงานปัจจุบัน กรุณาบันทึกโปรเจกต์ก่อน ต้องการเริ่มใหม่หรือไม่?")) return;
    handleClear();
    setWorkflow(next);
    setShowStart(false);
    if (next === "draw") dispatch({ type: "reset", project: { ...emptyProject(), planW: DRAW_PLAN_SIZE, planH: DRAW_PLAN_SIZE, scale: DRAW_PLAN_SIZE / 1000, screenPpm: 1000 / DRAW_PLAN_SIZE } });
  };
  return (
    <ProjectActionContext.Provider value={actions}><ProjectInputActions>
      {showSplash && <SplashScreen onComplete={() => setShowSplash(false)} />}
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        <header className="shrink-0 border-b border-border bg-card/50 backdrop-blur-sm">
          <div className="px-4 py-3 flex flex-wrap gap-3 items-center justify-between">
            <div className="flex items-center gap-3">
              {generated && !showStart && (
                <button
                  onClick={() => { dispatch({ type: "cancel" }); setGenerated(false); }}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group mr-1"
                >
                  <ChevronLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
                  {workflow === "draw" ? "กลับไปวาด 2D" : "Back to Review"}
                </button>
              )}
              <h1 className="text-sm font-semibold text-foreground tracking-tight font-sans">Sketch to Spec</h1>
            </div>
            <div className="flex items-center gap-2">
            {workflow && <button className="rounded-xl border px-3 py-2 text-xs hover:bg-accent" onClick={() => downloadProjectJson(projectData)}>บันทึกโปรเจกต์</button>}
            {!showStart && <button disabled={detecting} className="rounded-xl border px-3 py-2 text-xs hover:bg-accent disabled:opacity-50" onClick={() => setShowStart(true)}>เลือกโหมด</button>}
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Toggle theme"
            >
              {mounted && theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              {mounted && theme === "dark" ? "Light" : "Dark"}
            </button>
            </div>
          </div>
        </header>

        {showStart ? <StartScreen onChoose={chooseWorkflow} onImport={project => {
          if (workflow && (imageUrl || rooms.length || walls.length) && !window.confirm("เปิดโปรเจกต์นี้แทนงานปัจจุบัน? กรุณาบันทึกงานเดิมก่อน")) return;
          handleProjectImport(project);
        }} /> : <div className="flex-1 flex min-h-0">
          {workflow !== "draw" && <Sidebar
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
          />}

          {workflow === "draw" && !generated ? <DrawPlan project={editorHistory.present} onEdit={editProject} onGenerate={handleGenerate}
            canUndo={editorHistory.past.length > 0 || !!editorHistory.pending} canRedo={editorHistory.future.length > 0 && !editorHistory.pending}
            onUndo={() => undoEditorAction("review")} onRedo={() => redoEditorAction("review")} /> : detecting ? (
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
              planWidth={planW}
              planHeight={planH}
              onScaleChange={setScale}
              onPlanSizeChange={setPlanSize}
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
              onDoorAdd={handleDoorAdd}
              onDoorUpdate={handleDoorUpdate}
              onWindowDelete={handleWindowDelete}
              onWindowAdd={handleWindowAdd}
              onWindowUpdate={handleWindowUpdate}
              canUndo={editorHistory.past.length > 0 || !!editorHistory.pending}
              canRedo={editorHistory.future.length > 0 && !editorHistory.pending}
              onUndo={() => undoEditorAction("review")}
              onRedo={() => redoEditorAction("review")}
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
              furniture={editorHistory.present.furniture}
              rooms={rooms}
              generated={generated}
              walls={walls}
              doors={doors}
              windows={windows}
              planWidth={planW}
              planHeight={planH}
              originalPlanUrl={originalImageUrl}
              originalPlanName={imageName}
              originalPlanIsPdf={fileType === "application/pdf"}
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
              onBack={() => { dispatch({ type: "cancel" }); setGenerated(false); }}
              canUndo={editorHistory.past.length > 0 || !!editorHistory.pending}
              canRedo={editorHistory.future.length > 0 && !editorHistory.pending}
              onUndo={() => undoEditorAction("3d")}
              onRedo={() => redoEditorAction("3d")}
            />
          )}
        </div>}
      </div>
    </ProjectInputActions></ProjectActionContext.Provider>
  );
};

export default Index;
