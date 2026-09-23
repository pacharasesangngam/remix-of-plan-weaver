import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code,
  Copy,
  Download,
  Loader2,
  ScanLine,
  Upload,
  X,
} from "lucide-react";
import type { Room, FloorPlanData, AppMode, DimensionUnit } from "@/types/floorplan";
import type { FloorPlanProject } from "@/lib/projectIO";
import { downloadProjectJson, parseFloorPlanProject } from "@/lib/projectIO";
import DebugPanel from "@/components/DebugPanel";

interface SidebarProps {
  mode: AppMode;
  unit: DimensionUnit;
  imageUrl: string | null;
  fileType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  rooms: Room[];
  detected: boolean;
  detecting?: boolean;
  scale: number;
  debugMode: boolean;
  debugImages: Record<string, string> | null;
  onImageUpload: (file: File) => void;
  onClear: () => void;
  onDetect: () => void;
  onRoomUpdate: (id: string, field: keyof Room, value: number | string) => void;
  onScaleChange: (scale: number) => void;
  onUnitChange: (unit: DimensionUnit) => void;
  onGenerate: () => void;
  onDebugToggle: () => void;
  floorPlanData: FloorPlanData | null;
  projectData: FloorPlanProject;
  onProjectImport: (project: FloorPlanProject) => void;
}

