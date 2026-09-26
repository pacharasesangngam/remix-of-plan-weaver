import { useId } from "react";
import type { NormalizedPoint } from "@/types/floorplan";

/** Offset dimension line, readable for either drawing direction. */
export default function WallDimension({ from, to, planW, planH, uiScale = 1, offsetPixels = 24, label = "ระยะผนัง", labelOffset = 0, showExtensions = true }: {
  from: NormalizedPoint; to: NormalizedPoint; planW: number; planH: number; uiScale?: number; offsetPixels?: number; label?: string; labelOffset?: number; showExtensions?: boolean;
}) {
  const marker = useId().replace(/:/g, "");
  const dx = (to.x - from.x) * 1000, dy = (to.y - from.y) * 1000;
  const length = Math.hypot(dx, dy);
  if (length < 0.01) return null;
  let nx = dy / length, ny = -dx / length;
  if ((Math.abs(dy) > Math.abs(dx) && nx > 0) || (Math.abs(dx) >= Math.abs(dy) && ny > 0)) { nx *= -1; ny *= -1; }
  if (offsetPixels < 0) { nx *= -1; ny *= -1; }
  const offset = Math.abs(offsetPixels) * uiScale;
  const a = { x: from.x * 1000 + nx * offset, y: from.y * 1000 + ny * offset };
  const b = { x: to.x * 1000 + nx * offset, y: to.y * 1000 + ny * offset };
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const mid = { x: center.x + nx * labelOffset * uiScale, y: center.y + ny * labelOffset * uiScale };
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  const metres = Math.hypot((to.x - from.x) * planW, (to.y - from.y) * planH);
  return <g pointerEvents="none" aria-label={`${label} ${metres.toFixed(2)} เมตร`}>
    <defs><marker id={marker} viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 6 3 L 0 6 Z" fill="#111827" /></marker></defs>
    {showExtensions && <path d={`M ${from.x * 1000 + nx * 7 * uiScale} ${from.y * 1000 + ny * 7 * uiScale} L ${a.x + nx * 4 * uiScale} ${a.y + ny * 4 * uiScale} M ${to.x * 1000 + nx * 7 * uiScale} ${to.y * 1000 + ny * 7 * uiScale} L ${b.x + nx * 4 * uiScale} ${b.y + ny * 4 * uiScale}`} stroke="#94a3b8" strokeWidth={0.7 * uiScale} fill="none" />}
    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#111827" strokeWidth={uiScale} markerStart={`url(#${marker})`} markerEnd={`url(#${marker})`} />
    {labelOffset > 0 && <line x1={center.x} y1={center.y} x2={mid.x} y2={mid.y} stroke="#94a3b8" strokeWidth={0.7 * uiScale} />}
    <g transform={`translate(${mid.x} ${mid.y}) rotate(${angle})`}><rect x={-30 * uiScale} y={-8 * uiScale} width={60 * uiScale} height={16 * uiScale} fill="white" rx={2 * uiScale} /><text textAnchor="middle" dominantBaseline="central" fontSize={12 * uiScale} fill="#111827">{metres.toFixed(2)} m</text></g>
  </g>;
}
