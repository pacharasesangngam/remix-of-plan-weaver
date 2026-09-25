import { preservesConfirmedDimensions, type ConfirmedDimension } from "./confirmedDimensions";
import type { Room, NormalizedPoint, BBox } from "@/types/floorplan";
import type { DetectedWallSegment as Wall, DetectedDoor, DetectedWindow } from "@/types/detection";
import { resolveOpeningWall } from "./openingAttachment";
import { projectOpeningEdgesOntoWall } from "./wallRenderGeometry";
import { getWallThicknessM } from "./wallMetrics";

export interface GeometrySnapshot { confirmedDimensions?: ConfirmedDimension[]; walls: Wall[]; doors: DetectedDoor[]; windows: DetectedWindow[]; rooms: Room[] }
export type Anchor = "start" | "end";
export interface LengthRequest { wallId: string; length: number; anchor: Anchor }
export type LengthCandidate = { ok: true; geometry: GeometrySnapshot; changedWallIds: string[]; displacement: number }
  | { ok: false; reason: string };
type P = { x: number; y: number };
type Segment = { a: P; b: P };
const EPS = 1e-7;
const equal = (a: number, b: number) => Math.abs(a - b) <= EPS;
const same = (a: P, b: P) => equal(a.x, b.x) && equal(a.y, b.y);
export const WALL_AXIS_TOLERANCE_DEGREES = 5;
const ANGLE_SIN = Math.sin(WALL_AXIS_TOLERANCE_DEGREES * Math.PI / 180);
const axis = (s: Segment) => {
  const dx = Math.abs(s.b.x - s.a.x), dy = Math.abs(s.b.y - s.a.y), n = Math.hypot(dx, dy);
  return n <= EPS ? null : dy / n <= ANGLE_SIN ? "x" : dx / n <= ANGLE_SIN ? "y" : null;
};
export const wallIntendedAxis = (wall: Wall, pw: number, ph: number) => axis({ a: { x: wall.x1 * pw, y: wall.y1 * ph }, b: { x: wall.x2 * pw, y: wall.y2 * ph } });
const length = (s: Segment) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
const box = (s: Segment): BBox => ({ x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), w: Math.abs(s.b.x - s.a.x), h: Math.abs(s.b.y - s.a.y) });
const overlaps = (a: BBox, b: BBox) => a.x <= b.x + b.w + EPS && b.x <= a.x + a.w + EPS && a.y <= b.y + b.h + EPS && b.y <= a.y + a.h + EPS;
const on = (p: P, s: Segment) => Math.abs((s.b.x - s.a.x) * (p.y - s.a.y) - (s.b.y - s.a.y) * (p.x - s.a.x)) <= EPS * Math.max(1, length(s))
  && overlaps({ ...p, w: 0, h: 0 }, box(s));
const cross = (a: P, b: P, p: P) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const intersects = (s: Segment, t: Segment) => overlaps(box(s), box(t))
  && cross(s.a, s.b, t.a) * cross(s.a, s.b, t.b) <= EPS * EPS
  && cross(t.a, t.b, s.a) * cross(t.a, t.b, s.b) <= EPS * EPS;
const sweptIntersection = (before: Segment, after: Segment, other: Segment) => {
  const points = [before.a, before.b, after.a, after.b].sort((a, b) => a.x - b.x || a.y - b.y)
    .filter((p, i, all) => !i || !same(p, all[i - 1]));
  const chain = (ps: P[]) => {
    const result: P[] = [];
    for (const p of ps) {
      while (result.length > 1 && cross(result[result.length - 2], result[result.length - 1], p) <= EPS) result.pop();
      result.push(p);
    }
    return result.slice(0, -1);
  };
  const hull = [...chain(points), ...chain([...points].reverse())];
  if (hull.length < 3) return hull.length === 2 && intersects({ a: hull[0], b: hull[1] }, other);
  const edges = hull.map((a, i) => ({ a, b: hull[(i + 1) % hull.length] }));
  return edges.some(s => intersects(s, other)) || [other.a, other.b].some(p => edges.every(s => cross(s.a, s.b, p) >= -EPS));
};
const overlapLength = (s: Segment, t: Segment) => {
  const len = length(s);
  if (len <= EPS || Math.abs(cross(s.a, s.b, t.a)) > EPS * len || Math.abs(cross(s.a, s.b, t.b)) > EPS * len) return 0;
  const u = { x: (s.b.x - s.a.x) / len, y: (s.b.y - s.a.y) / len };
  const project = (p: P) => (p.x - s.a.x) * u.x + (p.y - s.a.y) * u.y;
  return Math.min(len, Math.max(project(t.a), project(t.b))) - Math.max(0, Math.min(project(t.a), project(t.b)));
};

