import { openingGeometry, materializeOpening } from "./openingModel";
import { isCalibrationDimension, preservesConfirmedDimensions, type ConfirmedDimension } from "./confirmedDimensions";
import type { Room, NormalizedPoint, BBox } from "@/types/floorplan";
import type { DetectedWallSegment as Wall, DetectedDoor, DetectedWindow } from "@/types/detection";
import { resolveOpeningWall } from "./openingAttachment";
import { projectOpeningEdgesOntoWall } from "./wallRenderGeometry";
import { deriveRooms, resolveWallGraph, type LogicalSegment, type WallGraph, type WallSegmentation } from "./wallTopology";

export interface GeometrySnapshot { confirmedDimensions?: ConfirmedDimension[]; walls: Wall[]; doors: DetectedDoor[]; windows: DetectedWindow[]; rooms: Room[];
  /** The shared graph for `walls`. Passed in so no path rebuilds its own topology. */
  graph?: WallGraph }
export type Anchor = "start" | "end";
export interface DimensionSpan { start: NormalizedPoint; end: NormalizedPoint }
/** A length request names a physical wall plus, optionally, the logical segment on it
 * being reshaped. Whole-wall, segment and room-boundary edits are the same model. */
export interface LengthRequest { wallId: string; length: number; anchor: Anchor; span?: DimensionSpan; segmentKey?: string; target?: NormalizedPoint; confirm?: boolean; automatic?: boolean; endpoint?: boolean }
export type LengthCandidate = { ok: true; geometry: GeometrySnapshot; changedWallIds: string[]; displacement: number }
  | { ok: false; reason: string };
type P = { x: number; y: number };
type Segment = { a: P; b: P };
const EPS = 1e-7;
/** Internal-only scale so an uncalibrated plan still has consistent metric math.
 * Wall coordinates are normalized, so any consistent positive scale yields the
 * same topology; this value never reaches a displayed measurement. */
const UNCALIBRATED_SCALE = 1000;
export const planMetricScale = (pw: number, ph: number) => {
    const calibrated = [pw, ph].every(n => Number.isFinite(n) && n > 0);
    return { pw: calibrated ? pw : UNCALIBRATED_SCALE, ph: calibrated ? ph : UNCALIBRATED_SCALE, calibrated };
};
/** Orientation classes. A wall is axis-aligned only when its own endpoints are
 * exactly axis-aligned, so there is no tolerance band and no cliff: a 3 degree
 * wall and a 7 degree wall are both "free" and behave identically. */
export type WallKind = "h" | "v" | "free";
const KIND_TOLERANCE = 1e-6;
export const wallKind = (wall: Wall): WallKind => {
    if (Math.abs(wall.y1 - wall.y2) <= KIND_TOLERANCE && Math.abs(wall.x2 - wall.x1) > KIND_TOLERANCE) return "h";
    if (Math.abs(wall.x1 - wall.x2) <= KIND_TOLERANCE && Math.abs(wall.y2 - wall.y1) > KIND_TOLERANCE) return "v";
    return "free";
};
/** Drop a dragged endpoint's component across its wall's axis so an existing
 * horizontal wall stays horizontal and a vertical wall stays vertical. Genuine
 * diagonal walls follow the pointer exactly. Preview and commit both call this,
 * so they can never disagree. */
export const projectDragPoint = (wall: Wall, point: P) => {
    const kind = wallKind(wall);
    if (kind === "h") return { x: point.x, y: wall.y1 };
    if (kind === "v") return { x: wall.x1, y: point.y };
    return { x: point.x, y: point.y };
};
const alongAxis = (kind: WallKind, d: P) => kind === "h" ? Math.abs(d.y) <= EPS : kind === "v" ? Math.abs(d.x) <= EPS : false;
export const wallIntendedAxis = (wall: Wall) => wallKind(wall) === "free" ? null : wallKind(wall);
const length = (s: Segment) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
const box = (s: Segment): BBox => ({ x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), w: Math.abs(s.b.x - s.a.x), h: Math.abs(s.b.y - s.a.y) });
const overlaps = (a: BBox, b: BBox) => a.x <= b.x + b.w + EPS && b.x <= a.x + a.w + EPS && a.y <= b.y + b.h + EPS && b.y <= a.y + a.h + EPS;
const on = (p: P, s: Segment) => Math.abs((s.b.x - s.a.x) * (p.y - s.a.y) - (s.b.y - s.a.y) * (p.x - s.a.x)) <= EPS * Math.max(1, length(s))
    && overlaps({ ...p, w: 0, h: 0 }, box(s));
