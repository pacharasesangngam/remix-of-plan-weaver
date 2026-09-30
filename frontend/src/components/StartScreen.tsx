import { ArrowUpRight, Pencil, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { parseFloorPlanProject, type FloorPlanProject } from "@/lib/projectIO";

export default function StartScreen({ onChoose, onImport }: { onChoose: (mode: "upload" | "draw") => void; onImport: (project: FloorPlanProject) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  return <main className="flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.12),transparent_65%)] px-4 py-6 sm:px-10 sm:py-12 lg:px-12">
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-6 sm:mb-8">
        <p className="text-xs font-semibold tracking-widest text-primary">WORKSPACE</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:mt-4 sm:text-4xl">Start a new project</h2>
        <p className="mt-2 text-sm font-medium text-muted-foreground sm:mt-3 sm:text-lg">Choose how you want to start based on what you have.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 md:gap-4">
        {([
          { mode: "upload", title: "Upload Floor Plan", tag: "PNG \u00b7 JPG \u00b7 WEBP \u00b7 PDF", detail: "Let AI detect the plan, then review it in 2D and 3D.", Icon: Upload },
          { mode: "draw", title: "Create from Measurements", tag: "Start with real dimensions", detail: "Enter room dimensions or sketch the space you measured.", Icon: Pencil },
        ] as const).map(({ mode, title, tag, detail, Icon }) =>
          <button key={mode} type="button" onClick={() => onChoose(mode)}
            className="group relative flex min-h-32 items-start gap-4 rounded-[26px] border border-border/70 bg-card/75 p-4 text-left shadow-[0_12px_36px_hsl(var(--foreground)/0.05)] backdrop-blur-xl transition duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:gap-6 sm:p-6">
            <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl sm:h-14 sm:w-14 ${mode === "upload" ? "bg-primary/10 text-primary" : "bg-violet-500/10 text-violet-500"}`}>
              <Icon className="h-7 w-7" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block pr-6 text-base font-semibold tracking-tight sm:text-lg">{title}</span>
              <span className="mt-1 block text-xs text-muted-foreground sm:text-sm">{tag}</span>
              <span className="mt-2 block text-xs leading-5 text-muted-foreground sm:mt-3 sm:text-sm sm:leading-6">{detail}</span>
            </span>
            <ArrowUpRight className="absolute right-4 top-4 h-4 w-4 text-muted-foreground/50 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary sm:right-5 sm:top-5" aria-hidden="true" />
          </button>)}
      </div>
      <div className="my-5 flex items-center gap-4 text-xs font-medium text-muted-foreground sm:my-6 sm:gap-6">
        <div className="h-px flex-1 bg-border" /><span>or</span><div className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-3 rounded-[26px] border border-border/70 bg-card/65 p-4 shadow-sm backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 sm:py-5">
        <div>
          <h3 className="text-base font-semibold">Import Existing Project</h3>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">Open a Sketch to Spec project file (.json).</p>
        </div>
        <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}
          className="h-11 w-full shrink-0 rounded-2xl bg-primary/10 px-7 text-primary hover:bg-primary/20 sm:w-auto">Import</Button>
      </div>
      <div>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={async e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; try { onImport(parseFloorPlanProject(JSON.parse(await file.text()))); setError(""); } catch { setError("เปิดไฟล์ไม่ได้ กรุณาเลือกไฟล์โปรเจกต์ JSON ที่บันทึกจากเว็บนี้"); } }} />
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  </main>;
}
