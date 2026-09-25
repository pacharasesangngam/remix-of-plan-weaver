import { describe, expect, it } from "vitest";
import type { DetectedWallSegment as Wall } from "@/types/detection";
import type { NormalizedPoint as Point, Room } from "@/types/floorplan";
import { buildWallTopology, deriveRooms, faceArea, pointInPolygon, polygonArea, ringsToPathD } from "./wallTopology";
import { emptyProject, initialHistory, projectHistoryReducer } from "./projectHistory";

const at = (...values: [number, number][]): Point[] => values.map(([x, y]) => ({ x, y }));
/** Wall segments along a vertex chain; a closed loop repeats its first vertex. */
const chain = (vertices: Point[], prefix: string): Wall[] => vertices.slice(0, -1).map((point, index) => ({
  id: `${prefix}${index}`, type: "interior", x1: point.x, y1: point.y, x2: vertices[index + 1].x, y2: vertices[index + 1].y,
}));
const loop = (vertices: Point[], prefix = "w") => chain([...vertices, vertices[0]], prefix);
const square = (x: number, y: number, w: number, h: number) => at([x, y], [x + w, y], [x + w, y + h], [x, y + h]);
const roomAt = (polygon: Point[], extra: Partial<Room> = {}): Room => ({
  id: "room", name: "Living", confidence: "high", width: 0, height: 0, polygon, wallPolygon: polygon, ...extra,
});
const rectangle = () => loop(square(0.1, 0.1, 0.4, 0.3));
const areaOf = (room: Room) => faceArea(room.polygon!, room.holes);
const partition: Wall = { id: "partition", type: "interior", x1: 0.3, y1: 0.1, x2: 0.3, y2: 0.4 };

