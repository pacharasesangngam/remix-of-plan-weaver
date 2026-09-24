import type { ProjectState } from "./projectHistory";
import type { NormalizedPoint, Room } from "@/types/floorplan";
import type { DetectedWallSegment } from "@/types/detection";

export const DRAW_PLAN_SIZE = 100;

/** Grow the sheet without changing any real-world object dimensions. */
export function expandDrawingSheet(project: ProjectState): ProjectState {
  const width = project.planW * 2, height = project.planH * 2;
  const point = (p: NormalizedPoint) => ({ x: p.x / 2, y: p.y / 2 });
  const bbox = (b: NonNullable<Room["bbox"]>) => ({ x: b.x / 2, y: b.y / 2, w: b.w / 2, h: b.h / 2 });
  return { ...project, planW: width, planH: height, scale: project.scale * 2, screenPpm: project.screenPpm / 2,
    rooms: project.rooms.map(r => ({ ...r, width: r.width / 2, height: r.height / 2,
      ...(r.bbox ? { bbox: bbox(r.bbox) } : {}), ...(r.center ? { center: point(r.center) } : {}),
      ...(r.polygon ? { polygon: r.polygon.map(point) } : {}), ...(r.wallPolygon ? { wallPolygon: r.wallPolygon.map(point) } : {}) })),
    walls: project.walls.map(w => ({ ...w, x1: w.x1 / 2, y1: w.y1 / 2, x2: w.x2 / 2, y2: w.y2 / 2, ...(w.thicknessRatio ? { thicknessRatio: w.thicknessRatio / 2 } : {}) })),
    doors: project.doors.map(o => ({ ...o, bbox: bbox(o.bbox), ...(o.polygon ? { polygon: o.polygon.map(point) } : {}) })),
    windows: project.windows.map(o => ({ ...o, bbox: bbox(o.bbox), ...(o.polygon ? { polygon: o.polygon.map(point) } : {}) })),
  };
}
export function polygonRoom(points: NormalizedPoint[], id: string, name: string, planW: number, planH: number, height: number) {
  if (points.length < 3 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const cross = (a: NormalizedPoint, b: NormalizedPoint, c: NormalizedPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const on = (a: NormalizedPoint, b: NormalizedPoint, p: NormalizedPoint) => Math.abs(cross(a, b, p)) < 1e-10 && p.x >= Math.min(a.x, b.x) - 1e-10 && p.x <= Math.max(a.x, b.x) + 1e-10 && p.y >= Math.min(a.y, b.y) - 1e-10 && p.y <= Math.max(a.y, b.y) + 1e-10;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (Math.hypot((a.x - b.x) * planW, (a.y - b.y) * planH) < 0.25) return null;
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      if ((cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) return null;
    }
  }
  const area = Math.abs(points.reduce((sum, a, i) => { const b = points[(i + 1) % points.length]; return sum + a.x * b.y - b.x * a.y; }, 0)) * planW * planH / 2;
  if (area < 0.25) return null;
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  const w = Math.max(...points.map(p => p.x)) - x, h = Math.max(...points.map(p => p.y)) - y;
  const room: Room = { id, name, width: w, height: h, bbox: { x, y, w, h }, polygon: points, wallPolygon: points,
    center: { x: x + w / 2, y: y + h / 2 }, confidence: "manual", wallHeight: height, floorColor: "#d9bc91" };
  const walls: DetectedWallSegment[] = points.map((p, i) => ({ id: `${id}-wall-${i}`, x1: p.x, y1: p.y,
    x2: points[(i + 1) % points.length].x, y2: points[(i + 1) % points.length].y, type: "exterior", thickness: 0.15, wallHeight: height }));
  return { room, walls };
}
export function rectangleRoom(a: NormalizedPoint, b: NormalizedPoint, id: string, name: string, planW: number, planH: number, height: number) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
  if (w * planW < 0.5 || h * planH < 0.5) return null;
  const polygon = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const room: Room = { id, name, width: w, height: h, bbox: { x, y, w, h }, polygon, wallPolygon: polygon,
    center: { x: x + w / 2, y: y + h / 2 }, confidence: "manual", wallHeight: height, floorColor: "#d9bc91" };
  const walls: DetectedWallSegment[] = polygon.map((p, i) => ({ id: `${id}-wall-${i}`, x1: p.x, y1: p.y,
    x2: polygon[(i + 1) % 4].x, y2: polygon[(i + 1) % 4].y, type: "exterior", thickness: 0.15, wallHeight: height }));
  return { room, walls };
}

export function removeDrawObject(project: ProjectState, selection: { type: "room" | "wall" | "door" | "window"; id: string }): ProjectState {
  const removed = new Set(project.walls.filter(w => selection.type === "wall" ? w.id === selection.id : selection.type === "room" && w.id.startsWith(`${selection.id}-wall-`)).map(w => w.id));
  return { ...project, rooms: project.rooms.filter(r => selection.type !== "room" || r.id !== selection.id),
    walls: project.walls.filter(w => !removed.has(w.id)),
    doors: project.doors.filter(d => !(selection.type === "door" && d.id === selection.id) && !removed.has(d.wallId ?? "")),
    windows: project.windows.filter(w => !(selection.type === "window" && w.id === selection.id) && !removed.has(w.wallId ?? "")) };
}
