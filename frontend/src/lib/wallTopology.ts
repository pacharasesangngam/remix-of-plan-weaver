import type { DetectedWallSegment as Wall } from "@/types/detection";
import type { NormalizedPoint as Point, Room } from "@/types/floorplan";

// Numerical coincidence only; this is not a screen-space snap or gap repair.
export const TOPOLOGY_EPS = 1e-9;
// Relative offset used to sample a point just inside a boundary. Never moves a wall.
const INSIDE_EPS = 1e-6;
const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= TOPOLOGY_EPS;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const minus = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
export const polygonArea = (points: Point[]) => points.reduce((sum, p, i) => sum + cross(p, points[(i + 1) % points.length]), 0) / 2;
export function pointInPolygon(p: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
/** Bounded region minus its islands, so a room around a courtyard never double counts area. */
export const faceArea = (polygon: Point[], holes: Point[][] = []) =>
  Math.max(0, Math.abs(polygonArea(polygon)) - holes.reduce((sum, hole) => sum + Math.abs(polygonArea(hole)), 0));
export const polygonBounds = (points: Point[]) => {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
/** Even-odd path for a face plus its islands, so holes stay unfilled in 2D plan views. */
export const ringsToPathD = (rings: (Point[] | undefined)[], scale = 1) =>
  rings.filter((ring): ring is Point[] => !!ring && ring.length >= 3)
    .map(ring => `M${ring.map(p => `${+(p.x * scale).toFixed(6)} ${+(p.y * scale).toFixed(6)}`).join("L")}Z`).join(" ");
export interface TopologyNode extends Point { endpoints: { wallId: string; end: "start" | "end" }[]; edges: number[] }
export interface TopologyEdge { a: number; b: number; wallIds: string[] }
export interface TopologyFace { polygon: Point[]; holes: Point[][]; wallIds: string[] }
export interface TopologyLoop { polygon: Point[]; area: number; wallIds: string[]; nodeIds: number[] }
export interface WallTopology { nodes: TopologyNode[]; edges: TopologyEdge[]; faces: TopologyFace[] }

/** Planar segment graph shared by all wall sources. Stored walls are never split or mutated. */
export function buildWallTopology(walls: Wall[]): WallTopology {
  const segments = walls.filter(w => [w.x1, w.y1, w.x2, w.y2].every(Number.isFinite))
    .map(w => ({ wall: w, a: { x: w.x1, y: w.y1 }, b: { x: w.x2, y: w.y2 }, cuts: [0, 1] }))
    .filter(s => !near(s.a, s.b)).sort((a, b) => a.wall.id.localeCompare(b.wall.id));
  const param = (p: Point, a: Point, b: Point) => {
    const d = minus(b, a), v = minus(p, a), n = Math.hypot(d.x, d.y);
    return Math.abs(cross(d, v)) <= TOPOLOGY_EPS * n ? (v.x * d.x + v.y * d.y) / (n * n) : NaN;
  };
  const cut = (s: typeof segments[number], t: number) => {
    if (t >= -TOPOLOGY_EPS && t <= 1 + TOPOLOGY_EPS) s.cuts.push(Math.max(0, Math.min(1, t)));
  };
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i], b = segments[j], u = minus(a.b, a.a), v = minus(b.b, b.a), d = minus(b.a, a.a);
    const det = cross(u, v);
    if (Math.abs(det) > 1e-14 * Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)) {
      const t = cross(d, v) / det, q = cross(d, u) / det;
      if (t >= -TOPOLOGY_EPS && t <= 1 + TOPOLOGY_EPS && q >= -TOPOLOGY_EPS && q <= 1 + TOPOLOGY_EPS) { cut(a, t); cut(b, q); }
    } else {
      for (const p of [a.a, a.b]) cut(b, param(p, b.a, b.b));
      for (const p of [b.a, b.b]) cut(a, param(p, a.a, a.b));
    }
  }
  const nodes: TopologyNode[] = [], edges: TopologyEdge[] = [], edgeByPair = new Map<string, number>();
  const node = (p: Point) => {
    let i = nodes.findIndex(n => near(n, p));
    if (i < 0) { i = nodes.length; nodes.push({ ...p, endpoints: [], edges: [] }); }
    return i;
  };
  for (const s of segments) {
    const ids = s.cuts.sort((a, b) => a - b).map(t => node({ x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t }))
      .filter((n, i, all) => !i || n !== all[i - 1]);
    nodes[ids[0]].endpoints.push({ wallId: s.wall.id, end: "start" });
    nodes[ids.at(-1)!].endpoints.push({ wallId: s.wall.id, end: "end" });
    for (let i = 1; i < ids.length; i++) {
      const a = ids[i - 1], b = ids[i], key = [a, b].sort((x, y) => x - y).join(":");
      const existing = edgeByPair.get(key);
      if (existing !== undefined) { edges[existing].wallIds.push(s.wall.id); continue; }
      const id = edges.length; edges.push({ a, b, wallIds: [s.wall.id] }); edgeByPair.set(key, id);
      nodes[a].edges.push(id); nodes[b].edges.push(id);
    }
  }
  // Bridges cannot enclose area. Remove them from face walks, retaining them in
  // the public graph for junction/propagation consumers.
  const bridges = new Set<number>(), entered = new Map<number, number>(), low = new Map<number, number>();
  let clock = 0;
  const visit = (n: number, parent = -1) => {
    entered.set(n, ++clock); low.set(n, clock);
    for (const e of nodes[n].edges) {
      if (e === parent) continue;
      const other = edges[e].a === n ? edges[e].b : edges[e].a;
      if (!entered.has(other)) { visit(other, e); low.set(n, Math.min(low.get(n)!, low.get(other)!)); if (low.get(other)! > entered.get(n)!) bridges.add(e); }
      else low.set(n, Math.min(low.get(n)!, entered.get(other)!));
    }
  };
  nodes.forEach((_, n) => { if (!entered.has(n)) visit(n); });
  const adjacent = nodes.map((n, id) => n.edges.filter(e => !bridges.has(e)).map(e => ({ e, to: edges[e].a === id ? edges[e].b : edges[e].a }))
    .sort((a, b) => Math.atan2(nodes[a.to].y - n.y, nodes[a.to].x - n.x) - Math.atan2(nodes[b.to].y - n.y, nodes[b.to].x - n.x)));
  const used = new Set<string>();
  const loops: TopologyLoop[] = [];
  for (let start = 0; start < nodes.length; start++) for (const first of adjacent[start]) {
    if (used.has(`${start}:${first.to}`)) continue;
    const nodeIds: number[] = [], wallIds = new Set<string>();
    let from = start, to = first.to;
    for (let step = 0; step <= edges.length * 2; step++) {
      const key = `${from}:${to}`;
      if (used.has(key)) break;
      used.add(key); nodeIds.push(from);
      const around = adjacent[to], back = around.findIndex(n => n.to === from);
      edges[around[back].e].wallIds.forEach(id => wallIds.add(id));
      const next = around[(back - 1 + around.length) % around.length].to;
      from = to; to = next;
      if (from === start && to === first.to) {
        const polygon = nodeIds.map(id => ({ x: nodes[id].x, y: nodes[id].y }));
        const area = polygonArea(polygon);
        if (Math.abs(area) > 1e-14) loops.push({ polygon, area, wallIds: [...wallIds].sort(), nodeIds });
        break;
      }
    }
  }
  const positive = loops.filter(loop => loop.area > 0);
  const faces = positive.map(loop => ({ polygon: loop.polygon, holes: [] as Point[][], wallIds: [...loop.wallIds] }));
  // A disconnected enclosure inside a face is a hole in that face, and has
  // its own bounded faces. This avoids overlapping room areas.
  for (const outside of loops.filter(loop => loop.area < 0)) {
    const parent = positive.map((loop, i) => ({ loop, i })).filter(({ loop }) =>
      !loop.nodeIds.some(n => outside.nodeIds.includes(n)) && pointInPolygon(outside.polygon[0], loop.polygon))
      .sort((a, b) => a.loop.area - b.loop.area)[0];
    if (parent) { faces[parent.i].holes.push(outside.polygon); faces[parent.i].wallIds = [...new Set([...faces[parent.i].wallIds, ...outside.wallIds])].sort(); }
  }
  return { nodes, edges, faces };
}

