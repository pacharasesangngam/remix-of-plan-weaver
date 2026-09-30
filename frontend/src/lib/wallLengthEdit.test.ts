import { describe, expect, it } from "vitest";
import { chooseLengthAnchor, proposeWallEndpoint, proposeWallLength, type GeometrySnapshot, type Anchor } from "./wallLengthEdit";
import type { DetectedWallSegment as Wall } from "@/types/detection";
import { confirmCalibration, preservesConfirmedDimensions } from "./confirmedDimensions";
import { createFloorPlanProject, parseFloorPlanProject } from "./projectIO";
import { wallIntendedAxis } from "./wallLengthEdit";
const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall =>
  ({ id, x1: x1 / 10, y1: y1 / 10, x2: x2 / 10, y2: y2 / 10, type: "interior", thickness: 0.15 });
const rectangle = (): GeometrySnapshot => ({ walls: [wall("top", 1, 1, 5.15, 1), wall("right", 5.15, 1, 5.15, 4),
  wall("bottom", 1, 4, 5.15, 4), wall("left", 1, 1, 1, 4)], doors: [], windows: [], rooms: [] });
const edit = (source: GeometrySnapshot, anchor: Anchor = "start", length = 4) => proposeWallLength(source, { wallId: "top", length, anchor }, 10, 10);
const accept = (source: GeometrySnapshot, anchor: Anchor = "start", length = 4) => {
  const result = edit(source, anchor, length);
  if (result.ok === false) throw new Error(result.reason);
  return result.geometry;
};
describe("bounded wall length propagation", () => {
  it("keeps a confirmed 13.20 span fixed while 4.08 becomes 4.00 and 9.12 becomes 9.20", () => {
    const source: GeometrySnapshot = { walls: [wall("a", 0, 0, 4.08, 0), wall("b", 4.08, 0, 13.2, 0), wall("branch", 4.08, 0, 4.08, 3)], rooms: [], doors: [], windows: [] };
    source.confirmedDimensions = confirmCalibration([{ x: 0, y: 0 }, { x: source.walls[1].x2, y: 0 }], source.walls, 13.2);
    expect(source.confirmedDimensions).toHaveLength(1);
    const anchor = chooseLengthAnchor(source, "a", 4, 10, 10);
    const first = proposeWallLength(source, { wallId: "a", length: 4, anchor }, 10, 10);
    expect(first.ok).toBe(true); if (!first.ok) return;
    expect(first.geometry.walls[0].x2).toBeCloseTo(0.4);
    expect((first.geometry.walls[1].x2 - first.geometry.walls[1].x1) * 10).toBeCloseTo(9.2);
    expect(first.geometry.walls[2].x1).toBeCloseTo(0.4);
    expect(preservesConfirmedDimensions(first.geometry.walls, source.confirmedDimensions, 10, 10)).toBe(true);
    // The second segment is new information, not a locked prior edit.
    const second = proposeWallLength(first.geometry, { wallId: "b", length: 9, anchor: chooseLengthAnchor(first.geometry, "b", 9, 10, 10) }, 10, 10);
    expect(second.ok).toBe(true); if (!second.ok) return;
    expect(second.geometry.walls[0].x2 * 10).toBeCloseTo(4.2);
    expect(second.geometry.walls[1].x2 * 10).toBeCloseTo(13.2);
    expect(second.geometry.walls[0].x1).toBe(0);
    expect(proposeWallLength(source, { wallId: "a", length: 14, anchor: "start" }, 10, 10).ok).toBe(false);
  });
  it("keeps a 9.13 m corner edit vertical and propagates the shared junction", () => {
    const source: GeometrySnapshot = { walls: [wall("horizontal", 0, 0, 9.13, 0), wall("vertical", 9.13, 0, 9.13, 4),
      wall("lower", 0, 4, 9.13, 4)], rooms: [], doors: [], windows: [] };
    const result = proposeWallLength(source, { wallId: "horizontal", length: 9, anchor: "start" }, 10, 10);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.geometry.walls[0].y2).toBe(result.geometry.walls[0].y1);
    expect(result.geometry.walls[1].x1).toBe(result.geometry.walls[1].x2);
    expect(result.geometry.walls[1].x1).toBeCloseTo(0.9);
    expect(result.geometry.walls[2].y1).toBe(result.geometry.walls[2].y2);
  });
  it("projects a 2D endpoint drag onto the wall axis and leaves the connected walls alone", () => {
    const source: GeometrySnapshot = { walls: [wall("horizontal", 0, 0, 9.13, 0), wall("vertical", 9.13, 0, 9.13, 4),
      wall("lower", 0, 4, 9.13, 4)], rooms: [], doors: [], windows: [] };
    const dragged = proposeWallEndpoint(source, source.walls.map(w => w.id === "horizontal" ? { ...w, x2: 0.9, y2: 0.03 } : w), 10, 10);
    expect(dragged?.ok).toBe(true); if (!dragged || !dragged.ok) return;
    // The dropped 0.03 is across the axis of a horizontal wall, so D1 drops it.
    expect(dragged.geometry.walls[0].x2).toBe(0.9);
    expect(dragged.geometry.walls[0].y2).toBe(0);
    // A direct drag moves one endpoint and nothing else: the two lines that used
    // to meet this corner simply stop meeting it, which is a legal disconnect.
    expect(dragged.geometry.walls[1]).toEqual(source.walls[1]);
    expect(dragged.geometry.walls[2]).toEqual(source.walls[2]);
    // A numeric length edit of the same wall still resolves along its axis, and it
    // is that path which carries the shared junction.
    const numeric = proposeWallLength(source, { wallId: "horizontal", length: 9, anchor: "start" }, 10, 10);
    expect(numeric.ok).toBe(true); if (!numeric.ok) return;
    expect(numeric.geometry.walls[0].y2).toBe(0);
    expect(numeric.geometry.walls[1].x1).toBe(0.9);
    expect(numeric.geometry.walls[2].x2).toBe(0.9);
  });
  it("refuses to slide a perpendicular stub along its host and keeps the host intact", () => {
    const source: GeometrySnapshot = { walls: [wall("stub", 5, 2, 5, 5), wall("host", 1, 5, 9, 5)], rooms: [], doors: [], windows: [] };
    const dragged = proposeWallEndpoint(source, source.walls.map(w => w.id === "stub" ? { ...w, x2: 0.72, y2: 0.5 } : w), 10, 10);
    // Sliding a vertical stub sideways along a horizontal host would make it
    // diagonal, so D1 refuses with a reason rather than silently doing nothing.
    expect(dragged?.ok).toBe(false);
    // The supported way to move a T node is to shorten its host instead.
    const hostEdit = proposeWallLength(source, { wallId: "host", length: 4, anchor: "end" }, 10, 10);
    expect(hostEdit.ok).toBe(true); if (!hostEdit.ok) return;
    expect(hostEdit.geometry.walls[1].x1).toBe(0.5);
    expect(hostEdit.geometry.walls[0]).toEqual(source.walls[0]);
  });
  it("keeps a dragged endpoint clear of a wall it never reached", () => {
    const source: GeometrySnapshot = { walls: [wall("mover", 1, 2, 3, 2), wall("obstacle", 5, 1, 5, 3)], rooms: [], doors: [], windows: [] };
    const swept = proposeWallEndpoint(source, source.walls.map(w => w.id === "mover" ? { ...w, x2: 0.55, y2: 0.2 } : w), 10, 10);
    expect(swept?.ok).toBe(false);
    const landed = proposeWallEndpoint(source, source.walls.map(w => w.id === "mover" ? { ...w, x2: 0.5, y2: 0.2 } : w), 10, 10);
    expect(landed?.ok).toBe(true);
  });
  it("accepts an intentional endpoint-to-endpoint snap", () => {
    const source: GeometrySnapshot = { walls: [wall("moving", 0, 0, 4, 0), wall("target", 8, 0, 8, 3)], rooms: [], doors: [], windows: [] };
    const updated = source.walls.map(w => w.id === "moving" ? { ...w, x2: 0.8, y2: 0 } : w);
    const result = proposeWallEndpoint(source, updated, 10, 10);
    expect(result?.ok).toBe(true); if (!result || !result.ok) return;
    expect(result.geometry.walls[0].x2).toBe(result.geometry.walls[1].x1);
    expect(result.geometry.walls[0].y2).toBe(result.geometry.walls[1].y1);
  });
  it("accepts an intentional endpoint-to-wall-interior T-junction snap", () => {
    const source: GeometrySnapshot = { walls: [wall("moving", 5, 0, 5, 4), wall("host", 0, 6, 10, 6)], rooms: [], doors: [], windows: [] };
    const updated = source.walls.map(w => w.id === "moving" ? { ...w, x2: 0.5, y2: 0.6 } : w);
    const result = proposeWallEndpoint(source, updated, 10, 10);
    expect(result?.ok).toBe(true); if (!result || !result.ok) return;
    expect(result.geometry.walls[0].x1).toBe(result.geometry.walls[0].x2);
    expect(result.geometry.walls[0].y2).toBeCloseTo(0.6);
    expect(result.geometry.walls[1]).toEqual(source.walls[1]);
  });
  it("has no intended-axis tolerance band: 3 degree and 7 degree walls are treated identically", () => {
    // The old 5 degree band made a 3 degree wall "horizontal" and a 7 degree one
    // not, which was a cliff rather than a rule. D1 classifies from the exact
    // endpoints, so both are simply free and both keep their own angle.
    const sloped = (id: string, degrees: number): Wall => {
      const rise = Math.tan(degrees * Math.PI / 180) * 4;
      return { ...wall(id, 1, 1, 5, 1), y2: (1 + rise) / 10 };
    };
    const three = sloped("three", 3), seven = sloped("seven", 7);
    expect(wallIntendedAxis(three)).toBeNull();
    expect(wallIntendedAxis(seven)).toBeNull();
    // Resizing a genuine slope preserves its angle instead of straightening it.
    for (const [degrees, source] of [[3, three], [7, seven]] as const) {
      const snapshot: GeometrySnapshot = { walls: [source], rooms: [], doors: [], windows: [] };
      const edited = proposeWallLength(snapshot, { wallId: source.id, length: 3, anchor: "start" }, 10, 10);
      expect(edited.ok).toBe(true); if (!edited.ok) return;
      const w = edited.geometry.walls[0];
      expect(wallIntendedAxis(w)).toBeNull();
      expect((w.y2 - w.y1) / (w.x2 - w.x1)).toBeCloseTo(Math.tan(degrees * Math.PI / 180), 8);
    }
    // An exactly axis-aligned wall still classifies, so the rule is not a cliff.
    expect(wallIntendedAxis(wall("exact", 1, 1, 5, 1))).toBe("h");
  });
  it.each([false, true])("resizes genuine diagonal walls along their existing angle (reversed=%s)", reversed => {
    const diagonal = reversed ? wall("top", 4, 5, 1, 1) : wall("top", 1, 1, 4, 5);
    const source: GeometrySnapshot = { walls: [diagonal], rooms: [], doors: [], windows: [] };
    expect(wallIntendedAxis(diagonal)).toBeNull();
    const w = accept(source, "start", 4).walls[0];
    expect(Math.hypot(w.x2 - w.x1, w.y2 - w.y1) * 10).toBeCloseTo(4);
    expect((w.x2 - w.x1) / (w.y2 - w.y1)).toBeCloseTo(0.75);
  });
  it("translates a connected diagonal rigidly instead of rotating it about the junction", () => {
    const source = rectangle(); source.walls.push(wall("oblique", 5.15, 1, 7, 2));
    const result = accept(source);
    // The corner moves 0.15 to the left, and the diagonal keeps its angle by
    // moving with it. It must not pivot about the shared corner, which is what
    // used to shear the far end.
    expect(result.walls[4].x1).toBe(result.walls[0].x2);
    expect(result.walls[4].y1).toBe(result.walls[0].y2);
    expect(result.walls[4].x2).toBeCloseTo(0.685, 10);
    expect((result.walls[4].y2 - result.walls[4].y1) / (result.walls[4].x2 - result.walls[4].x1))
      .toBeCloseTo((source.walls[4].y2 - source.walls[4].y1) / (source.walls[4].x2 - source.walls[4].x1), 10);
  });
  it("preserves opening width and host when a connected diagonal rotates", () => {
    const source = rectangle(); source.walls.push(wall("oblique", 5.15, 1, 7, 2));
    source.windows = [{ id: "window", wallId: "oblique", bbox: { x: 0.59, y: 0.135, w: 0.03, h: 0.015 } }];
    const result = accept(source);
    const width = (w: Wall, b: typeof source.windows[0]["bbox"]) => {
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1, len = Math.hypot(dx, dy);
      return (Math.abs(dx) * b.w + Math.abs(dy) * b.h) / len;
    };
    expect(width(result.walls[4], result.windows[0].bbox)).toBeCloseTo(width(source.walls[4], source.windows[0].bbox), 8);
    expect(result.windows[0].wallId).toBe("oblique");
  });
  it("resizes a rectangle and translates openings without mutating the source or opposite boundary", () => {
    const source = rectangle();
    source.doors = [{ id: "door", wallId: "right", bbox: { x: 0.51, y: 0.2, w: 0.01, h: 0.08 }, polygon: [{ x: 0.51, y: 0.2 }, { x: 0.52, y: 0.28 }] }];
    const before = structuredClone(source);
    const result = accept(source);
    expect(result.walls[0].x2).toBeCloseTo(0.5);
    expect(result.walls[1].x1).toBeCloseTo(0.5);
    expect(result.walls[1].x2).toBeCloseTo(0.5);
    expect(result.walls[2].x2).toBeCloseTo(0.5);
    expect(result.walls[3]).toBe(source.walls[3]);
    expect(result.doors[0].bbox.x).toBeCloseTo(0.495);
    expect(result.doors[0].bbox.h).toBe(0.08);
    expect(result.doors[0].polygon![0].x).toBeCloseTo(0.495);
    expect(result.doors[0].wallId).toBe("right");
    expect(source).toEqual(before);
  });
  it("supports the opposite anchor and reversed endpoint ordering", () => {
    const source = rectangle();
    expect(accept(source, "end").walls[3].x1).toBeCloseTo(0.115);
    source.walls[0] = wall("top", 5.15, 1, 1, 1);
    expect(accept(source, "end").walls[1].x1).toBeCloseTo(0.5);
  });
  it("defaults to start for symmetric anchors and prefers a connected anchor for free ends", () => {
    expect(chooseLengthAnchor(rectangle(), "top", 4, 10, 10)).toBe("start");
    const source = rectangle(); source.walls = [source.walls[0], source.walls[3]];
    expect(chooseLengthAnchor(source, "top", 4, 10, 10)).toBe("start");
    expect(accept(source).walls[1]).toBe(source.walls[1]);
    source.walls = [source.walls[0]];
    expect(chooseLengthAnchor(source, "top", 4, 10, 10)).toBe("start");
  });
  it("supports vertical edits", () => {
    const source = rectangle(); source.walls = source.walls.map(w => ({ ...w, x1: w.y1, y1: w.x1, x2: w.y2, y2: w.x2 }));
    expect(accept(source).walls[1].y1).toBeCloseTo(0.5);
  });
  it("propagates through split wall lines and T/X connections but stops at the next boundary", () => {
    const source = rectangle();
    source.walls.splice(1, 1, wall("r1", 5.15, 1, 5.15, 2.5), wall("r2", 5.15, 2.5, 5.15, 4));
    source.walls.push(wall("branch", 5.15, 2.5, 7, 2.5), wall("boundary", 7, 1, 7, 4), wall("through", 0, 3, 7, 3));
    const result = accept(source);
    expect(result.walls.find(w => w.id === "branch")!.x1).toBeCloseTo(0.5);
    expect(result.walls.find(w => w.id === "branch")!.x2).toBeCloseTo(0.7);
    expect(result.walls.find(w => w.id === "through")).toBe(source.walls.find(w => w.id === "through"));
    expect(result.walls.find(w => w.id === "boundary")).toBe(source.walls.find(w => w.id === "boundary"));
  });
  it("keeps openings fixed on resized walls and preserves implicit hosts", () => {
    const source = rectangle(); source.windows = [{ id: "window", bbox: { x: 0.2, y: 0.095, w: 0.1, h: 0.01 } }];
    expect(accept(source).windows[0]).toBe(source.windows[0]);
  });
  it("rejects clipping an opening and sweeping a junction through an opening on a through-wall", () => {
    const source = rectangle(); source.doors = [{ id: "d", wallId: "top", bbox: { x: 0.49, y: 0.095, w: 0.02, h: 0.01 } }];
    expect(edit(source).ok).toBe(false);
    source.doors = [{ id: "d", wallId: "through", bbox: { x: 0.45, y: 0.295, w: 0.03, h: 0.01 } }];
    source.walls.push(wall("through", 0, 3, 7, 3));
    expect(edit(source, "start", 3).ok).toBe(false);
  });
  it("rejects the edited wall's own impossible geometry and disconnects neighbours that cannot follow", () => {
    // A wall that already overlaps another one before the edit is pre-existing
    // geometry, not something this edit created, so it does not block the edit.
    const duplicate = rectangle(); duplicate.walls.push(wall("duplicate", 5.15, 1, 5.15, 3));
    expect(edit(duplicate).ok).toBe(true);
    // A stub too short to follow its host cannot follow at all, so it is left
    // where it is while the host slides on: a legal disconnect, not a refusal.
    const detached = rectangle(); detached.walls.push(wall("tiny", 5.15, 2, 5.1, 2));
    const disconnected = accept(detached);
    expect(disconnected.walls[1].x1).toBeCloseTo(0.5);
    expect(disconnected.walls[4]).toEqual(detached.walls[4]);
    // A wall the edit would drive onto an existing line cannot follow either, so
    // it stays and the edited wall simply stops meeting it.
    const source = rectangle(); source.walls.push(wall("obstacle", 5, 0, 5, 5));
    const stopped = accept(source);
    expect(stopped.walls[0].x2).toBeCloseTo(0.5);
    expect(stopped.walls[1]).toEqual(source.walls[1]);
    // Only the edited wall itself can make the edit impossible.
    expect(edit(rectangle(), "start", 0).ok).toBe(false);
  });
  it("updates mapped room polygons without blocking edits for independent mask geometry", () => {
    const source = rectangle();
    source.rooms = [{ id: "room", name: "Room", confidence: "high", width: 0.415, height: 0.3,
      polygon: [{ x: 0.1, y: 0.1 }, { x: 0.515, y: 0.1 }, { x: 0.515, y: 0.4 }, { x: 0.1, y: 0.4 }], areaSqm: 12.45 }];
    const result = accept(source);
    // deriveRooms is free to start the polygon at any corner, so the assertion is
    // on the vertex that exists, not on the index it happens to land at.
    const hasVertex = (polygon: { x: number; y: number }[], x: number, y: number) =>
        polygon.some(p => Math.abs(p.x - x) < 5e-3 && Math.abs(p.y - y) < 5e-3);
    expect(result.rooms[0].width).toBeCloseTo(0.4);
    expect(hasVertex(result.rooms[0].polygon!, 0.5, 0.1)).toBe(true);
    expect(result.rooms[0].areaSqm).toBeUndefined();
    source.rooms[0].polygon![1].y = 0.11;
    expect(hasVertex(accept(source).rooms[0].polygon!, 0.5, 0.1)).toBe(true);
    source.rooms[0].polygon = [{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.8 }, { x: 0.9, y: 0.9 }];
    // A stored mask that no longer resembles the walls neither blocks the edit nor
    // becomes the room: the enclosed face of the walls is what a room is.
    const unmapped = accept(source).rooms[0];
    expect(unmapped.id).not.toBe("room");
    expect(hasVertex(unmapped.polygon!, 0.5, 0.1)).toBe(true);
    expect(hasVertex(unmapped.polygon!, 0.9, 0.8)).toBe(false);
  });
});


