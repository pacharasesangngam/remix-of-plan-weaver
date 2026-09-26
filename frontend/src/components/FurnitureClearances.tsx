import type { FurnitureItem } from "@/types/furniture";
import type { DetectedWallSegment } from "@/types/detection";
import { furnitureClearances } from "@/lib/furnitureClearance";

export default function FurnitureClearances({ item, walls, planW, planH, uiScale }: { item: FurnitureItem; walls: DetectedWallSegment[]; planW: number; planH: number; uiScale: number }) {
  const distances = furnitureClearances(item, walls, planW, planH);
  return <g pointerEvents="none" aria-label="ระยะห่างเฟอร์นิเจอร์ถึงผิวผนัง">
    {distances.map(d => {
      const x1 = d.from.x * 1000, y1 = d.from.y * 1000, x2 = d.to.x * 1000, y2 = d.to.y * 1000;
      const vertical = d.direction === "บน" || d.direction === "ล่าง";
      const x = (x1 + x2) / 2 + (vertical ? 37 * uiScale : 0), y = (y1 + y2) / 2 - (vertical ? 0 : 14 * uiScale);
      return <g key={d.direction} aria-label={`ระยะถึงผนังด้าน${d.direction} ${d.metres.toFixed(2)} เมตร`}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#22c55e" strokeWidth={uiScale} />
        <circle cx={x2} cy={y2} r={2 * uiScale} fill="#22c55e" />
        <rect x={x - 28 * uiScale} y={y - 10 * uiScale} width={56 * uiScale} height={20 * uiScale} rx={9 * uiScale} fill="#15803d" />
        <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={12 * uiScale} fontWeight="600" fill="white">{d.metres.toFixed(2)} m</text>
      </g>;
    })}
  </g>;
}