/** Shared endpoint nodes plus endpoint-on-segment attachments. Far endpoints
 * are boundaries unless an interior attachment actually needs their support. */
function propagateJunctions(original: Segment[], moving: P, anchor: P, target: P, line: Set<number>, fixed: P[]) {
  type Node = { before: P; after: P; depth: number; fixed: boolean };
  const nodes: Node[] = [];
  const nodeFor = (p: P) => {
    let index = nodes.findIndex(node => same(node.before, p));
    if (index < 0) { index = nodes.length; nodes.push({ before: p, after: p, depth: Infinity, fixed: same(p, anchor) || fixed.some(q => same(p, q)) }); }
    return index;
  };
  const edges = original.map(s => ({ a: nodeFor(s.a), b: nodeFor(s.b) }));
  const movingId = nodeFor(moving);
  if (nodes[movingId].fixed) return null;
  const displacement = { x: target.x - moving.x, y: target.y - moving.y };
  nodes.forEach((node, id) => {
    if (!node.fixed && (id === movingId || [...line].some(i => on(node.before, original[i])))) {
      node.after = { x: node.before.x + displacement.x, y: node.before.y + displacement.y };
      node.depth = 0;
    }
  });
  nodes[movingId].after = target;
  nodes[movingId].fixed = true;
  const attachments = nodes.flatMap((node, n) => edges.flatMap((edge, i) => {
    if (edge.a === n || edge.b === n || !on(node.before, original[i])) return [];
    const s = original[i], dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
    const t = ((node.before.x - s.a.x) * dx + (node.before.y - s.a.y) * dy) / (dx * dx + dy * dy);
    return [{ n, edge, t }];
  }));
  // Resolve only existing attachments. Interior junctions can slide along an
  // unchanged host; otherwise the nearest driven junction deforms its support.
  // A bounded iteration detects contradictory cycles rather than disconnecting them.
  for (let pass = 0; pass <= nodes.length + attachments.length; pass++) {
    let changed = false;
    for (const { n, edge, t } of attachments) {
      const node = nodes[n], a = nodes[edge.a], b = nodes[edge.b];
      if (on(node.after, { a: a.after, b: b.after })) continue;
      const hostDepth = Math.min(a.depth, b.depth);
      if (!node.fixed && hostDepth < node.depth) {
        node.after = { x: a.after.x * (1 - t) + b.after.x * t, y: a.after.y * (1 - t) + b.after.y * t };
        node.depth = hostDepth + 1;
      } else {
        const desired = { x: a.after.x * (1 - t) + b.after.x * t, y: a.after.y * (1 - t) + b.after.y * t };
        const correction = { x: node.after.x - desired.x, y: node.after.y - desired.y };
        if (a.fixed && b.fixed) return null;
        const weight = a.fixed ? t : b.fixed ? 1 - t : 1;
        if (weight <= EPS) return null;
        for (const end of [a, b]) if (!end.fixed) {
          end.after = { x: end.after.x + correction.x / weight, y: end.after.y + correction.y / weight };
          end.depth = Math.min(end.depth, node.depth + 1);
        }
      }
      changed = true;
    }
    if (!changed) return {
      next: edges.map(edge => ({ a: nodes[edge.a].after, b: nodes[edge.b].after })),
      shift: (p: P) => nodes.find(node => same(node.before, p))?.after ?? p,
    };
  }
  return null;
}

