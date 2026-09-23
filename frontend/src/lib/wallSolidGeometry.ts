import { BufferGeometry, Float32BufferAttribute } from "three";
import type { DetectedWallSegment } from "@/types/detection";

type Point = { x: number; z: number };
export interface WallSolid { tStart: number; tEnd: number; yStart: number; yEnd: number }
export interface WallSolidInput {
    wall: DetectedWallSegment;
    thickness: number;
    solids: WallSolid[];
}
export interface WallPrism { wallId: string; polygon: Point[]; yStart: number; yEnd: number }
const EPS = 1e-9;
const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
// Translate to the first vertex so collinear clipping remnants have zero area
// rather than gaining spurious area from cancellation of world coordinates.
const area = (points: Point[]) => points.slice(1, -1).reduce((sum, p, i) =>
    sum + cross(points[0], p, points[i + 2]), 0) / 2;
const usable = (points: Point[]) => points.length >= 3 && Math.abs(area(points)) > EPS * EPS;

function cleanPolygon(points: Point[]): Point[] {
    const result = points.filter((p, i) => Math.hypot(p.x - points[(i + points.length - 1) % points.length].x,
        p.z - points[(i + points.length - 1) % points.length].z) > EPS);
    return result.filter((p, i) => {
        const a = result[(i + result.length - 1) % result.length], b = result[(i + 1) % result.length];
        return Math.abs(cross(a, p, b)) > EPS * Math.hypot(b.x - a.x, b.z - a.z);
    });
}

function clip(polygon: Point[], a: Point, b: Point, inside: boolean): Point[] {
    const tolerance = EPS * Math.hypot(b.x - a.x, b.z - a.z);
    if (tolerance <= EPS * EPS) return inside ? polygon : [];
    const result: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i], q = polygon[(i + 1) % polygon.length];
        const rawP = cross(a, b, p), rawQ = cross(a, b, q);
        const dp = Math.abs(rawP) <= tolerance ? 0 : rawP, dq = Math.abs(rawQ) <= tolerance ? 0 : rawQ;
        const pin = inside ? dp >= 0 : dp <= 0, qin = inside ? dq >= 0 : dq <= 0;
        if (pin) result.push(p);
        if (pin !== qin) {
            const t = dp / (dp - dq);
            result.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
        }
    }
    return cleanPolygon(result);
}

// Convex subtraction partitions the difference into disjoint convex polygons.
function subtract(polygon: Point[], cutter: Point[]): Point[][] {
    if (Math.max(...polygon.map(p => p.x)) <= Math.min(...cutter.map(p => p.x)) ||
        Math.min(...polygon.map(p => p.x)) >= Math.max(...cutter.map(p => p.x)) ||
        Math.max(...polygon.map(p => p.z)) <= Math.min(...cutter.map(p => p.z)) ||
        Math.min(...polygon.map(p => p.z)) >= Math.max(...cutter.map(p => p.z))) return [polygon];
    const pieces: Point[][] = [];
    let remaining = polygon;
    for (let i = 0; i < cutter.length && usable(remaining); i++) {
        const a = cutter[i], b = cutter[(i + 1) % cutter.length];
        const outside = clip(remaining, a, b, false);
        if (usable(outside)) pieces.push(outside);
        remaining = clip(remaining, a, b, true);
    }
    return pieces;
}

export function wallFrame(wall: DetectedWallSegment, pw: number, ph: number) {
    const a = { x: wall.x1 * pw - pw / 2, z: wall.y1 * ph - ph / 2 };
    const b = { x: wall.x2 * pw - pw / 2, z: wall.y2 * ph - ph / 2 };
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const ux = (b.x - a.x) / (length || 1), uz = (b.z - a.z) / (length || 1);
    return { a, b, length, ux, uz, cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2 };
}

