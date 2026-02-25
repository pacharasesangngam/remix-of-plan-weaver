import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Upload,
  X,
  ScanLine,
  Code,
  Zap,
  Download,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";

import type { Room, FloorPlanData } from "@/types/floorplan";

interface SidebarProps {
  imageUrl: string | null;
  rooms: Room[];
  detected: boolean;
  detecting?: boolean;

  onImageUpload: (file: File) => void;
  onClear: () => void;
  onDetect: () => void;
  onGenerate: () => void;

  floorPlanData: FloorPlanData;
}

const Sidebar = ({
  imageUrl,
  rooms,
  detected,
  detecting = false,
  onImageUpload,
  onClear,
  onDetect,
  onGenerate,
  floorPlanData,
}: SidebarProps) => {
  const [collapsed, setCollapsed] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith("image/")) {
        onImageUpload(file);
      }
    },
    [onImageUpload],
  );

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(floorPlanData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "floorplan.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="relative flex shrink-0">
      {/* Sidebar panel */}
      <div
        className={`relative flex flex-col bg-card border-r transition-all duration-300 ${
          collapsed ? "w-0 overflow-hidden" : "w-[360px]"
        }`}
      >
        {!collapsed && (
          <div className="flex flex-col h-full overflow-y-auto p-4 space-y-5">
            {/* Upload */}
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider">
                Upload Floor Plan
              </h2>

              {!imageUrl ? (
                <div
                  onClick={() => inputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragOver={(e) => e.preventDefault()}
                  className="h-32 border-2 border-dashed rounded-lg flex flex-col items-center justify-center cursor-pointer hover:bg-muted/40 transition"
                >
                  <Upload className="w-5 h-5 mb-2" />
                  <p className="text-xs text-muted-foreground">
                    Click or Drop image
                  </p>
                  <input
                    ref={inputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) =>
                      e.target.files && onImageUpload(e.target.files[0])
                    }
                  />
                </div>
              ) : (
                <div className="relative border rounded-lg p-2">
                  <img
                    src={imageUrl}
                    className="h-28 w-full object-contain"
                    alt="Floor plan"
                  />
                  <button
                    onClick={onClear}
                    className="absolute top-2 right-2 bg-destructive text-white text-xs px-2 py-1 rounded"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
            </section>

            {/* Detect */}
            {imageUrl && !detected && (
              <Button onClick={onDetect} disabled={detecting}>
                {detecting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ScanLine className="w-4 h-4" />
                )}
                Detect Rooms
              </Button>
            )}

            {/* Detected summary */}
            {/* {detected && (
              <div className="text-xs text-muted-foreground">
                Detected <span className="font-semibold">{rooms.length}</span>{" "}
                rooms
              </div>
            )} */}

            {/* JSON */}
            {detected && (
              <Collapsible open={jsonOpen} onOpenChange={setJsonOpen}>
                <CollapsibleTrigger className="text-xs flex items-center gap-1 hover:text-foreground">
                  <Code className="w-3 h-3" />
                  JSON Output 
                </CollapsibleTrigger>

                <CollapsibleContent className="space-y-2">
                  <pre className="text-[10px] bg-muted p-2 rounded max-h-48 overflow-auto">
                    {JSON.stringify(floorPlanData, null, 2)}
                  </pre>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleExportJSON}
                    className="w-full gap-1"
                  >
                    <Download className="w-3 h-3" />
                    Download JSON
                  </Button>
                </CollapsibleContent>
              </Collapsible>
            )}

            {/* Generate */}
            {/* {detected && (
              <Button onClick={onGenerate} className="mt-auto gap-2">
                <Zap className="w-4 h-4" />
                Generate 3D
              </Button>
            )} */}
          </div>
        )}
      </div>

      {/* Collapse toggle
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="absolute -right-3 top-1/2 -translate-y-1/2 bg-card border rounded-r px-1 py-2 shadow"
      >
        {collapsed ? (
          <ChevronRight className="w-4 h-4" />
        ) : (
          <ChevronLeft className="w-4 h-4" />
        )}
      </button> */}
    </div>
  );
};

export default Sidebar;