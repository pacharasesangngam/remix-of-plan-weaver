import { Pencil, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { parseFloorPlanProject, type FloorPlanProject } from "@/lib/projectIO";

export default function StartScreen({ onChoose, onImport }: { onChoose: (mode: "upload" | "draw") => void; onImport: (project: FloorPlanProject) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  return <main className="flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08),transparent_65%)] px-6 py-10 sm:px-10 sm:py-12 lg:px-12">
    <div className="w-full">
      <div className="mb-7">
        <p className="text-xs font-semibold tracking-widest text-primary">WORKSPACE</p>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">Start a new project</h2>
        <p className="mt-3 text-base font-medium text-muted-foreground sm:text-lg">Choose how you want to start based on what you have.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {([
          { mode: "upload", title: "Upload Floor Plan", tag: "PNG \u00b7 JPG \u00b7 WEBP \u00b7 PDF", detail: "Let AI detect the plan, then review it in 2D and 3D.", Icon: Upload },
          { mode: "draw", title: "Create from Measurements", tag: "Start with real dimensions", detail: "Enter room dimensions or sketch the space you measured.", Icon: Pencil },
        ] as const).map(({ mode, title, tag, detail, Icon }) =>
          <button key={mode} type="button" onClick={() => onChoose(mode)}
            className="flex items-start gap-4 rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition-colors hover:border-primary/60 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:gap-6 sm:p-6">
            <span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl ${mode === "upload" ? "bg-primary/10 text-primary" : "bg-violet-500/10 text-violet-500"}`}>
              <Icon className="h-7 w-7" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-lg font-semibold tracking-tight">{title}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{tag}</span>
              <span className="mt-3 block text-sm leading-6 text-muted-foreground">{detail}</span>
            </span>
          </button>)}
      </div>
      <div className="my-6 flex items-center gap-6 text-xs font-medium text-muted-foreground">
        <div className="h-px flex-1 bg-border" /><span>or</span><div className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <h3 className="text-base font-semibold">Import Existing Project</h3>
          <p className="mt-1 text-sm text-muted-foreground">Open a Sketch to Spec project file (.json).</p>
        </div>
        <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}
          className="shrink-0 bg-primary/10 px-7 text-primary hover:bg-primary/20">Import</Button>
      </div>
      <div>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={async e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; try { onImport(parseFloorPlanProject(JSON.parse(await file.text()))); setError(""); } catch { setError("เปิดไฟล์ไม่ได้ กรุณาเลือกไฟล์โปรเจกต์ JSON ที่บันทึกจากเว็บนี้"); } }} />
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  </main>;
}