type Frame = ReturnType<typeof wallFrame>;
type Entry = { input: WallSolidInput; frame: Frame; rank: number };
type Span = { start: number; end: number };
type Arm = { entry: Entry; direction: Point; reach: number; half: number; terminal: boolean };
const dot = (a: Point, b: Point) => a.x * b.x + a.z * b.z;
const offset = (p: Point, d: Point, t: number): Point => ({ x: p.x + d.x * t, z: p.z + d.z * t });
const delta = (a: Point, b: Point): Point => ({ x: a.x - b.x, z: a.z - b.z });
const normal = (d: Point): Point => ({ x: -d.z, z: d.x });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
const pointOrder = (a: Point, b: Point) => a.x - b.x || a.z - b.z;
const axisAngle = (f: Frame) => (Math.atan2(f.uz, f.ux) + Math.PI) % Math.PI;

function intersection(polygon: Point[], cutter: Point[]): Point[] {
    let result = polygon;
    for (let i = 0; i < cutter.length && usable(result); i++) result = clip(result, cutter[i], cutter[(i + 1) % cutter.length], true);
    return usable(result) ? result : [];
}
function difference(polygons: Point[][], cutters: Point[][]): Point[][] {
    return cutters.reduce((pieces, cutter) => pieces.flatMap(p => subtract(p, cutter)), polygons);
}
function union(polygons: Point[][]): Point[][] {
    const result: Point[][] = [];
    for (const p of polygons.filter(usable)) result.push(...difference([p], result));
    return result;
}
function halfPlane(p: Point[], origin: Point, direction: Point, amount: number, positive = true): Point[] {
    const a = offset(origin, direction, amount), b = { x: a.x + direction.z, z: a.z - direction.x };
    return clip(p, a, b, positive);
}
function hull(points: Point[], tolerance: number): Point[] {
    const sorted = [...points].sort(pointOrder).filter((p, i, all) => !i || distance(p, all[i - 1]) > tolerance);
    if (sorted.length < 3) return [];
    const chain = (list: Point[]) => {
        const result: Point[] = [];
        for (const p of list) {
            while (result.length > 1 && cross(result[result.length - 2], result[result.length - 1], p) <= 0) result.pop();
            result.push(p);
        }
        return result.slice(0, -1);
    };
    return [...chain(sorted), ...chain([...sorted].reverse())];
}
function rectangle(a: Point, b: Point, direction: Point, half: number): Point[] {
    const n = normal(direction);
    return [offset(a, n, -half), offset(b, n, -half), offset(b, n, half), offset(a, n, half)];
}
function spansFor(entry: Entry, lo: number, hi: number, tolerance: number): Span[] {
    const spans = entry.input.solids.filter(s => [s.tStart, s.tEnd, s.yStart, s.yEnd].every(Number.isFinite)
        && s.yStart <= lo && s.yEnd >= hi && s.tEnd > s.tStart)
        .map(s => ({ start: Math.max(0, s.tStart), end: Math.min(entry.frame.length, s.tEnd) }))
        .filter(s => s.end - s.start > tolerance).sort((a, b) => a.start - b.start);
    const result: Span[] = [];
    for (const s of spans) {
        const prev = result.at(-1);
        if (prev && s.start <= prev.end + tolerance) prev.end = Math.max(prev.end, s.end);
        else result.push({ ...s });
    }
    return result;
}

