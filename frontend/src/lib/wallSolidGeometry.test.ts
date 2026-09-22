import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import type { DetectedWallSegment as Wall } from "@/types/detection";
import { buildWallPrisms, buildWallSolidGeometries, wallFrame, type WallPrism, type WallSolidInput } from "./wallSolidGeometry";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number, thickness = 0.2, wallHeight = 3): Wall =>
    ({ id, x1, y1, x2, y2, thickness, wallHeight, type: "interior" });
const input = (wall: Wall, pw = 1, ph = 1): WallSolidInput => ({ wall, thickness: wall.thickness!,
    solids: [{ tStart: 0, tEnd: wallFrame(wall, pw, ph).length, yStart: 0, yEnd: wall.wallHeight! }] });
const area = (polygon: WallPrism["polygon"]) => Math.abs(polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    return sum + p.x * q.z - q.x * p.z;
}, 0)) / 2;
const volume = (cells: WallPrism[]) => cells.reduce((sum, c) => sum + area(c.polygon) * (c.yEnd - c.yStart), 0);
const contains = (cell: WallPrism, x: number, z: number, y: number) => y > cell.yStart && y < cell.yEnd && cell.polygon.every((p, i) => {
    const q = cell.polygon[(i + 1) % cell.polygon.length];
    return (q.x - p.x) * (z - p.z) - (q.z - p.z) * (x - p.x) > 1e-10;
});
const topCells = (cells: WallPrism[], height: number) => cells.filter(cell => cell.yEnd === height);
const topArea = (cells: WallPrism[], height: number) => topCells(cells, height).reduce((sum, cell) => sum + area(cell.polygon), 0);

