import type { DetectedWallSegment as Wall } from "@/types/detection";
import type { NormalizedPoint } from "@/types/floorplan";

export interface DimensionEndpoint extends NormalizedPoint { wallId: string; endpoint: "start" | "end" }
export interface ConfirmedDimension { start: DimensionEndpoint; end: DimensionEndpoint; lengthM: number }
export const endpointPosition = (wall: Wall, endpoint: "start" | "end"): NormalizedPoint => endpoint === "start"
  ? { x: wall.x1, y: wall.y1 } : { x: wall.x2, y: wall.y2 };
export function confirmCalibration(points: NormalizedPoint[], walls: Wall[], lengthM: number): ConfirmedDimension[] {
  if (points.length !== 2 || !Number.isFinite(lengthM) || lengthM <= 0) return [];
  const endpoints = points.map(point => {
    for (const wall of walls) for (const endpoint of ["start", "end"] as const) {
      const p = endpointPosition(wall, endpoint);
      if (p.x === point.x && p.y === point.y) return { ...p, wallId: wall.id, endpoint };
    }
    return null;
  });
  return endpoints.every(Boolean) && (points[0].x !== points[1].x || points[0].y !== points[1].y)
    ? [{ start: endpoints[0]!, end: endpoints[1]!, lengthM }] : [];
}
export function preservesConfirmedDimensions(walls: Wall[], dimensions: ConfirmedDimension[] = [], pw: number, ph: number): boolean {
  return dimensions.every(d => {
    const points = [d.start, d.end].map(ref => {
      const w = walls.find(w => w.id === ref.wallId);
      return w ? endpointPosition(w, ref.endpoint) : null;
    });
    return points.every((p, i) => p && Math.hypot((p.x - [d.start, d.end][i].x) * pw, (p.y - [d.start, d.end][i].y) * ph) < 1e-6)
      && Math.abs(Math.hypot((points[1]!.x - points[0]!.x) * pw, (points[1]!.y - points[0]!.y) * ph) - d.lengthM) < 1e-5;
  });
}
export function parseConfirmedDimensions(value: unknown, walls: Wall[], pw: number, ph: number): ConfirmedDimension[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Invalid confirmed calibration dimensions.");
  const validPoint = (p: DimensionEndpoint) => p && typeof p.wallId === "string" && ["start", "end"].includes(p.endpoint)
    && Number.isFinite(p.x) && Number.isFinite(p.y);
  if (!value.every(d => d && validPoint(d.start) && validPoint(d.end) && Number.isFinite(d.lengthM) && d.lengthM > 0)
    || !preservesConfirmedDimensions(walls, value, pw, ph)) throw new Error("Confirmed dimensions do not match the saved geometry and scale.");
  return value;
}

/** Deleting a reference wall may leave the same junction on another wall. */
export function rebindConfirmedDimensions(dimensions: ConfirmedDimension[] = [], walls: Wall[]): ConfirmedDimension[] {
  return dimensions.flatMap(d => {
    const resolve = (ref: DimensionEndpoint): DimensionEndpoint | null => {
      if (walls.some(w => w.id === ref.wallId)) return ref;
      for (const w of walls) for (const endpoint of ["start", "end"] as const) {
        const p = endpointPosition(w, endpoint);
        if (Math.hypot(p.x - ref.x, p.y - ref.y) < 1e-10) return { ...ref, wallId: w.id, endpoint };
      }
      return null;
    };
    const start = resolve(d.start), end = resolve(d.end);
    return start && end ? [{ ...d, start, end }] : [];
  });
}