/** Strictly between the endpoints, so a wall's own ends are not interior to it. */
const inside = (p: P, s: Segment) => on(p, s) && !samePoint(p, s.a) && !samePoint(p, s.b);
const samePoint = (a: P, b: P) => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;
/** Two walls meet when an endpoint of one lies on the other. */
const joined = (a: Segment, b: Segment) => [a.a, a.b].some(p => on(p, b)) || [b.a, b.b].some(p => on(p, a));
/** Passing clean through the middle of both, which no junction can record. */
const crossed = (a: Segment, b: Segment) => intersects(a, b) && !joined(a, b);
const cross = (a: P, b: P, p: P) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const intersects = (s: Segment, t: Segment) => {
    if (!overlaps(box(s), box(t))) return false;
    const tolerance = EPS * Math.max(1, length(s), length(t)) ** 2;
    return cross(s.a, s.b, t.a) * cross(s.a, s.b, t.b) <= tolerance
        && cross(t.a, t.b, s.a) * cross(t.a, t.b, s.b) <= tolerance;
};
const sweptIntersection = (before: Segment, after: Segment, other: Segment) => {
    const points = [before.a, before.b, after.a, after.b].sort((a, b) => a.x - b.x || a.y - b.y)
        .filter((p, i, all) => !i || !samePoint(p, all[i - 1]));
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
const segmentsOf = (walls: Wall[]): Segment[] => walls.map(w => ({ a: { x: w.x1, y: w.y1 }, b: { x: w.x2, y: w.y2 } }));

/** The shared junction/segment topology every edit runs through. A physical wall is
 * one chain of logical segments; a junction is one node shared by the chains that
 * meet there, so a T is an interior node of its host and a chain end of its stub.
 * Building this never splits or mutates a stored wall, which is what keeps 3D,
 * thickness, materials and openings on the one continuous physical wall. */
interface Chain { index: number; kind: WallKind; nodes: number[]; segments: LogicalSegment[] }
interface Graph { topology: WallGraph["topology"]; segmentation: WallSegmentation; chains: Map<string, Chain> }
/** The chains of the shared graph. The topology is never rebuilt here: it is the same
 * graph that owns rooms and room boundaries, so an edit can never see a different
 * junction than the one the user is looking at. */
function buildGraph(walls: Wall[], graph: WallGraph): Graph {
    const chains = new Map<string, Chain>();
    for (const [index, wall] of walls.entries()) {
        const segments = graph.segmentation.byWall.get(wall.id);
        if (!segments?.length) continue;
        chains.set(wall.id, { index, kind: wallKind(wall), segments,
            nodes: segments.flatMap((segment, i) => i ? [segment.nodeB] : [segment.nodeA, segment.nodeB]) });
    }
    return { topology: graph.topology, segmentation: graph.segmentation, chains };
}

/** Where every junction ended up. All moved nodes share one displacement, so a wall
 * whose nodes all moved is a rigid translation and a wall with one moved node has
 * resized. Nothing is dragged along "in proportion": a junction the edit did not
 * touch stays exactly where it is, which is what keeps a confirmed span's endpoints
 * pinned for free.
 *
 * The rules, in one place, so the four intents cannot drift apart:
 * - A wall containing the anchor never moves. The anchor is what the user held still,
 *   so no neighbour may carry it away.
 * - A wall entered at one of its own ends follows only when the displacement crosses
 *   its axis. When the displacement runs along that axis the wall keeps its far end,
 *   which is how a split wall line slides its junction and how a parallel neighbour
 *   resizes instead of shearing.
 * - A wall entered at an interior node (a T) follows only when that node is the one
 *   being driven, so a stub never deforms an undisturbed host.
 * - `frozen` names walls that could not follow without breaking geometry. They keep
 *   their own coordinates, so the junction they shared simply ends.
 *
 * Iteration is ordered by wall id, so the same plan always resolves the same way and
 * a reordered wall array cannot change the result. */
interface Displacement { position: (nodeId: number) => P; moved: number[]; disconnected: string[] }
function resolveDisplacement(graph: Graph, edited: string, reshapes: boolean, root: number, target: P, anchor: number): Displacement {
    const node = (id: number): P => ({ x: graph.topology.nodes[id].x, y: graph.topology.nodes[id].y });
    const at = new Map<number, P>([[root, target]]);
    // An axis wall being resized is reshaping its own junction, so a wall that
    // meets one there keeps hold of it. A diagonal is never rotated or
    // straightened, so it simply ends where its length says and a host it no
    // longer reaches is left alone.
    const junction = new Set(reshapes ? [root] : []);
    const decided = new Set<string>([edited]);
    const disconnected: string[] = [];
    const chains = [...graph.chains].sort((a, b) => a[0].localeCompare(b[0]));
    const queue = [...at.keys()];
    for (let head = 0; head < queue.length; head++) {
        const id = queue[head];
        for (const [wallId, chain] of chains) {
            if (decided.has(wallId)) continue;
            const at_ = chain.nodes.indexOf(id);
            if (at_ < 0) continue;
            const end = at_ === 0 || at_ === chain.nodes.length - 1;
            // A node in this wall's interior is a T on a host, and a host is never
            // dragged by a stub that is only passing through it.
            if (!end && !junction.has(id)) continue;
            const before = node(id), after = at.get(id) ?? before;
            const d = { x: after.x - before.x, y: after.y - before.y };
            if (Math.hypot(d.x, d.y) <= EPS) continue;
            decided.add(wallId);
            if (chain.nodes.includes(anchor)) { disconnected.push(wallId); continue; }
            // A wall parallel to the movement keeps its far end: the junction slides.
            // Disconnect only when that resize would collapse or reverse the follower.
            if (end && alongAxis(chain.kind, d)) {
                const far = node(chain.nodes[at_ === 0 ? chain.nodes.length - 1 : 0]);
                const candidate = at_ === 0 ? { a: after, b: far } : { a: far, b: after };
                const original = { a: node(chain.nodes[0]), b: node(chain.nodes[chain.nodes.length - 1]) };
                const dot = (candidate.b.x - candidate.a.x) * (original.b.x - original.a.x)
                    + (candidate.b.y - candidate.a.y) * (original.b.y - original.a.y);
                if (length(candidate) <= EPS || dot <= EPS * EPS) disconnected.push(wallId);
                continue;
            }
            if (!end && alongAxis(chain.kind, d)) continue;
            const far = node(chain.nodes[at_ === 0 ? chain.nodes.length - 1 : 0]);
            const candidate = at_ === 0 ? { a: after, b: far } : { a: far, b: after };
            const candidateOverlapsUnchanged = [...graph.chains].some(([otherId, other]) => {
                if (otherId === wallId || otherId === edited) return false;
                const otherSegment = { a: node(other.nodes[0]), b: node(other.nodes[other.nodes.length - 1]) };
                return overlapLength(candidate, otherSegment) > EPS && overlapLength(
                    { a: node(chain.nodes[0]), b: node(chain.nodes[chain.nodes.length - 1]) }, otherSegment) <= EPS;
            });
            if (candidateOverlapsUnchanged) { disconnected.push(wallId); continue; }
            for (const other of chain.nodes) {
                // Every node of a travelling wall moves by the same vector from its
                // own start, so the driven node lands exactly on the target it was
                // already given rather than being shifted twice.
                at.set(other, { x: node(other).x + d.x, y: node(other).y + d.y });
                if (!queue.includes(other)) queue.push(other);
            }
        }
    }
    return { position: id => at.get(id) ?? node(id), moved: [...at.keys()], disconnected };
}

/** Every wall that breaks geometry once the whole displacement has settled, in one pass.
 * Collapse, reversal, newly overlapped segments and a genuine through-crossing are
 * failures; landing an endpoint on a wall is a connection, and a junction that ends
 * up no longer shared is a disconnect, which this model allows.
 *
 * `edited` names the wall the user actually asked to move. A problem that belongs to
 * some *other* wall is reported as that wall's `culprit` instead: a neighbour that
 * cannot follow the edit is not a reason to refuse the user's own wall, it just stops
 * being connected to it.
 *
 * `order` is the wall index order used to pick the culprit, and it is sorted by wall
 * id, so the same plan reports the same culprit however the walls happen to be
 * stored. */
interface Invalid { reason: string; culprit: number; culprits: number[] }
const wallOrder = (walls: { id: string }[]) => walls.map((wall, index) => ({ wall, index }))
    .sort((a, b) => a.wall.id.localeCompare(b.wall.id)).map(entry => entry.index);
function validate(final: Segment[], original: Segment[], kinds: WallKind[], changed: boolean[], order: number[], edited = -1, disconnected = new Set<number>()): Invalid | null {
    const problems: { reason: string; culprits: number[] }[] = [];
    const report = (reason: string, ...culprits: number[]) => problems.push({ reason, culprits: culprits.filter(index => index >= 0) });
    for (const i of order) {
        if (!changed[i]) continue;
        if (length(final[i]) <= EPS) { report("That would collapse a wall.", i); continue; }
        const dot = (final[i].b.x - final[i].a.x) * (original[i].b.x - original[i].a.x) + (final[i].b.y - final[i].a.y) * (original[i].b.y - original[i].a.y);
        if (dot <= EPS * EPS) { report("That would collapse or reverse a wall.", i); continue; }
        if (kinds[i] !== "free" && !alongAxis(kinds[i], { x: final[i].b.x - final[i].a.x, y: final[i].b.y - final[i].a.y }))
            report("That would turn a straight wall into a diagonal.", i);
    }
    for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) {
        const i = order[a], j = order[b];
        const pair = (reason: string) => report(reason, changed[i] ? i : j, changed[i] ? j : i);
        if (overlapLength(final[i], final[j]) > EPS && overlapLength(original[i], original[j]) <= EPS) {
            pair("Overlapping wall segments make this edit ambiguous."); continue;
        }
        // A crossing that lands as a shared point is a junction, whether it is new
        // or kept. Only a wall passing clean through another leaves nothing to
        // record, and one that already crossed before this edit is not its fault.
        if (crossed(final[i], final[j]) && !crossed(original[i], original[j])) pair("This adjustment would cross a wall it met. Try a smaller length.");
    }
    const first = problems[0];
    if (!first) return null;
    const culprit = first.culprits.find(index => index === edited) ?? first.culprits[0];
    return { reason: first.reason, culprit, culprits: problems.flatMap(problem => problem.culprits) };
}

