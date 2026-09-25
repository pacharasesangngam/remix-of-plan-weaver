import type { DetectedWallSegment as Wall } from "@/types/detection";
import type { NormalizedPoint as Point } from "@/types/floorplan";

export type Endpoint = "start" | "end";
export const SNAP_PX = 12;
const EPS = 1e-8;
export const endpointPoint = (wall: Wall, end: Endpoint): Point => end === "start"
    ? { x: wall.x1, y: wall.y1 } : { x: wall.x2, y: wall.y2 };
export const screenDistance = (a: Point, b: Point, size: { width: number; height: number }) =>
    Math.hypot((a.x - b.x) * size.width, (a.y - b.y) * size.height);
export function projectToWall(point: Point, wall: Wall, size = { width: 1, height: 1 }) {
    const dx = (wall.x2 - wall.x1) * size.width, dy = (wall.y2 - wall.y1) * size.height;
    const t = Math.max(0, Math.min(1, (((point.x - wall.x1) * size.width * dx + (point.y - wall.y1) * size.height * dy) / (dx * dx + dy * dy || 1))));
    return { x: wall.x1 + (wall.x2 - wall.x1) * t, y: wall.y1 + (wall.y2 - wall.y1) * t, t };
}
export const validWall = (wall: Wall) => [wall.x1, wall.y1, wall.x2, wall.y2].every(Number.isFinite)
    && Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1) > EPS;
export const geometryChanged = (a: Wall, b: Wall) => a.x1 !== b.x1 || a.y1 !== b.y1 || a.x2 !== b.x2 || a.y2 !== b.y2;

// Apply only the selected wall's geometry; snapping targets are never edited.
export function editWallGeometry(walls: Wall[], updated: Wall, endpoint?: Endpoint): Wall[] | null {
    const original = walls.find(wall => wall.id === updated.id);
    if (!original) return null;
    const next = endpoint === "start"
        ? { ...original, x1: updated.x1, y1: updated.y1 }
        : endpoint === "end"
            ? { ...original, x2: updated.x2, y2: updated.y2 }
            : { ...original, x1: updated.x1, y1: updated.y1, x2: updated.x2, y2: updated.y2 };
    if (!validWall(next)) return null;
    return walls.map(wall => wall.id === original.id && geometryChanged(wall, next) ? next : wall);
}

export interface WallSnap extends Point { key: string; kind: "endpoint" | "segment" }
export function wallSnapTargets(point: Point, walls: Wall[], excluded: Set<string>, size: { width: number; height: number }): WallSnap[] {
    return walls.filter(wall => !excluded.has(wall.id) && validWall(wall)).flatMap(wall => [
        { ...endpointPoint(wall, "start"), key: `${wall.id}:start`, kind: "endpoint" as const },
        { ...endpointPoint(wall, "end"), key: `${wall.id}:end`, kind: "endpoint" as const },
        { ...projectToWall(point, wall, size), key: `${wall.id}:segment`, kind: "segment" as const },
    ]);
}
export function findWallSnap(point: Point, targets: WallSnap[], size: { width: number; height: number }, blocked: Set<string>): WallSnap | null {
    const candidates = targets.filter(target => {
        const distance = screenDistance(point, target, size);
        if (blocked.has(target.key)) {
            if (distance >= SNAP_PX) blocked.delete(target.key);
            return false;
        }
        return distance < SNAP_PX;
    });
    candidates.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "endpoint" ? -1 : 1)
        || screenDistance(point, a, size) - screenDistance(point, b, size) || a.key.localeCompare(b.key));
    return candidates[0] ?? null;
}