/** Derived mesh cells only. Build the finished union BEFORE assigning per-wall ownership. */
export function buildWallPrisms(inputs: WallSolidInput[], pw: number, ph: number): WallPrism[] {
    const tolerance = EPS * Math.max(1, Math.abs(pw), Math.abs(ph));
    const ordered: Entry[] = inputs.map(input => ({ input, frame: wallFrame(input.wall, pw, ph), rank: 0 }))
        .filter(e => Number.isFinite(e.frame.length) && e.frame.length > tolerance && Number.isFinite(e.input.thickness) && e.input.thickness > 0)
        .sort((a, b) => {
            const ap = [a.frame.a, a.frame.b].sort(pointOrder), bp = [b.frame.a, b.frame.b].sort(pointOrder);
            // Geometry controls ownership; IDs only break genuinely coincident geometry ties.
            return b.input.thickness - a.input.thickness || axisAngle(b.frame) - axisAngle(a.frame)
                || pointOrder(ap[0], bp[0]) || pointOrder(ap[1], bp[1]) || a.input.wall.id.localeCompare(b.input.wall.id);
        });
    ordered.forEach((e, i) => e.rank = i);
    const nodes: Point[] = [];
    for (const point of ordered.flatMap(e => [e.frame.a, e.frame.b]).sort(pointOrder)) {
        if (!nodes.some(p => distance(p, point) <= tolerance)) nodes.push(point);
    }
    const heights = [...new Set(ordered.flatMap(e => e.input.solids.flatMap(s =>
        [s.tStart, s.tEnd, s.yStart, s.yEnd].every(Number.isFinite) && s.tEnd > s.tStart && s.yEnd > s.yStart ? [s.yStart, s.yEnd] : [])))].sort((a, b) => a - b);
    const result: WallPrism[] = [];
    for (let band = 1; band < heights.length; band++) {
        const yStart = heights[band - 1], yEnd = heights[band];
        const spans = new Map(ordered.map(e => [e, spansFor(e, yStart, yEnd, tolerance)]));
        const shapes = new Map<Entry, Point[][]>();
        const extensions = new Map<Entry, Point[][]>(ordered.map(e => [e, []]));
        const patches: { polygon: Point[]; members: Entry[] }[] = [];
        for (const entry of ordered) {
            const { a, b, ux, uz, length } = entry.frame, d = { x: ux, z: uz };
            const at = (t: number) => t <= tolerance ? a : Math.abs(t - length) <= tolerance ? b : offset(a, d, t);
            shapes.set(entry, spans.get(entry)!.map(s => rectangle(at(s.start), at(s.end), d, entry.input.thickness / 2)));
        }
        for (const point of nodes) {
            const arms: Arm[] = [];
            for (const entry of ordered) {
                const { a, b, ux, uz, length } = entry.frame, d = { x: ux, z: uz }, v = delta(point, a);
                const t = dot(v, d);
                if (t < -tolerance || t > length + tolerance || Math.abs(dot(v, normal(d))) > tolerance) continue;
                const s = spans.get(entry)!.find(s => t >= s.start - tolerance && t <= s.end + tolerance);
                if (!s) continue;
                const terminal = distance(point, a) <= tolerance || distance(point, b) <= tolerance;
                if (t - s.start > tolerance) arms.push({ entry, direction: { x: -ux, z: -uz }, reach: t - s.start, half: entry.input.thickness / 2, terminal });
                if (s.end - t > tolerance) arms.push({ entry, direction: d, reach: s.end - t, half: entry.input.thickness / 2, terminal });
            }
            if (new Set(arms.map(a => a.entry)).size < 2) continue;
            const opposite = (a: Arm, b: Arm) => dot(a.direction, b.direction) < -1 + EPS;
            const continuing = arms.filter(a => arms.some(b => opposite(a, b)));
            if (continuing.length) {
                // A through axis owns its existing envelope. Clip each terminating branch
                // to the receiving face, separately on each side of a thickness shoulder.
                const host = [...continuing].sort((a, b) => a.entry.rank - b.entry.rank)[0];
                const hostArms = [host, continuing.filter(a => opposite(host, a)).sort((a, b) => a.entry.rank - b.entry.rank)[0]];
                for (const branch of arms.filter(a => !continuing.includes(a) && a.terminal)) {
                    let polygons = shapes.get(branch.entry)!;
                    let n = normal(host.direction);
                    if (dot(n, branch.direction) < 0) n = { x: -n.x, z: -n.z };
                    for (const side of hostArms) {
                        polygons = polygons.flatMap(p => {
                            const negative = halfPlane(p, point, side.direction, 0, false);
                            const positive = halfPlane(p, point, side.direction, 0);
                            const beyond = halfPlane(positive, point, side.direction, side.reach);
                            const within = halfPlane(positive, point, side.direction, side.reach, false);
                            const received = halfPlane(within, point, n, side.half);
                            return [negative, beyond, received].filter(usable);
                        });
                    }
                    shapes.set(branch.entry, polygons);
                }
                continue;
            }
            // No through axis: complete each exterior sector of the incident rays.
            // Collinear equal-direction rays share a cap; they do not create a corner.
            const rays = arms.filter((a, i) => !arms.some((b, j) => j < i && dot(a.direction, b.direction) > 1 - EPS))
                .sort((a, b) => Math.atan2(a.direction.z, a.direction.x) - Math.atan2(b.direction.z, b.direction.x));
            if (rays.length < 2) continue;
            const radius = 4 * Math.max(...rays.map(a => a.half));
            for (let i = 0; i < rays.length; i++) {
                const a = rays[i], b = rays[(i + 1) % rays.length];
                const gap = (Math.atan2(b.direction.z, b.direction.x) - Math.atan2(a.direction.z, a.direction.x) + Math.PI * 2) % (Math.PI * 2);
                if (gap <= Math.PI + EPS || !a.terminal || !b.terminal) continue;
                const pa = offset(point, normal(a.direction), a.half), pb = offset(point, normal(b.direction), -b.half);
                const determinant = a.direction.x * b.direction.z - a.direction.z * b.direction.x;
                const v = delta(pb, pa);
                const t = (v.x * b.direction.z - v.z * b.direction.x) / determinant;
                const miter = offset(pa, a.direction, t);
                // Bounded bevel for acute angles; never extrapolate an arbitrarily long spike.
                const limit = Math.min(radius, a.reach, b.reach);
                const polygon = hull([point, pa, pb, ...(Number.isFinite(t) && distance(point, miter) <= limit + tolerance ? [miter] : [])], tolerance);
                if (usable(polygon)) patches.push({ polygon, members: [a.entry, b.entry] });
            }
            for (const arm of arms.filter(a => a.terminal)) {
                extensions.get(arm.entry)!.push(rectangle(offset(point, arm.direction, -radius), point, arm.direction, arm.half));
            }
        }
        // First establish a single occupied envelope, independent of who will own it.
        const envelope = union([...ordered.flatMap(e => shapes.get(e)!), ...patches.map(p => p.polygon)]);
        let remaining = envelope;
        for (const entry of ordered) {
            const candidate = union([...shapes.get(entry)!, ...extensions.get(entry)!,
                ...patches.filter(p => [...p.members].sort((a, b) => a.rank - b.rank)[0] === entry).map(p => p.polygon)]);
            for (const cutter of candidate) {
                for (const p of remaining) {
                    const polygon = intersection(p, cutter);
                    if (usable(polygon)) result.push({ wallId: entry.input.wall.id, polygon, yStart, yEnd });
                }
                remaining = difference(remaining, [cutter]);
            }
        }
    }
    return result;
}

