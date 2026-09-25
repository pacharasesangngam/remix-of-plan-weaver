import { describe, expect, it } from "vitest";
import { chooseLengthAnchor, proposeWallLength, type GeometrySnapshot, type Anchor } from "./wallLengthEdit";
import type { DetectedWallSegment as Wall } from "@/types/detection";
import { confirmCalibration, preservesConfirmedDimensions } from "./confirmedDimensions";
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
  it("uses the same intended-axis tolerance for slightly sloped walls and their connected lines", () => {
    const source: GeometrySnapshot = { walls: [wall("top", 1, 1, 5.15, 1.04), wall("side", 5.15, 1.04, 5.18, 4),
      wall("opposite", 1, 4, 5.18, 4), wall("unrelated", 8, 6, 9, 6.05)], rooms: [], doors: [], windows: [] };
    expect(wallIntendedAxis(source.walls[0], 10, 10)).toBe("x");
    expect(wallIntendedAxis(source.walls[1], 10, 10)).toBe("y");
    const result = accept(source);
    expect(result.walls[0].x2).toBeCloseTo(0.5);
    expect(result.walls[0].y2).toBeCloseTo(0.1);
    expect(result.walls[1].x1).toBe(result.walls[0].x2);
    expect(result.walls[1].y1).toBe(result.walls[0].y2);
    expect(result.walls[2].x2).toBe(result.walls[1].x2);
    expect(result.walls[3]).toBe(source.walls[3]);
  });
  it.each([false, true])("resizes genuine diagonal walls along their existing angle (reversed=%s)", reversed => {
    const diagonal = reversed ? wall("top", 4, 5, 1, 1) : wall("top", 1, 1, 4, 5);
    const source: GeometrySnapshot = { walls: [diagonal], rooms: [], doors: [], windows: [] };
    expect(wallIntendedAxis(diagonal, 10, 10)).toBeNull();
    const w = accept(source, "start", 4).walls[0];
    expect(Math.hypot(w.x2 - w.x1, w.y2 - w.y1) * 10).toBeCloseTo(4);
    expect((w.x2 - w.x1) / (w.y2 - w.y1)).toBeCloseTo(0.75);
  });
  it("keeps an oblique endpoint junction connected instead of rejecting its angle", () => {
    const source = rectangle(); source.walls.push(wall("oblique", 5.15, 1, 7, 2));
    const result = accept(source);
    expect(result.walls[4].x1).toBe(result.walls[0].x2);
    expect(result.walls[4].y1).toBe(result.walls[0].y2);
    expect(result.walls[4].x2).toBe(source.walls[4].x2);
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
  it("rejects ambiguous overlap, collapsed walls and newly crossed walls", () => {
    for (const added of [wall("duplicate", 5.15, 1, 5.15, 3), wall("obstacle", 5.05, 0, 5.05, 5)]) {
      const source = rectangle(); source.walls.push(added);
      expect(edit(source).ok).toBe(false);
    }
    expect(edit(rectangle(), "start", 0).ok).toBe(false);
    const source = rectangle(); source.walls.push(wall("tiny", 5.15, 2, 5.1, 2));
    expect(edit(source).ok).toBe(false);
  });
  it("updates mapped room polygons without blocking edits for independent mask geometry", () => {
    const source = rectangle();
    source.rooms = [{ id: "room", name: "Room", confidence: "high", width: 0.415, height: 0.3,
      polygon: [{ x: 0.1, y: 0.1 }, { x: 0.515, y: 0.1 }, { x: 0.515, y: 0.4 }, { x: 0.1, y: 0.4 }], areaSqm: 12.45 }];
    const result = accept(source);
    expect(result.rooms[0].width).toBeCloseTo(0.4);
    expect(result.rooms[0].polygon![1].x).toBeCloseTo(0.5);
    expect(result.rooms[0].areaSqm).toBeUndefined();
    source.rooms[0].polygon![1].y = 0.11;
    expect(accept(source).rooms[0].polygon![1].x).toBeCloseTo(0.5);
    source.rooms[0].polygon = [{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.8 }, { x: 0.9, y: 0.9 }];
    expect(accept(source).rooms[0]).toBe(source.rooms[0]);
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

  it("propagates a rotating host through interior T attachments and a second connected chain", () => {
    const source = sourceOf([wall("edited", 1, 1, 5, 1), wall("diagonal", 5, 1, 8, 4),
      wall("branch", 6.5, 2.5, 6.5, 5), wall("leaf", 6.5, 3.75, 5, 5), wall("unrelated", 9, 7, 10, 7)]);
    const result = apply(source, "edited", 3.8);
    const [edited, diagonal, branch, leaf] = result.walls;
    expect(diagonal.x1).toBe(edited.x2);
    expect(diagonal.y1).toBe(edited.y2);
    endpointOn({ x: branch.x1, y: branch.y1 }, diagonal);
    endpointOn({ x: leaf.x1, y: leaf.y1 }, branch);
    expect(branch.x1).toBeCloseTo(0.64);
    expect(leaf.x1).toBeCloseTo(0.645);
    expect(diagonal.x2).toBe(source.walls[1].x2);
    expect(branch.x2).toBe(source.walls[2].x2);
    expect(leaf.x2).toBe(source.walls[3].x2);
    expect(result.walls[4]).toBe(source.walls[4]);
  });

  it("deforms a connected wall instead of moving a confirmed outer endpoint", () => {
    const source = sourceOf([wall("vertical", 1, 1, 1, 4.68), wall("horizontal", 1, 4.68, 5, 4.68),
      wall("confirmed", 5, 4.68, 5, 8)]);
    source.confirmedDimensions = confirmCalibration([{ x: 0.5, y: source.walls[2].y1 }, { x: 0.5, y: 0.8 }], source.walls, 3.32);
    expect(source.confirmedDimensions).toHaveLength(1);
    const result = apply(source, "vertical", 3.5);
    expect(result.walls[1].y1).toBeCloseTo(0.45);
    expect(result.walls[1].y2).toBe(source.walls[1].y2);
    expect(result.walls[2]).toBe(source.walls[2]);
    expect(preservesConfirmedDimensions(result.walls, source.confirmedDimensions, 10, 10)).toBe(true);
  });

  it("supports a genuine diagonal meeting multiple wall interiors without an angle-only rejection", () => {
    const source = sourceOf([wall("edited", 1, 1, 4, 4), wall("horizontal", 2, 4, 6, 4), wall("vertical", 4, 2, 4, 6)]);
    const result = apply(source, "edited", Math.sqrt(18) - 0.2);
    const [edited, horizontal, vertical] = result.walls;
    endpointOn({ x: edited.x2, y: edited.y2 }, horizontal);
    endpointOn({ x: edited.x2, y: edited.y2 }, vertical);
    expect(Math.hypot(edited.x2 - edited.x1, edited.y2 - edited.y1) * 10).toBeCloseTo(Math.sqrt(18) - 0.2);
    expect((edited.x2 - edited.x1) / (edited.y2 - edited.y1)).toBeCloseTo(1);
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
});
