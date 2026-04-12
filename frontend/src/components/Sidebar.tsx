import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Upload, X, ScanLine, CheckCircle2, AlertCircle, ChevronDown,
  Code, Download, ChevronLeft, ChevronRight,
  Image as ImageIcon, Loader2,
} from "lucide-react";
import type { Room, FloorPlanData, AppMode, DimensionUnit } from "@/types/floorplan";
import { MATERIALS, UNITS } from "@/types/floorplan";

interface SidebarProps {
  mode: AppMode;
  unit: DimensionUnit;
  imageUrl: string | null;
  rooms: Room[];
  detected: boolean;
  detecting?: boolean;
  scale: number;
  onImageUpload: (file: File) => void;
  onClear: () => void;
  onDetect: () => void;
  onRoomUpdate: (id: string, field: keyof Room, value: number | string) => void;
  onScaleChange: (scale: number) => void;
  onUnitChange: (unit: DimensionUnit) => void;
  onGenerate: () => void;
  floorPlanData: FloorPlanData | null; // 🔥 กัน undefined
}

const Sidebar = ({
  mode, unit, imageUrl, rooms, detected, detecting = false, scale,
  onImageUpload, onClear, onDetect, onRoomUpdate,
  onScaleChange, onUnitChange, onGenerate, floorPlanData,
}: SidebarProps) => {

  const [collapsed, setCollapsed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isPro = mode === "pro";

  // ✅ SAFETY LAYER
  const safeRooms = Array.isArray(rooms) ? rooms : [];
  const safeData = floorPlanData ?? { meta: { unit: unit, scale: scale }, rooms: [] };

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

  const confidenceLabel = (c: Room["confidence"]) => {
    if (c === "high") return { text: "Detected (high)", icon: CheckCircle2, cls: "text-success" };
    if (c === "low") return { text: "Detected (low)", icon: AlertCircle, cls: "text-warning" };
    return { text: "Manual", icon: AlertCircle, cls: "text-muted-foreground" };
  };

  const totalCost = safeRooms.reduce((sum, r) => {
    const mat = MATERIALS.find((m) => m.id === r.material);
    const area = (r.width ?? 0) * (r.height ?? 0);
    return sum + area * (mat?.costPerSqm ?? 0) + (r.finishCost ?? 0);
  }, 0);

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(safeData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "floorplan.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentUnit = UNITS.find((u) => u.value === unit) ?? UNITS[0];

  const step1Done = !!imageUrl;
  const step2Done = detected;

  const stepDot = (n: number, done: boolean, active: boolean) => (
    <span
      className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold font-mono shrink-0 transition-all duration-300 ${
        done
          ? "bg-success/20 text-success border border-success/30"
          : active
          ? "bg-primary/20 text-primary border border-primary/30"
          : "bg-muted/30 text-muted-foreground border border-border"
      }`}
    >
      {done ? "✓" : n}
    </span>
  );

  return (
    <div className="relative flex shrink-0">

      {/* Sidebar */}
      <div
        className={`relative flex flex-col bg-card/40 border-r border-border backdrop-blur-sm overflow-hidden transition-all duration-300 ${
          collapsed ? "w-0 opacity-0 pointer-events-none" : "w-[360px]"
        }`}
      >
        <div className="w-[360px] flex flex-col h-full overflow-y-auto">

          {/* Header */}
          <div className="px-4 py-3 border-b border-border flex justify-between">
            <span className="text-[11px] font-semibold uppercase">Steps</span>
          </div>

          <div className="flex-1 p-4 space-y-5">

            {/* Upload */}
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                {stepDot(1, step1Done, !step1Done)}
                <h2 className="text-xs font-semibold uppercase">
                  Upload Floor Plan
                </h2>
              </div>

              {!imageUrl ? (
                <div
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => inputRef.current?.click()}
                  className="h-32 flex flex-col items-center justify-center border-2 border-dashed rounded-xl cursor-pointer"
                >
                  <Upload className="w-5 h-5 mb-2" />
                  <p className="text-xs">Drop floor plan here</p>
                  <input ref={inputRef} type="file" className="hidden" onChange={handleFileChange} />
                </div>
              ) : (
                <div className="relative border rounded-xl overflow-hidden">
                  <img src={imageUrl} className="w-full h-32 object-contain p-2" />
                  <button onClick={onClear} className="absolute top-2 right-2">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
            </section>

            {/* Detect */}
            {imageUrl && (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  {stepDot(2, step2Done, !step2Done)}
                  <h2 className="text-xs font-semibold uppercase">
                    Detect & Calibrate
                  </h2>
                </div>

                {!detected ? (
                  <Button
                    onClick={onDetect}
                    disabled={!imageUrl || detecting} // 🔥 FIX
                    className="w-full"
                  >
                    {detecting ? (
                      <><Loader2 className="animate-spin w-4 h-4" /> Detecting…</>
                    ) : (
                      <><ScanLine className="w-4 h-4" /> Detect</>
                    )}
                  </Button>
                ) : (
                  <Collapsible open={jsonOpen} onOpenChange={setJsonOpen}>
                    <CollapsibleTrigger className="flex items-center gap-2 text-xs">
                      <Code className="w-3 h-3" />
                      JSON Output
                      <ChevronDown className={`ml-auto ${jsonOpen ? "rotate-180" : ""}`} />
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                      <pre className="text-xs overflow-auto max-h-[200px]">
                        {JSON.stringify(safeData, null, 2)}
                      </pre>

                      {isPro && (
                        <Button onClick={handleExportJSON} className="w-full mt-2">
                          <Download className="w-3 h-3" />
                          Download JSON
                        </Button>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </section>
            )}

          </div>
        </div>
      </div>

      {/* Toggle */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-12 border"
      >
        {collapsed ? <ChevronRight /> : <ChevronLeft />}
      </button>

    </div>
  );
};

export default Sidebar;