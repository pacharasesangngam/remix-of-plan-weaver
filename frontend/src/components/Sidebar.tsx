import { useCallback, useRef, useState } from "react";
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
  Loader2,
  ScanLine,
  Upload,
  X,
} from "lucide-react";
import type { Room, FloorPlanData, AppMode, DimensionUnit } from "@/types/floorplan";
import DebugPanel from "@/components/DebugPanel";

interface SidebarProps {
  mode: AppMode;
  unit: DimensionUnit;
  imageUrl: string | null;
  fileType?: string | null;
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
}

const Sidebar = ({
  unit,
  imageUrl,
  fileType,
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
}: SidebarProps) => {
  const [collapsed, setCollapsed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const safeData = floorPlanData ?? { meta: { unit, scale }, rooms: [] };

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

  const stepOneLabel = imageUrl ? "Loaded" : "Missing";
  const stepTwoLabel = detected ? "Ready" : detecting ? "Running" : "Idle";
  const isPdf = fileType === "application/pdf";

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
                  <h2 className="mt-1 text-lg font-semibold text-foreground">Plan Pipeline</h2>
                </div>
                <div className="rounded-2xl border border-border/70 bg-primary/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
                  2 Steps
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4 p-4">
            <section className="overflow-hidden rounded-[28px] border border-border/55 bg-card shadow-[0_14px_36px_hsl(var(--foreground)/0.04)]">
              <div className="flex items-center justify-between border-b border-border/55 px-4 py-4">
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
                  {stepOneLabel}
                </div>
              </div>

              <div className="p-4">
                {!imageUrl ? (
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
                      <button
                        type="button"
                        onClick={onDebugToggle}
                        className={`flex w-full items-center gap-2.5 rounded-[18px] border px-4 py-2.5 text-xs font-medium transition-colors ${
                          debugMode
                            ? "border-amber-400/60 bg-amber-400/10 text-amber-600 dark:text-amber-400"
                            : "border-border/55 bg-background text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <Bug className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1 text-left">Debug Mode</span>
                        <span className={`h-4 w-7 rounded-full transition-colors ${debugMode ? "bg-amber-400" : "bg-muted"}`}>
                          <span className={`block h-4 w-4 rounded-full border-2 bg-white transition-transform ${debugMode ? "translate-x-3 border-amber-400" : "translate-x-0 border-muted"}`} />
                        </span>
                      </button>
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
