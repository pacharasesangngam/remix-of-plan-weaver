import { describe, expect, it } from "vitest";
import type { DetectedWallSegment as Wall } from "@/types/detection";
import { buildWallTopology, deriveRooms, faceArea, roomBoundarySpans } from "./wallTopology";
import { proposeWallLength, chooseLengthAnchor, type GeometrySnapshot, type LengthRequest } from "./wallLengthEdit";
import { parseConfirmedDimensions, preservesConfirmedDimensions, rebindConfirmedDimensions } from "./confirmedDimensions";
import { createFloorPlanProject, parseFloorPlanProject } from "./projectIO";
import { newOpeningRecord, openingGeometry } from "./openingModel";
import { wallSolidInputs } from "./wallRenderGeometry";
import { buildWallSolidGeometries } from "./wallSolidGeometry";
import { Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three";
import { wallFrame } from "./wallSolidGeometry";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall =>
  ({ id, x1: x1 / 20, y1: y1 / 20, x2: x2 / 20, y2: y2 / 20, type: "interior", thickness: 0.15, wallHeight: 2.8 });
const divided = (): GeometrySnapshot => {
  const walls = [wall("top", 0, 0, 13.2, 0), wall("right", 13.2, 0, 13.2, 6), wall("bottom", 0, 6, 13.2, 6),
    wall("left", 0, 0, 0, 6), wall("divider", 5.5, 0, 5.5, 6)];
  return { walls, rooms: deriveRooms(walls, []), doors: [], windows: [] };
};
const apply = (source: GeometrySnapshot, request: Omit<LengthRequest, "anchor">) => {
  const result = proposeWallLength(source, { ...request, anchor: chooseLengthAnchor(source, request.wallId, request.length, 20, 20, request) }, 20, 20);
  if (result.ok === false) throw new Error(result.reason);
  return { ...result.geometry, rooms: deriveRooms(result.geometry.walls, source.rooms) };
};
const partial = { start: { x: 0, y: 0 }, end: { x: 5.5 / 20, y: 0 } };

describe("room boundary and whole-wall dimensions share geometry", () => {
  it("measures the actual L-shaped face and only its portion of a longer boundary wall", () => {
    const walls = [wall("top", 0, 0, 10, 0), wall("right", 10, 0, 10, 6), wall("bottom", 0, 6, 10, 6), wall("left", 0, 0, 0, 6),
      wall("notch-a", 4, 0, 4, 2), wall("notch-b", 4, 2, 7, 2), wall("notch-c", 7, 2, 7, 6)];
    const topology = buildWallTopology(walls), rooms = deriveRooms(walls, []);
    expect(rooms).toHaveLength(2);
    const areas = rooms.map(r => faceArea(r.polygon!, r.holes) * 400).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(24); expect(areas[1]).toBeCloseTo(36);
    const room = rooms.find(r => Math.abs(faceArea(r.polygon!) * 400 - 36) < 1e-8)!;
    const span = roomBoundarySpans(room, topology).find(s => s.wallId === "top")!;
    expect(Math.hypot(span.end.x - span.start.x, span.end.y - span.start.y) * 20).toBeCloseTo(4);
    expect(walls[0].x2 * 20).toBe(10);
  });

  it("confirms 13.20 overall and 5.70 inside it, then preserves the room portion when the overall wall changes", () => {
    const source = divided();
    const overall = apply(source, { wallId: "top", length: 13.2, confirm: true });
    const edited = apply(overall, { wallId: "top", span: partial, length: 5.7, confirm: true });
    expect(edited.walls[0]).toEqual(source.walls[0]);
    expect(edited.walls[4]).toMatchObject({ x1: 5.7 / 20, x2: 5.7 / 20 });
    const areas = edited.rooms.map(r => faceArea(r.polygon!) * 400).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(34.2); expect(areas[1]).toBeCloseTo(45);
    expect(edited.confirmedDimensions?.map(d => d.lengthM)).toEqual([13.2, 5.7]);
    expect(parseConfirmedDimensions(JSON.parse(JSON.stringify(edited.confirmedDimensions)), edited.walls, 20, 20)).toEqual(edited.confirmedDimensions);
    const saved = createFloorPlanProject({ ...edited, calibrationStatus: "calibrated", unit: "m", scale: 1, planWidth: 20, planHeight: 20 });
    expect(parseFloorPlanProject(JSON.parse(JSON.stringify(saved))).meta.confirmedDimensions).toEqual(edited.confirmedDimensions);
    const expanded = apply(edited, { wallId: "top", length: 14, confirm: true });
    expect(expanded.walls[0].x2 * 20).toBeCloseTo(14);
    expect(expanded.walls[4].x1 * 20).toBeCloseTo(5.7);
    expect(expanded.confirmedDimensions?.map(d => d.lengthM)).toEqual([5.7, 14]);
    expect(expanded.walls.map(w => w.id)).toEqual(source.walls.map(w => w.id));
  });

  it("propagates an interior crossing and keeps door/window hosts and sizes while 3D remains one continuous host mesh", () => {
    const source = divided();
    // Crossings with no stored endpoint are also editable boundary junctions.
    source.walls[4] = wall("divider", 5.5, -1, 5.5, 7);
    source.doors = [newOpeningRecord("door", "door", source.walls[4], { x: 5.5 / 20, y: 2 / 20 }, { x: 5.5 / 20, y: 2.9 / 20 }, 20, 20, 2.8)!];
    source.windows = [newOpeningRecord("window", "window", source.walls[0], { x: 8 / 20, y: 0 }, { x: 9.2 / 20, y: 0 }, 20, 20, 2.8)!];
    const beforeDoor = openingGeometry(source.doors[0], "door", source.walls, 20, 20)!;
    const beforeWindow = openingGeometry(source.windows[0], "window", source.walls, 20, 20)!;
    const edited = apply(source, { wallId: "top", span: partial, length: 5.7, confirm: true });
    expect(edited.walls[4].x1 * 20).toBeCloseTo(5.7);
    expect(edited.walls[4].x2 * 20).toBeCloseTo(5.7);
    const afterDoor = openingGeometry(edited.doors[0], "door", edited.walls, 20, 20)!;
    const afterWindow = openingGeometry(edited.windows[0], "window", edited.walls, 20, 20)!;
    expect(afterDoor.width).toBeCloseTo(beforeDoor.width);
    expect(afterDoor.height).toBe(beforeDoor.height);
    expect(afterWindow.width).toBeCloseTo(beforeWindow.width);
    expect(edited.doors[0].wallId).toBe("divider");
    expect(edited.windows[0].wallId).toBe("top");
    const inputs = wallSolidInputs(edited.walls, [], [], 2.8, 20, 20);
    const meshes = buildWallSolidGeometries(inputs, 20, 20);
    expect(meshes.size).toBe(source.walls.length);
    const host = meshes.get("top")!;
    host.computeBoundingBox();
    // Adjacent corner walls own their junction volume; topology adds no new trim.
    const beforeMeshes = buildWallSolidGeometries(wallSolidInputs(source.walls, [], [], 2.8, 20, 20), 20, 20);
    beforeMeshes.get("top")!.computeBoundingBox();
    expect(host.boundingBox).toEqual(beforeMeshes.get("top")!.boundingBox);
    const material = new MeshBasicMaterial();
    const objects = edited.walls.map(w => {
      const frame = wallFrame(w, 20, 20), mesh = new Mesh(meshes.get(w.id), material);
      mesh.position.set(frame.cx, 0, frame.cz); mesh.rotation.y = -Math.atan2(frame.uz, frame.ux); mesh.updateMatrixWorld();
      return mesh;
    });
    // Exactly one visible top surface through the junction, with no cracks or overlapping faces.
    for (const x of [5.59, 5.64, 5.69, 5.7, 5.71, 5.76, 5.81]) {
      const ray = new Raycaster(new Vector3(x - 10, 4, -10.021), new Vector3(0, -1, 0));
      const hits = ray.intersectObjects(objects);
      expect(hits).toHaveLength(1);
      expect(hits[0].point.y).toBeCloseTo(2.8, 5);
    }
    material.dispose(); beforeMeshes.forEach(g => g.dispose());
    meshes.forEach(g => g.dispose());
  });

  it("rejects inconsistent confirmed spans without modifying the source", () => {
    const first = apply(divided(), { wallId: "top", length: 13.2, confirm: true });
    const source = apply(first, { wallId: "top", span: partial, length: 5.7, confirm: true });
    const snapshot = structuredClone(source);
    const right = { start: { x: 5.7 / 20, y: 0 }, end: { x: 13.2 / 20, y: 0 } };
    for (const anchor of ["start", "end"] as const) expect(proposeWallLength(source, { wallId: "top", span: right, length: 8, anchor, confirm: true }, 20, 20).ok).toBe(false);
    expect(source).toEqual(snapshot);
    // An ordinary drag cannot leave the saved boundary constraint behind on its host.
    const moved = source.walls.map(w => w.id === "divider" ? { ...w, x1: 0.3, x2: 0.3 } : w);
    expect(preservesConfirmedDimensions(moved, source.confirmedDimensions, 20, 20)).toBe(false);
    const deleted = source.walls.filter(w => w.id !== "divider");
    const remaining = rebindConfirmedDimensions(source.confirmedDimensions, deleted);
    expect(remaining.map(d => d.lengthM)).toEqual([13.2]);
    expect(parseConfirmedDimensions(remaining, deleted, 20, 20)).toEqual(remaining);
  });
});
