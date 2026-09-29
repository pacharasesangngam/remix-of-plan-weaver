import OpeningDimensions from "./OpeningDimensions";
import { newOpeningRecord } from "@/lib/openingModel";
import { getMeasuredRoomArea, getWallHeightM } from "@/lib/wallMetrics";
import { chooseLengthAnchor, proposeWallLength } from "@/lib/wallLengthEdit";
import { useEffect, useRef, useState } from "react";
import { MousePointer2, Pencil, Square, DoorOpen, AppWindow, RotateCcw, RotateCw, Trash2, Plus, Minus, Maximize, Box } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import WallDimension from "./WallDimension";
import PlanDimensions from "./PlanDimensions";
import { moveDrawObject } from "@/lib/moveDrawObject";
import type { ProjectState, ActionInfo } from "@/lib/projectHistory";
import type { NormalizedPoint } from "@/types/floorplan";
import { rectangleRoom, polygonRoom, removeDrawObject } from "@/lib/manualPlan";
import { createOpeningBboxFromWallPoints } from "@/lib/openingPlacement";
import { ringsToPathD } from "@/lib/wallTopology";

type Tool = "select" | "room" | "wall" | "door" | "window";
type Selection = { type: "room" | "wall" | "door" | "window"; id: string };
interface Props { project: ProjectState; onEdit: (update: (p: ProjectState) => ProjectState, info: ActionInfo) => void; onGenerate: () => void; onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean }

