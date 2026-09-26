import { describe, expect, it } from "vitest";
import type { DetectedWallSegment as Wall } from "@/types/detection";
import { editWallGeometry, findWallSnap, projectToWall, snapWallTranslation, wallSnapTargets } from "./wallGeometry";

const host: Wall = { id: "host", x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, type: "interior" };
const branch: Wall = { ...host, id: "branch", x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.9 };
const connected: Wall = { ...host, id: "connected", x1: 0.9, y1: 0.5, x2: 0.9, y2: 0.9 };
const unrelated: Wall = { ...host, id: "unrelated", x1: 0.2, y1: 0.1, x2: 0.8, y2: 0.1 };

describe("independent wall geometry", () => {
    it("changes only the selected endpoint, retaining all adjacent walls by identity", () => {
        const before = [host, branch, connected, unrelated];
        const after = editWallGeometry(before, { ...host, x1: 99, y1: 99, x2: 0.8, y2: 0.6 }, "end")!;
        expect(after[0]).toEqual({ ...host, x2: 0.8, y2: 0.6 });
        after.slice(1).forEach((wall, index) => expect(wall).toBe(before[index + 1]));
        expect(before[0]).toBe(host);
    });
    it("freely detaches a T-junction endpoint in both axes without editing its host", () => {
        const after = editWallGeometry([host, branch], { ...branch, x1: 0.6, y1: 0.6 }, "start")!;
        expect(after[0]).toBe(host);
        expect(after[1]).toEqual({ ...branch, x1: 0.6, y1: 0.6 });
    });
    it("preserves adjacent walls during whole-wall movement", () => {
        const after = editWallGeometry([host, branch, connected], { ...host, y1: 0.6, y2: 0.6 })!;
        expect(after[1]).toBe(branch);
        expect(after[2]).toBe(connected);
    });
    it("rejects zero-length and nonfinite geometry", () => {
        expect(editWallGeometry([host], { ...host, x2: host.x1 }, "end")).toBeNull();
        expect(editWallGeometry([host], { ...host, x2: NaN }, "end")).toBeNull();
    });
    it("preserves the latest opposite endpoint across consecutive edits and JSON round-trips", () => {
        const before = [host, branch];
        const after = editWallGeometry(before, { ...host, x1: 0.95, y1: 0.7 }, "start")!;
        const restored = JSON.parse(JSON.stringify(after)) as Wall[];
        const edited = editWallGeometry(restored, { ...restored[0], y2: 0.8 }, "end")!;
        expect(edited[0]).toEqual({ ...host, x1: 0.95, y1: 0.7, y2: 0.8 });
        expect(edited[1]).toEqual(branch);
        expect(before[0]).toBe(host);
    });
});

describe("wall snapping", () => {
    it.each([0.5, 1, 3])("uses a screen-space threshold at zoom %s", zoom => {
        const size = { width: 1000 * zoom, height: 500 * zoom };
        const inside = { x: 0.5, y: 0.5 + 11 / size.height };
        expect(findWallSnap(inside, wallSnapTargets(inside, [host], new Set(), size), size, new Set())).toMatchObject({ kind: "segment", x: 0.5, y: 0.5 });
        const outside = { x: 0.5, y: 0.5 + 13 / size.height };
        expect(findWallSnap(outside, wallSnapTargets(outside, [host], new Set(), size), size, new Set())).toBeNull();
    });
    it("prioritizes exact endpoints over a closer segment projection", () => {
        const size = { width: 1000, height: 500 }, point = { x: 0.895, y: 0.502 };
        expect(findWallSnap(point, wallSnapTargets(point, [host], new Set(), size), size, new Set())).toMatchObject({ kind: "endpoint", x: 0.9, y: 0.5 });
    });
    it("does not snap back to an existing T junction until it has been left", () => {
        const size = { width: 1000, height: 500 }, blocked = new Set(["host:segment"]);
        const snap = (point: { x: number; y: number }) => findWallSnap(point, wallSnapTargets(point, [host], new Set(), size), size, blocked);
        expect(snap({ x: 0.5, y: 0.51 })).toBeNull();
        expect(snap({ x: 0.5, y: 0.6 })).toBeNull();
        expect(snap({ x: 0.5, y: 0.51 })).toMatchObject({ x: 0.5, y: 0.5 });
    });
});