type Vertex = { x: number; y: number; z: number };
type Face = { wallId: string; points: Vertex[] };

function exposedEdge(a: Point, b: Point, neighbors: Point[][], tolerance: number): [number, number][] {
    const d = delta(b, a), length = Math.hypot(d.x, d.z);
    if (length <= tolerance) return [];
    const outward = { x: d.z / length, z: -d.x / length };
    const hidden: [number, number][] = [];
    for (const polygon of neighbors) {
        let lo = 0, hi = 1;
        for (let i = 0; i < polygon.length && hi > lo; i++) {
            const p = polygon[i], q = polygon[(i + 1) % polygon.length];
            const edgeLength = distance(p, q);
            if (edgeLength <= tolerance) continue;
            const rawA = cross(p, q, a) / edgeLength, rawB = cross(p, q, b) / edgeLength;
            const da = Math.abs(rawA) <= tolerance ? 0 : rawA, db = Math.abs(rawB) <= tolerance ? 0 : rawB;
            const slope = db - da;
            if (Math.abs(slope) <= tolerance) { if (da < -tolerance) hi = lo; }
            else if (slope > 0) lo = Math.max(lo, -da / slope);
            else hi = Math.min(hi, -da / slope);
        }
        if (hi - lo <= tolerance / length) continue;
        const probe = offset(offset(a, d, (lo + hi) / 2), outward, tolerance * 4);
        if (polygon.every((p, i) => cross(p, polygon[(i + 1) % polygon.length], probe) >= -tolerance * distance(p, polygon[(i + 1) % polygon.length]) / 4)) {
            hidden.push([Math.max(0, lo), Math.min(1, hi)]);
        }
    }
    hidden.sort((a, b) => a[0] - b[0]);
    const exposed: [number, number][] = [];
    let cursor = 0;
    for (const [lo, hi] of hidden) {
        if (lo > cursor + tolerance / length) exposed.push([cursor, lo]);
        cursor = Math.max(cursor, hi);
    }
    if (cursor < 1 - tolerance / length) exposed.push([cursor, 1]);
    return exposed;
}