/** Bounded deformation of connected junctions, with calibration held fixed. */
export function proposeWallLength(source: GeometrySnapshot, request: LengthRequest, pw: number, ph: number): LengthCandidate {
  const fail = (reason: string): LengthCandidate => ({ ok: false, reason });
  if (![pw, ph, request.length].every(n => Number.isFinite(n) && n > 0)) return fail("Enter a positive length on a calibrated plan.");
  if (new Set(source.walls.map(w => w.id)).size !== source.walls.length) return fail("Duplicate wall IDs make this geometry ambiguous.");
  const metric = (p: NormalizedPoint): P => ({ x: p.x * pw, y: p.y * ph });
  const normalized = (p: P): P => ({ x: p.x / pw, y: p.y / ph });
  const original = source.walls.map(w => ({ a: metric({ x: w.x1, y: w.y1 }), b: metric({ x: w.x2, y: w.y2 }) }));
  const index = source.walls.findIndex(w => w.id === request.wallId);
  if (index < 0) return fail("Wall is no longer available.");
  const selected = original[index], direction = axis(selected);
  if (length(selected) <= EPS) return fail("Choose a wall with two different endpoints.");
  const anchor = request.anchor === "start" ? selected.a : selected.b;
  const moving = request.anchor === "start" ? selected.b : selected.a;
  const unit = { x: (moving.x - anchor.x) / length(selected), y: (moving.y - anchor.y) / length(selected) };
  // Only the edited wall may align to its intended axis. Unrelated walls are never straightened.
  const intended = direction === "x" ? { x: Math.sign(unit.x), y: 0 } : direction === "y" ? { x: 0, y: Math.sign(unit.y) } : unit;
  const target = { x: anchor.x + intended.x * request.length, y: anchor.y + intended.y * request.length };
  const displacement = { x: target.x - moving.x, y: target.y - moving.y };
  const delta = Math.hypot(displacement.x, displacement.y);
  if (delta <= EPS) return fail("The wall already has this length.");
  const across = direction === "x" ? "y" : "x";
  const line = new Set<number>();
  original.forEach((s, i) => {
    if (i === index || !on(moving, s)) return;
    if (direction ? axis(s) === across : !same(moving, s.a) && !same(moving, s.b)) line.add(i);
  });
  const parallel = (s: Segment, t: Segment) => Math.abs((s.b.x - s.a.x) * (t.b.y - t.a.y) - (s.b.y - s.a.y) * (t.b.x - t.a.x)) <= ANGLE_SIN * length(s) * length(t);
  let grew = true;
  while (grew) {
    grew = false;
    original.forEach((s, i) => {
      if (i !== index && !line.has(i) && [...line].some(j => parallel(s, original[j]) && intersects(s, original[j]))) { line.add(i); grew = true; }
    });
  }
  const fixed = (source.confirmedDimensions ?? []).flatMap(dimension => [metric(dimension.start), metric(dimension.end)]);
  const propagated = propagateJunctions(original, moving, anchor, target, line, fixed);
  if (!propagated) return fail("The connected junctions cannot satisfy this length while keeping the anchor and confirmed span fixed.");
  const { next, shift } = propagated;
  const changed = original.map((s, i) => !same(s.a, next[i].a) || !same(s.b, next[i].b));
  for (let i = 0; i < next.length; i++) {
    if (!changed[i]) continue;
    if ((next[i].b.x - next[i].a.x) * (original[i].b.x - original[i].a.x) + (next[i].b.y - next[i].a.y) * (original[i].b.y - original[i].a.y) <= EPS * EPS) return fail("This edit would collapse or reverse a wall.");
    for (let j = 0; j < next.length; j++) {
      if (i === j) continue;
      if (overlapLength(original[i], original[j]) > EPS || overlapLength(next[i], next[j]) > EPS) return fail("Overlapping wall segments make this edit ambiguous.");
      if (intersects(original[i], original[j]) !== intersects(next[i], next[j])) return fail("This edit would break a junction or create a new connection.");
      // Test the swept geometry, not a diagonal wall's oversized axis-aligned bounds.
      if (!changed[j] && !intersects(original[i], original[j])) {
        if (sweptIntersection(original[i], next[i], original[j])) return fail("This adjustment would cross another wall. Try a smaller length.");
      }
    }
  }
  const walls = source.walls.map((w, i) => changed[i] ? { ...w, x1: next[i].a.x / pw, y1: next[i].a.y / ph, x2: next[i].b.x / pw, y2: next[i].b.y / ph } : w);
  if (!preservesConfirmedDimensions(walls, source.confirmedDimensions, pw, ph)) return fail("This would move an endpoint of the confirmed calibration span. Edit a segment inside that span instead.");
  let openingError = "";
  const openings = <T extends DetectedDoor | DetectedWindow>(items: T[]): T[] => items.map(item => {
    const host = item.wallId ? source.walls.find(w => w.id === item.wallId) : resolveOpeningWall(item.bbox, source.walls, pw, ph).wall;
    const bounds = { x: item.bbox.x * pw, y: item.bbox.y * ph, w: item.bbox.w * pw, h: item.bbox.h * ph };
    if (!host) {
      if (original.some((s, i) => changed[i] && (overlaps(bounds, box(s)) || overlaps(bounds, box(next[i]))))) openingError = "An affected opening has no unambiguous host.";
      return item;
    }
    const i = source.walls.indexOf(host), s = original[i], n = next[i];
    const translated = changed[i] && equal(n.a.x - s.a.x, n.b.x - s.b.x) && equal(n.a.y - s.a.y, n.b.y - s.b.y);
    const before = projectOpeningEdgesOntoWall(item.bbox, host, length(s), pw, ph);
    let updated = item;
    if (changed[i] && before) {
      const u = { x: (s.b.x - s.a.x) / length(s), y: (s.b.y - s.a.y) / length(s) };
      const v = { x: (n.b.x - n.a.x) / length(n), y: (n.b.y - n.a.y) / length(n) };
      const rotated = Math.abs(u.x * v.y - u.y * v.x) > EPS;
      const fixedStart = same(s.a, n.a);
      const fixedOld = fixedStart || translated ? s.a : s.b, fixedNew = fixedStart || translated ? n.a : n.b;
      const transform = (p: NormalizedPoint): NormalizedPoint => {
        const q = metric(p), dx = q.x - fixedOld.x, dy = q.y - fixedOld.y;
        const t = dx * u.x + dy * u.y, off = -dx * u.y + dy * u.x;
        return normalized({ x: fixedNew.x + t * v.x - off * v.y, y: fixedNew.y + t * v.y + off * v.x });
      };
      if (translated || rotated || !same(fixedOld, fixedNew)) {
        const center = transform({ x: item.bbox.x + item.bbox.w / 2, y: item.bbox.y + item.bbox.h / 2 });
        // Bboxes stay axis-aligned. Preserve their measured host-axis width when the host rotates.
        const projected = Math.abs(v.x) * item.bbox.w * pw + Math.abs(v.y) * item.bbox.h * ph;
        const factor = rotated && projected > EPS ? (before.tEnd - before.tStart) / projected : 1;
        const w = item.bbox.w * factor, h = item.bbox.h * factor;
        updated = { ...item, bbox: { x: center.x - w / 2, y: center.y - h / 2, w, h },
          ...(item.polygon ? { polygon: item.polygon.map(transform) } : {}) };
      }
    }
    // Check every affected wall, not just the initially translated line. Use
    // actual segment sweeps instead of diagonal walls' axis-aligned envelopes.
    for (let j = 0; j < next.length; j++) {
      if (j === i || !changed[j]) continue;
      const half = getWallThicknessM(source.walls[j], pw, ph) / 2;
      const openingBox = (bbox: BBox) => {
        const x = bbox.x * pw - half, y = bbox.y * ph - half;
        const right = (bbox.x + bbox.w) * pw + half, bottom = (bbox.y + bbox.h) * ph + half;
        const points = [{ x, y }, { x: right, y }, { x: right, y: bottom }, { x, y: bottom }];
        return { edges: points.map((a, k) => ({ a, b: points[(k + 1) % points.length] })),
          contains: (p: P) => p.x >= x && p.x <= right && p.y >= y && p.y <= bottom };
      };
      const beforeBox = openingBox(item.bbox), afterBox = openingBox(updated.bbox);
      const touches = (s: Segment, b: ReturnType<typeof openingBox>) => b.contains(s.a) || b.contains(s.b) || b.edges.some(edge => intersects(s, edge));
      if (touches(original[j], beforeBox)) continue; // Do not reinterpret pre-existing opening geometry.
      if (touches(next[j], afterBox) || (!changed[i] && afterBox.edges.some(edge => sweptIntersection(original[j], next[j], edge))))
        openingError = "A moving wall would reach a door or window. Try a smaller adjustment.";
    }
    if (changed[i]) {
      const after = projectOpeningEdgesOntoWall(updated.bbox, walls[i], length(n), pw, ph);
      const ux = (n.b.x - n.a.x) / length(n), uy = (n.b.y - n.a.y) / length(n);
      const span = Math.abs(ux) * updated.bbox.w * pw + Math.abs(uy) * updated.bbox.h * ph;
      if (!before || !after || !equal(before.tEnd - before.tStart, after.tEnd - after.tStart)
        || !equal(span, after.tEnd - after.tStart)) openingError = "There is not enough wall length for the attached opening.";
    }
    if (!item.wallId && resolveOpeningWall(updated.bbox, walls, pw, ph).wall?.id !== host.id) openingError = "An opening would change host or become ambiguous.";
    return updated as T;
  });
  const doors = openings(source.doors), windows = openings(source.windows);
  if (openingError) return fail(openingError);

  // Update mapped room boundaries opportunistically; independent masks never block a wall edit.
  const rooms = source.rooms.map(room => {
    let roomError = false;
    const polygons = [room.polygon, room.wallPolygon].filter((p): p is NormalizedPoint[] => !!p?.length);
    const bounds = room.bbox ?? (polygons.length ? { x: Math.min(...polygons.flat().map(p => p.x)), y: Math.min(...polygons.flat().map(p => p.y)),
      w: Math.max(...polygons.flat().map(p => p.x)) - Math.min(...polygons.flat().map(p => p.x)), h: Math.max(...polygons.flat().map(p => p.y)) - Math.min(...polygons.flat().map(p => p.y)) } : null);
    if (!bounds) return room;
    const mb = { x: bounds.x * pw, y: bounds.y * ph, w: bounds.w * pw, h: bounds.h * ph };
    if (!original.some((s, i) => changed[i] && (overlaps(box(s), mb) || overlaps(box(next[i]), mb)))) return room;
    const roomPoint = (p: P): P => {
      const junction = shift(p);
      if (!same(junction, p)) return junction;
      // Map room faces along every affected host, including resized/rotated
      // branches, rather than only the initially translated wall line.
      for (let i = 0; i < original.length; i++) {
        if (!changed[i]) continue;
        const s = original[i], len = length(s), half = getWallThicknessM(source.walls[i], pw, ph) / 2;
        const t = ((p.x - s.a.x) * (s.b.x - s.a.x) + (p.y - s.a.y) * (s.b.y - s.a.y)) / len;
        if (t >= -half - EPS && t <= len + half + EPS && Math.abs(cross(s.a, s.b, p)) / len <= half + EPS) {
          const n = next[i], u = { x: (n.b.x - n.a.x) / length(n), y: (n.b.y - n.a.y) / length(n) };
          const off = cross(s.a, s.b, p) / len;
          return { x: n.a.x + (n.b.x - n.a.x) * t / len - u.y * off,
            y: n.a.y + (n.b.y - n.a.y) * t / len + u.x * off };
        }
      }
      return p;
    };
    const transform = (poly: NormalizedPoint[]) => {
      const before = poly.map(metric), after = before.map(roomPoint);
      const edges = (points: P[]) => points.map((a, i) => ({ a, b: points[(i + 1) % points.length] }));
      const es = edges(after);
      const signedArea = (ps: P[]) => ps.reduce((sum, p, i) => sum + p.x * ps[(i + 1) % ps.length].y - p.y * ps[(i + 1) % ps.length].x, 0);
      if (poly.length < 3 || signedArea(before) * signedArea(after) <= EPS || es.some(s => length(s) <= EPS)
        || es.some((s, i) => es.some((t, j) => j > i + 1 && !(i === 0 && j === es.length - 1) && intersects(s, t)))) roomError = true;
      return after.map((p, i) => same(p, before[i]) ? poly[i] : normalized(p));
    };
    if (!polygons.length) return room;
    const polygon = room.polygon ? transform(room.polygon) : undefined;
    const wallPolygon = room.wallPolygon ? transform(room.wallPolygon) : undefined;
    if ((!polygon || polygon.every((p, i) => p === room.polygon![i])) && (!wallPolygon || wallPolygon.every((p, i) => p === room.wallPolygon![i]))) return room;
    if (roomError) return room;
    const points = polygon ?? wallPolygon!;
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
    const w = Math.max(...points.map(p => p.x)) - x, h = Math.max(...points.map(p => p.y)) - y;
    return { ...room, polygon, wallPolygon, bbox: { x, y, w, h }, width: w, height: h, center: { x: x + w / 2, y: y + h / 2 }, areaSqm: undefined };
  });
  return { ok: true, geometry: { walls, doors, windows, rooms, ...(source.confirmedDimensions ? { confirmedDimensions: source.confirmedDimensions } : {}) }, changedWallIds: walls.filter((_, i) => changed[i]).map(w => w.id), displacement: delta };
}

export function chooseLengthAnchor(source: GeometrySnapshot, wallId: string, target: number, pw: number, ph: number): Anchor {
  const start = proposeWallLength(source, { wallId, length: target, anchor: "start" }, pw, ph);
  const end = proposeWallLength(source, { wallId, length: target, anchor: "end" }, pw, ph);
  if (start.ok !== end.ok) return start.ok ? "start" : "end";
  if (!start.ok || !end.ok) return "start";
  const wall = source.walls.find(w => w.id === wallId)!;
  const connected = (p: P) => source.walls.some(w => w.id !== wallId && on({ x: p.x * pw, y: p.y * ph },
    { a: { x: w.x1 * pw, y: w.y1 * ph }, b: { x: w.x2 * pw, y: w.y2 * ph } }));
  const a = connected({ x: wall.x1, y: wall.y1 }), b = connected({ x: wall.x2, y: wall.y2 });
  return a !== b ? a ? "start" : "end" : "start";
}
