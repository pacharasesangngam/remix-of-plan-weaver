import { useEffect, useRef, useState } from "react";
import { MousePointer2, Pencil, Square, DoorOpen, AppWindow, Hand, RotateCcw, RotateCw, Trash2, Plus, Minus, Maximize, Box } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import WallDimension from "./WallDimension";
import { moveDrawObject } from "@/lib/moveDrawObject";
import type { ProjectState, ActionInfo } from "@/lib/projectHistory";
import type { NormalizedPoint } from "@/types/floorplan";
import { rectangleRoom, polygonRoom, removeDrawObject, expandDrawingSheet } from "@/lib/manualPlan";
import { createOpeningBboxFromWallPoints } from "@/lib/openingPlacement";
import { ringsToPathD } from "@/lib/wallTopology";

type Tool = "select" | "room" | "wall" | "door" | "window" | "pan";
type Selection = { type: "room" | "wall" | "door" | "window"; id: string };
interface Props { project: ProjectState; onEdit: (update: (p: ProjectState) => ProjectState, info: ActionInfo) => void; onGenerate: () => void; onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean }

export default function DrawPlan({ project, onEdit, onGenerate, onUndo, onRedo, canUndo, canRedo }: Props) {
  const [movePreview, setMovePreview] = useState<ProjectState | null>(null);
  const { rooms, walls, doors, windows, planW, planH } = movePreview ?? project;
  const drag = useRef<{ selection: Selection; origin: NormalizedPoint; base: ProjectState; latest: ProjectState; pointerId: number } | null>(null);
  const [tool, setTool] = useState<Tool>("room");
  const [start, setStart] = useState<NormalizedPoint | null>(null);
  const [path, setPath] = useState<NormalizedPoint[]>([]);
  const [showHelp, setShowHelp] = useState(() => { try { return localStorage.getItem("draw-wall-help-hidden") !== "true"; } catch { return true; } });
  const [cursor, setCursor] = useState<NormalizedPoint | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [view, setView] = useState(() => {
    const size = Math.min(1000, 30000 / project.planW);
    return { x: (1000 - size) / 2, y: (1000 - size) / 2, size };
  });
  const [aspect, setAspect] = useState(1);
  const aspectRef = useRef(1);
  const [height, setHeight] = useState("2.8");
  const [openingWidth, setOpeningWidth] = useState("0.9");
  const [message, setMessage] = useState("");
  const svg = useRef<SVGSVGElement>(null);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  useEffect(() => {
    const element = svg.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      const next = width / height, previous = aspectRef.current;
      aspectRef.current = next;
      setAspect(next);
      setView(v => ({ ...v, x: v.x + v.size * (previous - next) / 2 }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (drag.current || pan.current) return;
      const matrix = element.getScreenCTM();
      if (!matrix) return;
      const pointer = element.createSVGPoint(); pointer.x = event.clientX; pointer.y = event.clientY;
      const anchor = pointer.matrixTransform(matrix.inverse());
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      const factor = Math.exp(Math.max(-200, Math.min(200, delta)) * 0.002);
      setView(v => {
        const size = Math.max(20, Math.min(4000, v.size * factor));
        const ratio = size / v.size;
        return { x: anchor.x - (anchor.x - v.x) * ratio, y: anchor.y - (anchor.y - v.y) * ratio, size };
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  const selectedRoom = selection?.type === "room" ? rooms.find(r => r.id === selection.id) : undefined;
  const selectedWall = selection?.type === "wall" ? walls.find(w => w.id === selection.id) : undefined;
  const switchTool = (next: Tool) => { setTool(next); setStart(null); setPath([]); setMessage(""); setSelection(null); if (next === "door" || next === "window") setOpeningWidth(next === "door" ? "0.9" : "1.2"); };
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => { if (e.key === "Escape") { drag.current = null; setMovePreview(null); setStart(null); setPath([]); setSelection(null); setMessage(""); } };
    window.addEventListener("keydown", cancel); return () => window.removeEventListener("keydown", cancel);
  }, []);
  useEffect(() => { setStart(null); setPath([]); drag.current = null; setMovePreview(null); }, [project]);
  const finishOpenWalls = () => {
    const wallHeight = Number(height);
    if (path.length < 2 || !Number.isFinite(wallHeight) || wallHeight < 1 || wallHeight > 10) { setMessage("ระบุความสูง 1–10 เมตร และวาดอย่างน้อยหนึ่งช่วง"); return; }
    const id = crypto.randomUUID();
    const created = path.slice(1).map((p, i) => ({ id: `draw-wall-${id}-${i}`, x1: path[i].x, y1: path[i].y, x2: p.x, y2: p.y, type: "interior" as const, thickness: 0.15, wallHeight }));
    onEdit(p => ({ ...p, walls: [...p.walls, ...created] }), { label: "wall chain creation" });
    setPath([]); setStart(null);
  };
  const point = (e: { clientX: number; clientY: number }): NormalizedPoint => {
    const p = svg.current!.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const local = p.matrixTransform(svg.current!.getScreenCTM()!.inverse());
    const snapped = { x: Math.max(0, Math.min(1, Math.round(local.x / 1000 * planW * 4) / 4 / planW)), y: Math.max(0, Math.min(1, Math.round(local.y / 1000 * planH * 4) / 4 / planH)) };
    if (tool === "wall" && path.length >= 3 && Math.hypot((snapped.x - path[0].x) * planW, (snapped.y - path[0].y) * planH) <= 0.35) return path[0];
    return snapped;
  };
  const zoom = (factor: number) => setView(v => { const size = Math.max(20, Math.min(4000, v.size * factor)); return { x: v.x + (v.size - size) * aspect / 2, y: v.y + (v.size - size) / 2, size }; });
  const choose = (e: React.PointerEvent, item: Selection) => {
    if (tool !== "select" || e.button !== 0) return;
    e.stopPropagation(); e.preventDefault(); setSelection(item); setMessage("");
    drag.current = { selection: item, origin: point(e), base: project, latest: project, pointerId: e.pointerId };
    svg.current?.setPointerCapture?.(e.pointerId);
  };
  const updateDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== e.pointerId) return;
    const p = point(e);
    active.latest = moveDrawObject(active.base, active.selection, { x: p.x - active.origin.x, y: p.y - active.origin.y });
    setMovePreview(active.latest);
  };
  const finishDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    updateDrag(e);
    const active = drag.current; drag.current = null; setMovePreview(null);
    if (active.latest !== active.base) onEdit(current => current === active.base ? active.latest : current, { label: `${active.selection.type} move` });
    if (svg.current?.hasPointerCapture?.(e.pointerId)) svg.current.releasePointerCapture(e.pointerId);
  };
  const draw = (p: NormalizedPoint) => {
    if (tool === "select") { setSelection(null); return; }
    if (tool === "pan") return;
    setMessage("");
    if (tool === "door" || tool === "window") {
      const width = Number(openingWidth);
      if (!Number.isFinite(width) || width < 0.3 || width > 5) { setMessage("ระบุความกว้างช่องเปิด 0.3–5 เมตร"); return; }
      const nearby = walls.map(wall => {
        const dx = (wall.x2 - wall.x1) * planW, dy = (wall.y2 - wall.y1) * planH, len = Math.hypot(dx, dy);
        const t = len ? Math.max(0, Math.min(1, ((p.x - wall.x1) * planW * dx + (p.y - wall.y1) * planH * dy) / (len * len))) : 0;
        return { wall, len, t, distance: Math.hypot((p.x - wall.x1) * planW - t * dx, (p.y - wall.y1) * planH - t * dy) };
      }).filter(w => w.distance < 0.35).sort((a, b) => a.distance - b.distance)[0];
      if (!nearby || nearby.len < width + 0.1) { setMessage("คลิกบนผนังที่ยาวกว่าช่องเปิด"); return; }
      const { wall, len } = nearby, half = width / len / 2, t = Math.max(half, Math.min(1 - half, nearby.t));
      const at = (v: number) => ({ x: wall.x1 + (wall.x2 - wall.x1) * v, y: wall.y1 + (wall.y2 - wall.y1) * v });
      const bbox = createOpeningBboxFromWallPoints(wall, at(t - half), at(t + half), planW, planH);
      if (!bbox) return;
      if ([...doors, ...windows].some(o => o.wallId === wall.id && o.bbox.x < bbox.x + bbox.w && o.bbox.x + o.bbox.w > bbox.x && o.bbox.y < bbox.y + bbox.h && o.bbox.y + o.bbox.h > bbox.y)) { setMessage("ตำแหน่งนี้ทับช่องเปิดเดิม กรุณาเลือกตำแหน่งอื่น"); return; }
      const opening = { id: crypto.randomUUID(), bbox, wallId: wall.id, widthM: width };
      onEdit(p => tool === "door" ? { ...p, doors: [...p.doors, opening] } : { ...p, windows: [...p.windows, opening] }, { label: `${tool} creation` }); return;
    }
    if (!start) { setStart(p); if (tool === "wall") setPath([p]); return; }
    const wallHeight = Number(height);
    if (!Number.isFinite(wallHeight) || wallHeight < 1 || wallHeight > 10) { setMessage("ความสูงต้องอยู่ระหว่าง 1–10 เมตร"); return; }
    if (tool === "room") {
      const result = rectangleRoom(start, p, `draw-${crypto.randomUUID()}`, `ห้อง ${rooms.length + 1}`, planW, planH, wallHeight);
      if (!result) { setMessage("ห้องต้องกว้างและยาวอย่างน้อย 0.5 เมตร"); return; }
      const b = result.room.bbox!;
      if (rooms.some(r => r.bbox && b.x < r.bbox.x + r.bbox.w - 1e-6 && b.x + b.w > r.bbox.x + 1e-6 && b.y < r.bbox.y + r.bbox.h - 1e-6 && b.y + b.h > r.bbox.y + 1e-6)) { setMessage("ห้องซ้อนกับห้องเดิม กรุณาวางในพื้นที่ว่าง"); return; }
      onEdit(p => ({ ...p, rooms: [...p.rooms, result.room], walls: [...p.walls, ...result.walls] }), { label: "room creation" });
      setSelection({ type: "room", id: result.room.id });
    } else {
      if (path.length >= 3 && Math.hypot((p.x - path[0].x) * planW, (p.y - path[0].y) * planH) <= 0.35) {
        const result = polygonRoom(path, `draw-${crypto.randomUUID()}`, `ห้อง ${rooms.length + 1}`, planW, planH, wallHeight);
        if (!result) { setMessage("ปิดห้องไม่ได้: แนวผนังต้องไม่ตัดกัน และห้องต้องมีพื้นที่อย่างน้อย 0.25 ตร.ม."); return; }
        onEdit(p => ({ ...p, rooms: [...p.rooms, result.room], walls: [...p.walls, ...result.walls] }), { label: "closed room creation" });
        setPath([]); setStart(null); setSelection({ type: "room", id: result.room.id }); return;
      }
      if (Math.hypot((p.x - start.x) * planW, (p.y - start.y) * planH) < 0.25) { setMessage("ผนังต้องยาวอย่างน้อย 0.25 เมตร"); return; }
      setPath(points => [...points, p]); setStart(p); return;
    }
    setStart(null);
  };
  const tools = [{ id: "select", label: "เลือก", Icon: MousePointer2 }, { id: "room", label: "วาดห้อง", Icon: Square }, { id: "wall", label: "วาดผนัง", Icon: Pencil }, { id: "door", label: "ประตู", Icon: DoorOpen }, { id: "window", label: "หน้าต่าง", Icon: AppWindow }, { id: "pan", label: "เลื่อนแปลน", Icon: Hand }] as const;
  const preview = start && cursor ? { x: Math.min(start.x, cursor.x), y: Math.min(start.y, cursor.y), w: Math.abs(cursor.x - start.x), h: Math.abs(cursor.y - start.y) } : null;
  const textStyle = { paintOrder: "stroke" as const, stroke: "white", strokeWidth: 3, fill: "#334155" };
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
    <aside className="z-10 max-h-[38vh] w-full shrink-0 overflow-y-auto border-b bg-card p-4 md:max-h-none md:w-64 md:border-b-0 md:border-r">
      <h2 className="text-lg font-semibold">สร้างแปลน</h2><p className="mb-4 mt-1 text-xs text-muted-foreground">ชั้น 1 · หน่วยเมตร · กริด 0.25 m</p>
      <div className="grid grid-cols-3 gap-2 md:grid-cols-2">{tools.map(({ id, label, Icon }) => <button key={id} onClick={() => switchTool(id)} aria-pressed={tool === id} className={`flex flex-col items-center gap-2 rounded-xl border p-3 text-xs transition ${tool === id ? "border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "hover:bg-accent"}`}><Icon className="h-5 w-5" />{label}</button>)}</div>
      <div className="mt-4 space-y-3">
        <div className="space-y-2 rounded-xl border p-3"><p className="text-xs text-muted-foreground">ลูกกลิ้ง: ซูมเข้า–ออกตามตำแหน่งเมาส์ · เครื่องมือมือ: เลื่อนแปลน</p>
          <Button variant="outline" className="w-full" disabled={!!start || !!movePreview || planW >= 1000 || planH >= 1000} onClick={() => { onEdit(expandDrawingSheet, { label: "expand drawing sheet" }); setView(v => ({ x: v.x / 2, y: v.y / 2, size: v.size / 2 })); }}>ขยายพื้นที่วาด 2 เท่า</Button>
          <p className="text-xs text-muted-foreground">ขนาดวัตถุจริงคงเดิม · Undo ได้</p>
        </div>
        {tool === "wall" && showHelp && <section className="rounded-xl border bg-background p-3 text-sm">
          <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">วิธีวาดผนัง</h3><button aria-label="ปิดคำแนะนำ" className="rounded px-2 py-1 hover:bg-accent" onClick={() => setShowHelp(false)}>×</button></div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">คลิกซ้ายเพื่อเริ่มวาด เลื่อนเมาส์เลือกระยะ แล้วคลิกเพื่อวางมุมถัดไป คลิกจุดสีเขียวจุดแรกเพื่อปิดห้องและสร้างพื้น</p>
          <svg viewBox="0 0 180 140" className="my-3 w-full" aria-label="ตัวอย่างการวาดผนังต่อเนื่อง"><rect x="25" y="15" width="130" height="100" fill="#d9bc91" fillOpacity="0.6" /><path d="M90 115H25V15H155V115H90" fill="none" stroke="#64748b" strokeWidth="7" /><path d="M90 115V78" stroke="#10b981" strokeWidth="6" strokeDasharray="5 3" /><circle cx="90" cy="115" r="6" fill="#10b981" /><circle cx="90" cy="78" r="4" fill="#10b981" /><text x="90" y="65" textAnchor="middle" fontSize="12" fill="#475569">ห้อง</text></svg>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" onChange={e => { try { localStorage.setItem("draw-wall-help-hidden", String(e.target.checked)); } catch { /* Optional preference only. */ } }} />ไม่ต้องแสดงครั้งถัดไป</label>
        </section>}
        {tool === "wall" && !showHelp && <button className="text-xs text-primary underline" onClick={() => setShowHelp(true)}>ดูวิธีวาดผนัง</button>}
        {tool === "wall" && path.length > 0 && <div className="space-y-2 rounded-xl border border-emerald-500/40 p-3"><p className="text-xs">กำลังร่าง {Math.max(0, path.length - 1)} ช่วง · ปิดห้องหรือกดจบแนวก่อนบันทึกงาน</p><Button variant="outline" className="w-full" disabled={path.length < 2} onClick={finishOpenWalls}>จบแนวผนัง (ไม่สร้างพื้น)</Button><Button variant="ghost" className="w-full" onClick={() => { const next = path.slice(0, -1); setPath(next); setStart(next.at(-1) ?? null); }}>ย้อนจุดล่าสุด</Button></div>}
        {(tool === "room" || tool === "wall") && <label className="grid gap-1 text-sm">ความสูงผนังใหม่ (m)<Input type="number" min="1" max="10" step="0.1" value={height} onChange={e => setHeight(e.target.value)} /></label>}
        {(tool === "door" || tool === "window") && <label className="grid gap-1 text-sm">ความกว้างช่องเปิด (m)<Input type="number" min="0.3" max="5" step="0.1" value={openingWidth} onChange={e => setOpeningWidth(e.target.value)} /></label>}
        <p className="text-xs leading-5 text-muted-foreground">{tool === "room" ? "คลิกมุมแรก แล้วคลิกมุมตรงข้ามเพื่อสร้างห้องสี่เหลี่ยมพร้อมพื้นและผนัง" : tool === "wall" ? "คลิกต่อแนวผนังทีละมุม แล้วคลิกจุดเริ่มสีเขียวเพื่อปิดห้อง หรือกดจบแนวเพื่อสร้างเฉพาะผนัง" : tool === "pan" ? "ลากพื้นที่วาดเพื่อเลื่อนแปลน" : tool === "select" ? "ลากพื้นห้องเพื่อย้ายทั้งห้อง หรือลากผนังแยกแต่ละชิ้น ประตู/หน้าต่างเลื่อนไปตามผนัง ปล่อยเมาส์เพื่อยืนยัน" : "คลิกบนผนังเพื่อวางช่องเปิด"} กด Esc เพื่อยกเลิก</p>
        {selection && <div className="space-y-2 rounded-xl border p-3"><p className="break-words text-xs font-semibold">{selectedRoom?.name ?? selectedWall?.id ?? selection.id}</p>
          {selectedRoom && <label className="grid gap-1 text-xs">ชื่อห้อง<Input value={selectedRoom.name} onChange={e => onEdit(p => ({ ...p, rooms: p.rooms.map(r => r.id === selectedRoom.id ? { ...r, name: e.target.value } : r) }), { label: "room name change" })} /></label>}
          {selectedWall && <p className="text-xs">ยาว {Math.hypot((selectedWall.x2 - selectedWall.x1) * planW, (selectedWall.y2 - selectedWall.y1) * planH).toFixed(2)} m</p>}
          <Button variant="outline" className="w-full text-destructive" onClick={() => { onEdit(p => removeDrawObject(p, selection), { label: `${selection.type} deletion` }); setSelection(null); }}><Trash2 className="mr-2 h-4 w-4" />ลบที่เลือก</Button>
          {selectedRoom && <p className="text-xs text-muted-foreground">ลบพร้อมผนังและช่องเปิดของห้องนี้ · Undo ได้</p>}</div>}
      </div>
    </aside>
    <div className="relative min-h-[360px] min-w-0 flex-1 overflow-hidden bg-white">
      <div className="absolute left-4 right-4 top-4 z-10 flex items-center justify-between gap-2 pointer-events-none"><span className="rounded-full border bg-white/95 px-4 py-2 text-xs text-slate-600">2D · พื้นที่ {planW} × {planH} m</span><Button className="pointer-events-auto rounded-full bg-emerald-600 text-white hover:bg-emerald-700" disabled={!!start || (!walls.length && !rooms.length)} onClick={onGenerate}><Box className="mr-2 h-4 w-4" />ดู 3D</Button></div>
      <svg ref={svg} role="img" aria-label="พื้นที่วาดแปลน 2D"
        className={`h-full min-h-[360px] w-full touch-none ${movePreview ? "cursor-grabbing" : tool === "pan" ? "cursor-grab" : tool === "select" ? "cursor-move" : "cursor-crosshair"}`}
        viewBox={`${view.x} ${view.y} ${view.size * aspect} ${view.size}`}
        preserveAspectRatio="none"
        onPointerDown={e => { if (e.button !== 0) return; if (tool === "pan") { const matrix = svg.current!.getScreenCTM()!; pan.current = { x: e.clientX / matrix.a, y: e.clientY / matrix.d, vx: view.x, vy: view.y }; e.currentTarget.setPointerCapture(e.pointerId); } else draw(point(e)); }}
        onPointerMove={e => { if (drag.current) { updateDrag(e); return; } if (pan.current) { const matrix = svg.current!.getScreenCTM()!; setView(v => ({ ...v, x: pan.current!.vx - (e.clientX / matrix.a - pan.current!.x), y: pan.current!.vy - (e.clientY / matrix.d - pan.current!.y) })); } else setCursor(point(e)); }}
        onPointerUp={e => { finishDrag(e); pan.current = null; }}
        onPointerCancel={() => { pan.current = null; drag.current = null; setMovePreview(null); }}
        onLostPointerCapture={() => { pan.current = null; drag.current = null; setMovePreview(null); }}>
        <defs><pattern id="draw-small-grid" width={1000 / planW / 4} height={1000 / planH / 4} patternUnits="userSpaceOnUse"><path d={`M ${1000 / planW / 4} 0 H 0 V ${1000 / planH / 4}`} fill="none" stroke="#e8edf1" strokeWidth="0.65" /></pattern><pattern id="draw-grid" width={1000 / planW} height={1000 / planH} patternUnits="userSpaceOnUse"><rect width={1000 / planW} height={1000 / planH} fill="url(#draw-small-grid)" /><path d={`M ${1000 / planW} 0 H 0 V ${1000 / planH}`} fill="none" stroke="#cbd5e1" strokeWidth="0.8" /></pattern></defs>
        <rect x={view.x} y={view.y} width={view.size * aspect} height={view.size} fill="white" />
        <rect x={view.x} y={view.y} width={view.size * aspect} height={view.size} fill="url(#draw-grid)" />
        <rect width="1000" height="1000" fill="none" stroke="#94a3b8" strokeDasharray="4 4" strokeWidth={view.size / 1000} pointerEvents="none" />
        {rooms.map(room => { const points = room.wallPolygon ?? room.polygon ?? []; const b = room.bbox; const holes = (room.holes ?? []).filter(hole => hole.length >= 3); const pathD = points.length >= 3 && holes.length ? ringsToPathD([points, ...holes], 1000) : null; const fill = room.floorColor ?? "#d9bc91"; const stroke = selection?.id === room.id ? "#059669" : "none"; return <g key={room.id} onPointerDown={e => choose(e, { type: "room", id: room.id })}>{pathD ? <path d={pathD} fillRule="evenodd" fill={fill} fillOpacity={0.55} stroke={stroke} strokeWidth={3} /> : <polygon points={points.map(p => `${p.x * 1000},${p.y * 1000}`).join(" ")} fill={fill} fillOpacity={0.55} stroke={stroke} strokeWidth={3} />}{b && <g pointerEvents="none" fontSize={10} textAnchor="middle"><text x={(b.x + b.w / 2) * 1000} y={(b.y + b.h / 2) * 1000} style={textStyle}>{room.name}</text><text x={(b.x + b.w / 2) * 1000} y={b.y * 1000 - 10} style={textStyle}>{(b.w * planW).toFixed(2)} m</text><text x={(b.x + b.w) * 1000 + 10} y={(b.y + b.h / 2) * 1000} textAnchor="start" style={textStyle}>{(b.h * planH).toFixed(2)} m</text></g>}</g>; })}
        {walls.map(w => <g key={w.id} onPointerDown={e => choose(e, { type: "wall", id: w.id })}><line x1={w.x1 * 1000} y1={w.y1 * 1000} x2={w.x2 * 1000} y2={w.y2 * 1000} stroke="transparent" strokeWidth={12} /><line x1={w.x1 * 1000} y1={w.y1 * 1000} x2={w.x2 * 1000} y2={w.y2 * 1000} stroke={selection?.id === w.id ? "#10b981" : "#64748b"} strokeWidth={(w.thickness ?? 0.15) / planW * 1000} pointerEvents="none" /></g>)}
        {[...doors.map(d => ({ ...d, type: "door" as const })), ...windows.map(w => ({ ...w, type: "window" as const }))].map(o => <rect key={o.id} x={o.bbox.x * 1000} y={o.bbox.y * 1000} width={o.bbox.w * 1000} height={o.bbox.h * 1000} fill={o.type === "door" ? "#fbbf24" : "#7dd3fc"} stroke={selection?.id === o.id ? "#059669" : "#334155"} strokeWidth={1.5} onPointerDown={e => choose(e, { type: o.type, id: o.id })} />)}
        {preview && start && cursor && tool === "room" && <g pointerEvents="none"><rect x={preview.x * 1000} y={preview.y * 1000} width={preview.w * 1000} height={preview.h * 1000} fill="#10b98122" stroke="#059669" strokeDasharray="5 3" /><text x={cursor.x * 1000 + 8} y={cursor.y * 1000 - 10} fontSize={12} style={textStyle}>{`${(preview.w * planW).toFixed(2)} × ${(preview.h * planH).toFixed(2)} m`}</text></g>}
        {tool === "wall" && path.length > 0 && <g pointerEvents="none">
          <polyline points={path.map(p => `${p.x * 1000},${p.y * 1000}`).join(" ")} fill="none" stroke="#64748b" strokeWidth={5} strokeLinejoin="round" />
          {path.map((p, i) => <circle key={i} cx={p.x * 1000} cy={p.y * 1000} r={i === 0 ? 6 : 3} fill={i === 0 ? "#10b981" : "#64748b"} stroke="white" strokeWidth={1} />)}
          {path.length >= 3 && <text x={path[0].x * 1000 + 10} y={path[0].y * 1000 - 12} fontSize={11} style={textStyle}>คลิกเพื่อปิดห้อง</text>}
        </g>}
        {tool === "wall" && start && cursor && <g pointerEvents="none">
          <line x1={start.x * 1000} y1={start.y * 1000} x2={cursor.x * 1000} y2={cursor.y * 1000} stroke="#22c55e" strokeOpacity={0.22} strokeWidth={12} />
          <line x1={start.x * 1000} y1={start.y * 1000} x2={cursor.x * 1000} y2={cursor.y * 1000} stroke="#65c98d" strokeWidth={5} />
          <circle cx={start.x * 1000} cy={start.y * 1000} r={4} fill="#4ade80" stroke="#16a34a" />
          <circle cx={cursor.x * 1000} cy={cursor.y * 1000} r={3} fill="#4ade80" stroke="#16a34a" />
          <WallDimension from={start} to={cursor} planW={planW} planH={planH} uiScale={view.size / 1000} />
          <g transform={`translate(${cursor.x * 1000 + 3} ${cursor.y * 1000 - 15 * view.size / 1000}) scale(${view.size / 1000})`}><Pencil width={16} height={16} color="#334155" fill="white" /></g>
        </g>}
      </svg>
      {message && <p role="status" className="absolute bottom-20 left-4 right-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{message}</p>}
      <div className="absolute bottom-4 left-4 flex gap-1 rounded-full border bg-white p-1 text-slate-600 shadow-sm"><Button variant="ghost" size="icon" aria-label="Undo" disabled={!canUndo} onClick={onUndo}><RotateCcw className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="Redo" disabled={!canRedo} onClick={onRedo}><RotateCw className="h-4 w-4" /></Button><span className="self-center px-3 text-xs">{rooms.length} ห้อง · {walls.length} ผนัง</span></div>
      <div className="absolute bottom-4 right-4 flex gap-1 rounded-full border bg-white p-1 text-slate-600 shadow-sm"><Button variant="ghost" size="icon" aria-label="ซูมเข้า" onClick={() => zoom(0.8)}><Plus className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="ซูมออก" onClick={() => zoom(1.25)}><Minus className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="ดูเต็มแปลน" onClick={() => { const size = Math.max(1000, 1000 / aspect); setView({ x: (1000 - size * aspect) / 2, y: (1000 - size) / 2, size }); }}><Maximize className="h-4 w-4" /></Button></div>
    </div>
  </div>;
}
