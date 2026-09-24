import { describe, it, expect } from "vitest";
import { rectangleRoom, polygonRoom, removeDrawObject, expandDrawingSheet } from "./manualPlan";
import { emptyProject, initialHistory, projectHistoryReducer } from "./projectHistory";
import { createFloorPlanProject, parseFloorPlanProject } from "./projectIO";

describe("manual drawing", () => {
  it("expands the sheet without resizing real-world geometry", () => {
    const result = rectangleRoom({ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.4 }, "r", "Room", 30, 30, 2.8)!;
    const original = { ...emptyProject(), planW: 30, planH: 30, scale: 0.03, rooms: [result.room], walls: result.walls,
      doors: [{ id: "d", wallId: result.walls[0].id, widthM: 0.9, bbox: { x: 0.15, y: 0.1, w: 0.03, h: 0.005 } }] };
    const next = expandDrawingSheet(original);
    expect(next.planW).toBe(60);
    expect(next.rooms[0].width * next.planW).toBeCloseTo(original.rooms[0].width * original.planW);
    expect(next.walls[0].x2 * next.planW).toBeCloseTo(original.walls[0].x2 * original.planW);
    expect(next.doors[0].bbox.w * next.planW).toBeCloseTo(0.9);
    expect(next.walls[0].thickness).toBe(original.walls[0].thickness);
  });
  it("creates concave rooms but rejects crossing wall loops", () => {
    const l = [{ x: 0, y: 0 }, { x: 0.4, y: 0 }, { x: 0.4, y: 0.2 }, { x: 0.2, y: 0.2 }, { x: 0.2, y: 0.4 }, { x: 0, y: 0.4 }];
    expect(polygonRoom(l, "l", "L room", 30, 30, 2.8)?.walls).toHaveLength(6);
    expect(polygonRoom([{ x: 0, y: 0 }, { x: 0.4, y: 0.4 }, { x: 0, y: 0.4 }, { x: 0.4, y: 0 }], "x", "Crossed", 30, 30, 2.8)).toBeNull();
  });
  const room = rectangleRoom({ x: 0.3, y: 0.4 }, { x: 0.1, y: 0.1 }, "r1", "Room", 20, 20, 2.8)!;
  it("creates a room and four normalized walls from either corner direction", () => {
    expect(room.room.bbox!.w * 20).toBeCloseTo(4);
    expect(room.room.bbox!.h * 20).toBeCloseTo(6);
    expect(room.walls).toHaveLength(4);
    expect(room.walls[3].x2).toBe(room.walls[0].x1);
    expect(room.room.wallHeight).toBe(2.8);
    expect(rectangleRoom({ x: 0, y: 0 }, { x: 0.001, y: 0.5 }, "r", "Room", 20, 20, 2.8)).toBeNull();
  });
  it("undoes a whole room in one action and restores it with redo", () => {
    const history = projectHistoryReducer(initialHistory(), { type: "edit", info: { label: "room creation" }, update: p => ({ ...p, rooms: [room.room], walls: room.walls }) });
    const undone = projectHistoryReducer(history, { type: "undo" });
    expect(undone.present.walls).toHaveLength(0);
    expect(undone.present.rooms).toHaveLength(0);
    expect(projectHistoryReducer(undone, { type: "redo" }).present.walls).toEqual(room.walls);
  });
  it("deletes room walls and attached openings without removing unrelated objects", () => {
    const state = { ...emptyProject(), rooms: [room.room], walls: [...room.walls, { ...room.walls[0], id: "other" }], doors: [
      { id: "d1", wallId: room.walls[0].id, bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.01 } },
      { id: "d2", wallId: "other", bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.01 } },
    ] };
    const next = removeDrawObject(state, { type: "room", id: "r1" });
    expect(next.rooms).toHaveLength(0);
    expect(next.walls.map(w => w.id)).toEqual(["other"]);
    expect(next.doors.map(d => d.id)).toEqual(["d2"]);
  });
  it("keeps drawing mode and geometry in saved projects", () => {
    const saved = createFloorPlanProject({ editorMode: "draw", unit: "m", scale: 0.02, planWidth: 20, planHeight: 20, rooms: [room.room], walls: room.walls, doors: [], windows: [] });
    const loaded = parseFloorPlanProject(JSON.parse(JSON.stringify(saved)));
    expect(loaded.meta.editorMode).toBe("draw");
    expect(loaded.walls).toEqual(room.walls);
    expect(loaded.image).toBeNull();
  });
});