describe("whole-wall endpoint snapping", () => {
    it.each([false, true])("preserves diagonal direction with reversed=%s", reversed => {
        const wall = { ...host, id: "moving", x1: 0.204, y1: 0.306, x2: 0.504, y2: 0.706 };
        if (reversed) [wall.x1, wall.y1, wall.x2, wall.y2] = [wall.x2, wall.y2, wall.x1, wall.y1];
        const target = { ...host, x1: 0.2, y1: 0.3 };
        const result = snapWallTranslation(wall, [wall, target], { width: 1000, height: 500 }, { start: new Set(), end: new Set() });
        expect(result.targets).toHaveLength(1);
        expect(result.wall.x2 - result.wall.x1).toBeCloseTo(wall.x2 - wall.x1, 12);
        expect(result.wall.y2 - result.wall.y1).toBeCloseTo(wall.y2 - wall.y1, 12);
        expect(reversed ? result.wall.x2 : result.wall.x1).toBe(target.x1);
        expect(reversed ? result.wall.y2 : result.wall.y1).toBe(target.y1);
    });

    it("allows leaving and returning to an original endpoint connection", () => {
        const blocked = { start: new Set(["host:start", "host:segment"]), end: new Set<string>() };
        const wall = { ...branch, x1: 0.1, y1: 0.5, x2: 0.2, y2: 0.8 };
        const size = { width: 1000, height: 500 };
        const reverseBlocked = new Set(["host:start"]);
        expect(snapWallTranslation(wall, [host], size, blocked, reverseBlocked).targets).toHaveLength(0);
        expect(snapWallTranslation({ ...wall, x1: 0.3, x2: 0.4, y1: 0.6, y2: 0.9 }, [host], size, blocked, reverseBlocked).targets).toHaveLength(0);
        expect(snapWallTranslation(wall, [host], size, blocked, reverseBlocked).targets).toHaveLength(1);
    });
});


describe("whole-wall T-junction snapping", () => {
    it.each([false, true])("uses the existing segment projection for a diagonal wall, reversed=%s", reversed => {
        const moving = { ...branch, x1: 0.504, y1: 0.51, x2: 0.704, y2: 0.81 };
        if (reversed) [moving.x1, moving.y1, moving.x2, moving.y2] = [moving.x2, moving.y2, moving.x1, moving.y1];
        const size = { width: 1000, height: 500 };
        const result = snapWallTranslation(moving, [moving, host], size, { start: new Set(), end: new Set() });
        const projected = projectToWall({ x: 0.504, y: 0.51 }, host, size);
        expect(result.targets).toEqual([{ x: projected.x, y: projected.y, kind: "endpoint", key: `branch:${reversed ? "end" : "start"}` }]);
        expect(reversed ? result.wall.x2 : result.wall.x1).toBe(projected.x);
        expect(reversed ? result.wall.y2 : result.wall.y1).toBe(projected.y);
        expect(result.wall.x2 - result.wall.x1).toBeCloseTo(moving.x2 - moving.x1, 12);
        expect(result.wall.y2 - result.wall.y1).toBeCloseTo(moving.y2 - moving.y1, 12);
    });

    it("prefers an endpoint at either end over a closer segment at the other", () => {
        const moving = { ...branch, x1: 0.5, y1: 0.502, x2: 0.7, y2: 0.802 };
        const target = { ...host, id: "endpoint", x1: 0.706, y1: 0.802, x2: 0.9, y2: 0.9 };
        const result = snapWallTranslation(moving, [host, target], { width: 1000, height: 500 }, { start: new Set(), end: new Set() });
        expect(result.targets[0]).toMatchObject({ key: "endpoint:start", kind: "endpoint" });
        expect(result.wall.x2).toBe(target.x1);
    });

    it("connects both ends to compatible interiors without moving either host", () => {
        const moving = { ...branch, x1: 0.306, y1: 0.4, x2: 0.706, y2: 0.4 };
        const left = { ...host, id: "left", x1: 0.3, y1: 0.1, x2: 0.3, y2: 0.9 };
        const right = { ...left, id: "right", x1: 0.7, x2: 0.7 };
        const before = structuredClone([left, right]);
        const result = snapWallTranslation(moving, [left, right], { width: 1000, height: 500 }, { start: new Set(), end: new Set() });
        expect(result.targets.map(target => target.kind)).toEqual(["endpoint", "endpoint"]);
        expect(result.wall.x1).toBeCloseTo(left.x1, 12);
        expect(result.wall.x2).toBeCloseTo(right.x1, 12);
        expect([left, right]).toEqual(before);
    });
});