const Sidebar = ({
  unit,
  imageUrl,
  fileType,
  fileName,
  fileSize,
  rooms,
  detected,
  detecting = false,
  scale,
  debugMode,
  debugImages,
  onImageUpload,
  onClear,
  onDetect,
  onDebugToggle,
  floorPlanData,
  projectData,
  onProjectImport,
}: SidebarProps) => {
  const [collapsed, setCollapsed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [developerToolsOpen, setDeveloperToolsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const safeData = floorPlanData ?? { meta: { unit, scale }, rooms: [] };

  useEffect(() => {
    setDeveloperToolsOpen(false);
  }, [imageUrl]);

  useEffect(() => {
    if (detected) setCollapsed(true);
  }, [detected]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) onImageUpload(file);
  }, [onImageUpload]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImageUpload(file);
  };

  const handleCopyJSON = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(safeData, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const handleExportProject = () => {
    downloadProjectJson(projectData);
  };

  const handleProjectFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const raw = await file.text();
      onProjectImport(parseFloorPlanProject(JSON.parse(raw)));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not import project file.");
    }
  };

  const isPdf = fileType === "application/pdf";
  // Retained for the non-rendered upload flow markup below.
  const stepTwoLabel = detected ? "Ready" : detecting ? "Running" : "Idle";
  const fileFormat = isPdf ? "PDF" : (fileType?.split("/")[1]?.toUpperCase() ?? "IMAGE");
  const fileSizeLabel = fileSize
    ? `${fileSize >= 1024 * 1024 ? (fileSize / (1024 * 1024)).toFixed(1) : Math.max(1, Math.round(fileSize / 1024))} ${fileSize >= 1024 * 1024 ? "MB" : "KB"}`
    : null;

  return (
    <div className="relative flex shrink-0">
      <div
        className={`relative flex flex-col overflow-hidden border-r border-border bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--surface-raised))_100%)] transition-all duration-300 ${
          collapsed ? "w-0 opacity-0 pointer-events-none" : "w-[360px]"
        }`}
      >
        <div className="scrollbar-none w-[360px] h-full overflow-y-auto">
          <div className="border-b border-border/70 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.22),transparent_34%)] px-5 pb-5 pt-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">Workspace</div>
                  <h2 className="mt-1 text-lg font-semibold text-foreground">2D Floor Plan to 3D Converter</h2>
                </div>
              </div>
            </div>
          </div>

          {imageUrl && (
            <div className="space-y-4 p-4">
              <section className="overflow-hidden rounded-[28px] border border-border/55 bg-card p-4 shadow-[0_14px_36px_hsl(var(--foreground)/0.04)]">
                <div className="relative overflow-hidden rounded-[24px] border border-border/55 bg-background shadow-inner">
                  {isPdf ? (
                    <iframe src={imageUrl} title="Floor plan PDF preview" className="h-72 w-full bg-background" />
                  ) : (
                    <img src={imageUrl} alt="Floor plan" className="h-72 w-full object-contain p-5" />
                  )}
                  <button type="button" onClick={onClear} aria-label="Remove floor plan" className="absolute right-3 top-3 rounded-full border border-border/55 bg-card/90 p-2 text-muted-foreground transition-colors hover:text-foreground">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="pt-3 text-center">
                  <div className="text-sm font-semibold text-foreground">{fileName ?? "Floor plan"}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{fileFormat}{fileSizeLabel ? ` · ${fileSizeLabel}` : ""}</div>
                </div>
              </section>

              {!detected && (
                <Button onClick={onDetect} disabled={detecting} className="h-12 w-full rounded-[22px] text-sm shadow-sm">
                  {detecting ? <><Loader2 className="h-4 w-4 animate-spin" />Detecting</> : <><ScanLine className="h-4 w-4" />Run Detection</>}
                </Button>
              )}

              <Collapsible open={developerToolsOpen} onOpenChange={setDeveloperToolsOpen} className="overflow-hidden rounded-[28px] border border-border/55 bg-card shadow-[0_14px_36px_hsl(var(--foreground)/0.04)]">
                <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-accent/40">
                  <div className="rounded-xl border border-border/55 bg-primary/10 p-2 text-primary"><Code className="h-5 w-5" /></div>
                  <div className="flex-1"><div className="text-sm font-semibold text-foreground">Developer Tools</div><div className="mt-0.5 text-xs text-muted-foreground">Debug & inspection tools</div></div>
                  <ChevronDown className={`h-5 w-5 text-foreground transition-transform ${developerToolsOpen ? "" : "-rotate-90"}`} />
                </CollapsibleTrigger>
                <CollapsibleContent className="border-t border-border/55 px-4 pb-4 pt-2">
                  {!detected && (
                    <button
                      type="button"
                      onClick={onDebugToggle}
                      className={`flex w-full items-center gap-3 border-b border-border/55 px-1 py-3 text-left transition-colors ${
                        debugMode ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <div className={`rounded-xl p-2 ${debugMode ? "bg-amber-400/10" : "bg-muted"}`}><Bug className="h-4 w-4" /></div>
                      <div className="flex-1"><div className="text-sm font-medium text-foreground">Debug Mode</div><div className="mt-0.5 text-xs text-muted-foreground">Generate inspection images</div></div>
                      <span className={`h-5 w-9 rounded-full p-0.5 transition-colors ${debugMode ? "bg-amber-400" : "bg-muted"}`}><span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${debugMode ? "translate-x-4" : "translate-x-0"}`} /></span>
                    </button>
                  )}
                  {debugImages && (
                    <button type="button" onClick={() => setDebugOpen(true)} className="flex w-full items-center gap-3 border-b border-border/55 px-1 py-3 text-left transition-colors hover:text-primary">
                      <div className="rounded-xl bg-amber-400/10 p-2 text-amber-600 dark:text-amber-400"><Bug className="h-4 w-4" /></div>
                      <div className="flex-1"><div className="text-sm font-medium text-foreground">Debug Images</div><div className="mt-0.5 text-xs text-muted-foreground">{Object.keys(debugImages).length} images available</div></div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  )}
                  <div className="pt-3">
                    <div className="mb-2 flex items-center gap-3 px-1">
                      <div className="rounded-xl bg-primary/10 p-2 text-primary"><Code className="h-4 w-4" /></div>
                      <div className="min-w-0 flex-1"><div className="text-sm font-medium text-foreground">JSON Output</div><div className="mt-0.5 text-xs text-muted-foreground">View or copy the current payload</div></div>
                      <button
                        type="button"
                        onClick={handleExportProject}
                        aria-label="Download full project JSON"
                        title="Download full project JSON"
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/55 bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="relative overflow-hidden rounded-[22px] border border-border/55 bg-background shadow-inner">
                      <button type="button" onClick={handleCopyJSON} className="absolute right-3 top-3 z-10 inline-flex h-9 items-center gap-1.5 rounded-full border border-border/55 bg-card/95 px-3 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"><Copy className="h-3.5 w-3.5" />{copied ? "Copied" : "Copy"}</button>
                      <pre className="scrollbar-none max-h-[250px] overflow-auto p-4 pt-14 text-xs text-muted-foreground">{JSON.stringify(safeData, null, 2)}</pre>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}

          <div className={imageUrl ? "hidden" : "space-y-4 p-4"}>
            <section className="overflow-hidden rounded-[28px] border border-border/55 bg-card shadow-[0_14px_36px_hsl(var(--foreground)/0.04)]">
              {imageUrl && <div className="flex items-center justify-between border-b border-border/55 px-4 py-4">
                <div className="flex items-center gap-3">
                  <div className={`flex h-9 w-9 items-center justify-center rounded-2xl border text-xs font-semibold ${
                    imageUrl ? "border-border/55 bg-success/10 text-success" : "border-border/55 bg-primary/10 text-primary"
                  }`}>
                    {imageUrl ? <CheckCircle2 className="h-4 w-4" /> : "1"}
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Step 1</div>
                    <div className="text-sm font-medium text-foreground">Upload Floor Plan</div>
                  </div>
                </div>
                <div className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                  imageUrl ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
                }`}>
                  Loaded
                </div>
              </div>}

              <div className="p-4">
                {!imageUrl ? (
                  <div className="space-y-3">
                    <button
                      type="button"
                      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleDrop}
                      onClick={() => inputRef.current?.click()}
                      className={`flex h-40 w-full flex-col items-center justify-center rounded-[24px] border-2 border-dashed px-4 text-center transition-all ${
                        isDragging
                          ? "border-primary bg-primary/10 shadow-[0_0_0_5px_hsl(var(--primary)/0.10)]"
                          : "border-border bg-background hover:border-primary/35 hover:bg-accent/60"
                      }`}
                    >
                      <div className="mb-3 rounded-2xl border border-border/70 bg-card p-3 shadow-sm">
                        <Upload className="h-5 w-5 text-primary" />
                      </div>
                      <div className="text-sm font-medium text-foreground">Drop floor plan here</div>
                      <div className="mt-1 text-[11px] text-muted-foreground">PNG, JPG, WEBP, PDF</div>
                      <input ref={inputRef} type="file" accept="image/*,.pdf,application/pdf" className="hidden" onChange={handleFileChange} />
                    </button>
                    <button
                      type="button"
                      onClick={() => importInputRef.current?.click()}
                      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[20px] border border-border/55 bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                    >
                      <Download className="h-4 w-4" />
                      Import Existing Project
                    </button>
                  </div>
                ) : (
                <div className="relative overflow-hidden rounded-[24px] border border-border/55 bg-background shadow-inner">
                    {isPdf ? (
                      <iframe src={imageUrl} title="Floor plan PDF preview" className="h-40 w-full bg-background" />
                    ) : (
                      <img src={imageUrl} alt="Floor plan" className="h-40 w-full object-contain p-3" />
                    )}
                    <button
                      type="button"
                      onClick={onClear}
                      className="absolute right-3 top-3 rounded-full border border-border/55 bg-card/90 p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </section>

            {imageUrl && (
              <section className="overflow-hidden rounded-[28px] border border-border/55 bg-card shadow-[0_14px_36px_hsl(var(--foreground)/0.04)]">
                <div className="flex items-center justify-between border-b border-border/55 px-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-9 w-9 items-center justify-center rounded-2xl border text-xs font-semibold ${
                      detected ? "border-border/55 bg-success/10 text-success" : "border-border/55 bg-primary/10 text-primary"
                    }`}>
                      {detected ? <CheckCircle2 className="h-4 w-4" /> : "2"}
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Step 2</div>
                      <div className="text-sm font-medium text-foreground">Detect And Inspect</div>
                    </div>
                  </div>
                  <div className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                    detected ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
                  }`}>
                    {stepTwoLabel}
                  </div>
                </div>

                <div className="p-4 space-y-3">
                  {!detected ? (
                    <>
                      <Button
                        onClick={onDetect}
                        disabled={!imageUrl || detecting}
                        className="h-12 w-full rounded-[22px] text-sm shadow-sm"
                      >
                        {detecting ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Detecting
                          </>
                        ) : (
                          <>
                            <ScanLine className="h-4 w-4" />
                            Run Detection
                          </>
                        )}
                      </Button>
                    </>
                  ) : (
                    <>
                      {debugImages && (
                        <button
                          type="button"
                          onClick={() => setDebugOpen(true)}
                          className="flex w-full items-center gap-3 rounded-[22px] border border-amber-400/60 bg-amber-400/10 px-4 py-3 text-left text-sm font-medium text-amber-600 transition-colors hover:bg-amber-400/20 dark:text-amber-400"
                        >
                          <div className="rounded-xl border border-amber-400/40 bg-amber-400/20 p-1.5">
                            <Bug className="h-4 w-4" />
                          </div>
                          <div className="flex-1">
                            <div>Debug Images</div>
                            <div className="text-[11px] font-normal opacity-70">{Object.keys(debugImages).length} ขั้นตอน</div>
                          </div>
                        </button>
                      )}
                    <Collapsible open={jsonOpen} onOpenChange={setJsonOpen}>
                      <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-[22px] border border-border/55 bg-background px-4 py-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent/70">
                        <div className="rounded-xl border border-border/55 bg-primary/10 p-1.5 text-primary">
                          <Code className="h-4 w-4" />
                        </div>
                        <div className="flex-1">
                          <div>JSON Output</div>
                          <div className="text-[11px] font-normal text-muted-foreground">Copy or export the current payload</div>
                        </div>
                        <ChevronDown className={`h-4 w-4 transition-transform ${jsonOpen ? "rotate-180" : ""}`} />
                      </CollapsibleTrigger>

                      <CollapsibleContent className="pt-3">
                        <div className="relative overflow-hidden rounded-[22px] border border-border/55 bg-background shadow-inner">
                          <button
                            type="button"
                            onClick={handleCopyJSON}
                            className="absolute right-3 top-3 z-10 inline-flex h-9 items-center gap-1.5 rounded-full border border-border/55 bg-card/95 px-3 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            {copied ? "Copied" : "Copy"}
                          </button>
                          <pre className="scrollbar-none max-h-[250px] overflow-auto p-4 pt-14 text-xs text-muted-foreground">
                            {JSON.stringify(safeData, null, 2)}
                          </pre>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => importInputRef.current?.click()}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-[18px] border border-border/55 bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                          >
                            <Upload className="h-3.5 w-3.5" />
                            Import Project
                          </button>
                          <button
                            type="button"
                            onClick={handleExportProject}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-[18px] border border-border/55 bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Export Project
                          </button>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                    </>
                  )}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Open sidebar" : "Close sidebar"}
        className="absolute -right-6 top-1/2 z-30 flex h-16 w-8 -translate-y-1/2 flex-col items-center justify-center gap-0.5 rounded-xl border border-border/55 bg-card/95 px-1 text-muted-foreground shadow-lg backdrop-blur-sm transition-all hover:text-foreground hover:shadow-xl"
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        <span className="text-[8px] font-semibold uppercase tracking-[0.14em] [writing-mode:vertical-rl]">
          {collapsed ? "Open" : "Close"}
        </span>
      </button>

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleProjectFileChange}
      />

      {debugImages && (
        <DebugPanel
          images={debugImages}
          open={debugOpen}
          onClose={() => setDebugOpen(false)}
        />
      )}
    </div>
  );
};

export default Sidebar;
