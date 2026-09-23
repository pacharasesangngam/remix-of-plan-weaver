import { describe, expect, it } from "vitest";
import { EdgesGeometry, Vector3 } from "three";
import { buildWallPrisms, buildWallSolidGeometries, wallFrame, type WallSolidInput, type WallPrism } from "./wallSolidGeometry";
import currentProject from "@/test/fixtures/current-wall-junctions.json";

const spec = (id: string, x1: number, z1: number, x2: number, z2: number, thickness = .2, height = 3): WallSolidInput => {
    // Add .5 so these readable test coordinates are also the resulting world coordinates.
    const wall = { id, x1: x1 + .5, y1: z1 + .5, x2: x2 + .5, y2: z2 + .5, thickness, wallHeight: height, type: "interior" as const };
    return { wall, thickness, solids: [{ tStart: 0, tEnd: wallFrame(wall, 1, 1).length, yStart: 0, yEnd: height }] };
};
const contains = (c: WallPrism, x: number, z: number, y = 1) => c.yStart < y && c.yEnd > y && c.polygon.every((p, i) => {
    const q = c.polygon[(i + 1) % c.polygon.length];
    return (q.x - p.x) * (z - p.z) - (q.z - p.z) * (x - p.x) >= -1e-8;
});
const owners = (cells: WallPrism[], x: number, z: number, y = 1) => [...new Set(cells.filter(c => contains(c, x, z, y)).map(c => c.wallId))];
const area = (p: WallPrism["polygon"]) => Math.abs(p.reduce((a, v, i) => {
    const q = p[(i + 1) % p.length]; return a + v.x * q.z - q.x * v.z;
}, 0)) / 2;
const volume = (cells: WallPrism[]) => cells.reduce((a, c) => a + area(c.polygon) * (c.yEnd - c.yStart), 0);

