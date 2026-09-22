import { describe, expect, it } from "vitest";
import type { DetectedWallSegment as Wall } from "@/types/detection";
import { editWallGeometry, findWallSnap, wallSnapTargets } from "./wallGeometry";

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
