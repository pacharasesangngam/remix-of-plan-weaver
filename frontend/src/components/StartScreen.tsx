import { notify } from "@/lib/notify";
import { ArrowRight, Box, FolderOpen, Pencil, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { parseFloorPlanProject, type FloorPlanProject } from "@/lib/projectIO";
import "./StartScreen.css";
import { type Language } from "./LanguageSwitcher";

function PlanPreview({ drawing }: { drawing: boolean }) {
  return <span className={`start-preview ${drawing ? "start-preview-draw" : "start-preview-upload"}`} aria-hidden="true">
    <svg viewBox="0 0 360 180" fill="none">
      <g className="start-plan-sheet">
        <rect x="82" y="15" width="196" height="150" rx="12" className="start-paper" />
        <path d="M104 40H256V140H104Z M194 40V98 M194 119V140 M104 100H146 M168 100H194" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
        <path d="M146 100V78A22 22 0 0 1 168 100 M194 98H215A21 21 0 0 1 194 119" stroke="currentColor" strokeOpacity=".35" strokeWidth="1.5" />
        <rect x="117" y="51" width="50" height="20" rx="4" fill="currentColor" fillOpacity=".12" />
        <rect x="214" y="52" width="29" height="32" rx="4" fill="currentColor" fillOpacity=".12" />
        <rect x="121" y="115" width="24" height="12" rx="3" fill="currentColor" fillOpacity=".12" />
        {drawing ? <g><path d="M104 28H256 M104 24V32 M256 24V32" stroke="currentColor" strokeOpacity=".5" /><path d="M256 100V140H194" stroke="currentColor" strokeWidth="3" strokeDasharray="5 5" /><circle cx="256" cy="140" r="5" fill="currentColor" stroke="white" strokeWidth="2" /></g> : <path className="start-scan" d="M94 82H266" stroke="currentColor" strokeWidth="2" strokeOpacity=".5" />}
      </g>
    </svg>
  </span>;
}

export default function StartScreen({ onChoose, onImport, language = "en" }: { language?: Language; onChoose: (mode: "upload" | "draw") => void; onImport: (project: FloorPlanProject) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const t = (en: string, th: string) => language === "th" ? th : en;
  return <main lang={language} className="start-workspace min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-8">
    <div className="relative mx-auto w-full max-w-[960px]">
      <div className="mb-8 text-center sm:mb-10">
        <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-[42px] sm:leading-tight">{t("Start a new project", "เริ่มต้นโปรเจกต์ใหม่")}</h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground sm:text-base">{t("Every great space starts with an idea.", "ทุกพื้นที่ดี ๆ เริ่มต้นจากไอเดียของคุณ")}<br />{t("Choose how you’d like to bring yours to life.", "เลือกวิธีที่ใช่ แล้วเริ่มออกแบบไปด้วยกัน")}</p>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        {([
          { mode: "upload", title: t("Upload Floor Plan", "อัปโหลดแปลน"), tag: "PNG · JPG · WEBP · PDF", detail: t("Let AI detect the plan, then review it in 2D and 3D.", "ให้ AI อ่านแปลน แล้วปรับแต่งในมุมมอง 2D และ 3D"), Icon: Upload },
          { mode: "draw", title: t("Create from Measurements", "วาดจากขนาดจริง"), tag: t("Start with real dimensions", "เริ่มจากขนาดพื้นที่ของคุณ"), detail: t("Enter room dimensions or sketch the space you measured.", "กำหนดขนาดห้อง หรือวาดพื้นที่ตามที่คุณวัดไว้"), Icon: Pencil },
        ] as const).map(({ mode, title, tag, detail, Icon }) =>
          <button key={mode} type="button" onClick={() => onChoose(mode)}
            className="start-choice group" data-mode={mode}>
            <span className="flex items-center justify-between px-6 pt-6 sm:px-7"><span className="start-choice-icon"><Icon size={21} strokeWidth={1.7} aria-hidden="true" /></span><span className="text-xs font-medium text-muted-foreground">{mode === "upload" ? t("FROM A FLOOR PLAN", "เริ่มจากแปลนที่มี") : t("FROM A BLANK CANVAS", "ออกแบบด้วยตัวเอง")}</span></span>
            <PlanPreview drawing={mode === "draw"} />
            <span className="block min-w-0 px-6 pb-6 sm:px-7 sm:pb-7">
              <span className="block text-xl font-semibold tracking-tight">{title}</span>
              <span className="mt-2 block min-h-12 text-sm leading-6 text-muted-foreground">{detail}</span>
              <span className="mt-6 flex items-center justify-between gap-3"><span className="start-tag">{tag}</span><span className="start-choice-arrow"><ArrowRight size={18} aria-hidden="true" /></span></span>
            </span>
          </button>)}
      </div>
      <div className="mx-auto my-6 flex max-w-xs items-center gap-5 text-sm text-muted-foreground">
        <div className="h-px flex-1 bg-border" /><span>{t("or", "หรือ")}</span><div className="h-px flex-1 bg-border" />
      </div>
      <div className="start-import flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-4"><span className="start-import-icon"><FolderOpen size={22} strokeWidth={1.5} aria-hidden="true" /></span><div>
          <h3 className="text-base font-semibold">{t("Import Existing Project", "เปิดโปรเจกต์เดิม")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("Open a Sketch to Spec project file (.json).", "เปิดไฟล์โปรเจกต์ Sketch to Spec (.json) ที่บันทึกไว้")}</p>
        </div></div>
        <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}
          className="start-import-button shrink-0 gap-2 px-6">{t("Import", "เปิดไฟล์")}<ArrowRight size={15} aria-hidden="true" /></Button>
      </div>
      <div>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={async e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; try { onImport(parseFloorPlanProject(JSON.parse(await file.text()))); setError(""); } catch { notify("destructive", t("Could not open project", "เปิดโปรเจกต์ไม่สำเร็จ"), t("Choose a valid project JSON saved from Sketch to Spec.", "กรุณาเลือกไฟล์ JSON ที่บันทึกจาก Sketch to Spec")); setError("เปิดไฟล์ไม่ได้ กรุณาเลือกไฟล์โปรเจกต์ JSON ที่บันทึกจากเว็บนี้"); } }} />
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{t("Could not open this file. Choose a project JSON saved from Sketch to Spec.", error)}</p>}
      </div>
    </div>
  </main>;
}
