import { afterEach, expect, it, vi } from "vitest";
import type { Mesh, Scene } from "three";
import { exportFloorPlanGlb } from "./blenderExport";
import { buildWallSolidGeometries, wallFrame } from "./wallSolidGeometry";
import type { DetectedWallSegment } from "@/types/detection";

const captured = vi.hoisted(() => ({ scene: null as Scene | null }));
vi.mock("three/examples/jsm/exporters/GLTFExporter.js", () => ({ GLTFExporter: class {
    parse(scene: Scene, complete: (buffer: ArrayBuffer) => void) {
        captured.scene = scene;
        complete(new ArrayBuffer(8));
    }
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("exports the same junction mesh used by preview without straightening, merging, or renaming walls", async () => {
    const walls: DetectedWallSegment[] = [
        { id: "host", x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.6, type: "interior", thickness: 0.35, wallHeight: 2.7 },
        { id: "branch", x1: 0.5, y1: 0.4, x2: 0.3, y2: 0.8, type: "interior", thickness: 0.17, wallHeight: 3.2 },
        { id: "short-wall", x1: 0.02, y1: 0.02, x2: 0.022, y2: 0.023, type: "interior", thickness: 0.1, wallHeight: 2.4 },
    ];
    const original = structuredClone(walls);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", { createObjectURL: () => "blob:test", revokeObjectURL: vi.fn() });
    const pw = 12, ph = 8;
    const expected = buildWallSolidGeometries(walls.map(wall => ({ wall, thickness: wall.thickness!, solids: [
        { tStart: 0, tEnd: wallFrame(wall, pw, ph).length, yStart: 0, yEnd: wall.wallHeight! },
    ] })), pw, ph);
    await exportFloorPlanGlb({ rooms: [], walls, doors: [], windows: [], planWidth: pw, planHeight: ph });
    const group = captured.scene!.getObjectByName("Walls")!;
    expect(group.children.map(child => child.name)).toEqual(walls.map(wall => wall.id));
    for (const wall of walls) {
        const wallGroup = group.getObjectByName(wall.id)!;
        const mesh = wallGroup.children[0] as Mesh;
        const frame = wallFrame(wall, pw, ph);
        expect(wallGroup.position.x).toBe(frame.cx);
        expect(wallGroup.position.z).toBe(frame.cz);
        expect(wallGroup.rotation.y).toBe(-Math.atan2(frame.uz, frame.ux));
        expect(mesh.geometry.getAttribute("position").array).toEqual(expected.get(wall.id)!.getAttribute("position").array);
        expect(wallGroup.userData.id).toBe(wall.id);
        mesh.geometry.dispose();
    }
    expect(walls).toEqual(original);
    expected.forEach(geometry => geometry.dispose());
});

it("uses an opening's saved wall attachment for its exported mesh", async () => {
    const walls: DetectedWallSegment[] = [
        { id: "horizontal", x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, type: "interior" },
        { id: "vertical", x1: 0.5, y1: 0.1, x2: 0.5, y2: 0.9, type: "interior" },
    ];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", { createObjectURL: () => "blob:test", revokeObjectURL: vi.fn() });

    await exportFloorPlanGlb({
        rooms: [], walls, windows: [], planWidth: 10, planHeight: 10,
        doors: [{ id: "attached-door", wallId: "vertical", bbox: { x: 0.49, y: 0.4, w: 0.02, h: 0.2 } }],
    });

    const door = captured.scene!.getObjectByName("Doors")!.getObjectByName("attached-door")!;
    expect(door.rotation.y).toBeCloseTo(-Math.PI / 2);
});
