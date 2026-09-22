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
