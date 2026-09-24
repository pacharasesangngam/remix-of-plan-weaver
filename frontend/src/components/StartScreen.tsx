import { ArrowRight, PencilRuler, Upload, Grid2X2 } from "lucide-react";
import { useRef, useState } from "react";
import { parseFloorPlanProject, type FloorPlanProject } from "@/lib/projectIO";

export default function StartScreen({ onChoose, onImport }: { onChoose: (mode: "upload" | "draw") => void; onImport: (project: FloorPlanProject) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  return <main className="flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08),transparent_65%)] px-6 py-12 sm:py-20">
    <div className="mx-auto max-w-4xl">
      <div className="mb-10 text-center"><span className="inline-flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-xs text-muted-foreground"><Grid2X2 className="h-4 w-4" /> YOUR SPACE, YOUR PLAN</span>
        <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">เริ่มออกแบบพื้นที่ของคุณ</h2><p className="mt-4 text-muted-foreground">มีแปลนอยู่แล้ว หรืออยากเริ่มวาดใหม่ เลือกวิธีที่เหมาะกับคุณ</p></div>
      <div className="grid gap-5 md:grid-cols-2">
        {([{ mode: "upload", title: "อัปโหลดแปลน", detail: "นำเข้าแปลนบ้าน ให้ AI ตรวจจับ แล้วตรวจแก้และแต่งต่อใน 3D", tag: "PNG · JPG · WEBP · PDF", Icon: Upload },
          { mode: "draw", title: "วาดแปลนเอง", detail: "เริ่มจากพื้นกริด วาดห้อง ผนัง ประตูและหน้าต่าง พร้อมดูระยะจริง", tag: "2D DRAWING → 3D", Icon: PencilRuler }] as const).map(({ mode, title, detail, tag, Icon }) =>
          <button key={mode} onClick={() => onChoose(mode)} className="group rounded-3xl border border-border bg-card p-7 text-left shadow-sm transition hover:-translate-y-1 hover:border-primary/60 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="mb-7 flex h-28 items-center justify-center rounded-2xl bg-primary/5"><Icon className="h-12 w-12 text-primary" strokeWidth={1.3} /></div>
            <p className="text-[11px] font-semibold tracking-widest text-primary">{tag}</p><h3 className="mt-3 text-2xl font-semibold">{title}</h3><p className="mt-3 min-h-12 text-sm leading-6 text-muted-foreground">{detail}</p><span className="mt-6 flex items-center justify-between text-sm font-medium">เริ่มต้น <ArrowRight className="h-5 w-5 transition group-hover:translate-x-1" /></span>
          </button>)}
      </div><p className="mt-7 text-center text-xs text-muted-foreground">ทั้งสองโหมดสามารถดู 3D ปรับวัสดุ และบันทึกโปรเจกต์ได้</p>
      <div className="mt-6 text-center"><button onClick={() => fileInput.current?.click()} className="rounded-full border bg-card px-5 py-2.5 text-sm hover:bg-accent">เปิดไฟล์โปรเจกต์เดิม</button>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={async e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; try { onImport(parseFloorPlanProject(JSON.parse(await file.text()))); setError(""); } catch { setError("เปิดไฟล์ไม่ได้ กรุณาเลือกไฟล์โปรเจกต์ JSON ที่บันทึกจากเว็บนี้"); } }} />
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  </main>;
}
