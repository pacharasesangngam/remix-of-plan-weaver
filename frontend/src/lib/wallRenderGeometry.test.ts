import { describe, expect, it } from "vitest";
import type { DetectedWallSegment as Wall, DetectedDoor, DetectedWindow } from "@/types/detection";
import { buildWallPrisms, buildWallSolidGeometries, wallFrame } from "./wallSolidGeometry";
import { wallFootprintPaths, wallSolidInputs } from "./wallRenderGeometry";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number, thickness = 0.2): Wall =>
  ({ id, x1, y1, x2, y2, thickness, wallHeight: 3, type: "interior" });
const polygons = (path: string) => path.split("Z").filter(p => p.trim()).map(p =>
  [...p.matchAll(/[ML]([^, ]+),([^ ]+)/g)].map(m => ({ x: Number(m[1]), y: Number(m[2]) })));
const contains = (polygon: { x: number; y: number }[], x: number, y: number) => polygon.every((p, i) => {
  const q = polygon[(i + 1) % polygon.length];
  return (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x) >= -1e-12;
});

describe("Review projection of the 3D wall solids", () => {
  it.each([
    [0, 0, 1, 0], [0.1, 0.3, 0.8, 0.3], [0.3, 0.1, 0.3, 0.8],
    [0.1, 0.2, 0.8, 0.7], [0.8, 0.7, 0.1, 0.2],
  ])("keeps free caps at stored endpoints with perpendicular thickness (%s,%s,%s,%s)", (x1, y1, x2, y2) => {
    for (const thickness of [0.01, 0.2, 0.6]) for (const [pw, ph] of [[12, 7], [18, 10.5]]) {
      const w = wall("a", x1, y1, x2, y2, thickness), before = structuredClone(w);
      const inputs = wallSolidInputs([w], [], [], 3, pw, ph);
      const points = polygons(wallFootprintPaths(inputs, pw, ph).get("a")!).flat();
      const f = wallFrame(w, pw, ph);
      const along = points.map(p => (p.x - x1) * pw * f.ux + (p.y - y1) * ph * f.uz);
      const across = points.map(p => -(p.x - x1) * pw * f.uz + (p.y - y1) * ph * f.ux);
      expect(Math.min(...along)).toBeCloseTo(0, 9);
      expect(Math.max(...along)).toBeCloseTo(f.length, 9);
      expect(Math.min(...across)).toBeCloseTo(-thickness / 2, 9);
      expect(Math.max(...across)).toBeCloseTo(thickness / 2, 9);
      const meshes = buildWallSolidGeometries(inputs, pw, ph);
      const mesh = meshes.get("a")!;
      mesh.computeBoundingBox();
      expect(mesh.boundingBox!.max.x - mesh.boundingBox!.min.x).toBeCloseTo(f.length, 5);
      expect(w).toEqual(before);
      meshes.forEach(g => g.dispose());
    }
  });

  it.each(["L", "T", "oblique", "reversed"])("projects the same occupied junction envelope for %s", kind => {
    const a = wall("a", 0.2, 0.5, 0.5, 0.5, 0.4);
    const b = kind === "T" ? wall("b", 0.5, 0.2, 0.5, 0.8)
      : wall("b", 0.5, 0.5, kind === "oblique" ? 0.7 : 0.5, 0.8);
    const walls = kind === "reversed" ? [b, a].map(w => ({ ...w, x1: w.x2, y1: w.y2, x2: w.x1, y2: w.y1 })) : [a, b];
    const inputs = wallSolidInputs(walls, [], [], 3, 12, 7);
    const cells = buildWallPrisms(inputs, 12, 7);
    const projected = [...wallFootprintPaths(inputs, 12, 7).values()].flatMap(polygons);
    for (let x = 0.44; x < 0.56; x += 0.0037) for (let y = 0.43; y < 0.57; y += 0.0031) {
      const occupied3D = cells.some(c => contains(c.polygon.map(p => ({ x: p.x, y: p.z })), x * 12 - 6, y * 7 - 3.5));
      expect(projected.some(p => contains(p, x, y))).toBe(occupied3D);
    }
    expect(projected.some(p => contains(p, 0.5, 0.5))).toBe(true);
  });

  it("retains door/window hosts, cut intervals and records through thickness and scale changes", () => {
    const w = wall("a", 0.1, 0.5, 0.9, 0.5);
    const door: DetectedDoor = { id: "d", wallId: "a", bbox: { x: 0.2, y: 0.49, w: 0.1, h: 0.02 } };
    const window: DetectedWindow = { id: "v", wallId: "a", bbox: { x: 0.6, y: 0.49, w: 0.1, h: 0.02 } };
    const before = structuredClone({ w, door, window });
    for (const pw of [12, 18]) for (const thickness of [0.1, 0.4]) {
      const inputs = wallSolidInputs([{ ...w, thickness }], [door], [window], 3, pw, pw / 2);
      const cells = buildWallPrisms(inputs, pw, pw / 2);
      const occupied = (x: number, height: number) => cells.some(c => c.yStart < height && c.yEnd > height
        && contains(c.polygon.map(p => ({ x: p.x, y: p.z })), x * pw - pw / 2, 0));
      expect(occupied(0.25, 1)).toBe(false);
      expect(occupied(0.25, 2.8)).toBe(true);
      expect(occupied(0.65, 1.5)).toBe(false);
      expect(occupied(0.65, 0.5)).toBe(true);
      // Top-down projection includes the lintel/sill, unlike a section through the opening.
      const projected = polygons(wallFootprintPaths(inputs, pw, pw / 2).get("a")!);
      expect(projected.some(p => contains(p, 0.25, 0.5))).toBe(true);
      expect(projected.some(p => contains(p, 0.65, 0.5))).toBe(true);
    }
    expect({ w, door, window }).toEqual(before);
  });
});