const roomPolygon = (room: Room): Point[] | null => {
  const polygon = room.polygon && room.polygon.length >= 3 ? room.polygon : room.wallPolygon;
  return polygon && polygon.length >= 3 ? polygon : null;
};
const roomContains = (room: Room, p: Point) => {
  const polygon = roomPolygon(room);
  return !!polygon && pointInPolygon(p, polygon) && !(room.holes ?? []).some(hole => pointInPolygon(p, hole));
};
const polygonCentroid = (points: Point[]) => {
  const area = polygonArea(points);
  if (Math.abs(area) <= TOPOLOGY_EPS) {
    return points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }), { x: 0, y: 0 });
  }
  const sum = points.reduce((acc, p, i) => {
    const next = points[(i + 1) % points.length], factor = cross(p, next);
    return { x: acc.x + (p.x + next.x) * factor, y: acc.y + (p.y + next.y) * factor };
  }, { x: 0, y: 0 });
  return { x: sum.x / (6 * area), y: sum.y / (6 * area) };
};
/** A point strictly inside the face; concave and donut faces fall back to sampling. */
function interiorPoint(face: TopologyFace): Point {
  const { x, y, w, h } = polygonBounds(face.polygon);
  const inside = (p: Point) => pointInPolygon(p, face.polygon) && !face.holes.some(hole => pointInPolygon(p, hole));
  const candidates: Point[] = [{ x: x + w / 2, y: y + h / 2 }, polygonCentroid(face.polygon)];
  for (let i = 0; i < face.polygon.length; i++) {
    const a = face.polygon[i], b = face.polygon[(i + 1) % face.polygon.length];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    candidates.push({ x: mid.x - dy / length * INSIDE_EPS, y: mid.y + dx / length * INSIDE_EPS });
    candidates.push({ x: mid.x + dy / length * INSIDE_EPS, y: mid.y - dx / length * INSIDE_EPS });
  }
  for (const candidate of candidates) if (inside(candidate)) return candidate;
  for (let gx = 1; gx < 8; gx++) for (let gy = 1; gy < 8; gy++) {
    const sample = { x: x + w * gx / 8, y: y + h * gy / 8 };
    if (inside(sample)) return sample;
  }
  return { x: x + w / 2, y: y + h / 2 };
}
const ringSamples = (points: Point[]) => {
  const samples = [...points];
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    samples.push({ x: (points[i].x + next.x) / 2, y: (points[i].y + next.y) / 2 });
  }
  samples.push(polygonCentroid(points));
  return samples;
};
const ringSimilarity = (a: Point[], b: Point[]) => {
  const ratio = (from: Point[], to: Point[]) => ringSamples(from).filter(p => pointInPolygon(p, to)).length / ringSamples(from).length;
  return Math.min(ratio(a, b), ratio(b, a));
};
/**
 * Rooms are matched to faces by boundary identity first, then by position, then by
 * overlap, so names and materials survive edits that move or split walls.
 */
