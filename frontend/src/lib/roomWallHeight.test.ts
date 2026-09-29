import { expect, it } from "vitest";
import { emptyProject, initialHistory, projectHistoryReducer } from "./projectHistory";
import { roomBoundaryWalls, roomWallHeightMinimum, setRoomWallHeight } from "./roomWallHeight";
import { newOpeningRecord, openingGeometry } from "./openingModel";
import { wallSolidInputs } from "./wallRenderGeometry";
import { buildWallSolidGeometries } from "./wallSolidGeometry";

export function adjacentRooms() {
  const segments = [[0.1, 0.1, 0.5, 0.1], [0.5, 0.1, 0.5, 0.7], [0.5, 0.7, 0.1, 0.7], [0.1, 0.7, 0.1, 0.1],
    [0.5, 0.1, 0.9, 0.1], [0.9, 0.1, 0.9, 0.7], [0.9, 0.7, 0.5, 0.7]];
  const walls = segments.map(([x1, y1, x2, y2], i) => ({ id: `wall-${i}`, x1, y1, x2, y2, type: "interior" as const, thickness: 0.15, wallHeight: 2.8 }));
  const doors = [newOpeningRecord("door", "door", walls[1], { x: 0.5, y: 0.3 }, { x: 0.5, y: 0.4 }, 10, 10)!];
  const windows = [newOpeningRecord("window", "window", walls[0], { x: 0.2, y: 0.1 }, { x: 0.3, y: 0.1 }, 10, 10)!];
  return initialHistory({ ...emptyProject(), calibrationStatus: "calibrated", scale: 0.01, planW: 10, planH: 10, walls, doors, windows });
}

it("updates actual boundaries including the shared wall, preserves openings and scale, and undoes atomically", () => {
  const history = adjacentRooms(), before = history.present;
  const room = before.rooms.find(r => r.center!.x < 0.5)!;
  const right = before.rooms.find(r => r.center!.x > 0.5)!;
  const after = projectHistoryReducer(history, { type: "edit", update: p => setRoomWallHeight(p, room.id, 3.5), info: { label: "room wall height" } });
  const project = after.present;
  expect(roomBoundaryWalls(project.rooms.find(r => r.id === room.id)!, project.walls).map(w => w.wallHeight)).toEqual([3.5, 3.5, 3.5, 3.5]);
  expect(roomBoundaryWalls(right, project.walls).find(w => w.id === "wall-1")!.wallHeight).toBe(3.5);
  expect(project.walls).toHaveLength(7);
  expect(project.walls.slice(4)).toEqual(before.walls.slice(4));
  for (const kind of ["door", "window"] as const) {
    const items = kind === "door" ? "doors" : "windows";
    const old = openingGeometry(before[items][0], kind, before.walls, 10, 10)!;
    const updated = openingGeometry(project[items][0], kind, project.walls, 10, 10)!;
    expect([updated.width, updated.height, updated.sill, updated.start, updated.end]).toEqual([old.width, old.height, old.sill, old.start, old.end]);
  }
  expect([project.planW, project.planH, project.scale, project.wallHeightMeter]).toEqual([10, 10, 0.01, 2.8]);
  expect(after.past).toHaveLength(1);
  expect(projectHistoryReducer(after, { type: "undo" }).present).toEqual(before);
  expect(projectHistoryReducer(projectHistoryReducer(after, { type: "undo" }), { type: "redo" }).present).toEqual(project);
});

it("updates rendered geometry and wall surface quantities from the same boundary records", () => {
  const { present } = adjacentRooms();
  const room = present.rooms.find(r => r.center!.x < 0.5)!;
  const updated = setRoomWallHeight(present, room.id, 3.5);
  const inputs = (p: typeof present) => wallSolidInputs(p.walls, p.doors, p.windows, p.wallHeightMeter, p.planW, p.planH);
  const area = (p: typeof present) => inputs(p).reduce((sum, input) => sum + input.solids.reduce((n, s) => n + (s.tEnd - s.tStart) * (s.yEnd - s.yStart), 0), 0);
  expect(area(updated) - area(present)).toBeCloseTo(20 * 0.7, 10);
  const meshes = buildWallSolidGeometries(inputs(updated), 10, 10);
  meshes.get("wall-1")!.computeBoundingBox();
  expect(meshes.get("wall-1")!.boundingBox!.max.y).toBeCloseTo(3.5);
  meshes.forEach(mesh => mesh.dispose());
});

it("rejects a height that would shrink an opening and supports rooms without cached boundary IDs", () => {
  const { present } = adjacentRooms();
  const room = present.rooms.find(r => r.center!.x < 0.5)!;
  expect(roomWallHeightMinimum(present, room.id)).toBeGreaterThan(2);
  expect(setRoomWallHeight(present, room.id, 1)).toBe(present);
  expect(setRoomWallHeight(present, room.id, NaN)).toBe(present);
  expect(roomBoundaryWalls({ ...room, topologyWallIds: undefined }, present.walls)).toEqual(roomBoundaryWalls(room, present.walls));
});
