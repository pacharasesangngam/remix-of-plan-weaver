import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { snapWallDrawPoint, wallDrawConnections, finishWallDraw, duplicateWall, MIN_WALL_LENGTH_M } from "./wallDrawing";
import { buildWallPrisms, type WallSolidInput } from "./wallSolidGeometry";
import type { DetectedWallSegment as Wall } from "@/types/detection";

const wallA: Wall = { id: "a", x1: 0.2, y1: 0.3, x2: 0.6, y2: 0.3, type: "interior", thickness: 0.2, wallHeight: 3 };
const wallB: Wall = { id: "b", x1: 0.6, y1: 0.3, x2: 0.6, y2: 0.7, type: "interior", thickness: 0.2, wallHeight: 3 };
const size = { width: 1000, height: 500 };

describe("shared wall draw snapping", () => {
  it("snaps to an endpoint within radius, prefers endpoint over interior, and copies exact coordinates", () => {
    // 0.206, 0.308 is 6 px and 4 px away on a 1000 x 500 canvas (screen distance = 7.2 px < 12 px)
    const { point, snap } = snapWallDrawPoint({ x: 0.206, y: 0.308 }, [wallA], size);
    expect(point).toEqual({ x: 0.2, y: 0.3 });
    expect(snap).toMatchObject({ kind: "endpoint", wallId: "a", end: "start", x: 0.2, y: 0.3 });

    // Free point far away stays free
    const free = snapWallDrawPoint({ x: 0.8, y: 0.8 }, [wallA], size);
    expect(free.point).toEqual({ x: 0.8, y: 0.8 });
    expect(free.snap).toBeNull();
  });

  it("snaps to wall interior (T-junction) with exact projection when near centerline", () => {
    // Near midpoint of wallA (x=0.4, y=0.3), offset in Y by 0.015 (7.5 px < 12 px)
    const { point, snap } = snapWallDrawPoint({ x: 0.402, y: 0.315 }, [wallA], size);
    expect(point.y).toBeCloseTo(0.3, 8);
    expect(point.x).toBeCloseTo(0.402, 8);
    expect(snap).toMatchObject({ kind: "junction", wallId: "a" });
    expect(snap!.t).toBeCloseTo((0.402 - 0.2) / 0.4, 6);
  });

  it("previews T-junction and endpoint connections on a draft wall", () => {
    // Draft starting at T-junction on wallA and ending at start of wallB
    const draft: Wall = { id: "draft", x1: 0.4, y1: 0.3, x2: 0.6, y2: 0.3, type: "interior" };
    const connections = wallDrawConnections(draft, [wallA, wallB], size);
    expect(connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "junction", wallId: "a" }),
      expect.objectContaining({ kind: "endpoint", wallId: "a", end: "end" }),
      expect.objectContaining({ kind: "endpoint", wallId: "b", end: "start" }),
    ]));
  });

  it("rejects duplicates and drafts shorter than the minimum physical length", () => {
    const spec = { id: "new-wall", thickness: 0.2, wallHeight: 3, type: "interior" as const };
    // Short draft (< 0.05m on a 20x20 plan: delta = 0.001 -> 0.02m)
    expect(finishWallDraw({ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.5 }, [wallA], size, 20, 20, spec)).toBeNull();
    // Duplicate of wallA
    expect(finishWallDraw({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.3 }, [wallA], size, 20, 20, spec)).toBeNull();
  });

  it("commits exact coordinates so 3D prisms leave no gaps at a T-junction", () => {
    const spec = { id: "stem", thickness: 0.2, wallHeight: 3, type: "interior" as const };
    // User clicks roughly near the midpoint of wallA and pulls straight down
    const committed = finishWallDraw({ x: 0.402, y: 0.312 }, { x: 0.402, y: 0.6 }, [wallA], size, 20, 20, spec);
    expect(committed).not.toBeNull();
    const stem = committed!.wall;
    // Exactly on wallA's centerline
    expect(stem.y1).toBe(0.3);

    // Feed to 3D geometry engine
    const inputs: WallSolidInput[] = [
      { wall: wallA, thickness: 0.2, solids: [{ tStart: 0, tEnd: 8, yStart: 0, yEnd: 3 }] },
      { wall: stem, thickness: 0.2, solids: [{ tStart: 0, tEnd: 6, yStart: 0, yEnd: 3 }] },
    ];
    // No gaps or overlap in physical cells
    const prisms = buildWallPrisms(inputs, 20, 20);
    expect(prisms.length).toBeGreaterThanOrEqual(2);
    const area = prisms.reduce((sum, prism) => sum + Math.abs(prism.polygon.reduce((cross, p, i, points) => {
      const q = points[(i + 1) % points.length];
      return cross + p.x * q.z - q.x * p.z;
    }, 0)) / 2, 0);
    expect(area).toBeCloseTo(8 * 0.2 + 6 * 0.2 - 0.1 * 0.2, 9);
    // Wall prisms partition the union without orphan holes
    for (const prism of prisms) {
      expect(prism.polygon.length).toBeGreaterThanOrEqual(3);
    }
  });
});


it.each([1, 2])("uses the same pixel radius and exact junction coordinates through a perspective camera at zoom %s", zoom => {
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 100);
  camera.position.set(0, 18, 12); camera.lookAt(0, 0, 0); camera.zoom = zoom;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const project = (p: { x: number; y: number }) => {
    const v = new THREE.Vector3((p.x - 0.5) * 20, 0.06, (p.y - 0.5) * 20).project(camera);
    return { x: (v.x + 1) * 500, y: (1 - v.y) * 250 };
  };
  const unproject = (p: { x: number; y: number }) => {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(p.x / 500 - 1, 1 - p.y / 250), camera);
    const v = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.06), new THREE.Vector3())!;
    return { x: v.x / 20 + 0.5, y: v.z / 20 + 0.5 };
  };
  const size = { width: 20, height: 20, project, unproject };
  for (const point of [{ x: wallA.x1, y: wallA.y1 }, { x: 0.4, y: 0.3 }]) {
    const pixel = project(point);
    const near = unproject({ x: pixel.x, y: pixel.y + 8 });
    const snap = snapWallDrawPoint(near, [wallA], size);
    expect(snap.snap?.kind).toBe(point.x === wallA.x1 ? "endpoint" : "junction");
    expect(snap.point.x).toBeCloseTo(point.x, 10); expect(snap.point.y).toBeCloseTo(point.y, 10);
    expect(snapWallDrawPoint(unproject({ x: pixel.x, y: pixel.y + 20 }), [wallA], size).snap).toBeNull();
    const result = finishWallDraw(snap.point, { x: 0.4, y: 0.7 }, [wallA], size, 20, 20,
      { id: "new", thickness: 0.2, wallHeight: 3.4, type: "interior" })!;
    expect(result.wall.x1).toBeCloseTo(snap.point.x, 10);
    expect(result.wall.y1).toBeCloseTo(snap.point.y, 10);
    expect(result.connections).toEqual(wallDrawConnections(result.wall, [wallA], size));
  }
});

it("previews interior crossings and both T-junctions on the same host", () => {
  const draft = { ...wallA, id: "draft", x1: 0.4, y1: 0.1, x2: 0.4, y2: 0.8 };
  expect(wallDrawConnections(draft, [wallA], size)).toContainEqual(expect.objectContaining({ kind: "junction", x: 0.4, y: 0.3 }));
  const along = { ...wallA, id: "draft", x1: 0.3, x2: 0.5 };
  expect(wallDrawConnections(along, [wallA], size).filter(p => p.kind === "junction")).toHaveLength(2);
});
