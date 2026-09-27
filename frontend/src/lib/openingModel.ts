import { projectToWall, screenDistance, SNAP_PX } from "./wallGeometry";
import type { DetectedDoor, DetectedWindow, DetectedWallSegment as Wall } from "@/types/detection";
import type { NormalizedPoint as Point } from "@/types/floorplan";
import { resolveOpeningWall } from "./openingAttachment";
import { projectOpeningEdgesOntoWall } from "./openingProjection";
import { createOpeningBboxFromWallPoints } from "./openingPlacement";
import { getWallHeightM, getWallThicknessM } from "./wallMetrics";
import { defaultOpeningHeight, defaultOpeningSill, OPENING_CLEARANCE_M } from "./openingDefaults";
export type Opening = DetectedDoor | DetectedWindow;
export type OpeningKind = "door" | "window";
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export function openingGeometry(opening: Opening, kind: OpeningKind, walls: Wall[], pw: number, ph: number, defaultHeight = 2.8) {
  const wall = opening.wallId ? walls.find(w => w.id === opening.wallId) : resolveOpeningWall(opening.bbox, walls, pw, ph).wall;
  if (!wall) return null;
  const dx = (wall.x2 - wall.x1) * pw, dy = (wall.y2 - wall.y1) * ph, length = Math.hypot(dx, dy);
  if (length < 1e-8) return null;
  const span = opening.wallSpan;
  const segment = opening.planSegment;
  const along = (p: Point) => ((p.x - wall.x1) * pw * dx + (p.y - wall.y1) * ph * dy) / length;
  const projection = segment
    ? { tStart: along(segment.start), tEnd: along(segment.end) }
    : span && Number.isFinite(span.start) && Number.isFinite(span.end)
    ? { tStart: clamp(span.start, 0, 1) * length, tEnd: clamp(span.end, 0, 1) * length }
    : projectOpeningEdgesOntoWall(opening.bbox, wall, length, pw, ph);
  if (!projection || projection.tEnd - projection.tStart <= 1e-7) return null;
  const { tStart, tEnd } = projection;
  const wallHeight = getWallHeightM(wall, defaultHeight);
  const sill = kind === "door" ? 0 : clamp(Number.isFinite(opening.sillHeightM) ? opening.sillHeightM! : defaultOpeningSill(kind, wallHeight), 0, Math.max(0, wallHeight - OPENING_CLEARANCE_M));
  const height = clamp(Number.isFinite(opening.heightM) ? opening.heightM! : defaultOpeningHeight(kind, wallHeight), 0.01, wallHeight - sill);
  const point = (t: number): Point => ({ x: wall.x1 + dx / pw * t / length, y: wall.y1 + dy / ph * t / length });
  const start = point(tStart), end = point(tEnd), half = getWallThicknessM(wall, pw, ph) / 2;
  const offset = { x: -dy / length * half / pw, y: dx / length * half / ph };
  const polygon = segment && opening.polygon?.length ? opening.polygon : [{ x: start.x + offset.x, y: start.y + offset.y }, { x: end.x + offset.x, y: end.y + offset.y },
    { x: end.x - offset.x, y: end.y - offset.y }, { x: start.x - offset.x, y: start.y - offset.y }];
  const x = Math.min(...polygon.map(p => p.x)), y = Math.min(...polygon.map(p => p.y));
  return { wall, length, tStart, tEnd, width: tEnd - tStart, height, sill, start, end, polygon,
    bbox: { x, y, w: Math.max(...polygon.map(p => p.x)) - x, h: Math.max(...polygon.map(p => p.y)) - y },
    center: [(wall.x1 + wall.x2 - 1) * pw / 2, (wall.y1 + wall.y2 - 1) * ph / 2] as [number, number],
    angle: Math.atan2(dy, dx), localX: (tStart + tEnd - length) / 2, wallLengthM: length, projectedWidth: tEnd - tStart };
}
/** Materialize geometry once; calibration and cosmetic edits must not rebuild it. */
export function materializeOpening<T extends Opening>(opening: T, kind: OpeningKind, walls: Wall[], pw: number, ph: number, height = 2.8, reference?: Opening): T {
  const g = openingGeometry(opening, kind, walls, pw, ph, height);
  if (!g) return opening;
  if (!opening.planSegment && reference?.planSegment && reference.polygon?.length) {
    const { start, end } = reference.planSegment;
    const dx = (end.x - start.x) * pw, dy = (end.y - start.y) * ph, length = Math.hypot(dx, dy);
    if (length > 1e-8) {
      const ux = Math.cos(g.angle), uy = Math.sin(g.angle);
      const polygon = reference.polygon.map(p => {
        const x = (p.x - start.x) * pw, y = (p.y - start.y) * ph;
        const along = (x * dx + y * dy) / length * g.width / length;
        const across = (-x * dy + y * dx) / length;
        return { x: g.start.x + (along * ux - across * uy) / pw,
          y: g.start.y + (along * uy + across * ux) / ph };
      });
      return materializeOpening({ ...opening, planSegment: { start: g.start, end: g.end }, polygon }, kind, walls, pw, ph, height);
    }
  }
  return { ...opening, wallId: g.wall.id, planSegment: { start: g.start, end: g.end },
    wallSpan: { start: g.tStart / g.length, end: g.tEnd / g.length }, bbox: g.bbox, polygon: g.polygon,
    heightM: opening.heightM ?? g.height, ...(kind === "window" ? { sillHeightM: opening.sillHeightM ?? g.sill } : {}) };
}
export type OpeningGeometry = NonNullable<ReturnType<typeof openingGeometry>>;
/** Explicit edited spans win; ambiguous hosts and overlapping secondary detections
 * remain in project data, but never create overlapping meshes or extra wall cuts. */