/** Only exposed surfaces are emitted. Contacts between walls remain ownership seams,
 * not duplicate buried faces. Coordinates stay local to the original wall frame. */
export function buildWallSolidGeometries(inputs: WallSolidInput[], pw: number, ph: number): Map<string, BufferGeometry> {
    const cells = buildWallPrisms(inputs, pw, ph);
    const tolerance = EPS * Math.max(1, Math.abs(pw), Math.abs(ph));
    const faces: Face[] = [];
    const vertex = (p: Point, y: number): Vertex => ({ x: p.x, y, z: p.z });
    for (const cell of cells) {
        const peers = cells.filter(c => c !== cell && c.yStart === cell.yStart && c.yEnd === cell.yEnd).map(c => c.polygon);
        for (const [height, top] of [[cell.yStart, false], [cell.yEnd, true]] as const) {
            const adjacent = cells.filter(c => top ? c.yStart === height : c.yEnd === height).map(c => c.polygon);
            for (const p of difference([cell.polygon], adjacent)) {
                faces.push({ wallId: cell.wallId, points: (top ? [...p].reverse() : p).map(p => vertex(p, height)) });
            }
        }
        for (let i = 0; i < cell.polygon.length; i++) {
            const a = cell.polygon[i], b = cell.polygon[(i + 1) % cell.polygon.length], d = delta(b, a);
            for (const [lo, hi] of exposedEdge(a, b, peers, tolerance)) {
                const p = offset(a, d, lo), q = offset(a, d, hi);
                faces.push({ wallId: cell.wallId, points: [vertex(p, cell.yStart), vertex(p, cell.yEnd), vertex(q, cell.yEnd), vertex(q, cell.yStart)] });
            }
        }
    }
    // Make adjacent face triangulations conform at all T vertices. EdgesGeometry can
    // then discard coplanar subdivision edges, including unrelated height-band cuts.
    const points = new Map<string, Vertex>();
    for (const face of faces) face.points = face.points.map(p => {
        const v = { x: Math.round(p.x / tolerance) * tolerance, y: Math.round(p.y / tolerance) * tolerance, z: Math.round(p.z / tolerance) * tolerance };
        const key = `${v.x},${v.y},${v.z}`;
        if (!points.has(key)) points.set(key, v);
        return points.get(key)!;
    });
    const all = [...points.values()];
    const output = new Map(inputs.map(({ wall }) => [wall.id, { positions: [] as number[], uvs: [] as number[], frame: wallFrame(wall, pw, ph) }]));
    for (const face of faces) {
        const boundary: Vertex[] = [];
        for (let i = 0; i < face.points.length; i++) {
            const a = face.points[i], b = face.points[(i + 1) % face.points.length];
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l2 = dx * dx + dy * dy + dz * dz;
            if (l2 <= tolerance * tolerance) continue;
            const splits = all.map(p => ({ p, t: ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2 }))
                .filter(({ p, t }) => t >= 0 && t < 1 && Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy, p.z - a.z - t * dz) <= tolerance / 2)
                .sort((a, b) => a.t - b.t);
            boundary.push(...splits.map(s => s.p));
        }
        if (boundary.length < 3) continue;
        const center = boundary.reduce((a, p) => ({ x: a.x + p.x / boundary.length, y: a.y + p.y / boundary.length, z: a.z + p.z / boundary.length }), { x: 0, y: 0, z: 0 });
        const target = output.get(face.wallId)!;
        const add = (p: Vertex) => {
            const f = target.frame, dx = p.x - f.cx, dz = p.z - f.cz;
            const x = dx * f.ux + dz * f.uz, z = -dx * f.uz + dz * f.ux;
            target.positions.push(x, p.y, z); target.uvs.push(x, p.y + z);
        };
        for (let i = 0; i < boundary.length; i++) {
            const a = boundary[i], b = boundary[(i + 1) % boundary.length];
            if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= tolerance) continue;
            add(center); add(a); add(b);
        }
    }
    return new Map([...output].map(([id, { positions, uvs }]) => {
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
        geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
        geometry.computeVertexNormals();
        return [id, geometry];
    }));
}
