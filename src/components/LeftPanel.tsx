import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Upload, X, ScanLine, CheckCircle2, AlertCircle, ChevronDown, Code, Settings2, Zap } from "lucide-react";
import type { Room, FloorPlanData } from "@/types/floorplan";

interface LeftPanelProps {
  imageUrl: string | null;
  rooms: Room[];
  detected: boolean;
  scale: number;
  onImageUpload: (file: File) => void;
  onClear: () => void;
  onDetect: () => void;
  onRoomUpdate: (id: string, field: "width" | "height", value: number) => void;
  onScaleChange: (scale: number) => void;
  onGenerate: () => void;
  floorPlanData: FloorPlanData;
}

const LeftPanel = ({
  imageUrl,
  rooms,
  detected,
  scale,
  onImageUpload,
  onClear,
  onDetect,
  onRoomUpdate,
  onScaleChange,
  onGenerate,
  floorPlanData,
}: LeftPanelProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (c === "high") return { text: "Detected (high confidence)", icon: CheckCircle2, cls: "text-success" };
    if (c === "low") return { text: "Detected (low confidence)", icon: AlertCircle, cls: "text-warning" };
    return { text: "Manual input", icon: AlertCircle, cls: "text-muted-foreground" };
  };

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
                    Detected {rooms.length} rooms with dimension annotations
                  </span>
                </div>

                {/* Room list */}
                <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
                  {rooms.map((room) => {
                    const conf = confidenceLabel(room.confidence);
                    const Icon = conf.icon;
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
                            <label className="text-[10px] text-muted-foreground mb-0.5 block">Width (m)</label>
                            <Input
                              type="number"
                              value={room.width}
                              onChange={(e) => onRoomUpdate(room.id, "width", parseFloat(e.target.value) || 0)}
                              step={0.1}
                              className="h-8 text-xs font-mono"
                            />
                          </div>
                          <div className="flex-1">
                            <label className="text-[10px] text-muted-foreground mb-0.5 block">Depth (m)</label>
                            <Input
                              type="number"
                              value={room.height}
                              onChange={(e) => onRoomUpdate(room.id, "height", parseFloat(e.target.value) || 0)}
                              step={0.1}
                              className="h-8 text-xs font-mono"
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Advanced */}
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

                {/* Developer JSON */}
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