describe("bidirectional whole-wall connections", () => {
    const size = { width: 1000, height: 500 };
    const snap = (moving: Wall, walls: Wall[]) => snapWallTranslation(moving, walls, size, { start: new Set(), end: new Set() });
    const assertRealHighlights = (result: ReturnType<typeof snap>, walls: Wall[]) => {
        for (const target of result.targets) {
            const candidates = target.key.startsWith(result.wall.id + ":") ? walls : [result.wall];
            expect(candidates.some(wall => {
                const projection = projectToWall(target, wall, size);
                return Math.hypot(projection.x - target.x, projection.y - target.y) < 1e-12;
            })).toBe(true);
        }
    };

    it.each([false, true])("connects several stationary endpoints to a moving interior, reversed=%s", reversed => {
        const moving = { ...host, id: "moving", x1: 0.2, y1: 0.49, x2: 0.8, y2: 0.49 };
        if (reversed) [moving.x1, moving.x2] = [moving.x2, moving.x1];
        const walls = [0.35, 0.65].map((x, i) => ({ ...branch, id: `target${i}`, x1: x, y1: 0.5, x2: x, y2: 0.8 }));
        const before = structuredClone(walls);
        const result = snap(moving, walls);
        expect(result.wall.y1).toBe(0.5);
        expect(result.wall.y2).toBe(0.5);
        expect(result.wall.x2 - result.wall.x1).toBe(moving.x2 - moving.x1);
        expect(result.targets.map(target => target.key)).toEqual(["target0:start", "target1:start"]);
        expect(walls).toEqual(before);
        assertRealHighlights(result, walls);
    });

    it("combines forward and reverse interior constraints in one translation", () => {
        const moving = { ...host, id: "moving", x1: 0.306, y1: 0.49, x2: 0.706, y2: 0.49 };
        const vertical = { ...branch, id: "vertical", x1: 0.3, y1: 0.1, x2: 0.3, y2: 0.9 };
        const branchWall = { ...branch, id: "branch", x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.8 };
        const result = snap(moving, [vertical, branchWall]);
        expect(result.wall.x1).toBeCloseTo(0.3, 12);
        expect(result.wall.y1).toBe(0.5);
        expect(result.wall.x2 - result.wall.x1).toBeCloseTo(0.4, 12);
        expect(result.targets.map(target => target.key)).toEqual(["moving:start", "branch:start"]);
        assertRealHighlights(result, [vertical, branchWall]);
    });

    it("does not highlight incompatible stationary endpoints or endpoints beyond the finite segment", () => {
        const moving = { ...host, id: "moving", x1: 0.2, y1: 0.49, x2: 0.8, y2: 0.49 };
        const walls = [
            { ...branch, id: "near", x1: 0.35, y1: 0.5, x2: 0.35, y2: 0.8 },
            { ...branch, id: "far", x1: 0.65, y1: 0.51, x2: 0.65, y2: 0.8 },
            { ...branch, id: "beyond", x1: 0.9, y1: 0.5, x2: 0.9, y2: 0.8 },
        ];
        const result = snap(moving, walls);
        expect(result.targets.map(target => target.key)).toEqual(["near:start"]);
        assertRealHighlights(result, walls);
    });

    it("preserves a diagonal vector when connecting a stationary endpoint to its interior", () => {
        const moving = { ...host, id: "moving", x1: 0.2, y1: 0.3, x2: 0.8, y2: 0.7 };
        const target = { ...branch, x1: 0.5, y1: 0.51, x2: 0.5, y2: 0.9 };
        const result = snap(moving, [target]);
        expect(result.targets.map(target => target.key)).toEqual(["branch:start"]);
        expect(result.wall.x2 - result.wall.x1).toBeCloseTo(moving.x2 - moving.x1, 12);
        expect(result.wall.y2 - result.wall.y1).toBeCloseTo(moving.y2 - moving.y1, 12);
        assertRealHighlights(result, [target]);
    });
});
