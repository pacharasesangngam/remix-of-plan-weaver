import type { FurnitureItem } from "@/types/furniture";
import type { DetectedWallSegment } from "@/types/detection";
import { getWallThicknessM } from "./wallMetrics";

export interface Clearance {
  direction: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  metres: number;
}

/** Four axis-aligned rays through the object centre, measuring to the actual wall face. */
export function furnitureClearances(item: FurnitureItem, walls: DetectedWallSegment[], pw: number, ph: number): Clearance[] {
  if (!(pw > 0 && ph > 0)) return [];
  const cx = item.x * pw, cy = item.y * ph, angle = item.rotation * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  return [{ name: "ซ้าย", x: -1, y: 0 }, { name: "ขวา", x: 1, y: 0 }, { name: "บน", x: 0, y: -1 }, { name: "ล่าง", x: 0, y: 1 }].flatMap(dir => {
    const fx = dir.x * c + dir.y * s, fy = -dir.x * s + dir.y * c;
    const edge = Math.min(Math.abs(fx) > 1e-9 ? item.width / 2 / Math.abs(fx) : Infinity, Math.abs(fy) > 1e-9 ? item.depth / 2 / Math.abs(fy) : Infinity);
    let nearest = Infinity;
    for (const wall of walls) {
      const ax = wall.x1 * pw, ay = wall.y1 * ph, dx = (wall.x2 - wall.x1) * pw, dy = (wall.y2 - wall.y1) * ph;
      const length = Math.hypot(dx, dy);
      if (length < 1e-9) continue;
      const ux = dx / length, uy = dy / length;
      const origin = [(cx - ax) * ux + (cy - ay) * uy, -(cx - ax) * uy + (cy - ay) * ux];
      const direction = [dir.x * ux + dir.y * uy, -dir.x * uy + dir.y * ux];
      const half = getWallThicknessM(wall, pw, ph) / 2;
      const low = [0, -half], high = [length, half];
      let enter = -Infinity, leave = Infinity;
      for (let axis = 0; axis < 2; axis++) {
        if (Math.abs(direction[axis]) < 1e-9) {
          if (origin[axis] < low[axis] || origin[axis] > high[axis]) { enter = Infinity; break; }
        } else {
          const t1 = (low[axis] - origin[axis]) / direction[axis], t2 = (high[axis] - origin[axis]) / direction[axis];
          enter = Math.max(enter, Math.min(t1, t2)); leave = Math.min(leave, Math.max(t1, t2));
        }
      }
      if (leave >= Math.max(0, enter)) nearest = Math.min(nearest, Math.max(0, enter));
    }
    if (!Number.isFinite(nearest) || nearest < edge - 1e-7) return []; // No valid free gap along this ray.
    return [{ direction: dir.name, from: { x: (cx + dir.x * edge) / pw, y: (cy + dir.y * edge) / ph },
      to: { x: (cx + dir.x * nearest) / pw, y: (cy + dir.y * nearest) / ph }, metres: Math.max(0, nearest - edge) }];
  });
}
