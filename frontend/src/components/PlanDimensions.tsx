import type { ProjectState } from "@/lib/projectHistory";
import WallDimension from "./WallDimension";

export default function PlanDimensions({ project, uiScale }: { project: ProjectState; uiScale: number }) {
  const points = [...project.walls.flatMap(w => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]),
    ...project.rooms.flatMap(r => r.wallPolygon ?? r.polygon ?? (r.bbox ? [{ x: r.bbox.x, y: r.bbox.y }, { x: r.bbox.x + r.bbox.w, y: r.bbox.y + r.bbox.h }] : []))];
  if (!points.length) return null;
  const unique = (values: number[]) => [...new Set(values.filter(Number.isFinite).map(v => Math.round(v * 1e7) / 1e7))].sort((a, b) => a - b);
  const xs = unique(points.map(p => p.x)), ys = unique(points.map(p => p.y));
  if (!xs.length || !ys.length) return null;
  const left = xs[0], right = xs.at(-1)!, top = ys[0], bottom = ys.at(-1)!;
  const props = { planW: project.planW, planH: project.planH, uiScale, showExtensions: false };
  // Use room extents, not every vertex of sloped walls, to build the outer chain.
  const bounds = project.rooms.map(room => {
    const polygon = room.wallPolygon ?? room.polygon;
    if (polygon?.length) return { left: Math.min(...polygon.map(p => p.x)), right: Math.max(...polygon.map(p => p.x)), top: Math.min(...polygon.map(p => p.y)), bottom: Math.max(...polygon.map(p => p.y)) };
    const b = room.bbox;
    return b ? { left: b.x, right: b.x + b.w, top: b.y, bottom: b.y + b.h } : null;
  }).filter((b): b is NonNullable<typeof b> => b !== null);
  const cutsX = unique([left, right, ...bounds.flatMap(b => [b.left, b.right])]);
  // Only rooms touching each outside edge contribute vertical dimensions.
  // An inset room's bottom edge is not a subdivision of the outside wall.
  const leftEdge = bounds.length ? Math.min(...bounds.map(b => b.left)) : left;
  const rightEdge = bounds.length ? Math.max(...bounds.map(b => b.right)) : right;
  const leftRooms = bounds.filter(b => Math.abs(b.left - leftEdge) < 1e-7);
  const rightRooms = bounds.filter(b => Math.abs(b.right - rightEdge) < 1e-7);
  const edgeCuts = (rooms: typeof bounds) => rooms.length ? unique(rooms.flatMap(b => [b.top, b.bottom])) : [top, bottom];
  const chain = (cuts: number[], spans: { start: number; end: number }[]) => {
    const occupied: number[] = [];
    return cuts.slice(1).map((end, i) => ({ start: cuts[i], end }))
      .filter(({ start, end }) => !spans.length || spans.some(span => (start + end) / 2 > span.start - 1e-7 && (start + end) / 2 < span.end + 1e-7))
      .map(({ start, end }) => {
      const middle = (start + end) * 500 / uiScale;
      let lane = 0;
      while (occupied[lane] !== undefined && middle - occupied[lane] < 70) lane++;
      occupied[lane] = middle;
      return { start, end, lift: lane * 20 };
    });
  };
  const horizontal = chain(cutsX, bounds.map(b => ({ start: b.left, end: b.right })));
  const vertical = chain(edgeCuts(rightRooms), rightRooms.map(b => ({ start: b.top, end: b.bottom })));
  const verticalLeft = chain(edgeCuts(leftRooms), leftRooms.map(b => ({ start: b.top, end: b.bottom })));
  const horizontalTotalOffset = 46 + Math.max(0, ...horizontal.map(s => s.lift));
  const verticalTotalOffset = 46 + Math.max(0, ...vertical.map(s => s.lift));
  return <g aria-label="ขนาดรวมแปลน (วัดตามแนวแกนผนัง)" pointerEvents="none">
    {horizontal.map(s => <g key={`x-${s.start}`}>
      <WallDimension {...props} from={{ x: s.start, y: top }} to={{ x: s.end, y: top }} offsetPixels={28} labelOffset={s.lift} label="ระยะแนวนอนด้านบน" />
      <WallDimension {...props} from={{ x: s.start, y: bottom }} to={{ x: s.end, y: bottom }} offsetPixels={-28} labelOffset={s.lift} label="ระยะแนวนอนด้านล่าง" />
    </g>)}
    {vertical.map(s => <WallDimension key={`y-${s.start}`} {...props} from={{ x: right, y: s.start }} to={{ x: right, y: s.end }} offsetPixels={-28} labelOffset={s.lift} label="ระยะแนวตั้งด้านขวา" />)}
    {verticalLeft.map(s => <WallDimension key={`left-${s.start}`} {...props} from={{ x: left, y: s.start }} to={{ x: left, y: s.end }} offsetPixels={28} labelOffset={s.lift} label="ระยะแนวตั้งด้านซ้าย" />)}
    <WallDimension {...props} from={{ x: left, y: bottom }} to={{ x: right, y: bottom }} offsetPixels={-horizontalTotalOffset} label="ความกว้างรวม" />
    <WallDimension {...props} from={{ x: right, y: top }} to={{ x: right, y: bottom }} offsetPixels={-verticalTotalOffset} label="ความลึกรวม" />
  </g>;
}