/** Openings belong to a host wall, never to a junction, so a host that translates
 * carries its doors and windows and a host that resizes keeps their offsets. */
function remapOpenings(source: GeometrySnapshot, nextWalls: Wall[], original: Segment[], final: Segment[], changed: boolean[], pw: number, ph: number) {
    let error = "";
    const remap = <T extends DetectedDoor | DetectedWindow>(items: T[], kind: "door" | "window"): T[] => items.map(item => {
        const host = item.wallId ? source.walls.find(w => w.id === item.wallId) : resolveOpeningWall(item.bbox, source.walls, pw, ph).wall;
        if (!host) {
            if (original.some((s, i) => changed[i] && (overlaps(item.bbox as BBox, box(s)) || overlaps(item.bbox as BBox, box(final[i]))))) error = "An affected opening has no unambiguous host.";
            return item;
        }
        const i = source.walls.indexOf(host), s = original[i], n = final[i];
        const translated = changed[i] && samePoint({ x: n.a.x - s.a.x, y: n.a.y - s.a.y }, { x: n.b.x - s.b.x, y: n.b.y - s.b.y });
        const canonical = (item.planSegment || item.wallSpan) ? openingGeometry(item, kind, source.walls, pw, ph) : null;
        const before = canonical ?? projectOpeningEdgesOntoWall(item.bbox, host, length(s) * pw, pw, ph);
        let updated = item;
        if (changed[i] && before) {
            const u = { x: (s.b.x - s.a.x) / length(s), y: (s.b.y - s.a.y) / length(s) };
            const v = { x: (n.b.x - n.a.x) / length(n), y: (n.b.y - n.a.y) / length(n) };
            const rotated = Math.abs(u.x * v.y - u.y * v.x) > EPS;
            const fixedOld = samePoint(s.a, n.a) || translated ? s.a : s.b;
            const fixedNew = samePoint(s.a, n.a) || translated ? n.a : n.b;
            const transform = (p: NormalizedPoint): NormalizedPoint => {
                const dx = p.x * pw - fixedOld.x * pw, dy = p.y * ph - fixedOld.y * ph;
                const t = dx * u.x + dy * u.y, off = -dx * u.y + dy * u.x;
                return { x: (fixedNew.x * pw + t * v.x - off * v.y) / pw, y: (fixedNew.y * ph + t * v.y + off * v.x) / ph };
            };
            if (translated || rotated || !samePoint(fixedOld, fixedNew)) {
                const center = transform({ x: item.bbox.x + item.bbox.w / 2, y: item.bbox.y + item.bbox.h / 2 });
                // Bboxes stay axis-aligned. Preserve the measured host-axis width when the host rotates.
                const projected = Math.abs(v.x) * item.bbox.w * pw + Math.abs(v.y) * item.bbox.h * ph;
                const factor = rotated && projected > EPS ? (before.tEnd - before.tStart) / projected : 1;
                const w = item.bbox.w * factor, h = item.bbox.h * factor;
                updated = { ...item, bbox: { x: center.x - w / 2, y: center.y - h / 2, w, h },
                    ...(item.polygon ? { polygon: item.polygon.map(transform) } : {}) };
            }
        }
        if (canonical && changed[i] && !translated) {
            const center = { x: (updated.bbox.x + updated.bbox.w / 2) * pw, y: (updated.bbox.y + updated.bbox.h / 2) * ph };
            // Opening spans are stored as fractions of the host but measured in
            // metres, so the projection is done in metres and only divided back
            // into fractions at the end.
            const nx = (n.b.x - n.a.x) * pw, ny = (n.b.y - n.a.y) * ph, metres = Math.hypot(nx, ny);
            const along = ((center.x - n.a.x * pw) * nx + (center.y - n.a.y * ph) * ny) / (metres * metres) * metres;
            const start = along - canonical.width / 2, end = along + canonical.width / 2;
            if (metres <= EPS || start < -EPS || end > metres + EPS) error = "There is not enough wall length for the attached opening.";
            updated = { ...updated, planSegment: undefined, wallSpan: { start: start / metres, end: end / metres } };
        }
        if (changed[i]) {
            const after = canonical ? openingGeometry(updated, kind, nextWalls, pw, ph)
                : projectOpeningEdgesOntoWall(updated.bbox, nextWalls[i], length(n) * pw, pw, ph);
            if (!before || !after || Math.abs((before.tEnd - before.tStart) - (after.tEnd - after.tStart)) > EPS)
                error = "There is not enough wall length for the attached opening.";
        }
        // A wall that did not host this opening must not now reach it.
        const openingBox: Segment = { a: { x: item.bbox.x * pw, y: item.bbox.y * ph },
            b: { x: (item.bbox.x + item.bbox.w) * pw, y: (item.bbox.y + item.bbox.h) * ph } };
        for (let j = 0; j < final.length; j++) {
            if (j === i || !changed[j]) continue;
            if (sweptIntersection({ a: { x: original[j].a.x * pw, y: original[j].a.y * ph }, b: { x: original[j].b.x * pw, y: original[j].b.y * ph } },
                { a: { x: final[j].a.x * pw, y: final[j].a.y * ph }, b: { x: final[j].b.x * pw, y: final[j].b.y * ph } }, openingBox))
                error = "A moving wall would reach a door or window. Try a smaller adjustment.";
        }
        if (canonical && changed[i]) updated = materializeOpening(updated, kind, nextWalls, pw, ph, 2.8, item) ?? updated;
        if (!item.wallId && resolveOpeningWall(updated.bbox, nextWalls, pw, ph).wall?.id !== host.id) error = "An opening would change host or become ambiguous.";
        return updated as T;
    });
    const doors = remap(source.doors, "door"), windows = remap(source.windows, "window");
    return { doors, windows, error };
}