describe("unified finished junctions", () => {
    it("emits only exposed surfaces and conserves volume for the full exported 12-wall project", () => {
        const inputs = currentProject.inputs as unknown as WallSolidInput[];
        const { pw, ph } = currentProject;
        const before = structuredClone(inputs);
        const cells = buildWallPrisms(inputs, pw, ph), geometries = buildWallSolidGeometries(inputs, pw, ph);
        let signedVolume = 0;
        for (const { wall } of inputs) {
            const frame = wallFrame(wall, pw, ph), p = geometries.get(wall.id)!.getAttribute("position");
            const world = (i: number) => {
                const v = new Vector3().fromBufferAttribute(p, i);
                return new Vector3(frame.cx + v.x * frame.ux - v.z * frame.uz, v.y, frame.cz + v.x * frame.uz + v.z * frame.ux);
            };
            for (let i = 0; i < p.count; i += 3) {
                const a = world(i), b = world(i + 1), c = world(i + 2);
                signedVolume += a.dot(b.clone().cross(c)) / 6;
                const n = b.clone().sub(a).cross(c.clone().sub(a));
                if (n.length() < 1e-8) continue;
                const mid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
                const outside = mid.clone().addScaledVector(n.normalize(), 1e-5);
                expect(cells.some(cell => contains(cell, outside.x, outside.z, outside.y))).toBe(false);
            }
        }
        expect(signedVolume).toBeCloseTo(volume(cells), 4);
        expect(inputs).toEqual(before);
        geometries.forEach(g => g.dispose());
    });
    it("keeps L boundaries and physical ownership independent of IDs, order and endpoint direction", () => {
        const original = [spec("a", -2, 0, 0, 0), spec("z", 0, -2, 0, 0)];
        const changed = structuredClone(original).reverse();
        changed.forEach(s => { s.wall.id = s.wall.id === "a" ? "z" : "a";
            [s.wall.x1, s.wall.x2] = [s.wall.x2, s.wall.x1]; [s.wall.y1, s.wall.y2] = [s.wall.y2, s.wall.y1]; });
        const a = buildWallPrisms(original, 1, 1), b = buildWallPrisms(changed, 1, 1);
        expect(owners(a, .05, .05)).toEqual(["z"]); // canonical vertical owner
        expect(owners(b, .05, .05)).toEqual(["a"]);
        expect(owners(a, -.05, .05)).toEqual(["z"]);
        expect(owners(b, -.05, .05)).toEqual(["a"]);
        expect(volume(a)).toBeCloseTo(2.4, 8);
        expect(volume(b)).toBeCloseTo(volume(a), 8);
    });

    it("finishes oblique L and multi-wall exterior sectors without miter spikes", () => {
        for (const extra of [[], [spec("third", 0, 0, -2, 2)]]) {
            const cells = buildWallPrisms([spec("west", -2, 0, 0, 0), spec("north", 0, 0, 1, 2), ...extra], 1, 1);
            expect(owners(cells, .04, -.04)).toHaveLength(1);
        }
        const acute = buildWallPrisms([spec("a", 0, 0, 2, 0), spec("b", 0, 0, 2, .01)], 1, 1);
        expect(Math.min(...acute.flatMap(c => c.polygon.map(p => p.x)))).toBeGreaterThanOrEqual(-.4 - 1e-8);
    });

    it("preserves T host faces, trims an oblique thick branch, and ignores ID priority", () => {
        for (const ids of [["a", "z"], ["z", "a"]]) {
            const cells = buildWallPrisms([spec(ids[0], -2, 0, 2, 0, .2), spec(ids[1], 0, 0, 2, 2, .8)], 1, 1);
            expect(Math.min(...cells.flatMap(c => c.polygon.map(p => p.z)))).toBeCloseTo(-.1, 8);
            expect(owners(cells, .02, .04)).toEqual([ids[0]]);
            expect(owners(cells, .2, .2)).toEqual([ids[1]]);
            expect(owners(cells, .02, -.15)).toEqual([]);
        }
    });

    it("handles a split host with a thickness shoulder and preserves an intentional stub", () => {
        const cells = buildWallPrisms([spec("left", -2, 0, 0, 0, .2), spec("right", 0, 0, .3, 0, .4), spec("branch", 0, 0, 0, 2, .6)], 1, 1);
        expect(owners(cells, -.05, .05)).toEqual(["left"]);
        expect(owners(cells, .05, .15)).toEqual(["right"]);
        expect(owners(cells, -.8, .15)).toEqual([]); // intentional shoulder
        expect(owners(cells, .29, -.15)).toEqual(["right"]); // short but real stub
        expect(owners(cells, .31, -.15)).toEqual([]);
    });

    it("uses only solid incident directions in each height band and preserves openings", () => {
        const a = spec("a", -2, 0, 0, 0), b = spec("b", 0, 0, 0, 2), third = spec("c", 0, 0, 2, 0);
        third.solids[0].yStart = 2;
        const cells = buildWallPrisms([a, b, third], 1, 1);
        expect(owners(cells, .05, -.05, 1)).toHaveLength(1); // L below third wall
        expect(owners(cells, 1, 0, 1)).toEqual([]); // opening stays open
        expect(owners(cells, 1, 0, 2.5)).toEqual(["c"]);
        b.solids[0].yStart = 1.5;
        expect(owners(buildWallPrisms([a, b], 1, 1), .05, -.05, 1)).toEqual([]);
    });

    it("is independent of solid segmentation and tolerates numerical endpoint noise only", () => {
        const a = spec("a", -2, 0, 0, 0), b = spec("b", 0, 0, 0, 2);
        const baseline = volume(buildWallPrisms([a, b], 1, 1));
        a.solids = [{ tStart: 0, tEnd: 1.96, yStart: 0, yEnd: 3 }, { tStart: 1.96, tEnd: 2, yStart: 0, yEnd: 3 }];
        b.wall.x1 += 1e-12;
        expect(volume(buildWallPrisms([b, a], 1, 1))).toBeCloseTo(baseline, 8);
        b.wall.x1 += .001;
        expect(owners(buildWallPrisms([a, b], 1, 1), .05, -.05)).toEqual([]);
    });

    it("partitions multi-wall volume without duplicate occupancy under ID and order changes", () => {
        const specs = [spec("west", -2, 0, 0, 0, .4), spec("east", 0, 0, 2, 0, .4),
            spec("north", 0, 0, 0, 2, .2), spec("diagonal", 0, 0, 2, 2, .3)];
        const before = structuredClone(specs);
        const cells = buildWallPrisms(specs, 1, 1);
        const shuffled = buildWallPrisms([...specs].reverse().map(s => ({ ...s, wall: { ...s.wall, id: 'renamed-' + s.wall.id } })), 1, 1);
        for (let x = -.347; x < .35; x += .031) for (let z = -.247; z < .35; z += .027) {
            expect(owners(cells, x, z).length).toBeLessThanOrEqual(1);
            expect(owners(shuffled, x, z)).toEqual(owners(cells, x, z).map(id => 'renamed-' + id));
        }
        expect(specs).toEqual(before);
    });

    it("removes buried faces and artificial outline edges introduced by unrelated heights", () => {
        const wall = spec("main", 0, 0, 2, 0), far = spec("far", 8, 8, 9, 8, .2, 1);
        const geometry = buildWallSolidGeometries([wall, far], 1, 1).get("main")!;
        const p = geometry.getAttribute("position");
        let buriedTriangles = 0;
        for (let i = 0; i < p.count; i += 3) if ([0, 1, 2].every(j => Math.abs(p.getY(i + j) - 1) < 1e-8)) buriedTriangles++;
        expect(buriedTriangles).toBe(0);
        const edges = new EdgesGeometry(geometry), e = edges.getAttribute("position");
        for (let i = 0; i < e.count; i += 2) expect(Math.abs(e.getY(i) - 1) < 1e-8 && Math.abs(e.getY(i + 1) - 1) < 1e-8).toBe(false);
        let signedVolume = 0;
        for (let i = 0; i < p.count; i += 3) signedVolume += new Vector3().fromBufferAttribute(p, i).dot(
            new Vector3().fromBufferAttribute(p, i + 1).cross(new Vector3().fromBufferAttribute(p, i + 2))) / 6;
        expect(signedVolume).toBeCloseTo(1.2, 6);
        edges.dispose(); geometry.dispose();
    });
});
