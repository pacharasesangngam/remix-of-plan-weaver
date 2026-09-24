import { expect, it } from "vitest";
import { rectangleRoom } from "./manualPlan";
import { emptyProject } from "./projectHistory";
import { moveDrawObject } from "./moveDrawObject";

const room = rectangleRoom({ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }, "r", "Room", 30, 30, 2.8)!;
const state = { ...emptyProject(), planW: 30, planH: 30, rooms: [room.room], walls: room.walls,
  doors: [{ id: "d", wallId: room.walls[0].id, widthM: 0.9, bbox: { x: 0.15, y: 0.0975, w: 0.03, h: 0.005 } }],
  windows: [{ id: "w", wallId: room.walls[0].id, widthM: 1.2, bbox: { x: 0.3, y: 0.0975, w: 0.04, h: 0.005 } }],
};
it("moves the room, its walls and openings together without mutating the source", () => {
  const next = moveDrawObject(state, { type: "room", id: "r" }, { x: 0.2, y: 0.1 });
  expect(next.rooms[0].bbox!.x).toBeCloseTo(0.3);
  expect(next.rooms[0].polygon![0].y).toBeCloseTo(0.2);
  expect(next.walls[0].x1).toBeCloseTo(0.3);
  expect(next.doors[0].bbox.x).toBeCloseTo(0.35);
  expect(next.windows[0].bbox.y).toBeCloseTo(0.1975);
  expect(state.walls[0].x1).toBe(0.1);
});
it("moves only the selected wall and its attached openings", () => {
  const next = moveDrawObject(state, { type: "wall", id: room.walls[0].id }, { x: 0, y: 0.1 });
  expect(next.walls[0].y1).toBeCloseTo(0.2);
  expect(next.walls[1]).toBe(state.walls[1]);
  expect(next.rooms[0]).toBe(state.rooms[0]);
  expect(next.doors[0].bbox.y).toBeCloseTo(0.1975);
});
it("keeps a moved group inside the drawing boundary", () => {
  const next = moveDrawObject(state, { type: "room", id: "r" }, { x: 2, y: -2 });
  expect(next.rooms[0].bbox!.x + next.rooms[0].bbox!.w).toBeCloseTo(1);
  expect(next.rooms[0].bbox!.y).toBeCloseTo(0);
});
it("slides openings along their wall and rejects collisions", () => {
  const next = moveDrawObject(state, { type: "door", id: "d" }, { x: 0.05, y: 0.3 });
  expect(next.doors[0].bbox.x).toBeCloseTo(0.2);
  expect(next.doors[0].bbox.y).toBeCloseTo(state.doors[0].bbox.y);
  expect(next.doors[0].wallId).toBe(state.doors[0].wallId);
  expect(moveDrawObject(state, { type: "door", id: "d" }, { x: 0.15, y: 0 })).toBe(state);
  expect(moveDrawObject(state, { type: "window", id: "w" }, { x: 3, y: 0 }).windows[0].bbox.x).toBeCloseTo(0.36);
});