/** Reshape one logical segment, or the whole wall when no span is given. This is the
 * single model behind Total Length, Segment Length and Room Boundary Length. */
export function proposeWallLength(source: GeometrySnapshot, request: LengthRequest, planWidth: number, planHeight: number): LengthCandidate {
    const fail = (reason: string): LengthCandidate => ({ ok: false, reason });
    const { pw, ph, calibrated } = planMetricScale(planWidth, planHeight);
    if (!calibrated) return fail("Enter a positive length on a calibrated plan.");
    if (!Number.isFinite(request.length) || request.length <= 0) return fail("Enter a positive length.");
    if (new Set(source.walls.map(w => w.id)).size !== source.walls.length) return fail("Duplicate wall IDs make this geometry ambiguous.");
    const walls = source.walls;
    const graph = buildGraph(walls, resolveWallGraph(walls, source.graph));
    const chain = graph.chains.get(request.wallId);
    if (!chain) return fail("Wall is no longer available.");
    const node = (id: number): P => ({ x: graph.topology.nodes[id].x, y: graph.topology.nodes[id].y });
    // The edited span is the whole wall, or a run of its logical segments. Both ends
    // must be junctions of this wall, which is what makes a room boundary edit and a
    // segment edit the same operation.
    let anchorNode: number, movingNode: number;
    const requestedSegment = request.segmentKey ? graph.segmentation.byKey.get(request.segmentKey) : undefined;
    if (request.segmentKey && (!requestedSegment || requestedSegment.wallId !== request.wallId)) return fail("This logical segment is no longer available.");
    if (requestedSegment) {
        anchorNode = requestedSegment.nodeA;
        movingNode = requestedSegment.nodeB;
    } else if (!request.span) {
        anchorNode = chain.nodes[0];
        movingNode = chain.nodes[chain.nodes.length - 1];
    } else {
        const start = chain.nodes.findIndex(id => samePoint(node(id), request.span!.start));
        const end = chain.nodes.findIndex(id => samePoint(node(id), request.span!.end));
        if (start < 0 || end < 0 || start === end) return fail("Choose a segment of this wall.");
        anchorNode = chain.nodes[start];
        movingNode = chain.nodes[end];
    }
    if (request.anchor === "end") [anchorNode, movingNode] = [movingNode, anchorNode];
    const anchor = node(anchorNode), moving = node(movingNode);
    const current = length({ a: anchor, b: moving });
    if (current <= EPS) return fail("Choose a wall with two different endpoints.");
    // A typed length resolves along the wall's own axis, or along its existing
    // angle when it is a genuine diagonal. Unrelated walls are never straightened.
    const ux = (moving.x - anchor.x) * pw, uy = (moving.y - anchor.y) * ph;
    const span = Math.hypot(ux, uy);
    const unit = chain.kind === "h" ? { x: Math.sign(ux) || 1, y: 0 }
        : chain.kind === "v" ? { x: 0, y: Math.sign(uy) || 1 }
            : { x: ux / span, y: uy / span };
    const target = { x: anchor.x + unit.x * request.length / pw, y: anchor.y + unit.y * request.length / ph };
    const displacement = Math.hypot(target.x - moving.x, target.y - moving.y);
    if (displacement <= EPS && !request.confirm) return fail("This segment already has this length.");
    const original = segmentsOf(walls);
    const kinds = walls.map(wallKind);
    // A neighbour that cannot follow without collapsing, bending or crossing
    // something is pinned where it is, which disconnects it from the edited wall.
    // Only the edited wall's own geometry can make the edit itself impossible.
    const propagation = resolveDisplacement(graph, request.wallId, chain.kind !== "free", movingNode, target, anchorNode);
    const final = walls.map((w, i) => {
        const nodes = graph.chains.get(w.id)?.nodes;
        return nodes && !propagation.disconnected.includes(w.id)
            ? { a: propagation.position(nodes[0]), b: propagation.position(nodes[nodes.length - 1]) }
            : original[i];
    });
    const changed = final.map((s, i) => !samePoint(s.a, original[i].a) || !samePoint(s.b, original[i].b));
    const disconnected = new Set(propagation.disconnected.map(id => walls.findIndex(wall => wall.id === id)).filter(index => index >= 0));
    const invalid = validate(final, original, kinds, changed, wallOrder(walls), chain.index, disconnected);
    // Confirming a length the wall already has is a measurement, not an edit, so it
    // is allowed to record a dimension without moving anything.
    if (!changed.some(Boolean) && !request.confirm) return fail("This segment already has this length.");
    if (invalid) return fail(invalid.reason);
    const nextWalls = walls.map((w, i) => changed[i]
        ? { ...w, x1: final[i].a.x, y1: final[i].a.y, x2: final[i].b.x, y2: final[i].b.y } : w);
    const { doors, windows, error } = remapOpenings(source, nextWalls, original, final, changed, pw, ph);
    if (error) return fail(error);
    // A confirmed dimension is a distance, not a coordinate. An explicit new length
    // on the same span replaces the old record; every other record follows its junction.
    const sameSpan = (d: ConfirmedDimension) =>
        (samePoint(d.start, anchor) && samePoint(d.end, moving)) || (samePoint(d.end, anchor) && samePoint(d.start, moving));
    const shift = (p: P): P => {
        const id = graph.topology.nodes.findIndex(n => samePoint(n, p));
        return id >= 0 ? propagation.position(id) : p;
    };
    const dimensions = (source.confirmedDimensions ?? [])
        .filter(d => !(request.confirm && sameSpan(d)))
        .map(d => d.kind !== "length" ? d : {
            ...d,
            start: { ...d.start, ...shift(d.start) },
            end: { ...d.end, ...shift(d.end) } });
    if (request.confirm) {
            // The wall's own ends stay "start"/"end"; anything else is a junction, and a
            // junction reference records the other walls meeting there. A T-junction is
            // the interior of the host but the *endpoint* of the stub, so inclusive
            // containment is what actually identifies the walls holding the reference.
            const reference = (p: P) => {
                const endpoint = samePoint(p, node(chain.nodes[0])) ? "start" as const
                    : samePoint(p, node(chain.nodes[chain.nodes.length - 1])) ? "end" as const : "interior" as const;
                const junctionWallIds = endpoint === "interior"
                    ? walls.filter((w, i) => i !== chain.index && on(p, final[i])).map(w => w.id) : [];
            return { ...p, wallId: request.wallId, endpoint, ...(junctionWallIds.length ? { junctionWallIds } : {}) };
        };
        dimensions.push({ kind: "length", source: request.automatic ? "dimension" : undefined,
            start: reference(anchor), end: reference(target), lengthM: request.length });
    }
    const calibration = dimensions.filter(d => isCalibrationDimension(d) || !d.source);
    if (calibrated && !preservesConfirmedDimensions(nextWalls, calibration, planWidth, planHeight))
        return fail("This edit conflicts with the confirmed calibration span. Try editing the other end or the overall span.");
    return { ok: true, geometry: { walls: nextWalls, doors, windows, rooms: deriveRooms(nextWalls, source.rooms),
        ...(source.confirmedDimensions || request.confirm ? { confirmedDimensions: dimensions } : {}) },
        changedWallIds: nextWalls.filter((_, i) => changed[i]).map(w => w.id), displacement };
}