export default function DrawPlan({ project, onEdit, onGenerate, onUndo, onRedo, canUndo, canRedo }: Props) {
  const [movePreview, setMovePreview] = useState<ProjectState | null>(null);
  const { rooms, walls, doors, windows, planW, planH } = movePreview ?? project;
  const drag = useRef<{ selection: Selection; origin: NormalizedPoint; base: ProjectState; latest: ProjectState; pointerId: number } | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [start, setStart] = useState<NormalizedPoint | null>(null);
  const [path, setPath] = useState<NormalizedPoint[]>([]);
  const [cursor, setCursor] = useState<NormalizedPoint | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [view, setView] = useState(() => {
    const size = Math.min(1000, 30000 / project.planW);
    return { x: (1000 - size) / 2, y: (1000 - size) / 2, size };
  });
  const [aspect, setAspect] = useState(1);
  const [viewportHeight, setViewportHeight] = useState(1000);
  const aspectRef = useRef(1);
  const [height, setHeight] = useState(String(project.wallHeightMeter));
  const [roomWidth, setRoomWidth] = useState("4");
  const [roomLength, setRoomLength] = useState("5");
  const [roomMethod, setRoomMethod] = useState<"measurements" | "sketch">("measurements");
  const [roomReady, setRoomReady] = useState(false);
  const [openingWidth, setOpeningWidth] = useState("0.9");
  const [message, setMessage] = useState("");
  const svg = useRef<SVGSVGElement>(null);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number; scaleX: number; scaleY: number; pointerId: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const beginPan = (e: React.PointerEvent<SVGSVGElement>) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix?.a || !matrix.d || drag.current || pan.current) return;
    e.preventDefault(); e.stopPropagation();
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, scaleX: matrix.a, scaleY: matrix.d, pointerId: e.pointerId };
    setIsPanning(true); e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  useEffect(() => {
    const element = svg.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      const next = width / height, previous = aspectRef.current;
      aspectRef.current = next;
      setAspect(next);
      setViewportHeight(height);
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
  const switchTool = (next: Tool) => { setTool(next); setRoomReady(false); setStart(null); setPath([]); setMessage(""); setSelection(null); if (next === "door" || next === "window") setOpeningWidth(next === "door" ? "0.9" : "1.2"); };
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => { if (e.key === "Escape") { setTool("select"); setRoomReady(false); pan.current = null; setIsPanning(false); drag.current = null; setMovePreview(null); setStart(null); setPath([]); setSelection(null); setMessage(""); } };
    window.addEventListener("keydown", cancel); return () => window.removeEventListener("keydown", cancel);
  }, []);
  useEffect(() => { setStart(null); setPath([]); drag.current = null; setMovePreview(null); }, [project]);
  const finishOpenWalls = () => {
    const wallHeight = Number(height);
    if (path.length < 2 || !Number.isFinite(wallHeight) || wallHeight < 1 || wallHeight > 10) { setMessage("ระบุความสูง 1–10 เมตร และวาดอย่างน้อยหนึ่งช่วง"); return; }
    const id = crypto.randomUUID();
    const created = path.slice(1).map((p, i) => ({ id: `draw-wall-${id}-${i}`, x1: path[i].x, y1: path[i].y, x2: p.x, y2: p.y, type: "interior" as const, thickness: 0.15, wallHeight }));
    onEdit(p => ({ ...p, walls: [...p.walls, ...created] }), { label: "wall chain creation" });
    setPath([]); setStart(null); setTool("select");
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
  const createRectangle = (a: NormalizedPoint, b: NormalizedPoint) => {
    if (b.x > 1 || b.y > 1 || a.x < 0 || a.y < 0) { setMessage("This room extends beyond the drawing area. Choose another position."); return false; }
    const result = rectangleRoom(a, b, `draw-${crypto.randomUUID()}`, `Room ${rooms.length + 1}`, planW, planH, Number(height));
    if (!result) { setMessage("Width and length must each be at least 0.5 m."); return false; }
    const box = result.room.bbox!;
    if (rooms.some(r => r.bbox && box.x < r.bbox.x + r.bbox.w - 1e-6 && box.x + box.w > r.bbox.x + 1e-6 && box.y < r.bbox.y + r.bbox.h - 1e-6 && box.y + box.h > r.bbox.y + 1e-6)) {
      setMessage("This room overlaps an existing room. Choose another position."); return false;
    }
    onEdit(p => ({ ...p, rooms: [...p.rooms, result.room], walls: [...p.walls, ...result.walls] }), { label: "room creation" });
    setSelection({ type: "room", id: result.room.id }); setTool("select"); setRoomReady(false); setStart(null);
    return true;
  };
  const resizeWall = (length: number) => {
    if (!selectedWall) return;
    const result = proposeWallLength(project, { wallId: selectedWall.id, length,
      anchor: chooseLengthAnchor(project, selectedWall.id, length, planW, planH) }, planW, planH);
    if (result.ok === false) { setMessage(result.reason); return; }
    onEdit(p => ({ ...p, ...result.geometry }), { label: "wall length change" }); setMessage("");
  };
  const draw = (p: NormalizedPoint) => {
    if (tool === "select") { setSelection(null); return; }
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
      const opening = newOpeningRecord(tool, crypto.randomUUID(), wall, at(t - half), at(t + half), planW, planH, project.wallHeightMeter);
      if (!opening) return;
      onEdit(p => tool === "door" ? { ...p, doors: [...p.doors, opening] } : { ...p, windows: [...p.windows, opening] }, { label: `${tool} creation` }); return;
    }
    if (tool === "room" && roomMethod === "measurements") {
      if (!roomReady) { setMessage("Enter the room dimensions, then choose Place room."); return; }
      createRectangle(p, { x: p.x + Number(roomWidth) / planW, y: p.y + Number(roomLength) / planH });
      return;
    }
    if (!start) { setStart(p); if (tool === "wall") setPath([p]); return; }
    const wallHeight = Number(height);
    if (!Number.isFinite(wallHeight) || wallHeight < 1 || wallHeight > 10) { setMessage("ความสูงต้องอยู่ระหว่าง 1–10 เมตร"); return; }
    if (tool === "room") {
      if (!createRectangle(start, p)) return;
    } else {
      if (path.length >= 3 && Math.hypot((p.x - path[0].x) * planW, (p.y - path[0].y) * planH) <= 0.35) {
        const result = polygonRoom(path, `draw-${crypto.randomUUID()}`, `ห้อง ${rooms.length + 1}`, planW, planH, wallHeight);
        if (!result) { setMessage("ปิดห้องไม่ได้: แนวผนังต้องไม่ตัดกัน และห้องต้องมีพื้นที่อย่างน้อย 0.25 ตร.ม."); return; }
        onEdit(p => ({ ...p, rooms: [...p.rooms, result.room], walls: [...p.walls, ...result.walls] }), { label: "closed room creation" });
        setPath([]); setStart(null); setSelection({ type: "room", id: result.room.id }); setTool("select"); return;
      }
      if (Math.hypot((p.x - start.x) * planW, (p.y - start.y) * planH) < 0.25) { setMessage("ผนังต้องยาวอย่างน้อย 0.25 เมตร"); return; }
      setPath(points => [...points, p]); setStart(p); return;
    }
    setStart(null);
  };
  const tools = [{ id: "room", label: "Add Room", Icon: Square }, { id: "wall", label: "Add Wall", Icon: Pencil }, { id: "door", label: "Door", Icon: DoorOpen }, { id: "window", label: "Window", Icon: AppWindow }] as const;
  const selectedOpening = selection?.type === "door" ? doors.find(o => o.id === selection.id) : selection?.type === "window" ? windows.find(o => o.id === selection.id) : undefined;
  const preview = start && cursor ? { x: Math.min(start.x, cursor.x), y: Math.min(start.y, cursor.y), w: Math.abs(cursor.x - start.x), h: Math.abs(cursor.y - start.y) } : null;
  const textStyle = { paintOrder: "stroke" as const, stroke: "white", strokeWidth: 3, fill: "#334155" };
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
    <aside className="z-10 max-h-[45vh] w-full shrink-0 overflow-y-auto border-b border-border bg-card p-4 md:max-h-none md:w-72 md:border-b-0 md:border-r">
      <h2 className="text-lg font-semibold tracking-tight">Create from Measurements</h2>
      <p className="mb-5 mt-1 text-xs leading-5 text-muted-foreground">Start with a room, or draw walls for an irregular space.</p>
      <div className="flex flex-col gap-2">
        {tools.map(({ id, label, Icon }) => <Button key={id} variant={tool === id || (id === "room" && tool === "select") ? "default" : "outline"}
          className="justify-start rounded-xl text-xs" aria-pressed={tool === id} onClick={() => switchTool(id)}><Icon className="h-4 w-4" />{label}</Button>)}
      </div>
      {tool !== "select" && <div className="mt-4 space-y-3 rounded-xl border border-border p-3">
        <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">{tools.find(t => t.id === tool)?.label}</h3>
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => switchTool("select")}>Cancel</button></div>
{tool === "room" && <>
            <div className="flex flex-col gap-2"><Button size="sm" className="h-auto whitespace-normal px-2 py-2 text-xs" variant={roomMethod === "measurements" ? "secondary" : "ghost"} onClick={() => { setRoomMethod("measurements"); setStart(null); }}>Enter dimensions</Button>
              <Button size="sm" className="h-auto whitespace-normal px-2 py-2 text-xs" variant={roomMethod === "sketch" ? "secondary" : "ghost"} onClick={() => { setRoomMethod("sketch"); setRoomReady(false); }}>Draw on canvas</Button></div>
            <form className="space-y-3" onSubmit={e => {
            e.preventDefault();
            if (![Number(roomWidth), Number(roomLength), Number(height)].every(Number.isFinite) || Number(roomWidth) < 0.5 || Number(roomLength) < 0.5 || Number(height) < 1 || Number(height) > 10) { setMessage("Enter valid dimensions and a wall height between 1 and 10 m."); return; }
            setRoomReady(true); setMessage("");
          }}>
            {roomMethod === "measurements" && <div className="flex flex-col gap-2">
              <label className="text-xs">Width (m)<Input type="number" required min="0.5" max={planW} step="any" value={roomWidth} onChange={e => { setRoomWidth(e.target.value); setRoomReady(false); }} /></label>
              <label className="text-xs">Length (m)<Input type="number" required min="0.5" max={planH} step="any" value={roomLength} onChange={e => { setRoomLength(e.target.value); setRoomReady(false); }} /></label>
            </div>}
            <label className="grid gap-1 text-xs">Wall Height (m)<Input type="number" required min="1" max="10" step="any" value={height} onChange={e => { setHeight(e.target.value); setRoomReady(false); }} /></label>
            {roomMethod === "measurements" && <Button type="submit" className="w-full" disabled={roomReady}>{roomReady ? "Click on the canvas to place" : "Place room"}</Button>}
          </form>
          <p className="text-xs leading-5 text-muted-foreground">{roomMethod === "measurements" ? "Place the room by its top-left corner. Its dimensions stay exact." : "Click two opposite corners to draw a rectangular room."}</p>
        </>}
        {tool === "wall" && <>
          <label className="grid gap-1 text-xs">Wall Height (m)<Input type="number" min="1" max="10" step="0.1" value={height} onChange={e => setHeight(e.target.value)} /></label>
          <p className="text-xs leading-5 text-muted-foreground">Click to add corners. Click the first point to close a room, or finish an open wall chain.</p>
          {start && cursor && <output className="block text-sm font-mono">Length: {Math.hypot((cursor.x - start.x) * planW, (cursor.y - start.y) * planH).toFixed(2)} m</output>}
          {path.length > 0 && <div className="flex flex-wrap gap-2"><Button size="sm" disabled={path.length < 2} onClick={finishOpenWalls}>Finish walls</Button>
            <Button size="sm" variant="outline" onClick={() => { const next = path.slice(0, -1); setPath(next); setStart(next.at(-1) ?? null); }}>Undo point</Button></div>}
        </>}
        {(tool === "door" || tool === "window") && <>
          <label className="grid gap-1 text-xs">Width (m)<Input type="number" min="0.3" max="5" step="0.1" value={openingWidth} onChange={e => setOpeningWidth(e.target.value)} /></label>
          <p className="text-xs text-muted-foreground">Click a wall to place the opening. Press Escape to select and edit it.</p>
        </>}
      </div>}
      <section aria-label="Properties" className="mt-5 space-y-3 border-t border-border pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Properties</h3>
        {!selection && <p className="text-sm leading-6 text-muted-foreground">Select an element on the canvas to view or edit its properties.</p>}
        {selectedRoom && <>
          <label className="grid gap-1 text-xs">Room name<Input key={selectedRoom.id + selectedRoom.name} defaultValue={selectedRoom.name}
            onBlur={e => { const name = e.target.value.trim(); if (name && name !== selectedRoom.name) onEdit(p => ({ ...p, rooms: p.rooms.map(r => r.id === selectedRoom.id ? { ...r, name } : r) }), { label: "room name change" }); }} /></label>
          <dl className="space-y-2 text-sm"><div className="flex justify-between"><dt>Width</dt><dd>{(selectedRoom.width * planW).toFixed(2)} m</dd></div>
            <div className="flex justify-between"><dt>Length</dt><dd>{(selectedRoom.height * planH).toFixed(2)} m</dd></div>
            <div className="flex justify-between"><dt>Calculated area</dt><dd><output aria-label="Calculated room area">{getMeasuredRoomArea(selectedRoom, planW, planH, true)?.toFixed(2)} m<sup>2</sup></output></dd></div></dl>
          <label className="grid gap-1 text-xs">Wall Height (m)<Input key={`${selectedRoom.id}:wallHeight`} type="number" min="1" max="10" step="0.1" defaultValue={selectedRoom.wallHeight?.toFixed(1) ?? project.wallHeightMeter.toFixed(1)}
            onBlur={e => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= 1 && value <= 10) onEdit(p => ({ ...p, rooms: p.rooms.map(r => r.id === selectedRoom.id ? { ...r, wallHeight: value } : r) }), { label: "room wall height change" }); }} /></label>
        </>}
        {selectedWall && <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">Length (m)<Input key={`${selectedWall.id}:${selectedWall.x1}:${selectedWall.y1}:${selectedWall.x2}:${selectedWall.y2}`} type="number" min="0.25" step="any"
              defaultValue={Math.hypot((selectedWall.x2 - selectedWall.x1) * planW, (selectedWall.y2 - selectedWall.y1) * planH).toFixed(2)} onBlur={e => { if (e.target.value && e.target.value !== Math.hypot((selectedWall.x2 - selectedWall.x1) * planW, (selectedWall.y2 - selectedWall.y1) * planH).toFixed(2)) resizeWall(Number(e.target.value)); }} /></label>
            <label className="text-xs">Height (m)<Input key={`${selectedWall.id}:${selectedWall.wallHeight}`} type="number" min="1" max="10" step="any" defaultValue={getWallHeightM(selectedWall, project.wallHeightMeter)}
              onBlur={e => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= 1 && value <= 10) onEdit(p => ({ ...p, walls: p.walls.map(w => w.id === selectedWall.id ? { ...w, wallHeight: value } : w) }), { label: "wall height change" }); }} /></label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">Thickness (m)<Input key={`${selectedWall.id}:${selectedWall.thickness}`} type="number" min="0.05" max="1" step="0.01" defaultValue={(selectedWall.thickness ?? 0.15).toFixed(2)}
              onBlur={e => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= 0.05 && value <= 1) onEdit(p => ({ ...p, walls: p.walls.map(w => w.id === selectedWall.id ? { ...w, thickness: value } : w) }), { label: "wall thickness change" }); }} /></label>
            <label className="text-xs">Wall Type<select key={`${selectedWall.id}:type`} defaultValue={selectedWall.type} onChange={e => {
              const type = e.target.value;
              if (type === "exterior" || type === "interior") onEdit(p => ({ ...p, walls: p.walls.map(w => w.id === selectedWall.id ? { ...w, type } : w) }), { label: "wall type change" });
            }}>
              <option value="exterior">Exterior</option>
              <option value="interior">Interior</option>
            </select></label>
          </div>
        </div>}
        {selectedOpening && (selection?.type === "door" || selection?.type === "window") && <OpeningDimensions opening={selectedOpening} kind={selection.type}
          walls={walls} doors={doors} windows={windows} pw={planW} ph={planH} wallHeight={project.wallHeightMeter} calibrated
          onEdit={(field, value) => onEdit(p => selection.type === "door" ? { ...p, doors: p.doors.map(o => o.id === selectedOpening.id ? { ...o, [field]: value } : o) } : { ...p, windows: p.windows.map(o => o.id === selectedOpening.id ? { ...o, [field]: value } : o) }, { label: "opening dimensions" })} />}
        {selection && <Button variant="ghost" className="w-full justify-start text-destructive hover:text-destructive" onClick={() => { onEdit(p => removeDrawObject(p, selection), { label: `${selection.type} deletion` }); setSelection(null); }}><Trash2 className="h-4 w-4" />Delete selected</Button>}
      </section>
      <p className="mt-5 text-xs leading-5 text-muted-foreground">Drag empty space to pan. Scroll to zoom. Press Escape to return to selection.</p>
    </aside>
    <div className="relative min-h-[360px] min-w-0 flex-1 overflow-hidden bg-white">
      <div className="absolute left-4 right-4 top-4 z-10 flex items-center justify-between gap-2 pointer-events-none">
        <span className="rounded-xl border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground">{tool === "select" ? "Select and edit" : tools.find(t => t.id === tool)?.label}</span>
        <Button className="pointer-events-auto rounded-xl" disabled={!!start || roomReady || !!movePreview || (!walls.length && !rooms.length)} onClick={onGenerate}><Box className="h-4 w-4" />View in 3D</Button>
      </div>
      <svg ref={svg} role="img" aria-label="พื้นที่วาดแปลน 2D"
        className={`h-full min-h-[360px] w-full touch-none ${movePreview || isPanning ? "cursor-grabbing" : tool === "select" ? "cursor-grab" : "cursor-crosshair"}`}
        viewBox={`${view.x} ${view.y} ${view.size * aspect} ${view.size}`}
        preserveAspectRatio="none"
        onContextMenu={e => e.preventDefault()}
        onPointerDownCapture={e => { if (e.button === 2) beginPan(e); }}
        onPointerDown={e => { if (e.button !== 0 || pan.current) return; if (tool === "select") { beginPan(e); setSelection(null); } else draw(point(e)); }}
        onPointerMove={e => { if (drag.current) { updateDrag(e); return; } const active = pan.current; if (active) { if (active.pointerId !== e.pointerId) return; const x = active.vx - (e.clientX - active.x) / active.scaleX, y = active.vy - (e.clientY - active.y) / active.scaleY; setView(v => ({ ...v, x, y })); } else setCursor(point(e)); }}
        onPointerUp={e => { finishDrag(e); if (pan.current?.pointerId === e.pointerId) { pan.current = null; setIsPanning(false); if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); } }}
        onPointerCancel={() => { pan.current = null; setIsPanning(false); drag.current = null; setMovePreview(null); }}
        onLostPointerCapture={() => { pan.current = null; setIsPanning(false); drag.current = null; setMovePreview(null); }}>
        <defs><pattern id="draw-small-grid" width={1000 / planW / 4} height={1000 / planH / 4} patternUnits="userSpaceOnUse"><path d={`M ${1000 / planW / 4} 0 H 0 V ${1000 / planH / 4}`} fill="none" stroke="#e8edf1" strokeWidth="0.65" /></pattern><pattern id="draw-grid" width={1000 / planW} height={1000 / planH} patternUnits="userSpaceOnUse"><rect width={1000 / planW} height={1000 / planH} fill="url(#draw-small-grid)" /><path d={`M ${1000 / planW} 0 H 0 V ${1000 / planH}`} fill="none" stroke="#cbd5e1" strokeWidth="0.8" /></pattern></defs>
        <rect x={view.x} y={view.y} width={view.size * aspect} height={view.size} fill="white" />
        <rect x={view.x} y={view.y} width={view.size * aspect} height={view.size} fill="url(#draw-grid)" />
        <rect width="1000" height="1000" fill="none" stroke="#94a3b8" strokeDasharray="4 4" strokeWidth={view.size / 1000} pointerEvents="none" />
        {rooms.map(room => { const points = room.wallPolygon ?? room.polygon ?? []; const b = room.bbox; const holes = (room.holes ?? []).filter(hole => hole.length >= 3); const pathD = points.length >= 3 && holes.length ? ringsToPathD([points, ...holes], 1000) : null; const fill = room.floorColor ?? "#d9bc91"; const stroke = selection?.id === room.id ? "#059669" : "none"; return <g key={room.id} onPointerDown={e => choose(e, { type: "room", id: room.id })}>{pathD ? <path d={pathD} fillRule="evenodd" fill={fill} fillOpacity={0.55} stroke={stroke} strokeWidth={3} /> : <polygon points={points.map(p => `${p.x * 1000},${p.y * 1000}`).join(" ")} fill={fill} fillOpacity={0.55} stroke={stroke} strokeWidth={3} />}{b && <g pointerEvents="none" fontSize={10} textAnchor="middle"><text x={(b.x + b.w / 2) * 1000} y={(b.y + b.h / 2) * 1000} style={textStyle}>{room.name}</text><text x={(b.x + b.w / 2) * 1000} y={b.y * 1000 - 10} style={textStyle}>{(b.w * planW).toFixed(2)} m</text><text x={(b.x + b.w) * 1000 + 10} y={(b.y + b.h / 2) * 1000} textAnchor="start" style={textStyle}>{(b.h * planH).toFixed(2)} m</text></g>}</g>; })}
        {walls.map(w => <g key={w.id} onPointerDown={e => choose(e, { type: "wall", id: w.id })}><line x1={w.x1 * 1000} y1={w.y1 * 1000} x2={w.x2 * 1000} y2={w.y2 * 1000} stroke="transparent" strokeWidth={12} /><line x1={w.x1 * 1000} y1={w.y1 * 1000} x2={w.x2 * 1000} y2={w.y2 * 1000} stroke={selection?.id === w.id ? "#10b981" : "#64748b"} strokeWidth={(w.thickness ?? 0.15) / planW * 1000} pointerEvents="none" /></g>)}
        {[...doors.map(d => ({ ...d, type: "door" as const })), ...windows.map(w => ({ ...w, type: "window" as const }))].map(o => <rect key={o.id} x={o.bbox.x * 1000} y={o.bbox.y * 1000} width={o.bbox.w * 1000} height={o.bbox.h * 1000} fill={o.type === "door" ? "#fbbf24" : "#f472b6"} stroke={selection?.id === o.id ? "#059669" : "#334155"} strokeWidth={1.5} onPointerDown={e => choose(e, { type: o.type, id: o.id })} />)}
        {tool === "room" && roomMethod === "measurements" && roomReady && cursor && <g pointerEvents="none">
          <rect x={cursor.x * 1000} y={cursor.y * 1000} width={Number(roomWidth) / planW * 1000} height={Number(roomLength) / planH * 1000} fill="hsl(var(--primary) / 0.12)" stroke="hsl(var(--primary))" strokeDasharray="5 3" />
          <text x={cursor.x * 1000} y={cursor.y * 1000 - 8} fontSize={12} style={textStyle}>{roomWidth} m x {roomLength} m</text>
        </g>}
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
          <WallDimension from={start} to={cursor} planW={planW} planH={planH} uiScale={view.size / viewportHeight} />
          <g transform={`translate(${cursor.x * 1000 + 3} ${cursor.y * 1000 - 15 * view.size / 1000}) scale(${view.size / 1000})`}><Pencil width={16} height={16} color="#334155" fill="white" /></g>
        </g>}
        <PlanDimensions project={movePreview ?? project} uiScale={view.size / viewportHeight} />
      </svg>
      {message && <p role="status" className="absolute bottom-16 left-4 right-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{message}</p>}
      <div className="absolute bottom-4 left-4 flex gap-1 rounded-xl border border-border bg-card p-1 text-muted-foreground shadow-sm"><Button variant="ghost" size="icon" aria-label="Undo" disabled={!canUndo} onClick={onUndo}><RotateCcw className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="Redo" disabled={!canRedo} onClick={onRedo}><RotateCw className="h-4 w-4" /></Button><span className="hidden self-center px-3 text-xs sm:inline">{rooms.length} ห้อง · {walls.length} ผนัง</span></div>
      <div className="absolute bottom-4 right-4 flex gap-1 rounded-xl border border-border bg-card p-1 text-muted-foreground shadow-sm">
        <Button variant="ghost" size="icon" aria-label="Select" aria-pressed={tool === "select"} onClick={() => switchTool("select")}><MousePointer2 className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="ซูมเข้า" onClick={() => zoom(0.8)}><Plus className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="ซูมออก" onClick={() => zoom(1.25)}><Minus className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="ดูเต็มแปลน" onClick={() => { const size = Math.max(1000, 1000 / aspect); setView({ x: (1000 - size * aspect) / 2, y: (1000 - size) / 2, size }); }}><Maximize className="h-4 w-4" /></Button></div>
    </div>
  </div>;
}