describe("shared junction deformation", () => {
  const apply = (source: GeometrySnapshot, wallId: string, value: number, anchor: Anchor = "start") => {
    const candidate = proposeWallLength(source, { wallId, length: value, anchor }, 10, 10);
    if (candidate.ok === false) throw new Error(candidate.reason);
    return candidate.geometry;
  };
  const sourceOf = (walls: Wall[]): GeometrySnapshot => ({ walls, doors: [], windows: [], rooms: [] });
  const endpointOn = (point: { x: number; y: number }, host: Wall) => {
    expect((host.x2 - host.x1) * (point.y - host.y1) - (host.y2 - host.y1) * (point.x - host.x1)).toBeCloseTo(0, 10);
    expect(point.x).toBeGreaterThanOrEqual(Math.min(host.x1, host.x2) - 1e-10);
    expect(point.x).toBeLessThanOrEqual(Math.max(host.x1, host.x2) + 1e-10);
    expect(point.y).toBeGreaterThanOrEqual(Math.min(host.y1, host.y2) - 1e-10);
    expect(point.y).toBeLessThanOrEqual(Math.max(host.y1, host.y2) + 1e-10);
  };

  it("shortens 3.68 to 3.50 by moving the shared lower junction and connected wall line up 0.18", () => {
    const source = sourceOf([wall("vertical", 1, 1, 1, 4.68), wall("horizontal", 1, 4.68, 5, 4.68),
      wall("right", 5, 1, 5, 4.68), wall("top", 1, 1, 5, 1), wall("distant", 7, 7, 9, 7)]);
    source.doors = [{ id: "door", wallId: "horizontal", bbox: { x: 0.25, y: 0.463, w: 0.08, h: 0.01 } }];
    source.rooms = [{ id: "room", name: "Room", confidence: "high", width: 0.4, height: 0.368,
      polygon: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.468 }, { x: 0.1, y: 0.468 }] }];
    const before = structuredClone(source);
    const result = apply(source, "vertical", 3.5);
    expect(result.walls[0].y2).toBeCloseTo(0.45);
    expect(result.walls[1].y1).toBe(result.walls[0].y2);
    expect(result.walls[1].y2).toBe(result.walls[2].y2);
    expect(result.doors[0].bbox.y).toBeCloseTo(0.445);
    expect(result.rooms[0].height).toBeCloseTo(0.35);
    expect(result.walls[3]).toBe(source.walls[3]);
    expect(result.walls[4]).toBe(source.walls[4]);
    expect(source).toEqual(before);
  });

  it("carries interior T attachments along a host that translated, through a second chain", () => {
    const source = sourceOf([wall("edited", 1, 1, 5, 1), wall("diagonal", 5, 1, 8, 4),
      wall("branch", 6.5, 2.5, 6.5, 5), wall("leaf", 6.5, 3.75, 5, 5), wall("unrelated", 9, 7, 10, 7)]);
    const result = apply(source, "edited", 3.8);
    const [edited, diagonal, branch, leaf] = result.walls;
    expect(diagonal.x1).toBe(edited.x2);
    expect(diagonal.y1).toBe(edited.y2);
    // The diagonal could not rotate, so it translated. A wall that moved as a
    // rigid body takes the junctions in its interior with it, otherwise moving
    // it would silently tear its own T's off.
    endpointOn({ x: branch.x1, y: branch.y1 }, diagonal);
    endpointOn({ x: leaf.x1, y: leaf.y1 }, branch);
    expect(branch.x1).toBeCloseTo(0.63);
    expect(leaf.x1).toBeCloseTo(0.63);
    // The whole diagonal moved by the same 0.02 as the corner.
    expect(diagonal.x2).toBeCloseTo(source.walls[1].x2 - 0.02);
    expect(diagonal.y2).toBe(source.walls[1].y2);
    // Nothing rotated: the branch is still vertical and the leaf keeps its angle.
    expect(branch.x1).toBe(branch.x2);
    expect((leaf.y2 - leaf.y1) / (leaf.x2 - leaf.x1))
      .toBeCloseTo((source.walls[3].y2 - source.walls[3].y1) / (source.walls[3].x2 - source.walls[3].x1), 10);
    expect(result.walls[4]).toBe(source.walls[4]);
  });

  it("rejects an edit that would stretch a confirmed span, and lets an explicit length replace it", () => {
    const source = sourceOf([wall("vertical", 1, 1, 1, 4.68), wall("horizontal", 1, 4.68, 5, 4.68),
      wall("confirmed", 5, 4.68, 5, 8)]);
    source.confirmedDimensions = confirmCalibration([{ x: 0.5, y: source.walls[2].y1 }, { x: 0.5, y: 0.8 }], source.walls, 3.32);
    expect(source.confirmedDimensions).toHaveLength(1);
    // D3: the confirmed span is a distance constraint, so shortening the wall it
    // hangs from would stretch it. That is refused with a visible reason rather
    // than reverting the wall behind the user's back.
    const rejected = proposeWallLength(source, { wallId: "vertical", length: 3.5, anchor: "start" }, 10, 10);
    expect(rejected.ok).toBe(false);
    if (rejected.ok === false) expect(rejected.reason).toMatch(/confirmed/i);
    // Re-entering the length on the same span is how the user overrides it.
    const replaced = proposeWallLength(source, { wallId: "confirmed", length: 4, anchor: "start", confirm: true }, 10, 10);
    expect(replaced.ok).toBe(true); if (!replaced.ok) return;
    expect(preservesConfirmedDimensions(replaced.geometry.walls, replaced.geometry.confirmedDimensions!, 10, 10)).toBe(true);
    // A confirmed span does not lock its wall: the confirmed wall still edits.
    const shrunk = proposeWallLength(source, { wallId: "confirmed", length: 3, anchor: "start", confirm: true }, 10, 10);
    expect(shrunk.ok).toBe(true); if (!shrunk.ok) return;
    expect(Math.hypot(shrunk.geometry.walls[2].x2 - shrunk.geometry.walls[2].x1,
      shrunk.geometry.walls[2].y2 - shrunk.geometry.walls[2].y1) * 10).toBeCloseTo(3, 8);
  });

  it("leaves the hosts of a shortened diagonal alone instead of bending them", () => {
    const source = sourceOf([wall("edited", 1, 1, 4, 4), wall("horizontal", 2, 4, 6, 4), wall("vertical", 4, 2, 4, 6)]);
    const result = apply(source, "edited", Math.sqrt(18) - 0.2);
    const [edited, horizontal, vertical] = result.walls;
    // D1 and D4 together: the diagonal may not rotate, and the two axis walls it
    // meets may not be deformed to chase it. So it simply ends short and the
    // junctions it no longer reaches are gone.
    expect(Math.hypot(edited.x2 - edited.x1, edited.y2 - edited.y1) * 10).toBeCloseTo(Math.sqrt(18) - 0.2);
    expect((edited.x2 - edited.x1) / (edited.y2 - edited.y1)).toBeCloseTo(1);
    expect(horizontal).toEqual(source.walls[1]);
    expect(vertical).toEqual(source.walls[2]);
  });

  it("updates an opening on an indirectly rotated branch while keeping its host and width", () => {
    const source = sourceOf([wall("edited", 1, 1, 5, 1), wall("diagonal", 5, 1, 8, 4), wall("branch", 6.5, 2.5, 6.5, 5)]);
    source.windows = [{ id: "window", wallId: "branch", bbox: { x: 0.645, y: 0.35, w: 0.01, h: 0.05 } }];
    const result = apply(source, "edited", 3.8);
    const host = result.walls[2], window = result.windows[0];
    const len = Math.hypot(host.x2 - host.x1, host.y2 - host.y1);
    expect((Math.abs(host.x2 - host.x1) * window.bbox.w + Math.abs(host.y2 - host.y1) * window.bbox.h) / len).toBeCloseTo(0.05, 8);
    expect(window.wallId).toBe("branch");
    expect(window.bbox.x).not.toBe(source.windows[0].bbox.x);
  });

  it("leaves a stored project untouched on refusal and reopens an accepted edit unchanged", () => {
    const stored = parseFloorPlanProject(createFloorPlanProject({
      calibrationStatus: "calibrated", unit: "m", scale: 0.02, planWidth: 10, planHeight: 10,
      walls: rectangle().walls, rooms: [], doors: [], windows: [],
    }));
    const before = JSON.stringify(stored);
    const refused = proposeWallLength(stored, { wallId: "top", length: 0, anchor: "start" }, stored.meta.planWidth, stored.meta.planHeight);
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(stored)).toBe(before);
    const accepted = proposeWallLength(stored, { wallId: "top", length: 3, anchor: "start" }, stored.meta.planWidth, stored.meta.planHeight);
    expect(accepted.ok).toBe(true);
    // Neither path may write back into the snapshot it was handed.
    expect(JSON.stringify(stored)).toBe(before);
    if (!accepted.ok) return;
    const reloaded = parseFloorPlanProject(JSON.parse(JSON.stringify(createFloorPlanProject({
      ...accepted.geometry, calibrationStatus: "calibrated", unit: "m", scale: 0.02, planWidth: 10, planHeight: 10,
    }))));
    expect(reloaded.walls.map(w => w.id)).toEqual(["top", "right", "bottom", "left"]);
    expect(reloaded.meta.calibrationStatus).toBe("calibrated");
    expect((reloaded.walls[0].x2 - reloaded.walls[0].x1) * reloaded.meta.planWidth).toBeCloseTo(3, 8);
  });
});