export function resolveOpenings(doors: DetectedDoor[], windows: DetectedWindow[], walls: Wall[], pw: number, ph: number, height = 2.8) {
  const active: { opening: Opening; kind: OpeningKind; geometry: OpeningGeometry }[] = [];
  const rejected = new Map<string, "unresolved" | "overlap">();
  const items = [...doors.map(opening => ({ opening, kind: "door" as const })), ...windows.map(opening => ({ opening, kind: "window" as const }))]
    .sort((a, b) => Number(!!b.opening.wallSpan) - Number(!!a.opening.wallSpan) || Number(!!b.opening.wallId) - Number(!!a.opening.wallId)
      || a.opening.id.localeCompare(b.opening.id) || a.kind.localeCompare(b.kind));
  for (const item of items) {
    const geometry = openingGeometry(item.opening, item.kind, walls, pw, ph, height);
    const key = `${item.kind}:${item.opening.id}`;
    if (!geometry) { rejected.set(key, "unresolved"); continue; }
    if (active.some(other => other.geometry.wall.id === geometry.wall.id
      && Math.min(other.geometry.tEnd, geometry.tEnd) - Math.max(other.geometry.tStart, geometry.tStart) > 1e-7)) {
      rejected.set(key, "overlap"); continue;
    }
    active.push({ ...item, geometry });
  }
  return { active, rejected };
}
export function openingAtPoints<T extends Opening>(opening: T, wall: Wall, a: Point, b: Point, pw: number, ph: number): T {
  const dx = (wall.x2 - wall.x1) * pw, dy = (wall.y2 - wall.y1) * ph, len2 = dx * dx + dy * dy;
  const t = (p: Point) => clamp(((p.x - wall.x1) * pw * dx + (p.y - wall.y1) * ph * dy) / len2, 0, 1);
  const placed = materializeOpening({ ...opening, planSegment: undefined, wallId: wall.id, wallSpan: { start: Math.min(t(a), t(b)), end: Math.max(t(a), t(b)) } }, "door", [wall], pw, ph);
  // This geometry helper is shared by doors and windows; defaults need the kind.
  return { ...placed, heightM: opening.heightM, sillHeightM: opening.sillHeightM };
}

/**
 * A new opening always stores its own measured physical height and sill, so
 * changes to the host wall or room later will not stretch it.
 */
