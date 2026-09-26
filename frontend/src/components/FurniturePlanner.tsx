import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import FurnitureSizeEditor from "./FurnitureSizeEditor";
import FurnitureRotationHandle from "./FurnitureRotationHandle";
import { FurnitureSymbol } from "./FurnitureVisual";
import { FURNITURE_CATALOG, fitFurniture, furnitureHalfSize, type FurnitureItem, type FurnitureKind } from "@/types/furniture";
import type { ActionInfo, ProjectState } from "@/lib/projectHistory";
import { hasCalibration, getWallThicknessM } from "@/lib/wallMetrics";

interface Props {
  project: ProjectState;
  imageUrl?: string | null;
  onEdit: (update: (p: ProjectState) => ProjectState, info: ActionInfo) => void;
  onBack: () => void;
  onGenerate: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export default function FurniturePlanner({ project, imageUrl, onEdit, onBack, onGenerate, onUndo, onRedo, canUndo, canRedo }: Props) {
  const [kind, setKind] = useState<FurnitureKind | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<FurnitureItem | null>(null);
  const [message, setMessage] = useState("");
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number; scaleX: number; scaleY: number; pointerId: number } | null>(null);
  const drag = useRef<{ item: FurnitureItem; x: number; y: number; latest: FurnitureItem } | null>(null);
  const { planW, planH } = project;
  const calibrated = hasCalibration(project.calibrationStatus, project.scale, planW, planH);
  const items = (project.furniture ?? []).map(item => preview?.id === item.id ? preview : item);
  const selected = items.find(item => item.id === selectedId);
  const cancel = () => { drag.current = null; pan.current = null; setIsPanning(false); setPreview(null); setKind(null); };
  const beginPan = (event: React.PointerEvent<SVGSVGElement>) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix?.a || !matrix.d || drag.current || pan.current) return;
    event.preventDefault(); event.stopPropagation();
    pan.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, scaleX: matrix.a, scaleY: matrix.d, pointerId: event.pointerId };
    setIsPanning(true); event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  useEffect(() => { drag.current = null; setPreview(null); }, [project]);
  const point = (event: { clientX: number; clientY: number }) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix || !svg.current) return null;
    const p = svg.current.createSVGPoint(); p.x = event.clientX; p.y = event.clientY;
    const local = p.matrixTransform(matrix.inverse());
    return { x: local.x / (planW * 100), y: local.y / (planH * 100) };
  };
  const fits = (item: FurnitureItem) => {
    const half = furnitureHalfSize(item, planW, planH);
    return half.x <= 0.5 && half.y <= 0.5;
  };
  const update = (item: FurnitureItem, label: string) => {
    if (!calibrated) return;
    if (!fits(item)) { setMessage("เฟอร์นิเจอร์มีขนาดเกินพื้นที่แปลน"); return; }
    setMessage("");
    onEdit(p => ({ ...p, furniture: (p.furniture ?? []).map(f => f.id === item.id ? fitFurniture(item, planW, planH) : f) }), { label });
  };
  return <section className="flex min-w-0 flex-1 flex-col overflow-auto md:flex-row" aria-label="จัดวางเฟอร์นิเจอร์">
    <aside className="w-full shrink-0 space-y-3 overflow-y-auto border-r bg-card p-4 md:w-64">
      <h2 className="font-semibold">จัดวางเฟอร์นิเจอร์</h2>
      <Button variant="outline" onClick={onBack}>กลับไปตรวจแปลน</Button>
      {!calibrated ? <p role="alert" className="text-sm text-amber-600">กรุณากลับไปตั้งสเกลด้วย Calibrate Scale ก่อนวางเฟอร์นิเจอร์ เพื่อให้ขนาดจริงถูกต้อง</p> : <p className="text-xs text-muted-foreground">เลือกชนิดแล้วคลิกบนแปลนเพื่อวาง ลากเพื่อย้าย · Esc ยกเลิก</p>}
      {FURNITURE_CATALOG.map(option => <Button key={option.kind} variant={kind === option.kind ? "default" : "outline"} className="h-auto w-full justify-between py-3" disabled={!calibrated} aria-pressed={kind === option.kind} onClick={() => { cancel(); setKind(option.kind); setSelectedId(null); setMessage(""); }}>
        <svg viewBox="-25 -25 50 50" className="h-9 w-9 shrink-0" aria-hidden="true"><FurnitureSymbol item={{ ...option, id: "preview", x: 0, y: 0, rotation: 0 }} planW={50} planH={50} /></svg><span>{option.name}</span><span className="text-xs">{option.width} × {option.depth} m</span>
      </Button>)}
      {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
      {selected && calibrated && <div className="space-y-3 border-t pt-3">
        <h3 className="text-sm font-semibold">{FURNITURE_CATALOG.find(f => f.kind === selected.kind)?.name} · {selected.rotation}°</h3>
        <FurnitureSizeEditor item={selected} planW={planW} planH={planH} onApply={size => update({ ...selected, ...size }, "furniture dimensions")} />
        <Button variant="outline" onClick={() => update({ ...selected, rotation: (selected.rotation + 90) % 360 }, "furniture rotation")}>หมุน 90°</Button>
        <Button variant="destructive" onClick={() => { onEdit(p => ({ ...p, furniture: (p.furniture ?? []).filter(f => f.id !== selected.id) }), { label: "furniture deletion" }); setSelectedId(null); }}>ลบเฟอร์นิเจอร์</Button>
      </div>}
      <div className="flex gap-2"><Button variant="outline" disabled={!canUndo} onClick={() => { cancel(); onUndo(); }}>Undo</Button><Button variant="outline" disabled={!canRedo} onClick={() => { cancel(); onRedo(); }}>Redo</Button></div>
      <Button className="w-full" disabled={!calibrated} onClick={onGenerate}>ดู 3D</Button>
    </aside>
    <div className="relative flex min-h-80 min-w-0 flex-1 items-center justify-center bg-muted/30 p-4">
      {calibrated && <svg ref={svg} aria-label="แปลนสำหรับวางเฟอร์นิเจอร์" className="h-full min-h-80 w-full touch-none" viewBox={`${view.x} ${view.y} ${planW * 100} ${planH * 100}`} style={{ cursor: isPanning ? "grabbing" : kind ? "crosshair" : "grab" }}
        onContextMenu={event => event.preventDefault()}
        onPointerDownCapture={event => { if (event.button === 2) beginPan(event); }}
        onPointerDown={event => {
          if (event.button !== 0 || pan.current) return;
          if (!kind) { beginPan(event); setSelectedId(null); return; }
          const p = point(event);
          if (!p || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
          const option = FURNITURE_CATALOG.find(f => f.kind === kind)!;
          const item = { ...option, id: crypto.randomUUID(), ...p, rotation: 0 };
          if (!fits(item)) { setMessage("เฟอร์นิเจอร์มีขนาดเกินพื้นที่แปลน"); return; }
          onEdit(state => ({ ...state, furniture: [...(state.furniture ?? []), fitFurniture(item, planW, planH)] }), { label: "furniture creation" });
          setKind(null); setSelectedId(item.id); setMessage("");
        }}
        onPointerMove={event => {
          const activePan = pan.current;
          if (activePan) {
            if (activePan.pointerId === event.pointerId) setView({ x: activePan.vx - (event.clientX - activePan.x) / activePan.scaleX, y: activePan.vy - (event.clientY - activePan.y) / activePan.scaleY });
            return;
          }
          const d = drag.current, p = point(event);
          if (!d || !p) return;
          d.latest = fitFurniture({ ...d.item, x: d.item.x + p.x - d.x, y: d.item.y + p.y - d.y, roomId: undefined }, planW, planH);
          setPreview(d.latest);
        }}
        onPointerUp={event => {
          if (pan.current) {
            if (pan.current.pointerId !== event.pointerId) return;
            pan.current = null; setIsPanning(false);
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            return;
          }
          const d = drag.current;
          drag.current = null; setPreview(null);
          if (d && (d.latest.x !== d.item.x || d.latest.y !== d.item.y)) update(d.latest, "furniture movement");
        }}
        onPointerCancel={cancel} onLostPointerCapture={() => { pan.current = null; setIsPanning(false); drag.current = null; setPreview(null); }}>
        <rect width={planW * 100} height={planH * 100} fill="white" />
        {imageUrl && <image href={imageUrl} width={planW * 100} height={planH * 100} preserveAspectRatio="none" opacity={0.7} pointerEvents="none" />}
        <g pointerEvents="none">{project.walls.map(w => <line key={w.id} x1={w.x1 * planW * 100} y1={w.y1 * planH * 100} x2={w.x2 * planW * 100} y2={w.y2 * planH * 100} stroke="#64748b" strokeWidth={getWallThicknessM(w, planW, planH) * 100} />)}</g>
        {items.map(item => <g key={item.id} aria-label={`เฟอร์นิเจอร์ ${FURNITURE_CATALOG.find(f => f.kind === item.kind)?.name}`} transform={`translate(${item.x * planW * 100} ${item.y * planH * 100}) rotate(${item.rotation})`} style={{ cursor: "move" }} onPointerDown={event => {
          if (kind || event.button !== 0) return;
          event.stopPropagation(); event.preventDefault();
          const p = point(event); if (!p) return;
          setSelectedId(item.id); drag.current = { item, ...p, latest: item };
          svg.current?.setPointerCapture(event.pointerId);
        }}>
          <FurnitureSymbol item={item} planW={10} planH={10} />
          {selectedId === item.id && <rect x={-item.width * 50 - 3} y={-item.depth * 50 - 3} width={item.width * 100 + 6} height={item.depth * 100 + 6} fill="none" stroke="#10b981" strokeWidth={2} pointerEvents="none" />}
          <title>{`${item.width} × ${item.depth} × ${item.height} m`}</title>
        </g>)}
        {selected && <FurnitureRotationHandle key={selected.id} item={selected} planW={planW} planH={planH} unitsX={planW * 100} unitsY={planH * 100}
          uiScale={Math.max(planW * 100 / (svg.current?.clientWidth || 800), planH * 100 / (svg.current?.clientHeight || 600))}
          onPreview={setPreview} onCommit={item => update(item, "furniture rotation")} />}
      </svg>}
    </div>
  </section>;
}
