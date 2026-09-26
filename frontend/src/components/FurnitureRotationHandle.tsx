import { useEffect, useRef, useState, type PointerEvent } from "react";
import { furnitureHalfSize, type FurnitureItem } from "@/types/furniture";

interface Props {
  item: FurnitureItem; planW: number; planH: number;
  unitsX: number; unitsY: number; uiScale: number;
  onPreview: (item: FurnitureItem | null) => void;
  onCommit: (item: FurnitureItem) => void;
}

export default function FurnitureRotationHandle({ item, planW, planH, unitsX, unitsY, uiScale, onPreview, onCommit }: Props) {
  const drag = useRef<{ original: FurnitureItem; latest: FurnitureItem; startAngle: number; pointerId: number } | null>(null);
  const [active, setActive] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const scale = Math.max(0.01, uiScale);
  const angle = item.rotation * Math.PI / 180;
  const cx = item.x * unitsX, cy = item.y * unitsY;
  const radius = Math.hypot(item.width, item.depth) / 2 + 26 * scale * planH / unitsY;
  const hx = cx + Math.sin(angle) * radius / planW * unitsX;
  const hy = cy - Math.cos(angle) * radius / planH * unitsY;
  const edgeX = cx + Math.sin(angle) * item.depth / 2 / planW * unitsX;
  const edgeY = cy - Math.cos(angle) * item.depth / 2 / planH * unitsY;
  const emphasized = active || hovered || focused;
  const accent = blocked ? "#d97706" : "#059669";
  const normalize = (degrees: number) => ((degrees % 360) + 360) % 360;
  const fits = (next: FurnitureItem) => {
    const half = furnitureHalfSize(next, planW, planH);
    // Rotate around the object's centre, never silently move it away from an edge.
    return half.x <= next.x && half.x <= 1 - next.x && half.y <= next.y && half.y <= 1 - next.y;
  };
  const pointerAngle = (event: PointerEvent<SVGGElement>) => {
    const svg = event.currentTarget.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const p = svg.createSVGPoint(); p.x = event.clientX; p.y = event.clientY;
    const local = p.matrixTransform(matrix.inverse());
    return Math.atan2((local.y / unitsY - item.y) * planH, (local.x / unitsX - item.x) * planW) * 180 / Math.PI;
  };
  const cancel = () => { drag.current = null; setActive(false); setBlocked(false); onPreview(null); };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && drag.current) cancel(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  });
  return <g>
    {active && <g aria-label="วงนำทางการหมุน" pointerEvents="none">
      <ellipse cx={cx} cy={cy} rx={radius / planW * unitsX} ry={radius / planH * unitsY} fill="none" stroke="#a7f3d0" strokeWidth={scale} />
      {Array.from({ length: 24 }, (_, index) => {
        const a = index * Math.PI / 12;
        const inset = (index % 6 === 0 ? 7 : 3) * scale * planH / unitsY;
        return <line key={index} x1={cx + Math.sin(a) * (radius - inset) / planW * unitsX} y1={cy - Math.cos(a) * (radius - inset) / planH * unitsY}
          x2={cx + Math.sin(a) * radius / planW * unitsX} y2={cy - Math.cos(a) * radius / planH * unitsY}
          stroke={index % 6 === 0 ? "#34d399" : "#a7f3d0"} strokeWidth={scale} />;
      })}
      <circle cx={cx} cy={cy} r={3 * scale} fill="white" stroke={accent} strokeWidth={1.5 * scale} />
    </g>}
    <line x1={edgeX} y1={edgeY} x2={hx} y2={hy} stroke={emphasized ? "#6ee7b7" : "#a7f3d0"} strokeWidth={1.5 * scale} pointerEvents="none" />
    <circle cx={edgeX} cy={edgeY} r={2.5 * scale} fill="white" stroke="#6ee7b7" strokeWidth={scale} pointerEvents="none" />
    <g role="slider" aria-label="ลากเพื่อหมุนเฟอร์นิเจอร์" aria-valuemin={0} aria-valuemax={359} aria-valuenow={Math.round(item.rotation)} aria-valuetext={`${Math.round(item.rotation)} องศา`} tabIndex={0}
      transform={`translate(${hx} ${hy}) scale(${scale})`} style={{ cursor: active ? "grabbing" : "grab", touchAction: "none", outline: "none" }}
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onPointerDown={event => {
        event.stopPropagation(); if (event.button !== 0) return;
        event.preventDefault(); const startAngle = pointerAngle(event); if (startAngle === null) return;
        drag.current = { original: item, latest: item, startAngle, pointerId: event.pointerId };
        setActive(true); event.currentTarget.focus(); event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={event => {
        event.stopPropagation(); const d = drag.current;
        if (!d || event.pointerId !== d.pointerId) return;
        const current = pointerAngle(event); if (current === null) return;
        const step = event.shiftKey ? 15 : 1;
        const next = { ...d.original, rotation: normalize(Math.round((d.original.rotation + current - d.startAngle) / step) * step) };
        setBlocked(!fits(next));
        if (fits(next)) { d.latest = next; onPreview(next); }
      }}
      onPointerUp={event => {
        event.stopPropagation(); const d = drag.current;
        if (!d || event.pointerId !== d.pointerId) return;
        drag.current = null; setActive(false); setBlocked(false); onPreview(null);
        if (d.latest.rotation !== d.original.rotation) onCommit(d.latest);
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={event => { event.stopPropagation(); cancel(); }}
      onLostPointerCapture={event => { event.stopPropagation(); if (drag.current) cancel(); }}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === "Escape") { cancel(); return; }
        const next = { ...item, rotation: normalize(item.rotation + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 15 : 5)) };
        setBlocked(!fits(next)); if (fits(next)) onCommit(next);
      }}>
      <title>ลากเพื่อหมุน · กด Shift ล็อกทีละ 15° · Esc ยกเลิก</title>
      <circle r={22} fill="transparent" />
      {emphasized && <circle r={21} fill={blocked ? "#fef3c7" : "#d1fae5"} opacity={0.8} pointerEvents="none" />}
      <circle r={16} fill={active ? accent : "white"} stroke={emphasized ? accent : "#d1fae5"} strokeWidth={1.5}
        style={{ filter: "drop-shadow(0 2px 3px rgb(15 23 42 / 0.15))", transition: "fill 120ms, stroke 120ms" }} />
      <path d="M 5.5 -4.5 A 6.8 6.8 0 1 0 6.8 2 M 5.5 -9 V -4.5 H 1" fill="none" stroke={active ? "white" : accent} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
      {(emphasized || blocked) && <g transform="translate(0 -36)" pointerEvents="none" aria-label="คำแนะนำการหมุน">
        <rect x={blocked ? -94 : active ? -34 : -58} y={-13} width={blocked ? 188 : active ? 68 : 116} height={26} rx={8} fill={blocked ? "#fffbeb" : "#0f172a"} stroke={blocked ? "#fcd34d" : "#1e293b"} strokeWidth={0.7}
          style={{ filter: "drop-shadow(0 2px 4px rgb(15 23 42 / 0.12))" }} />
        <text textAnchor="middle" dominantBaseline="central" fill={blocked ? "#92400e" : "white"} fontSize={active ? 12 : 11} fontWeight={500} fontFamily="sans-serif">{blocked ? "ย้ายออกจากขอบก่อนหมุน" : active ? `${Math.round(item.rotation)}°` : "ลากเพื่อหมุน"}</text>
        {active && !blocked && <g transform="translate(0 -30)">
          <rect x={-61} y={-10} width={122} height={20} rx={6} fill="white" stroke="#e2e8f0" strokeWidth={0.7} />
          <text textAnchor="middle" dominantBaseline="central" fill="#64748b" fontSize={9} fontFamily="sans-serif">Shift ล็อกทีละ 15°</text>
        </g>}
      </g>}
    </g>
  </g>;
}