export function newOpeningRecord<T extends Opening>(
  kind: OpeningKind,
  id: string,
  wall: Wall,
  start: Point,
  end: Point,
  pw: number,
  ph: number,
  defaultHeight = 2.8,
): T | null {
  const bbox = createOpeningBboxFromWallPoints(wall, start, end, pw, ph);
  if (!bbox) return null;
  const wallHeight = getWallHeightM(wall, defaultHeight);
  const explicit = {
    id,
    bbox,
    heightM: defaultOpeningHeight(kind, wallHeight),
    ...(kind === "window" ? { sillHeightM: defaultOpeningSill(kind, wallHeight) } : {}),
  } as T;
  const placed = openingAtPoints(explicit, wall, start, end, pw, ph);
  const geometry = openingGeometry(placed, kind, [wall], pw, ph, wallHeight);
  if (!geometry) return null;
  return { ...placed, bbox: geometry.bbox, polygon: geometry.polygon,
    heightM: geometry.height, ...(kind === "window" ? { sillHeightM: geometry.sill } : {}) };
}
export type OpeningEdit = { mode: "move" | "start" | "end"; value: number } | { mode: "width" | "height" | "sill"; value: number };
/** All distances are metres in the project's calibrated plan coordinates. */
export function editOpening(opening: Opening, kind: OpeningKind, edit: OpeningEdit, walls: Wall[], doors: DetectedDoor[], windows: DetectedWindow[], pw: number, ph: number, height = 2.8): Opening | null {
  const g = openingGeometry(opening, kind, walls, pw, ph, height);
  if (!g || !Number.isFinite(edit.value)) return null;
  if (edit.mode === "height" || edit.mode === "sill") {
    if (edit.value < 0 || (edit.mode === "height" && edit.value === 0)) return null;
    const updated = { ...opening, [edit.mode === "height" ? "heightM" : "sillHeightM"]: edit.value };
    const next = openingGeometry(updated, kind, walls, pw, ph, height)!;
    return { ...updated, heightM: next.height, sillHeightM: next.sill };
  }
  const others = resolveOpenings(doors.filter(o => !(kind === "door" && o.id === opening.id)), windows.filter(o => !(kind === "window" && o.id === opening.id)), walls, pw, ph, height).active
    .map(o => o.geometry).filter(o => o.wall.id === g.wall.id);
  const low = Math.max(0, ...others.filter(o => o.tEnd <= g.tStart + 1e-7).map(o => o.tEnd));
  const high = Math.min(g.length, ...others.filter(o => o.tStart >= g.tEnd - 1e-7).map(o => o.tStart));
  const min = Math.min(0.05, high - low);
  let start = g.tStart, end = g.tEnd;
  if (edit.mode === "move") { start = clamp(g.tStart + edit.value, low, high - g.width); end = start + g.width; }
  if (edit.mode === "start") start = clamp(edit.value, low, end - min);
  if (edit.mode === "end") end = clamp(edit.value, start + min, high);
  if (edit.mode === "width") { if (edit.value <= 0) return null; end = clamp(start + edit.value, start + min, high); }
  if (others.some(o => Math.min(end, o.tEnd) - Math.max(start, o.tStart) > 1e-7)) return null;
  return materializeOpening({ ...opening, planSegment: undefined, wallId: g.wall.id, wallSpan: { start: start / g.length, end: end / g.length } }, kind, walls, pw, ph, height, opening);
}


const sameOrdinate = (a: number, b: number) => Math.abs(a - b) <= 1e-12;
const samePoint = (a: Point, b: Point) => sameOrdinate(a.x, b.x) && sameOrdinate(a.y, b.y);
const sameData = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Rigid attachment updates preserve size. Collinear endpoint edits leave the
 * opening in place unless it must slide to remain inside the shortened host. */