describe("shared 3D wall geometry", () => {
    it("preserves a diagonal centerline, length, thickness, height and ID on a rectangular plan", () => {
        const w = wall("diagonal", 0.15, 0.25, 0.8, 0.7, 0.37, 2.4);
        const original = structuredClone(w), spec = input(w, 12, 7);
        const geometries = buildWallSolidGeometries([spec], 12, 7);
        const geometry = geometries.get(w.id)!;
        geometry.computeBoundingBox();
        const bounds = geometry.boundingBox!;
        expect(bounds.max.x - bounds.min.x).toBeCloseTo(wallFrame(w, 12, 7).length, 5);
        expect(bounds.max.z - bounds.min.z).toBeCloseTo(0.37, 5);
        expect(bounds.max.y).toBeCloseTo(2.4, 5);
        expect(w).toEqual(original);
        expect([...geometries.keys()]).toEqual([w.id]);
        geometries.forEach(g => g.dispose());
    });

    it("removes the exact overlapping volume of a perpendicular unequal-thickness T-junction", () => {
        const host = input(wall("host", 0, 0, 4, 0, 0.4));
        const branch = input(wall("branch", 2, 0, 2, 2, 0.2));
        const cells = buildWallPrisms([host, branch], 1, 1);
        expect(volume(cells)).toBeCloseTo((4 * 0.4 + 2 * 0.2 - 0.2 * 0.2) * 3, 9);
        // No duplicate occupied volume throughout the junction footprint.
        for (let x = 1.33; x < 1.7; x += 0.023) for (let z = -0.67; z < -0.15; z += 0.019) {
            expect(cells.filter(cell => contains(cell, x, z, 1)).length).toBeLessThanOrEqual(1);
        }
    });

    it("supports oblique T-junctions without moving either centerline", () => {
        const specs = [input(wall("host", 0, 0, 4, 2, 0.4)), input(wall("branch", 2, 1, 1.4, 3, 0.25))];
        const before = structuredClone(specs);
        const cells = buildWallPrisms(specs, 1, 1);
        const separate = specs.reduce((sum, spec) => sum + spec.solids[0].tEnd * spec.thickness * 3, 0);
        expect(volume(cells)).toBeLessThan(separate);
        expect(volume(cells)).toBeGreaterThan(separate - 0.5);
        for (let x = 0.7; x < 2.2; x += 0.047) for (let z = 0.1; z < 1.1; z += 0.031) {
            expect(cells.filter(cell => contains(cell, x, z, 1)).length).toBeLessThanOrEqual(1);
        }
        expect(specs).toEqual(before);
    });

    it("fills shared endpoint corners without long miter spikes and is independent of array order", () => {
        const specs = [input(wall("a", 0, 0, 2, 0)), input(wall("b", 2, 0, 2.1, 2, 0.4))];
        const cells = buildWallPrisms(specs, 1, 1);
        expect(buildWallPrisms([...specs].reverse(), 1, 1)).toEqual(cells);
        expect(cells.every(c => c.polygon.every(p => Number.isFinite(p.x) && Number.isFinite(p.z)))).toBe(true);
        expect(Math.max(...cells.flatMap(c => c.polygon.map(p => p.x)))).toBeLessThan(2);
    });

    it.each([
        ["equal thickness", 0.15, 0.15],
        ["unequal thickness", 0.15, 0.3],
    ])("keeps an exact shared endpoint corner covered with %s walls", (_label, firstThickness, secondThickness) => {
        const first = input(wall("corner-a", 0, 0, 2, 0, firstThickness));
        const second = input(wall("corner-b", 2, 0, 2, 2, secondThickness));
        const cells = buildWallPrisms([first, second], 1, 1);

        expect(first.wall.x2).toBe(second.wall.x1);
        expect(first.wall.y2).toBe(second.wall.y1);
        expect(topArea(cells, 3)).toBeCloseTo(2 * firstThickness + 2 * secondThickness, 8);
        expect(cells.filter(cell => contains(cell, 2.02, -0.02, 1)).length).toBeLessThanOrEqual(1);
        expect(cells.every(cell => cell.polygon.every(point => Number.isFinite(point.x) && Number.isFinite(point.z)))).toBe(true);
    });

    it.each([
        ["a-a", [0, 0, 2, 0], [0, 0, 0, 2]],
        ["a-b", [0, 0, 2, 0], [0, -2, 0, 0]],
        ["b-a", [-2, 0, 0, 0], [0, 0, 0, 2]],
        ["b-b", [-2, 0, 0, 0], [0, -2, 0, 0]],
    ])("generates a derived corner join for the %s endpoint pairing", (_label, firstPoints, secondPoints) => {
        const makeWall = (id: string, points: number[]) => input(wall(id, points[0], points[1], points[2], points[3], 0.15));
        const cells = buildWallPrisms([
            makeWall("corner-a", firstPoints),
            makeWall("corner-b", secondPoints),
        ], 1, 1);
        expect(cells.some(cell => cell.wallId === "corner-a" && cell.polygon.length > 4)).toBe(true);
        expect(topArea(cells, 3)).toBeCloseTo(0.6, 8);
    });

    it("generates the same exact corner join after reversing wall order and directions", () => {
        const forward = buildWallPrisms([
            input(wall("corner-a", 0, 0, 2, 0, 0.15)),
            input(wall("corner-b", 0, 0, 0, 2, 0.15)),
        ], 1, 1);
        const reversed = buildWallPrisms([
            input(wall("corner-b", 0, 2, 0, 0, 0.15)),
            input(wall("corner-a", 2, 0, 0, 0, 0.15)),
        ], 1, 1);
        expect(forward.some(cell => cell.wallId === "corner-a" && cell.polygon.length > 4)).toBe(true);
        expect(reversed.some(cell => cell.wallId === "corner-a" && cell.polygon.length > 4)).toBe(true);
        expect(topArea(forward, 3)).toBeCloseTo(topArea(reversed, 3), 8);
    });

    it("does not generate a corner join for detached endpoints", () => {
        const cells = buildWallPrisms([
            input(wall("corner-a", 0, 0, 2, 0, 0.15)),
            input(wall("corner-b", 0.001, 0, 0.001, 2, 0.15)),
        ], 1, 1);
        expect(cells.some(cell => cell.wallId === "corner-a" && cell.polygon.length > 4)).toBe(false);
    });

    it("does not bridge small detached collinear endpoints", () => {
        const specs = [input(wall("a", 0, 0, 1, 0)), input(wall("b", 1.002, 0, 2, 0))];
        const cells = buildWallPrisms(specs, 1, 1);
        expect(cells.filter(c => contains(c, 0.501, -0.5, 1))).toHaveLength(0);
        expect(volume(cells)).toBeCloseTo(1.998 * 0.2 * 3, 10);
    });

    it("preserves different heights and an opening at a junction", () => {
        const host = input(wall("host", 0, 0, 4, 0, 0.4, 2));
        const branch = input(wall("branch", 2, 0, 2, 2, 0.2, 4));
        expect(volume(buildWallPrisms([host, branch], 1, 1))).toBeCloseTo(4 * 0.4 * 2 + 2 * 0.2 * 4 - 0.04 * 2);
        host.solids = [{ tStart: 0, tEnd: 4, yStart: 1.5, yEnd: 2 }];
        const cells = buildWallPrisms([host, branch], 1, 1);
        expect(cells.some(c => contains(c, 1.5, -0.6, 1))).toBe(false);
        expect(volume(cells)).toBeCloseTo(4 * 0.4 * 0.5 + 2 * 0.2 * 4 - 0.04 * 0.5);
    });

    it("emits outward-facing triangles with the expected solid volume", () => {
        const spec = input(wall("a", 0, 0, 2, 1));
        const geometry = buildWallSolidGeometries([spec], 1, 1).get("a")!;
        const position = geometry.getAttribute("position");
        let signedVolume = 0;
        for (let i = 0; i < position.count; i += 3) {
            const a = new Vector3().fromBufferAttribute(position, i);
            const b = new Vector3().fromBufferAttribute(position, i + 1);
            const c = new Vector3().fromBufferAttribute(position, i + 2);
            signedVolume += a.dot(b.cross(c)) / 6;
        }
        expect(signedVolume).toBeCloseTo(Math.sqrt(5) * 0.2 * 3, 5);
        geometry.dispose();
    });
});
