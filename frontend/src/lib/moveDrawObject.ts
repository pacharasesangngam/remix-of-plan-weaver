import type { ProjectState } from "./projectHistory";
import type { NormalizedPoint } from "@/types/floorplan";

export type DrawSelection = { type: "room" | "wall" | "door" | "window"; id: string };

/** Move from an immutable drag-start snapshot; openings remain attached to their wall. */
export function moveDrawObject(project: ProjectState, selection: DrawSelection, delta: NormalizedPoint): ProjectState {
  if (![delta.x, delta.y].every(Number.isFinite)) return project;
  let dx = delta.x, dy = delta.y;
  if (selection.type === "door" || selection.type === "window") {
    const opening = (selection.type === "door" ? project.doors : project.windows).find(o => o.id === selection.id);
    const wall = project.walls.find(w => w.id === opening?.wallId);
    if (!opening || !wall) return project;
    const wx = wall.x2 - wall.x1, wy = wall.y2 - wall.y1;
    const metres = Math.hypot(wx * project.planW, wy * project.planH);
    if (metres <= 0) return project;
    const center = { x: opening.bbox.x + opening.bbox.w / 2, y: opening.bbox.y + opening.bbox.h / 2 };
    const projectT = (x: number, y: number) => ((x - wall.x1) * wx * project.planW ** 2 + (y - wall.y1) * wy * project.planH ** 2) / metres ** 2;
    const width = opening.widthM ?? Math.max(opening.bbox.w * project.planW, opening.bbox.h * project.planH);
    const half = width / metres / 2;
    if (half > 0.5) return project;
    const t = Math.max(half, Math.min(1 - half, projectT(center.x + dx, center.y + dy)));
    dx = wall.x1 + wx * t - center.x; dy = wall.y1 + wy * t - center.y;
    const bbox = { ...opening.bbox, x: opening.bbox.x + dx, y: opening.bbox.y + dy };
    if ([...project.doors, ...project.windows].some(o => o !== opening && o.wallId === wall.id && bbox.x < o.bbox.x + o.bbox.w - 1e-9 && bbox.x + bbox.w > o.bbox.x + 1e-9 && bbox.y < o.bbox.y + o.bbox.h - 1e-9 && bbox.y + bbox.h > o.bbox.y + 1e-9)) return project;
    const moved = { ...opening, bbox, ...(opening.polygon ? { polygon: opening.polygon.map(p => ({ x: p.x + dx, y: p.y + dy })) } : {}) };
    return selection.type === "door" ? { ...project, doors: project.doors.map(o => o.id === opening.id ? moved : o) } : { ...project, windows: project.windows.map(o => o.id === opening.id ? moved : o) };
  }
  const room = selection.type === "room" ? project.rooms.find(r => r.id === selection.id) : undefined;
  const movedWalls = project.walls.filter(w => selection.type === "wall" ? w.id === selection.id : w.id.startsWith(`${selection.id}-wall-`));
  const points = [...movedWalls.flatMap(w => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]), ...(room?.wallPolygon ?? room?.polygon ?? [])];
  if (room?.bbox) points.push({ x: room.bbox.x, y: room.bbox.y }, { x: room.bbox.x + room.bbox.w, y: room.bbox.y + room.bbox.h });
  if (!points.length) return project;
  dx = Math.max(-Math.min(...points.map(p => p.x)), Math.min(1 - Math.max(...points.map(p => p.x)), dx));
  dy = Math.max(-Math.min(...points.map(p => p.y)), Math.min(1 - Math.max(...points.map(p => p.y)), dy));
  if (Math.abs(dx) + Math.abs(dy) < 1e-10) return project;
  const translate = (p: NormalizedPoint) => ({ x: p.x + dx, y: p.y + dy });
  const ids = new Set(movedWalls.map(w => w.id));
  const translateOpening = <T extends ProjectState["doors"][number]>(o: T): T => ids.has(o.wallId ?? "") ? { ...o, bbox: { ...o.bbox, x: o.bbox.x + dx, y: o.bbox.y + dy }, ...(o.polygon ? { polygon: o.polygon.map(translate) } : {}) } : o;
  return { ...project,
    rooms: project.rooms.map(r => r.id !== room?.id ? r : { ...r, ...(r.bbox ? { bbox: { ...r.bbox, x: r.bbox.x + dx, y: r.bbox.y + dy } } : {}),
      ...(r.polygon ? { polygon: r.polygon.map(translate) } : {}), ...(r.wallPolygon ? { wallPolygon: r.wallPolygon.map(translate) } : {}), ...(r.center ? { center: translate(r.center) } : {}) }),
    walls: project.walls.map(w => ids.has(w.id) ? { ...w, x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy } : w),
    doors: project.doors.map(translateOpening), windows: project.windows.map(translateOpening),
  };
}