function reattachToHost<T extends Opening>(record: T, kind: OpeningKind, host: Wall, previous: {
  walls: Wall[]; planW: number; planH: number; wallHeightMeter: number;
}, pw: number, ph: number): T | null {
  // Use the new conversion for both geometries, including edits bundled with calibration.
  const old = openingGeometry(record, kind, previous.walls, pw, ph, previous.wallHeightMeter);
  if (!old) return null;
  const dx = (host.x2 - host.x1) * pw, dy = (host.y2 - host.y1) * ph, length = Math.hypot(dx, dy);
  if (length < old.width - 1e-8 || length < 1e-8 || getWallHeightM(host) < old.sill + old.height - 1e-8) return null;
  const oldStart = { x: old.wall.x1, y: old.wall.y1 }, oldEnd = { x: old.wall.x2, y: old.wall.y2 };
  const newStart = { x: host.x1, y: host.y1 }, newEnd = { x: host.x2, y: host.y2 };
  const endFixed = samePoint(oldEnd, newEnd);
  const anchor = endFixed ? oldEnd : oldStart, target = endFixed ? newEnd : newStart;
  const angle = Math.atan2(dy, dx) - old.angle, cos = Math.cos(angle), sin = Math.sin(angle);
  const transform = (p: Point): Point => {
    const x = (p.x - anchor.x) * pw, y = (p.y - anchor.y) * ph;
    return { x: target.x + (x * cos - y * sin) / pw, y: target.y + (x * sin + y * cos) / ph };
  };
  let start = transform(old.start), end = transform(old.end);
  const t = ((start.x - host.x1) * pw * dx + (start.y - host.y1) * ph * dy) / length;
  const shift = clamp(t, 0, Math.max(0, length - old.width)) - t;
  const slide = (p: Point) => ({ x: p.x + dx / length * shift / pw, y: p.y + dy / length * shift / ph });
  start = slide(start); end = slide(end);
  return materializeOpening({ ...record, wallId: host.id, planSegment: { start, end },
    polygon: old.polygon.map(p => slide(transform(p))) }, kind, [host], pw, ph, previous.wallHeightMeter);
}

export function syncOpeningRecords<T extends { walls: Wall[]; doors: DetectedDoor[]; windows: DetectedWindow[]; planW: number; planH: number; wallHeightMeter: number }>(project: T, previous?: T): T {
  const pw = project.planW > 0 ? project.planW : 20, ph = project.planH > 0 ? project.planH : 20;
  let invalid = false;
  const sync = <O extends Opening>(records: O[], kind: OpeningKind, old: O[] = []): O[] => records.map(record => {
    const before = old.find(o => o.id === record.id);
    let input = record;
    if (before && previous) {
      const hostBefore = previous.walls.find(w => w.id === before.wallId);
      const host = project.walls.find(w => w.id === record.wallId);
      const ownGeometryUnchanged = sameData([record.wallId, record.wallSpan, record.planSegment, record.bbox],
        [before.wallId, before.wallSpan, before.planSegment, before.bbox]);
      if (ownGeometryUnchanged) {
        const endpoints = (w: Wall) => [w.x1, w.y1, w.x2, w.y2];
        if (host && hostBefore && (!sameData(endpoints(host), endpoints(hostBefore))
          || getWallHeightM(host, project.wallHeightMeter) !== getWallHeightM(hostBefore, previous.wallHeightMeter))) {
          const attached = reattachToHost(record, kind, { ...host, wallHeight: getWallHeightM(host, project.wallHeightMeter) }, previous, pw, ph);
          if (!attached) { invalid = true; return record; }
          return attached;
        }
        return record;
      }
      // Existing controls send span or bbox edits. Convert those commands once,
      // rather than leaving a wall fraction as the opening's source of truth.
      if (sameData(record.planSegment, before.planSegment)) {
        input = { ...record, planSegment: undefined };
        if (record.wallId !== before.wallId && sameData(record.wallSpan, before.wallSpan) && host) {
          const g = openingGeometry(before, kind, previous.walls, pw, ph, previous.wallHeightMeter);
          const center = record.wallSpan ? (record.wallSpan.start + record.wallSpan.end) / 2 : 0.5;
          const point = { x: host.x1 + (host.x2 - host.x1) * center, y: host.y1 + (host.y2 - host.y1) * center };
          const moved = g && rehostOpening(before, kind, host.id, point, project.walls, project.doors, project.windows, pw, ph, project.wallHeightMeter);
          if (!moved) { invalid = true; return record; }
          input = moved as O;
        } else if (!sameData(record.bbox, before.bbox) && sameData(record.wallSpan, before.wallSpan)) {
          input = { ...input, wallSpan: undefined };
        }
      }
    }
    // Already materialized records survive save/reopen and calibration verbatim.
    if (!before && record.planSegment && record.heightM !== undefined && (kind === "door" || record.sillHeightM !== undefined)) return record;
    return materializeOpening(input, kind, project.walls, pw, ph, project.wallHeightMeter, before);
  });
  const doors = sync(project.doors, "door", previous?.doors), windows = sync(project.windows, "window", previous?.windows);
  // Reject an impossible host edit atomically instead of shrinking its openings.
  if (invalid && previous) return previous;
  if (previous) {
    const active = [...doors.map(opening => ({ opening, kind: "door" as const })), ...windows.map(opening => ({ opening, kind: "window" as const }))];
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      const geometry = (item: typeof a, state: T) => openingGeometry(item.opening, item.kind, state.walls, pw, ph, state.wallHeightMeter);
      const ga = geometry(a, project), gb = geometry(b, project);
      if (!ga || !gb || ga.wall.id !== gb.wall.id || Math.min(ga.tEnd, gb.tEnd) <= Math.max(ga.tStart, gb.tStart) + 1e-8) continue;
      const oldA = (a.kind === "door" ? previous.doors : previous.windows).find(o => o.id === a.opening.id);
      const oldB = (b.kind === "door" ? previous.doors : previous.windows).find(o => o.id === b.opening.id);
      if (!oldA || !oldB) continue;
      const oa = geometry({ ...a, opening: oldA }, previous), ob = geometry({ ...b, opening: oldB }, previous);
      if (oa && ob && (oa.wall.id !== ob.wall.id || Math.min(oa.tEnd, ob.tEnd) <= Math.max(oa.tStart, ob.tStart) + 1e-8)) return previous;
    }
  }
  return { ...project, doors: doors.every((o, i) => o === project.doors[i]) ? project.doors : doors,
    windows: windows.every((o, i) => o === project.windows[i]) ? project.windows : windows };
}


