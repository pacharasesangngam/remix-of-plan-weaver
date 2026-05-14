import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, ZoomIn } from "lucide-react";

const DEBUG_LABELS: Record<string, string> = {
  "01_preprocessed": "1. Preprocessed",
  "02_dark_threshold": "2. Dark Threshold Mask",
  "03_yolo_walls": "3. YOLO Walls",
  "04_cv_walls": "4. CV Dark-Line Walls",
  "05_final_walls": "5. Final Walls",
};

const DEBUG_DESC: Record<string, string> = {
  "01_preprocessed": "ภาพหลัง resize / crop / deskew ก่อนส่งให้ YOLO",
  "02_dark_threshold": "Mask ขาว-ดำของเส้นมืด — ขาว = ผนัง, ดำ = ห้องว่าง",
  "03_yolo_walls": "ผนังที่ YOLO model ตรวจพบ (สีส้ม)",
  "04_cv_walls": "ผนังที่ตรวจด้วย CV dark-line (สีฟ้า)",
  "05_final_walls": "ผนังสุดท้ายหลัง merge + snap + filter (สีเขียว)",
};

interface DebugPanelProps {
  images: Record<string, string>;
  open: boolean;
  onClose: () => void;
}

const DebugPanel = ({ images, open, onClose }: DebugPanelProps) => {
  const [zoomed, setZoomed] = useState<{ key: string; src: string } | null>(null);
  const entries = Object.entries(images).sort(([a], [b]) => a.localeCompare(b));

  const handleClose = () => {
    setZoomed(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-4xl w-full">
        {zoomed ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setZoomed(null)}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <div>
                  <DialogTitle className="text-sm">
                    {DEBUG_LABELS[zoomed.key] ?? zoomed.key}
                  </DialogTitle>
                  {DEBUG_DESC[zoomed.key] && (
                    <p className="text-[11px] text-muted-foreground">{DEBUG_DESC[zoomed.key]}</p>
                  )}
                </div>
              </div>
            </DialogHeader>
            <div className="flex items-center justify-center overflow-auto max-h-[76vh]">
              <img
                src={zoomed.src}
                alt={zoomed.key}
                className="max-h-[74vh] w-full rounded-xl border border-border object-contain"
              />
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Debug Images</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-4 max-h-[72vh] overflow-y-auto pr-1">
              {entries.map(([key, src]) => (
                <div key={key} className="space-y-1">
                  <p className="text-xs font-semibold text-foreground">
                    {DEBUG_LABELS[key] ?? key}
                  </p>
                  {DEBUG_DESC[key] && (
                    <p className="text-[10px] text-muted-foreground">{DEBUG_DESC[key]}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => setZoomed({ key, src })}
                    className="group relative w-full overflow-hidden rounded-xl border border-border bg-background"
                  >
                    <img
                      src={src}
                      alt={key}
                      className="w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                    />
                    <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/0 transition-colors duration-200 group-hover:bg-black/30">
                      <ZoomIn className="h-7 w-7 text-white opacity-0 drop-shadow transition-opacity duration-200 group-hover:opacity-100" />
                    </div>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default DebugPanel;