/** Direct manipulation. Exactly one endpoint of one wall moves: the opposite end
 * stays, the wall keeps its orientation, and no connected wall is dragged along.
 * Snapping is a preview-time offer rather than a lock, so releasing away from it
 * simply disconnects the old junction. */
export function proposeWallEndpoint(source: GeometrySnapshot, updatedWalls: Wall[], planWidth: number, planHeight: number, options?: { exact?: boolean }): LengthCandidate | null {
    if (updatedWalls.length !== source.walls.length || updatedWalls.some((wall, index) => wall.id !== source.walls[index].id)) return null;
    const changed = source.walls.flatMap((wall, index) => {
        const next = updatedWalls[index];
        const start = !samePoint({ x: wall.x1, y: wall.y1 }, { x: next.x1, y: next.y1 });
        const end = !samePoint({ x: wall.x2, y: wall.y2 }, { x: next.x2, y: next.y2 });
        // Direct manipulation is one endpoint of one wall. A body move is the
        // caller's separate path, so two ends at once is not this operation.
        return start !== end ? [{ index, wall, start }] : [];
    });
    if (changed.length !== 1) return null;
    const { index, wall, start } = changed[0];
    const end = !start;
    const fail = (reason: string): LengthCandidate => ({ ok: false, reason });
    const { pw, ph } = planMetricScale(planWidth, planHeight);
    // Apply the same axis projection the live preview used, so release cannot
    // disagree with what the user was shown. A resolved snap is exempt: landing on
    // a specific endpoint or host is deliberate and outranks the projection.
    const anchor = start ? { x: wall.x2, y: wall.y2 } : { x: wall.x1, y: wall.y1 };
    const raw = start ? { x: updatedWalls[index].x1, y: updatedWalls[index].y1 } : { x: updatedWalls[index].x2, y: updatedWalls[index].y2 };
    const point = options?.exact ? raw : projectDragPoint(wall, raw);
    if (samePoint(point, anchor)) return null;
    const walls = updatedWalls.map((w, i) => i !== index ? w
        : start ? { ...w, x1: point.x, y1: point.y } : { ...w, x2: point.x, y2: point.y });
    const original = segmentsOf(source.walls), final = segmentsOf(walls);
    // D1: axis walls keep their axis. A drop that lands on a wall the projection
    // then slides *along* is a perpendicular stub asking to move sideways, which
    // would turn it into a diagonal and quietly deform its host. Refusing it names
    // the supported move instead of silently doing nothing.
    if (!options?.exact && !samePoint(point, raw) && final.some((s, j) => j !== index && on(raw, s)))
        return fail("A wall cannot slide along the wall it meets. Shorten that wall to move the junction.");
    if (length(final[index]) <= EPS) return fail("That would collapse the wall.");
    for (let j = 0; j < final.length; j++) {
        if (j === index) continue;
        if (overlapLength(final[index], final[j]) > EPS && overlapLength(original[index], original[j]) <= EPS)
            return fail("Overlapping wall segments make this edit ambiguous.");
        // Sweeping clean through a wall is a gesture, not a connection: the endpoint
        // has to land on it, or the drag is refused rather than silently becoming a
        // crossing the user never asked for.
        if (!on(point, final[j]) && !intersects(original[index], original[j]) && sweptIntersection(original[index], final[index], original[j]))
            return fail("That would drag the endpoint through another wall. Drop it on the wall to connect.");
    }
    if (source.confirmedDimensions && !preservesConfirmedDimensions(walls, source.confirmedDimensions.filter(isCalibrationDimension), planWidth, planHeight))
        return fail("That would stretch a confirmed calibration span. Try editing the other end or the overall span.");
    const changedIds = walls.filter((_, i) => !samePoint(original[i].a, final[i].a) || !samePoint(original[i].b, final[i].b)).map(w => w.id);
    const { doors, windows, error } = remapOpenings(source, walls, original, final,
        original.map((_, i) => i === index), pw, ph);
    if (error) return fail(error);
    return { ok: true, geometry: { walls, doors, windows, rooms: deriveRooms(walls, source.rooms),
        ...(source.confirmedDimensions ? { confirmedDimensions: source.confirmedDimensions } : {}) },
        changedWallIds: changedIds, displacement: Math.hypot((point.x - anchor.x) * pw, (point.y - anchor.y) * ph) };
}