// A body drag has one translation. Connections constrain that translation,
// using the same finite-segment projections and screen-space range as endpoint drags.
export function snapWallTranslation(wall: Wall, walls: Wall[], size: { width: number; height: number }, blocked: Record<Endpoint, Set<string>>, reverseBlocked = new Set<string>()) {
    const ends = ["start", "end"] as const;
    const others = walls.filter(other => other.id !== wall.id && validWall(other));
    type Connection = { shift: Point; normal?: Point; movingEnd?: Endpoint; fixed: Wall; target: WallSnap; reverseEnd?: Endpoint };
    const connections: Connection[] = [];
    const normal = (segment: Wall) => {
        const dx = (segment.x2 - segment.x1) * size.width, dy = (segment.y2 - segment.y1) * size.height;
        const length = Math.hypot(dx, dy);
        return { x: -dy / length, y: dx / length };
    };
    for (const end of ends) {
        const point = endpointPoint(wall, end);
        for (const fixed of others) for (const target of wallSnapTargets(point, [fixed], new Set(), size)) {
            if (!findWallSnap(point, [target], size, blocked[end])) continue;
            connections.push({ movingEnd: end, fixed, target,
                shift: { x: target.x - point.x, y: target.y - point.y },
                normal: target.kind === "segment" ? normal(fixed) : undefined });
        }
    }
    for (const fixed of others) for (const end of ends) {
        const point = endpointPoint(fixed, end);
        const projected = projectToWall(point, wall, size);
        const target: WallSnap = { ...projected, key: `${fixed.id}:${end}`, kind: "segment" };
        if (!findWallSnap(point, [target], size, reverseBlocked)) continue;
        connections.push({ fixed, reverseEnd: end, target,
            shift: { x: point.x - projected.x, y: point.y - projected.y }, normal: normal(wall) });
    }
    const translate = (shift: Point): Wall => ({ ...wall,
        x1: wall.x1 + shift.x, y1: wall.y1 + shift.y,
        x2: wall.x2 + shift.x, y2: wall.y2 + shift.y });
    const connected = (connection: Connection, moved: Wall) => {
        const point = connection.movingEnd ? endpointPoint(moved, connection.movingEnd) : endpointPoint(connection.fixed, connection.reverseEnd!);
        const target = connection.movingEnd
            ? connection.target.kind === "endpoint" ? connection.target : projectToWall(point, connection.fixed, size)
            : projectToWall(point, moved, size);
        return screenDistance(point, target, size) < 1e-7;
    };
    const shifts = connections.map(connection => connection.shift);
    // Two segment constraints may determine one compatible translation (e.g. two
    // perpendicular hosts). Parallel constraints already share a projected shift.
    for (let i = 0; i < connections.length; i++) for (let j = i + 1; j < connections.length; j++) {
        const a = connections[i], b = connections[j];
        if (!a.normal || !b.normal) continue;
        const det = a.normal.x * b.normal.y - a.normal.y * b.normal.x;
        if (Math.abs(det) < 1e-8) continue;
        const da = a.normal.x * a.shift.x * size.width + a.normal.y * a.shift.y * size.height;
        const db = b.normal.x * b.shift.x * size.width + b.normal.y * b.shift.y * size.height;
        shifts.push({ x: (da * b.normal.y - db * a.normal.y) / det / size.width,
            y: (a.normal.x * db - b.normal.x * da) / det / size.height });
    }
    const options = shifts.filter(shift => screenDistance(shift, { x: 0, y: 0 }, size) < SNAP_PX).map(shift => {
        const moved = translate(shift);
        const matches = connections.filter(connection => connected(connection, moved));
        const endpoints = matches.filter(connection => connection.movingEnd && connection.target.kind === "endpoint");
        const count = new Set(matches.map(connection => connection.movingEnd
            ? `${connection.movingEnd}:${connection.fixed.id}` : `${connection.fixed.id}:${connection.reverseEnd}`)).size;
        return { moved, shift, matches, endpoints, count };
    }).sort((a, b) => b.endpoints.length - a.endpoints.length || b.count - a.count
        || screenDistance(a.shift, { x: 0, y: 0 }, size) - screenDistance(b.shift, { x: 0, y: 0 }, size));
    const best = options[0];
    if (!best) return { wall, targets: [] as WallSnap[] };
    // Copy exact stored coordinates for endpoint matches; the only correction
    // beyond the common translation is floating-point roundoff.
    for (const connection of best.endpoints) {
        if (connection.movingEnd === "start") { best.moved.x1 = connection.target.x; best.moved.y1 = connection.target.y; }
        else { best.moved.x2 = connection.target.x; best.moved.y2 = connection.target.y; }
    }
    return { wall: best.moved, targets: wallConnectionTargets(best.moved, others, size) };
}

// Read-only feedback for actual endpoint connections on a previewed wall.
export function wallConnectionTargets(wall: Wall, walls: Wall[], size: { width: number; height: number }): WallSnap[] {
    const ends = ["start", "end"] as const;
    const others = walls.filter(other => other.id !== wall.id && validWall(other));
    // Enumerate actual connections after the chosen translation, in both
    // directions. All feedback denotes an endpoint that will really connect.
    const targets = new Map<string, WallSnap>();
    const highlight = (segment: Wall, end: Endpoint) => {
        const key = `${segment.id}:${end}`;
        targets.set(key, { ...endpointPoint(segment, end), key, kind: "endpoint" });
    };
    for (const fixed of others) {
        for (const end of ends) {
            const point = endpointPoint(wall, end);
            if (screenDistance(point, projectToWall(point, fixed, size), size) < 1e-7) {
                const matchingEnds = ends.filter(fixedEnd => screenDistance(point, endpointPoint(fixed, fixedEnd), size) < 1e-7);
                if (matchingEnds.length) matchingEnds.forEach(fixedEnd => highlight(fixed, fixedEnd));
                else highlight(wall, end);
            }
        }
        for (const end of ends) {
            const point = endpointPoint(fixed, end);
            if (screenDistance(point, projectToWall(point, wall, size), size) < 1e-7) highlight(fixed, end);
        }
    }
    return [...targets.values()];
}
