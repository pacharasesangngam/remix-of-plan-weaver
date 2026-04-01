import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
    Upload, X, ScanLine, CheckCircle2, AlertCircle, ChevronDown,
    Code, Settings2, Zap, Download, Package, ChevronLeft, ChevronRight,
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
    floorPlanData: FloorPlanData;
}

const Sidebar = ({
    mode, unit, imageUrl, rooms, detected, detecting = false, scale,
    onImageUpload, onClear, onDetect, onRoomUpdate,
    onScaleChange, onUnitChange, onGenerate, floorPlanData,
}: SidebarProps) => {
    const [collapsed, setCollapsed] = useState(false);
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

    // Step status
    const step1Done = !!imageUrl;
    const step2Done = detected;

    const stepDot = (n: number, done: boolean, active: boolean) => (
        <span
            className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold font-mono shrink-0 transition-all duration-300 ${done
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
            {/* Main sidebar panel */}
            <div
                className={`relative flex flex-col bg-card/40 border-r border-border backdrop-blur-sm overflow-hidden transition-all duration-300 ease-in-out ${collapsed ? "w-0 opacity-0 pointer-events-none" : "w-[360px] opacity-100"
                    }`}
            >
                <div className="w-[360px] flex flex-col h-full overflow-y-auto">
                    {/* Sidebar header */}
                    <div className="shrink-0 px-4 py-3 border-b border-border flex items-center justify-between bg-card/50">
                        <span className="text-[11px] font-semibold text-foreground uppercase tracking-widest">
                            Steps
                        </span>
                        <div className="flex items-center gap-1.5">
                            {[
                                { n: 1, done: step1Done, active: !step1Done },
                                { n: 2, done: step2Done, active: step1Done && !step2Done },
                                { n: 3, done: false, active: step2Done },
                            ].map(({ n, done, active }) => (
                                <span
                                    key={n}
                                    className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${done ? "bg-success" : active ? "bg-primary" : "bg-border"
                                        }`}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Content */}
                    <div className="flex-1 p-4 space-y-5 overflow-y-auto">

                        {/* Step 1: Upload */}
                        <section className="space-y-3">
                            <div className="flex items-center gap-2">
                                {stepDot(1, step1Done, !step1Done)}
                                <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
                                    Upload Floor Plan
                                </h2>
                            </div>

                            {!imageUrl ? (
                                <div
                                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                                    onDragLeave={() => setIsDragging(false)}
                                    onDrop={handleDrop}
                                    onClick={() => inputRef.current?.click()}
                                    className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed cursor-pointer transition-all duration-200 h-32 group ${isDragging
                                        ? "border-primary bg-primary/8 scale-[1.02]"
                                        : "border-border/60 hover:border-primary/50 hover:bg-primary/5"
                                        }`}
                                >
                                    <div className={`p-2.5 rounded-full mb-2 transition-all duration-200 ${isDragging ? "bg-primary/15" : "bg-muted/40 group-hover:bg-primary/10"
                                        }`}>
                                        <Upload className={`w-5 h-5 transition-colors duration-200 ${isDragging ? "text-primary" : "text-muted-foreground group-hover:text-primary/70"
                                            }`} />
                                    </div>
                                    <p className="text-xs font-medium text-foreground">Drop floor plan here</p>
                                    <p className="text-[10px] text-muted-foreground mt-0.5">JPG, PNG, WEBP, PDF</p>
                                    <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
                                </div>
                            ) : (
                                <div className="relative rounded-xl border border-border overflow-hidden bg-surface group">
                                    <img src={imageUrl} alt="Floor plan" className="w-full h-32 object-contain p-2" />
                                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all duration-200 flex items-center justify-center">
                                        <button
                                            onClick={onClear}
                                            className="opacity-0 group-hover:opacity-100 transition-all duration-200 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-destructive text-destructive-foreground text-xs font-medium"
                                        >
                                            <X className="w-3 h-3" />
                                            Remove
                                        </button>
                                    </div>
                                    <div className="absolute top-2 right-2">
                                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-success/10 border border-success/20 text-[10px] text-success">
                                            <ImageIcon className="w-2.5 h-2.5" /> Loaded
                                        </span>
                                    </div>
                                </div>
                            )}
                        </section>

                        {/* Step 2: Detect */}
                        {imageUrl && (
                            <section className="space-y-3">
                                <div className="flex items-center gap-2">
                                    {stepDot(2, step2Done, !step2Done)}
                                    <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
                                        Detect &amp; Calibrate
                                    </h2>
                                </div>

                                {!detected ? (
                                    <Button
                                        onClick={onDetect}
                                        disabled={detecting}
                                        variant="outline"
                                        className="w-full justify-center gap-2 h-9 text-xs border-primary/30 hover:bg-primary/10 hover:border-primary/60 hover:text-primary transition-all disabled:opacity-60"
                                    >
                                        {detecting ? (
                                            <><Loader2 className="w-3.5 h-3.5 animate-spin" />AI กำลังวิเคราะห์…</>
                                        ) : (
                                            <><ScanLine className="w-3.5 h-3.5" />Detect Rooms &amp; Dimensions</>
                                        )}
                                    </Button>
                                ) : (

                                    // <div className="space-y-3">
                                        // <div className="flex items-center gap-2 rounded-lg bg-success/8 border border-success/20 px-3 py-2">
                                        //     <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                                        //     <span className="text-xs text-success">Detected {rooms.length} rooms</span>
                                        // </div>

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
                                //    </div>
                                )}
                            </section>
                        )}

                        {/* Step 3: Generate */}
                        {/* {detected && (
                            <section className="space-y-3">
                                <div className="flex items-center gap-2">
                                    {stepDot(3, false, true)}
                                    <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">Generate 3D</h2>
                                </div>
                                <Button
                                    onClick={onGenerate}
                                    className="w-full gap-2 h-10 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-[0_0_20px_rgba(59,130,246,0.3)] hover:shadow-[0_0_28px_rgba(59,130,246,0.5)] transition-all duration-300"
                                >
                                    <Zap className="w-4 h-4" />
                                    Generate 3D
                                </Button>
                            </section>
                        )} */}
                    </div>
                </div>
            </div>

            {/* Collapse/Expand toggle tab */}
            <button
                onClick={() => setCollapsed((c) => !c)}
                className="absolute -right-3 top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-6 h-12 rounded-r-lg bg-card border border-border border-l-0 hover:bg-accent transition-colors shadow-md"
                title={collapsed ? "Open panel" : "Close panel"}
            >
                {collapsed
                    ? <ChevronRight className="w-3 h-3 text-muted-foreground" />
                    : <ChevronLeft className="w-3 h-3 text-muted-foreground" />
                }
            </button>
        </div>
    );
};

export default Sidebar;
