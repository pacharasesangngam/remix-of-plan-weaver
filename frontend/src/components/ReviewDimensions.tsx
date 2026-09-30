import type { DimensionSpan } from "@/lib/wallLengthEdit";

export interface PlanDimension extends DimensionSpan { id: string; wallId: string; segmentKey?: string; length: number; boundary?: boolean }
export interface DimensionDraft { id?: string; wallId: string; value: string; span?: DimensionSpan; segmentKey?: string; inline?: boolean }

/** Screen-sized, read-only labels over normalized plan geometry. */
export function ReviewDimensions({ dimensions, width, height }: {
  dimensions: PlanDimension[]; width: number; height: number;
}) {
  const w = Math.max(1, width), h = Math.max(1, height);
  return <g data-plan-dimensions>
    {dimensions.map(dimension => {
      const { start, end, id } = dimension;
      const label = dimension.length.toFixed(2);
      const x = (start.x + end.x) / 2 * w;
      const y = (start.y + end.y) / 2 * h;
      const color = dimension.boundary ? "#7c3aed" : "#2563eb";
      return <g key={id} data-plan-dimension={id} data-dimension-wall={dimension.wallId}
        onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
        {dimension.boundary && <>
          <line data-room-boundary-span x1={start.x} y1={start.y} x2={end.x} y2={end.y}
            stroke={color} strokeWidth={3} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          <line data-boundary-hit-target x1={start.x} y1={start.y} x2={end.x} y2={end.y}
            stroke="transparent" strokeWidth={16} vectorEffect="non-scaling-stroke" pointerEvents="stroke" />
        </>}
        <g data-dimension-label transform={`translate(${x / w} ${y / h}) scale(${1 / w} ${1 / h})`}>
          <text textAnchor="middle" dominantBaseline="central" fontSize={12} fill={color} fontFamily="sans-serif"
            stroke="white" strokeWidth={4}
            strokeLinejoin="round" paintOrder="stroke">{label}</text>
        </g>
      </g>;
    })}
  </g>;
}