describe("wall topology rooms", () => {
  it("turns a closed rectangle into one room of the enclosed size", () => {
    const topology = buildWallTopology(rectangle());
    expect(topology.faces).toHaveLength(1);
    expect(topology.faces[0].holes).toEqual([]);
    expect(polygonArea(topology.faces[0].polygon)).toBeCloseTo(0.12, 10);
    const rooms = deriveRooms(rectangle(), []);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].width).toBeCloseTo(0.4, 10);
    expect(rooms[0].height).toBeCloseTo(0.3, 10);
    expect(rooms[0].bbox!.x).toBeCloseTo(0.1, 9);
    expect(rooms[0].bbox!.y).toBeCloseTo(0.1, 9);
    expect(rooms[0].center!.x).toBeCloseTo(0.3, 9);
    expect(rooms[0].center!.y).toBeCloseTo(0.25, 9);
    expect(rooms[0].polygon).toHaveLength(4);
    expect(rooms[0].wallPolygon).toEqual(rooms[0].polygon);
    expect(rooms[0].topologyWallIds).toHaveLength(4);
  });

  it("leaves real gaps open instead of inventing a room", () => {
    const open = rectangle().slice(0, 3);
    expect(buildWallTopology(open).faces).toEqual([]);
    expect(deriveRooms(open, [])).toEqual([]);
  });

  it("splits walls at T junctions without mutating the stored walls", () => {
    const walls: Wall[] = [
      { id: "top", type: "interior", x1: 0, y1: 0, x2: 0.6, y2: 0 },
      { id: "right", type: "interior", x1: 0.6, y1: 0, x2: 0.6, y2: 0.4 },
      { id: "bottom", type: "interior", x1: 0.6, y1: 0.4, x2: 0, y2: 0.4 },
      { id: "left", type: "interior", x1: 0, y1: 0.4, x2: 0, y2: 0 },
      { id: "partition", type: "interior", x1: 0.3, y1: 0, x2: 0.3, y2: 0.4 },
    ];
    const snapshot = JSON.parse(JSON.stringify(walls)) as Wall[];
    const topology = buildWallTopology(walls);
    expect(topology.nodes).toHaveLength(6);
    expect(topology.edges).toHaveLength(7);
    expect(topology.faces).toHaveLength(2);
    topology.faces.forEach(face => expect(Math.abs(polygonArea(face.polygon))).toBeCloseTo(0.12, 10));
    expect(walls).toEqual(snapshot);
  });

  it("splits two crossing diagonals at their real intersection point", () => {
    const walls: Wall[] = [...loop(square(0, 0, 0.6, 0.6), "s"),
      { id: "d1", type: "interior", x1: 0, y1: 0, x2: 0.6, y2: 0.6 },
      { id: "d2", type: "interior", x1: 0.6, y1: 0, x2: 0, y2: 0.6 }];
    const topology = buildWallTopology(walls);
    expect(topology.nodes.some(node => Math.abs(node.x - 0.3) < 1e-12 && Math.abs(node.y - 0.3) < 1e-12)).toBe(true);
    expect(topology.faces).toHaveLength(4);
    expect(topology.faces.reduce((sum, face) => sum + Math.abs(polygonArea(face.polygon)), 0)).toBeCloseTo(0.36, 10);
    expect(deriveRooms(walls, [])).toHaveLength(4);
  });

  it("ignores a dangling wall that cannot enclose area", () => {
    const stub: Wall = { id: "stub", type: "interior", x1: 0.1, y1: 0.25, x2: 0.3, y2: 0.25 };
    const walls = [...rectangle(), stub];
    const topology = buildWallTopology(walls);
    expect(topology.faces).toHaveLength(1);
    expect(topology.edges.some(edge => edge.wallIds.includes("stub"))).toBe(true);
    expect(deriveRooms(walls, [])).toHaveLength(1);
  });

  it("keeps concave rooms whole and puts the label point inside them", () => {
    const l = loop(at([0, 0], [0.4, 0], [0.4, 0.2], [0.2, 0.2], [0.2, 0.4], [0, 0.4]));
    const topology = buildWallTopology(l);
    expect(topology.faces).toHaveLength(1);
    expect(topology.faces[0].polygon).toHaveLength(6);
    expect(polygonArea(topology.faces[0].polygon)).toBeCloseTo(0.12, 10);
    const room = deriveRooms(l, [])[0];
    expect(pointInPolygon(room.center!, room.polygon!)).toBe(true);
  });

  it("treats a disconnected inner enclosure as a hole and as its own room", () => {
    const walls = [...loop(square(0, 0, 0.6, 0.6), "outer"), ...loop(square(0.2, 0.2, 0.2, 0.2), "inner")];
    const faces = buildWallTopology(walls).faces;
    expect(faces).toHaveLength(2);
    const outer = faces.find(face => Math.abs(polygonArea(face.polygon)) > 0.3)!;
    expect(outer.holes).toHaveLength(1);
    expect(faceArea(outer.polygon, outer.holes)).toBeCloseTo(0.32, 10);
    const rooms = deriveRooms(walls, []);
    expect(rooms).toHaveLength(2);
    expect(rooms.reduce((sum, room) => sum + areaOf(room), 0)).toBeCloseTo(0.36, 10);
    rooms.forEach(room => expect(ringsToPathD([room.polygon, ...(room.holes ?? [])]).match(/Z/g)).toHaveLength((room.holes ?? []).length + 1));
  });

  it("keeps room identity when a wall splits a room and names the remaining region", () => {
    const walls = rectangle();
    const first = deriveRooms(walls, [roomAt(square(0.1, 0.1, 0.4, 0.3), { material: "tile", tileCode: "T1", wallHeight: 3 })]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: "room", name: "Living", material: "tile", tileCode: "T1", wallHeight: 3 });
    const split = deriveRooms([...walls, partition], first);
    expect(split).toHaveLength(2);
    const kept = split.filter(room => room.name === "Living");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: "room", material: "tile", tileCode: "T1", wallHeight: 3 });
    split.forEach(room => expect(areaOf(room)).toBeCloseTo(0.06, 10));
  });

  it("keeps a room when the plan moves and drops it when a wall is deleted", () => {
    const walls = rectangle();
    const first = deriveRooms(walls, [roomAt(square(0.1, 0.1, 0.4, 0.3))]);
    const moved = deriveRooms(walls.map(wall => ({ ...wall, x1: wall.x1 + 0.05, x2: wall.x2 + 0.05 })), first);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ id: "room", name: "Living" });
    expect(moved[0].bbox!.x).toBeCloseTo(0.15, 9);
    expect(deriveRooms(walls.slice(0, 3), moved)).toEqual([]);
    const far = deriveRooms(loop(square(0.7, 0.7, 0.2, 0.2), "f"), first);
    expect(far[0]).toMatchObject({ id: "room-topology-1", name: "Room 1" });
  });

  it("recomputes rooms from walls through undo and redo", () => {
    const walls = rectangle();
    const created = projectHistoryReducer(initialHistory(), { type: "edit", info: { label: "room creation" },
      update: project => ({ ...project, walls, rooms: [roomAt(square(0.1, 0.1, 0.4, 0.3))] }) });
    expect(created.present.rooms).toHaveLength(1);
    expect(created.present.rooms[0]).toMatchObject({ id: "room", name: "Living" });
    const split = projectHistoryReducer(created, { type: "edit", info: { label: "wall creation" },
      update: project => ({ ...project, walls: [...project.walls, partition] }) });
    expect(split.present.rooms).toHaveLength(2);
    const undone = projectHistoryReducer(split, { type: "undo" });
    expect(undone.present.walls).toHaveLength(4);
    expect(undone.present.rooms).toHaveLength(1);
    expect(undone.present.rooms[0]).toMatchObject({ id: "room", name: "Living" });
    expect(undone.present.rooms[0].polygon).toHaveLength(4);
    expect(undone.present.rooms[0].topologyWallIds).toHaveLength(4);
    const redone = projectHistoryReducer(undone, { type: "redo" });
    expect(redone.present.rooms).toHaveLength(2);
    expect(redone.present.rooms.some(room => room.name === "Living")).toBe(true);
  });

  it("derives rooms for imported projects and never mutates the stored walls", () => {
    const walls = rectangle();
    const snapshot = JSON.parse(JSON.stringify(walls)) as Wall[];
    expect(deriveRooms(walls, [])).toEqual(deriveRooms(walls, []));
    expect(walls).toEqual(snapshot);
    const imported = initialHistory({ ...emptyProject(), walls, rooms: [roomAt(square(0.1, 0.1, 0.4, 0.3), { name: "ห้องนอน" })] });
    expect(imported.present.rooms).toHaveLength(1);
    expect(imported.present.rooms[0].name).toBe("ห้องนอน");
    expect(initialHistory({ ...emptyProject(), walls: walls.slice(0, 3) }).present.rooms).toEqual([]);
  });
});
