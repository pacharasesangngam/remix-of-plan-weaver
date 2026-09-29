import { useState } from "react";
import type { DimensionSpan } from "@/lib/wallLengthEdit";

export interface PlanDimension extends DimensionSpan { id: string; wallId: string; length: number; boundary?: boolean }
export interface DimensionDraft { id?: string; wallId: string; value: string; span?: DimensionSpan; inline?: boolean }

/** Screen-sized labels over normalized plan geometry. Editing is owned by Review,
 * so the canvas and sidebar submit the same atomic geometry command. */
export function ReviewDimensions({ dimensions, width, height, draft, onDraft, onCommit, onCancel, error }: {
  dimensions: PlanDimension[]; width: number; height: number; draft: DimensionDraft | null;
  onDraft: (draft: DimensionDraft) => void; onCommit: () => void; onCancel: () => void; error: string | null;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const w = Math.max(1, width), h = Math.max(1, height);
  return <g data-plan-dimensions>
    {dimensions.map(dimension => {
      const { start, end, id } = dimension;
      const editing = draft?.id === id && draft.inline;
      const active = hovered === id || editing;
      const label = dimension.length.toFixed(2);
      const labelWidth = editing ? 104 : Math.max(64, label.length * 7 + 16);
      const x = (start.x + end.x) / 2 * w;
      const y = (start.y + end.y) / 2 * h;
      const color = dimension.boundary ? "#7c3aed" : "#2563eb";
      const begin = () => onDraft({ id, inline: true, wallId: dimension.wallId, value: dimension.length.toFixed(2),
        ...(dimension.boundary ? { span: { start, end } } : {}) });
      return <g key={id} data-plan-dimension={id} data-dimension-wall={dimension.wallId}
        style={{ cursor: "pointer" }} onMouseEnter={() => setHovered(id)} onMouseLeave={() => setHovered(null)}
        onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
        {dimension.boundary && <>
          <line data-room-boundary-span x1={start.x} y1={start.y} x2={end.x} y2={end.y}
            stroke={color} strokeWidth={3} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          <line data-boundary-hit-target x1={start.x} y1={start.y} x2={end.x} y2={end.y}
            stroke="transparent" strokeWidth={16} vectorEffect="non-scaling-stroke" pointerEvents="stroke" onClickCapture={begin} />
        </>}
        {active && <g data-dimension-highlight={id} pointerEvents="none">
          <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={color} strokeWidth={4} vectorEffect="non-scaling-stroke" />
          {!dimension.boundary && [start, end].map((p, i) => <ellipse key={i} cx={p.x} cy={p.y} rx={6 / w} ry={6 / h} fill="white" stroke={color} strokeWidth={3} vectorEffect="non-scaling-stroke" />)}
        </g>}
        <g data-dimension-label transform={`translate(${x / w} ${y / h}) scale(${1 / w} ${1 / h})`}>
          {editing ? <foreignObject x={-labelWidth / 2} y={-14} width={labelWidth} height={error ? 105 : 30} style={{ overflow: "visible" }}>
            <input autoFocus aria-label={dimension.boundary ? "Boundary length (m)" : "Canvas wall length (m)"}
              type="number" min="0.01" step="0.01" value={draft.value}
              className="h-8 w-full rounded-xl border-2 border-primary/70 bg-background px-3 text-sm font-mono text-foreground shadow-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              onFocus={e => e.currentTarget.select()} onChange={e => onDraft({ ...draft, value: e.target.value })}
              onBlur={onCommit} onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); onCancel(); } if (e.key === "Enter") { e.preventDefault(); onCommit(); } }} />
            {error && <p role="alert" className="mt-1 rounded border border-border bg-background p-1 text-xs text-destructive">{error}</p>}
          </foreignObject> : <g role="button" tabIndex={0} aria-label={`Edit ${dimension.boundary ? "boundary" : "wall"} length ${label}`}
            style={{ cursor: "pointer" }} onClickCapture={begin} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); begin(); } }}>
            <title>Click to edit</title>
            <text textAnchor="middle" dominantBaseline="central" fontSize={12} fill={color} fontFamily="sans-serif"
              stroke="white" strokeWidth={4}
              strokeLinejoin="round" paintOrder="stroke">{label}</text>
          </g>}
        </g>
      </g>;
    })}
  </g>;
}