/** Direct manipulation of a wall body: translate both endpoints as one rigid
 * wall. It may disconnect from neighbours, but never reshapes them. */
export function proposeWallBody(source: GeometrySnapshot, updatedWalls: Wall[], planWidth: number, planHeight: number): LengthCandidate | null {
    if (updatedWalls.length !== source.walls.length || updatedWalls.some((wall, index) => wall.id !== source.walls[index].id)) return null;
    const { pw, ph } = planMetricScale(planWidth, planHeight);
    const original = segmentsOf(source.walls), final = segmentsOf(updatedWalls);
    const changed = original.map((segment, index) => !samePoint(segment.a, final[index].a) || !samePoint(segment.b, final[index].b));
    const changedIds = changed.flatMap((value, index) => value ? [index] : []);
    if (changedIds.length !== 1) return null;
    const index = changedIds[0];
    const delta = { x: final[index].a.x - original[index].a.x, y: final[index].a.y - original[index].a.y };
    if (!samePoint({ x: final[index].b.x - original[index].b.x, y: final[index].b.y - original[index].b.y }, delta))
        return { ok: false, reason: "A wall-body move must keep both endpoints together." };
    const invalid = validate(final, original, source.walls.map(wallKind), changed, wallOrder(source.walls), index);
    if (invalid) return { ok: false, reason: invalid.reason };
    const nextWalls = source.walls.map((wall, i) => changed[i] ? { ...wall, x1: final[i].a.x, y1: final[i].a.y, x2: final[i].b.x, y2: final[i].b.y } : wall);
    const remapped = remapOpenings(source, nextWalls, original, final, changed, pw, ph);
    if (remapped.error) return { ok: false, reason: remapped.error };
    if (!preservesConfirmedDimensions(nextWalls, (source.confirmedDimensions ?? []).filter(isCalibrationDimension), planWidth, planHeight))
        return { ok: false, reason: "That would stretch a confirmed calibration span." };
    return { ok: true, geometry: { walls: nextWalls, doors: remapped.doors, windows: remapped.windows, rooms: deriveRooms(nextWalls, source.rooms),
        ...(source.confirmedDimensions ? { confirmedDimensions: source.confirmedDimensions } : {}) },
        changedWallIds: [source.walls[index].id], displacement: Math.hypot(delta.x * pw, delta.y * ph) };
}

/** Anchor on the junction that is already connected, so a numeric edit reshapes the
 * layout around it instead of tearing that junction away. */
export function chooseLengthAnchor(source: GeometrySnapshot, wallId: string, target: number, planWidth: number, planHeight: number, options: Pick<LengthRequest, "span" | "confirm"> = {}): Anchor {
    const start = proposeWallLength(source, { wallId, length: target, anchor: "start", ...options }, planWidth, planHeight);
    const end = proposeWallLength(source, { wallId, length: target, anchor: "end", ...options }, planWidth, planHeight);
    if (start.ok !== end.ok) return start.ok ? "start" : "end";
    if (!start.ok || !end.ok) return "start";
    const graph = buildGraph(source.walls, resolveWallGraph(source.walls, source.graph));
    const chain = graph.chains.get(wallId);
    if (!chain) return "start";
    const connected = (id: number) => [...graph.chains.values()].some(other => other !== chain && other.nodes.includes(id));
    const a = connected(chain.nodes[0]), b = connected(chain.nodes[chain.nodes.length - 1]);
    return a !== b ? (a ? "start" : "end") : "start";
}
