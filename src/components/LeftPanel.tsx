import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Upload, X, ScanLine, CheckCircle2, AlertCircle, ChevronDown,
  Code, Settings2, Zap, Download, Package,
} from "lucide-react";
import type { Room, FloorPlanData, AppMode, DimensionUnit } from "@/types/floorplan";
import { MATERIALS, UNITS } from "@/types/floorplan";

interface LeftPanelProps {
  mode: AppMode;
  unit: DimensionUnit;
  imageUrl: string | null;
  rooms: Room[];
  detected: boolean;
  scale: number;
  onImageUpload: (file: File) => void;
  onClear: () => void;
  onDetect: () => void;
  onRoomUpdate: (id: string, field: keyof Room, value: number | string) => void;
  onScaleChange: (scale: number) => void;
  onUnitChange: (unit: DimensionUnit) => void;
  onGenerate: () => void;
  floorPlanData: FloorPlanData;
}

const LeftPanel = ({
  mode,
  unit,
  imageUrl,
  rooms,
  detected,
  scale,
  onImageUpload,
  onClear,
  onDetect,
  onRoomUpdate,
  onScaleChange,
  onUnitChange,
  onGenerate,
  floorPlanData,
}: LeftPanelProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isPro = mode === "pro";

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith("image/")) onImageUpload(file);
    },
    [onImageUpload]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImageUpload(file);
  };

  const confidenceLabel = (c: Room["confidence"]) => {
    if (c === "high") return { text: "Detected (high)", icon: CheckCircle2, cls: "text-success" };
    if (c === "low") return { text: "Detected (low)", icon: AlertCircle, cls: "text-warning" };
    return { text: "Manual", icon: AlertCircle, cls: "text-muted-foreground" };
  };

  // Total cost estimate for Pro mode
  const totalCost = rooms.reduce((sum, r) => {
    const mat = MATERIALS.find((m) => m.id === r.material);
    const area = r.width * r.height;
    return sum + area * (mat?.costPerSqm ?? 0) + (r.finishCost ?? 0);
  }, 0);

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(floorPlanData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "floorplan.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentUnit = UNITS.find((u) => u.value === unit) ?? UNITS[0];

  return (
    <div className="w-[480px] shrink-0 border-r border-border flex flex-col bg-card/30 overflow-y-auto">
      <div className="p-5 space-y-5">

        {/* Step 1: Upload */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-[10px] font-bold font-mono">1</span>
            <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider font-sans">Upload Floor Plan</h2>
          </div>

          {!imageUrl ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => inputRef.current?.click()}
              className={`flex flex-col items-center justify-center rounded-lg border border-dashed cursor-pointer transition-all h-36 ${
                isDragging
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/40 hover:bg-surface-raised/50"
              }`}
            >
              <Upload className="w-6 h-6 text-muted-foreground mb-2" />
              <p className="text-xs font-medium text-foreground">Drop floor plan here</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">JPG, PNG, WEBP, PDF</p>
              <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
            </div>
          ) : (
            <div className="relative rounded-lg border border-border overflow-hidden bg-surface h-36">
              <img src={imageUrl} alt="Floor plan" className="w-full h-full object-contain p-2" />
              <button
                onClick={onClear}
                className="absolute top-2 right-2 p-1 rounded-md bg-card/80 backdrop-blur-sm border border-border hover:bg-destructive hover:text-destructive-foreground transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </section>

        {/* Step 2: Detect */}
        {imageUrl && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-[10px] font-bold font-mono">2</span>
              <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider font-sans">Detect & Calibrate</h2>
            </div>

            {!detected ? (
              <Button onClick={onDetect} variant="outline" className="w-full justify-center gap-2 h-9 text-xs">
                <ScanLine className="w-3.5 h-3.5" />
                Detect Rooms & Dimensions
              </Button>
            ) : (
              <div className="space-y-3">
                {/* Detection summary */}
                <div className="flex items-center gap-2 rounded-md bg-success/10 border border-success/20 px-3 py-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                  <span className="text-xs text-success">
                    Detected {rooms.length} rooms
                  </span>
                </div>

                {/* Pro: Unit selector */}
                {isPro && (
                  <div className="rounded-lg border border-border bg-surface p-3 space-y-2">
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider block">หน่วยวัด</label>
                    <div className="flex flex-wrap gap-1.5">
                      {UNITS.map((u) => (
                        <button
                          key={u.value}
                          onClick={() => onUnitChange(u.value)}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-mono border transition-all ${
                            unit === u.value
                              ? "bg-primary text-primary-foreground border-primary"
                              : "border-border text-muted-foreground hover:text-foreground hover:border-border/80"
                          }`}
                        >
                          {u.value.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Room list */}
                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {rooms.map((room) => {
                    const conf = confidenceLabel(room.confidence);
                    const Icon = conf.icon;
                    const displayW = +(room.width / currentUnit.toMeter).toFixed(2);
                    const displayH = +(room.height / currentUnit.toMeter).toFixed(2);
                    const mat = MATERIALS.find((m) => m.id === (room.material ?? "none"));
                    const area = room.width * room.height;
                    const matCost = area * (mat?.costPerSqm ?? 0);

                    return (
                      <div key={room.id} className="rounded-lg border border-border bg-surface p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-foreground">{room.name}</span>
                          <span className={`flex items-center gap-1 text-[10px] ${conf.cls}`}>
                            <Icon className="w-3 h-3" />
                            {conf.text}
                          </span>
                        </div>

                        <div className="flex gap-2">
                          <div className="flex-1">
                            <label className="text-[10px] text-muted-foreground mb-0.5 block">
                              Width ({unit})
                            </label>
                            <Input
                              type="number"
                              value={displayW}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value) || 0;
                                onRoomUpdate(room.id, "width", v * currentUnit.toMeter);
                              }}
                              step={unit === "m" ? 0.1 : unit === "ft" ? 0.1 : 1}
                              className="h-8 text-xs font-mono"
                            />
                          </div>
                          <div className="flex-1">
                            <label className="text-[10px] text-muted-foreground mb-0.5 block">
                              Depth ({unit})
                            </label>
                            <Input
                              type="number"
                              value={displayH}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value) || 0;
                                onRoomUpdate(room.id, "height", v * currentUnit.toMeter);
                              }}
                              step={unit === "m" ? 0.1 : unit === "ft" ? 0.1 : 1}
                              className="h-8 text-xs font-mono"
                            />
                          </div>
                          {isPro && (
                            <div className="w-20">
                              <label className="text-[10px] text-muted-foreground mb-0.5 block">
                                สูง (m)
                              </label>
                              <Input
                                type="number"
                                value={room.wallHeight ?? 2.8}
                                onChange={(e) => onRoomUpdate(room.id, "wallHeight", parseFloat(e.target.value) || 2.8)}
                                step={0.05}
                                className="h-8 text-xs font-mono"
                              />
                            </div>
                          )}
                        </div>

                        {/* Pro: Material & cost */}
                        {isPro && (
                          <div className="space-y-1.5 pt-1 border-t border-border">
                            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block">วัสดุพื้น</label>
                            <select
                              value={room.material ?? "none"}
                              onChange={(e) => onRoomUpdate(room.id, "material", e.target.value)}
                              className="w-full h-8 rounded-md border border-border bg-surface-raised text-xs text-foreground px-2 font-sans focus:outline-none focus:ring-1 focus:ring-ring"
                            >
                              {MATERIALS.map((m) => (
                                <option key={m.id} value={m.id}>{m.label}</option>
                              ))}
                            </select>
                            {(mat?.costPerSqm ?? 0) > 0 && (
                              <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
                                <span>{area.toFixed(2)} m² × {mat?.costPerSqm} ฿/m²</span>
                                <span className="text-foreground font-semibold">≈ {matCost.toLocaleString()} ฿</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Pro: Total cost */}
                {isPro && totalCost > 0 && (
                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs text-primary">
                      <Package className="w-3.5 h-3.5" />
                      <span>ราคาประมาณรวม (วัสดุพื้น)</span>
                    </div>
                    <span className="text-sm font-semibold text-primary font-mono">
                      {totalCost.toLocaleString()} ฿
                    </span>
                  </div>
                )}

                {/* Advanced (scale) */}
                <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                  <CollapsibleTrigger className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors py-1 w-full">
                    <Settings2 className="w-3 h-3" />
                    <span>Advanced (optional)</span>
                    <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-2">
                    <div className="rounded-lg border border-border bg-surface p-3 space-y-2">
                      <label className="text-[10px] text-muted-foreground block">Global scale multiplier</label>
                      <Input
                        type="number"
                        value={scale}
                        onChange={(e) => onScaleChange(parseFloat(e.target.value) || 1)}
                        step={0.1}
                        min={0.1}
                        className="h-8 text-xs font-mono w-32"
                      />
                      <p className="text-[10px] text-muted-foreground">Applied to all detected dimensions</p>
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {/* JSON Output */}
                <Collapsible open={jsonOpen} onOpenChange={setJsonOpen}>
                  <CollapsibleTrigger className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors py-1 w-full">
                    <Code className="w-3 h-3" />
                    <span>Show JSON Output</span>
                    <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${jsonOpen ? "rotate-180" : ""}`} />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-2">
                    <pre className="rounded-lg bg-surface border border-border p-3 text-[10px] font-mono text-muted-foreground overflow-auto max-h-[200px]">
                      {JSON.stringify(floorPlanData, null, 2)}
                    </pre>
                    {isPro && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleExportJSON}
                        className="w-full mt-2 gap-2 h-8 text-xs"
                      >
                        <Download className="w-3 h-3" />
                        Download JSON
                      </Button>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}
          </section>
        )}

        {/* Generate */}
        {detected && (
          <Button onClick={onGenerate} className="w-full gap-2 h-10">
            <Zap className="w-4 h-4" />
            Generate 3D
          </Button>
        )}
      </div>
    </div>
  );
};

export default LeftPanel;