/** Re-host without shrinking the opening. The complete updated record is committed atomically. */
export function rehostOpening(opening: Opening, kind: OpeningKind, targetId: string, point: Point,
  walls: Wall[], doors: DetectedDoor[], windows: DetectedWindow[], pw: number, ph: number, height = 2.8, grabOffset = 0): Opening | null {
  const source = openingGeometry(opening, kind, walls, pw, ph, height);
  const wall = walls.find(w => w.id === targetId);
  if (!source || !wall) return null;
  const dx = (wall.x2 - wall.x1) * pw, dy = (wall.y2 - wall.y1) * ph, length = Math.hypot(dx, dy);
  const wallHeight = wall.wallHeight && wall.wallHeight > 0 ? wall.wallHeight : height;
  if (length < source.width - 1e-7 || length < 1e-7 || source.sill + source.height > wallHeight + 1e-7) return null;
  const t = ((point.x - wall.x1) * pw * dx + (point.y - wall.y1) * ph * dy) / length - grabOffset;
  const start = clamp(t - source.width / 2, 0, Math.max(0, length - source.width)), end = start + source.width;
  const occupied = resolveOpenings(doors.filter(o => kind !== "door" || o.id !== opening.id),
    windows.filter(o => kind !== "window" || o.id !== opening.id), walls, pw, ph, height).active;
  if (occupied.some(o => o.geometry.wall.id === wall.id && Math.min(end, o.geometry.tEnd) - Math.max(start, o.geometry.tStart) > 1e-7)) return null;
  const updated = { ...opening, planSegment: undefined, wallId: wall.id, wallSpan: { start: start / length, end: end / length }, heightM: source.height, sillHeightM: source.sill };
  return materializeOpening(updated, kind, walls, pw, ph, height, opening);
}

export function findOpeningRehost(opening: Opening, kind: OpeningKind, point: Point, size: { width: number; height: number },
  walls: Wall[], doors: DetectedDoor[], windows: DetectedWindow[], pw: number, ph: number, height = 2.8, grabOffset = 0): Opening | null {
  const source = openingGeometry(opening, kind, walls, pw, ph, height);
  if (!source) return null;
  const distance = (wall: Wall) => screenDistance(point, projectToWall(point, wall, size), size);
  const currentDistance = distance(source.wall);
  const candidates = walls.filter(w => w.id !== source.wall.id).map(wall => ({ wall, distance: distance(wall) }))
    .filter(item => item.distance < SNAP_PX && item.distance < currentDistance - 1e-7)
    .sort((a, b) => a.distance - b.distance || a.wall.id.localeCompare(b.wall.id));
  for (const candidate of candidates) {
    const result = rehostOpening(opening, kind, candidate.wall.id, point, walls, doors, windows, pw, ph, height, grabOffset);
    if (result) return result;
  }
  return null;
}