const matchRoom = (face: TopologyFace, center: Point, unused: Room[]): Room | undefined => {
  const signature = face.wallIds.join("|");
  const byWalls = unused.find(room => room.topologyWallIds?.join("|") === signature);
  if (byWalls) return byWalls;
  const byPosition = unused.filter(room => roomContains(room, center));
  if (byPosition.length) return byPosition[0];
  const bounds = polygonBounds(face.polygon);
  const overlapping = unused.filter(room => {
    const polygon = roomPolygon(room);
    if (!polygon) return false;
    const other = polygonBounds(polygon);
    return other.x < bounds.x + bounds.w && bounds.x < other.x + other.w && other.y < bounds.y + bounds.h && bounds.y < other.y + other.h;
  });
  return overlapping.map(room => ({ room, score: ringSimilarity(face.polygon, roomPolygon(room)!) }))
    .filter(candidate => candidate.score >= 0.5)
    .sort((a, b) => b.score - a.score)[0]?.room;
};

/**
 * Every enclosed wall region becomes a room, whatever its shape. Boundaries always
 * come from the current walls; stored names, materials and 3D settings are kept.
 */
export function deriveRooms(walls: Wall[], previous: Room[], height = 2.8): Room[] {
  const faces = buildWallTopology(walls).faces;
  const unused = [...previous];
  const reserved = new Set(previous.map(r => r.id));
  return faces.map((face, i) => {
    const { x, y, w, h } = polygonBounds(face.polygon);
    const center = interiorPoint(face);
    const old = matchRoom(face, center, unused);
    if (old) unused.splice(unused.indexOf(old), 1);
    let id = old?.id ?? `room-topology-${i + 1}`;
    if (!old) { let suffix = i + 1; while (reserved.has(id)) id = `room-topology-${++suffix}`; reserved.add(id); }
    return { ...old, id, name: old?.name ?? `Room ${i + 1}`, confidence: old?.confidence ?? "high", wallHeight: old?.wallHeight ?? height,
      width: w, height: h, bbox: { x, y, w, h }, center, polygon: face.polygon, wallPolygon: face.polygon,
      holes: face.holes, topologyWallIds: face.wallIds, areaSqm: undefined };
  });
}
