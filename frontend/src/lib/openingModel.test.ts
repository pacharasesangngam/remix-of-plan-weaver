import { withDefaultWallHeight } from "./wallMetrics";
import { createFloorPlanProject, parseFloorPlanProject } from "./projectIO";
import { proposeWallLength } from "./wallLengthEdit";
import { describe, expect, it } from "vitest";
import { openingGeometry, openingAtPoints, rehostOpening, findOpeningRehost, editOpening, resolveOpenings, syncOpeningRecords, type OpeningKind } from "./openingModel";
import { computeGapIntervals, computeSolidSegments } from "./wallRenderGeometry";
import { emptyProject, initialHistory, projectHistoryReducer, type HistoryState, type ProjectState } from "./projectHistory";
import type { DetectedDoor, DetectedWindow, DetectedWallSegment } from "@/types/detection";
const wall: DetectedWallSegment = { id: "host", x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.2, type: "interior", thickness: 0.2, wallHeight: 3 };
const door: DetectedDoor = { id: "door", wallId: wall.id, wallSpan: { start: 0.25, end: 0.5 }, bbox: { x: 0.3, y: 0.19, w: 0.2, h: 0.02 } };
describe("shared opening model", () => {
  it.each([wall, { ...wall, x2: 0.1, y2: 0.9 }, { ...wall, x2: 0.8, y2: 0.8 }, { ...wall, x1: 0.9, x2: 0.1 }])("uses exact host spans for horizontal, vertical, diagonal and reversed walls: %j", host => {
    const g = openingGeometry(door, "door", [host], 12, 8)!;
    expect(g.width).toBeCloseTo(g.length * 0.25);
    const moved = editOpening(door, "door", { mode: "move", value: 0.4 }, [host], [door], [], 12, 8)!;
    const after = openingGeometry(moved, "door", [host], 12, 8)!;
    expect(after.width).toBeCloseTo(g.width);
    expect(after.tStart).toBeCloseTo(g.tStart + 0.4);
    const resized = editOpening(moved, "door", { mode: "end", value: after.tStart + 1.3 }, [host], [moved], [], 12, 8)!;
    const numeric = editOpening(moved, "door", { mode: "width", value: 1.3 }, [host], [moved], [], 12, 8)!;
    expect(resized.wallSpan).toEqual(numeric.wallSpan);
    const gap = computeGapIntervals(host, g.length, 3, [numeric], [], [host], 12, 8)[0];
    const final = openingGeometry(numeric, "door", [host], 12, 8)!;
    expect(gap.tStart).toBe(final.tStart); expect(gap.tEnd).toBe(final.tEnd);
    expect(final.localX).toBeCloseTo((gap.tStart + gap.tEnd - g.length) / 2);
  });
  it("clips movement and both resize handles to the host and neighboring openings", () => {
    const other = { ...door, id: "neighbor", wallSpan: { start: 0.7, end: 0.9 } };
    const move = editOpening(door, "door", { mode: "move", value: 100 }, [wall], [door, other], [], 10, 10)!;
    expect(move.wallSpan!.end).toBeCloseTo(0.7);
    const left = editOpening(door, "door", { mode: "start", value: -100 }, [wall], [door], [], 10, 10)!;
    expect(left.wallSpan!.start).toBe(0);
    const right = editOpening(door, "door", { mode: "end", value: 100 }, [wall], [door], [], 10, 10)!;
    expect(right.wallSpan!.end).toBe(1);
  });
  it("does not merge duplicate/overlapping door and window detections into a larger rectangular cut", () => {
    const window = { ...door, id: "window", wallSpan: { start: 0.4, end: 0.65 }, heightM: 1, sillHeightM: 1 };
    const result = resolveOpenings([door, { ...door, id: "duplicate" }], [window], [wall], 10, 10);
    expect(result.active).toHaveLength(1); expect(result.rejected.size).toBe(2);
    const gaps = computeGapIntervals(wall, 8, 3, [door], [window], [wall], 10, 10);
    expect(gaps).toHaveLength(1); expect(gaps[0].tEnd).toBe(4);
    expect(computeSolidSegments(8, 3, gaps)).toContainEqual({ tStart: 4, tEnd: 8, yStart: 0, yEnd: 3 });
  });
  it("never cuts unrelated parallel walls or falls back from a missing explicit host", () => {
    const parallel = { ...wall, id: "parallel", y1: 0.21, y2: 0.21 };
    expect(computeGapIntervals(parallel, 8, 3, [door], [], [wall, parallel], 10, 10)).toEqual([]);
    expect(openingGeometry({ ...door, wallId: "missing" }, "door", [wall], 10, 10)).toBeNull();
    expect(resolveOpenings([{ id: "unattached", bbox: { x: 0.3, y: 0.195, w: 0.1, h: 0.02 } }], [], [wall, parallel], 10, 10).active).toHaveLength(0);
  });
  it("shares height and sill with 3D and clips them to the actual host height", () => {
    const window = { ...door, heightM: 1.4, sillHeightM: 0.8 };
    const g = openingGeometry(window, "window", [wall], 10, 10)!;
    expect(computeGapIntervals(wall, 8, 3, [], [window], [wall], 10, 10)[0]).toMatchObject({ height: g.height, yStart: g.sill });
    expect(openingGeometry({ ...window, heightM: 5 }, "window", [wall], 10, 10)!.height).toBeCloseTo(2.2);
  });
  it("creates an exact diagonal span without reprojecting an axis-aligned bounding box", () => {
    const host = { ...wall, x2: 0.8, y2: 0.9 };
    const created = openingAtPoints(door, host, { x: 0.24, y: 0.34 }, { x: 0.38, y: 0.48 }, 10, 10);
    expect(created.wallSpan!.start).toBeCloseTo(0.2); expect(created.wallSpan!.end).toBeCloseTo(0.4);
  });
  it("persists the same span through save/reopen, wall translation, calibration and Undo", () => {
    let history = initialHistory({ ...emptyProject(), calibrationStatus: "calibrated", scale: 0.02, planW: 10, planH: 10, walls: [wall], doors: [door] });
    const before = history.present;
    history = projectHistoryReducer(history, { type: "edit", info: { label: "opening resize" }, update: p => ({ ...p, doors: [editOpening(p.doors[0], "door", { mode: "width", value: 1.2 }, p.walls, p.doors, [], 10, 10)!] }) });
    expect(openingGeometry(history.present.doors[0], "door", [wall], 10, 10)!.width).toBeCloseTo(1.2);
    expect(history.present.scale).toBe(before.scale);
    expect(initialHistory(JSON.parse(JSON.stringify(history.present))).present.doors).toEqual(history.present.doors);
    expect(projectHistoryReducer(history, { type: "undo" }).present).toEqual(before);
    const translated = syncOpeningRecords({ ...before, walls: [{ ...wall, y1: 0.4, y2: 0.4 }] }, before);
    expect(translated.doors[0].bbox.y).toBeCloseTo(0.39);
    expect(translated.doors[0].wallSpan).toEqual({ start: expect.closeTo(0.25, 10), end: expect.closeTo(0.5, 10) });
  });
});


it("preserves an edited canonical opening width when a connected diagonal rotates", () => {
  const edited = { ...wall, id: "edited", x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.1 };
  const diagonal = { ...wall, id: "diagonal", x1: 0.5, y1: 0.1, x2: 0.8, y2: 0.4 };
  const raw = { ...door, wallId: diagonal.id, wallSpan: { start: 0.3, end: 0.5 } };
  const source = syncOpeningRecords({ ...emptyProject(), planW: 10, planH: 10, walls: [edited, diagonal], doors: [raw] });
  const before = openingGeometry(source.doors[0], "door", source.walls, 10, 10)!;
  const result = proposeWallLength(source, { wallId: edited.id, length: 3.8, anchor: "start" }, 10, 10);
  if (result.ok === false) throw new Error(result.reason);
  expect(openingGeometry(result.geometry.doors[0], "door", result.geometry.walls, 10, 10)!.width).toBeCloseTo(before.width, 8);
});


it("rejects short, low, occupied and missing hosts without shrinking or detaching an opening", () => {
  const target = { ...wall, id: "target", y1: 0.6, y2: 0.6 };
  for (const invalid of [{ ...target, x2: 0.15 }, { ...target, wallHeight: 1 }]) {
    expect(rehostOpening(door, "door", invalid.id, { x: 0.5, y: 0.6 }, [wall, invalid], [door], [], 10, 10)).toBeNull();
  }
  const occupied = { ...door, id: "occupied", wallId: target.id, wallSpan: { start: 0.2, end: 0.8 } };
  expect(rehostOpening(door, "door", target.id, { x: 0.5, y: 0.6 }, [wall, target], [door, occupied], [], 10, 10)).toBeNull();
  expect(rehostOpening(door, "door", "missing", { x: 0.5, y: 0.6 }, [wall], [door], [], 10, 10)).toBeNull();
});

it.each([1, 2])("finds a diagonal host within the same screen-space range at zoom %s", zoom => {
  const target = { ...wall, id: "diagonal", x1: 0.2, y1: 0.5, x2: 0.8, y2: 0.9, wallHeight: 4 };
  const size = { width: 1000 * zoom, height: 600 * zoom };
  const moved = findOpeningRehost(door, "door", { x: 0.5, y: 0.7 + 5 / size.height }, size, [wall, target], [door], [], 10, 10)!;
  expect(moved.wallId).toBe(target.id);
  const after = openingGeometry(moved, "door", [wall, target], 10, 10)!;
  expect(after.width).toBeCloseTo(2); expect(after.height).toBeCloseTo(2.2);
  expect((after.end.y - after.start.y) / (after.end.x - after.start.x)).toBeCloseTo(2 / 3);
  expect(findOpeningRehost(door, "door", { x: 0.5, y: 0.76 }, size, [wall, target], [door], [], 10, 10)).toBeNull();
});

it("commits host, span and height together as one Undo step even when old/new span fractions match", () => {
  const target = { ...wall, id: "new", y1: 0.6, y2: 0.6, wallHeight: 4 };
  let state = initialHistory({ ...emptyProject(), planW: 10, planH: 10, walls: [wall, target], doors: [door] });
  const before = state.present;
  state = projectHistoryReducer(state, { type: "edit", info: { label: "opening wall change" }, update: p => ({ ...p,
    doors: [{ ...rehostOpening(p.doors[0], "door", target.id, { x: 0.4, y: 0.6 }, p.walls, p.doors, p.windows, 10, 10)!, wallSpan: door.wallSpan }] }) });
  expect(state.past).toHaveLength(1);
  expect(state.present.doors[0].wallSpan).toEqual({ start: expect.closeTo(0.25, 10), end: expect.closeTo(0.5, 10) });
  expect(state.present.doors[0].wallId).toBe(target.id);
  expect(openingGeometry(state.present.doors[0], "door", state.present.walls, 10, 10)!.height).toBe(2.2);
  expect(projectHistoryReducer(state, { type: "undo" }).present).toEqual(before);
});

/** One edit per element: wall geometry changes never scale the doors and
 * windows attached to them, and opening edits never touch wall geometry. */
describe("opening size is independent of its host wall", () => {
  const host: DetectedWallSegment = { id: "host", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.2, type: "interior", thickness: 0.2, wallHeight: 3 };
  const doorOnHost: DetectedDoor = { id: "door", wallId: "host", wallSpan: { start: 0.25, end: 0.5 }, bbox: { x: 0.2, y: 0.19, w: 0.1, h: 0.02 } };
  const windowOnHost: DetectedWindow = { id: "window", wallId: "host", wallSpan: { start: 0.6, end: 0.8 }, bbox: { x: 0.35, y: 0.19, w: 0.08, h: 0.02 },
    heightM: 1.2, sillHeightM: 0.9 };
  const project = () => initialHistory({ ...emptyProject(), calibrationStatus: "calibrated", scale: 0.02, planW: 10, planH: 10,
    walls: [host], doors: [doorOnHost], windows: [windowOnHost] });
  const edit = (state: HistoryState, update: (state: ProjectState) => ProjectState) =>
    projectHistoryReducer(state, { type: "edit", info: { label: "test edit" }, update });
  const widthOf = (state: ProjectState, kind: OpeningKind, id: string) => {
    const opening = kind === "door" ? state.doors.find(item => item.id === id) : state.windows.find(item => item.id === id);
    const geometry = opening && openingGeometry(opening, kind, state.walls, state.planW, state.planH, state.wallHeightMeter);
    return geometry ? geometry.width : null;
  };

  it("keeps door and window width when its host wall is resized", () => {
    const state = project();
    expect(widthOf(state.present, "door", "door")).toBeCloseTo(1, 8);
    expect(widthOf(state.present, "window", "window")).toBeCloseTo(0.8, 8);
    const resized = edit(state, p => ({ ...p, walls: p.walls.map(wall => ({ ...wall, x2: 0.9 })) }));
    expect(widthOf(resized.present, "door", "door")).toBeCloseTo(1, 8);
    expect(widthOf(resized.present, "window", "window")).toBeCloseTo(0.8, 8);
    // The shared wall cut that both the 2D preview and the 3D CSG walls read
    // reports the same, unchanged opening sizes.
    const cuts = computeGapIntervals(resized.present.walls[0], 8, 3, resized.present.doors, resized.present.windows, resized.present.walls, 10, 10);
    expect(cuts.map(cut => cut.tEnd - cut.tStart)).toEqual([expect.closeTo(1, 8), expect.closeTo(0.8, 8)]);
    // Both stay attached to the wall they were measured on.
    expect(resized.present.doors[0].wallId).toBe("host");
    expect(resized.present.windows[0].wallId).toBe("host");
    expect(resized.past).toHaveLength(1);
    expect(projectHistoryReducer(resized, { type: "undo" }).present).toEqual(state.present);
  });

  it("moves attached openings with a translated wall without resizing them", () => {
    const state = project();
    const before = state.present.doors[0];
    const moved = edit(state, p => ({ ...p, walls: p.walls.map(wall => ({ ...wall, x1: 0.2, x2: 0.6 })) }));
    expect(widthOf(moved.present, "door", "door")).toBeCloseTo(1, 8);
    expect(moved.present.doors[0].bbox.x).toBeCloseTo(before.bbox.x + 0.1, 8);
    expect(moved.present.doors[0].wallSpan!.start).toBeCloseTo(before.wallSpan!.start, 8);
    expect(moved.present.doors[0].wallSpan!.end).toBeCloseTo(before.wallSpan!.end, 8);
  });

  it("rejects host shortening that would shrink or overlap openings", () => {
    const state = project();
    for (const x2 of [0.3, 0.15]) {
      const shrunk = edit(state, p => ({ ...p, walls: p.walls.map(wall => ({ ...wall, x2 })) }));
      expect(shrunk).toBe(state);
    }
  });

  it("keeps opening records untouched by calibration while their physical size follows the plan", () => {
    const state = project();
    const calibrated = edit(state, p => ({ ...p, scale: 0.04, planW: 20, planH: 20 }));
    expect(calibrated.present.walls).toBe(state.present.walls);
    expect(calibrated.present.doors[0]).toBe(state.present.doors[0]);
    expect(calibrated.present.windows[0]).toBe(state.present.windows[0]);
    expect(widthOf(calibrated.present, "door", "door")).toBeCloseTo(2, 8);
    expect(widthOf(calibrated.present, "window", "window")).toBeCloseTo(1.6, 8);
    expect(projectHistoryReducer(calibrated, { type: "undo" }).present).toEqual(state.present);
  });

  it("never changes wall geometry when a door or window is moved or resized", () => {
    const state = project();
    const movedSpan = edit(state, p => ({ ...p, doors: p.doors.map(item => ({ ...item, wallSpan: { start: 0.1, end: 0.2 } })) }));
    expect(movedSpan.present.walls).toBe(state.present.walls);
    expect(widthOf(movedSpan.present, "door", "door")).toBeCloseTo(0.4, 8);
    const widened = edit(state, p => ({ ...p, doors: [editOpening(p.doors[0], "door", { mode: "width", value: 1.2 }, p.walls, p.doors, p.windows, 10, 10)!] }));
    expect(widened.present.walls).toBe(state.present.walls);
    expect(widthOf(widened.present, "door", "door")).toBeCloseTo(1.2, 8);
    expect(widened.present.doors[0].wallSpan).toEqual({ start: expect.closeTo(0.25, 10), end: expect.closeTo(0.55, 10) });
  });

  it("re-hosts an opening without inheriting the new host's length ratio", () => {
    const wide: DetectedWallSegment = { id: "wide", x1: 0.05, y1: 0.8, x2: 0.85, y2: 0.8, type: "interior", thickness: 0.2, wallHeight: 3 };
    const state = edit(project(), p => ({ ...p, walls: [...p.walls, wide] }));
    expect(widthOf(state.present, "door", "door")).toBeCloseTo(1, 8);
    const rehosted = edit(state, p => ({ ...p, doors: p.doors.map(item => ({ ...item, wallId: "wide" })) }));
    expect(rehosted.present.doors[0].wallId).toBe("wide");
    expect(widthOf(rehosted.present, "door", "door")).toBeCloseTo(1, 8);
    expect(rehosted.present.doors[0].wallSpan).toEqual({ start: expect.closeTo(0.3125, 10), end: expect.closeTo(0.4375, 10) });
    expect(widthOf(rehosted.present, "window", "window")).toBeCloseTo(0.8, 8);
  });

  it("preserves a window's measured width through a wall length change", () => {
    const source = syncOpeningRecords({ ...emptyProject(), calibrationStatus: "calibrated", scale: 0.02, planW: 10, planH: 10,
      walls: [host], windows: [windowOnHost] });
    const before = openingGeometry(source.windows[0], "window", source.walls, 10, 10)!;
    const result = proposeWallLength(source, { wallId: host.id, length: 6.5, anchor: "start" }, 10, 10);
    if (result.ok === false) throw new Error(result.reason);
    expect(openingGeometry(result.geometry.windows[0], "window", result.geometry.walls, 10, 10)!.width).toBeCloseTo(before.width, 8);
  });

  it("preserves an opening's measured height and sill through a wall height edit", () => {
    // A door without explicit heightM and a window with explicit height/sill
    const plainDoor: DetectedDoor = { id: "door", wallId: "host", wallSpan: { start: 0.25, end: 0.5 }, bbox: { x: 0.2, y: 0.19, w: 0.1, h: 0.02 } };
    const plainWindow: DetectedWindow = { id: "window", wallId: "host", wallSpan: { start: 0.6, end: 0.8 }, bbox: { x: 0.35, y: 0.19, w: 0.08, h: 0.02 } };
    const state = initialHistory({ ...emptyProject(), calibrationStatus: "calibrated", scale: 0.02, planW: 10, planH: 10, wallHeightMeter: 3,
      walls: [host], doors: [plainDoor], windows: [plainWindow] });
    const beforeDoor = openingGeometry(state.present.doors[0], "door", state.present.walls, 10, 10, state.present.wallHeightMeter)!;
    const beforeWindow = openingGeometry(state.present.windows[0], "window", state.present.walls, 10, 10, state.present.wallHeightMeter)!;
    expect(beforeDoor.height).toBeCloseTo(2.2, 8);
    expect(beforeWindow.height).toBeCloseTo(1.2, 8);
    expect(beforeWindow.sill).toBeCloseTo(0.9, 8);

    // Wall height increases from 3 to 4.5 m
    const taller = edit(state, p => ({ ...p, walls: p.walls.map(w => ({ ...w, wallHeight: 4.5 })) }));
    const afterDoor = openingGeometry(taller.present.doors[0], "door", taller.present.walls, 10, 10, taller.present.wallHeightMeter)!;
    const afterWindow = openingGeometry(taller.present.windows[0], "window", taller.present.walls, 10, 10, taller.present.wallHeightMeter)!;
    expect(afterDoor.height).toBeCloseTo(beforeDoor.height, 8);
    expect(afterWindow.height).toBeCloseTo(beforeWindow.height, 8);
    expect(afterWindow.sill).toBeCloseTo(beforeWindow.sill, 8);
    // And 3D cut bands match the preserved heights
    const doorGap = computeGapIntervals(taller.present.walls[0], 4, 4.5, taller.present.doors, [], taller.present.walls, 10, 10)[0];
    expect(doorGap.height).toBeCloseTo(2.2, 8);
    expect(doorGap.yStart).toBeCloseTo(0, 8);
    const winGap = computeGapIntervals(taller.present.walls[0], 4, 4.5, [], taller.present.windows, taller.present.walls, 10, 10)[0];
    expect(winGap.height).toBeCloseTo(1.2, 8);
    expect(winGap.yStart).toBeCloseTo(0.9, 8);
  });
});



describe("independent normalized opening geometry", () => {
  const hosts = [wall, { ...wall, x2: 0.1, y2: 0.9 }, { ...wall, x2: 0.8, y2: 0.8 }, { ...wall, x1: 0.9, x2: 0.1 }];
  it.each(hosts)("preserves geometry through calibration, reopen, and translation: %j", host => {
    const initial = initialHistory({ ...emptyProject(), walls: [host], doors: [door], windows: [{ ...door, id: "window", wallSpan: { start: 0.65, end: 0.8 } }] });
    const calibrated = projectHistoryReducer(initial, { type: "edit", info: { label: "calibration" },
      update: p => ({ ...p, planW: 12, planH: 8, scale: 0.02, calibrationStatus: "calibrated" }) });
    expect(calibrated.present.doors).toBe(initial.present.doors);
    expect(calibrated.present.windows).toBe(initial.present.windows);
    const reopened = initialHistory(JSON.parse(JSON.stringify(calibrated.present)));
    expect(reopened.present).toEqual(calibrated.present);
    const moved = syncOpeningRecords({ ...reopened.present, walls: [{ ...host, x1: host.x1 + 0.02, x2: host.x2 + 0.02, y1: host.y1 + 0.03, y2: host.y2 + 0.03 }] }, reopened.present);
    for (const kind of ["door", "window"] as const) {
      const before = (kind === "door" ? reopened.present.doors : reopened.present.windows)[0];
      const after = (kind === "door" ? moved.doors : moved.windows)[0];
      expect(after.heightM).toBe(before.heightM);
      expect(after.bbox.w).toBeCloseTo(before.bbox.w, 10);
      expect(after.bbox.h).toBeCloseTo(before.bbox.h, 10);
      expect(after.planSegment!.start.x).toBeCloseTo(before.planSegment!.start.x + 0.02, 10);
      expect(after.planSegment!.start.y).toBeCloseTo(before.planSegment!.start.y + 0.03, 10);
      after.polygon!.forEach((p, i) => {
        expect(p.x).toBeCloseTo(before.polygon![i].x + 0.02, 10);
        expect(p.y).toBeCloseTo(before.polygon![i].y + 0.03, 10);
      });
      expect(openingGeometry(before, kind, [host], 12, 8)!.polygon).toEqual(before.polygon);
    }
  });

  it.each(["start", "end"] as const)("leaves a valid opening in place when the wall's %s endpoint moves", endpoint => {
    const previous = initialHistory({ ...emptyProject(), planW: 10, planH: 10, walls: [wall], doors: [door] }).present;
    const host = endpoint === "start" ? { ...wall, x1: 0.2 } : { ...wall, x2: 0.7 };
    const next = syncOpeningRecords({ ...previous, walls: [host] }, previous);
    const before = previous.doors[0], after = next.doors[0];
    expect(after.bbox.x).toBeCloseTo(before.bbox.x, 10);
    expect(after.bbox.w).toBeCloseTo(before.bbox.w, 10);
    expect(after.planSegment!.start.x).toBeCloseTo(before.planSegment!.start.x, 10);
    // Even without synchronization, an endpoint extension cannot scale saved geometry.
    const read = openingGeometry(before, "door", [host], 10, 10)!;
    expect(read.width).toBeCloseTo(2, 10);
  });

  it("slides an opening only as far as needed on a shortened host and preserves its width", () => {
    const previous = initialHistory({ ...emptyProject(), planW: 10, planH: 10, walls: [wall], doors: [door] }).present;
    const next = syncOpeningRecords({ ...previous, walls: [{ ...wall, x2: 0.4 }] }, previous);
    expect(next.doors[0].planSegment!.start.x).toBeCloseTo(0.2, 10);
    expect(next.doors[0].planSegment!.end.x).toBeCloseTo(0.4, 10);
    expect(openingGeometry(next.doors[0], "door", next.walls, 10, 10)!.width).toBeCloseTo(2, 10);
  });

  it.each(["door", "window"] as const)("moves and resizes only the selected %s, including its stored polygon", kind => {
    const state = initialHistory({ ...emptyProject(), planW: 10, planH: 10, walls: [wall],
      doors: [door], windows: [{ ...door, id: "window", wallSpan: { start: 0.65, end: 0.8 } }] });
    for (const mode of ["move", "width"] as const) {
      const items = kind === "door" ? state.present.doors : state.present.windows;
      const updated = editOpening(items[0], kind, { mode, value: mode === "move" ? 0.1 : 0.5 }, state.present.walls, state.present.doors, state.present.windows, 10, 10)!;
      const next = projectHistoryReducer(state, { type: "edit", info: { label: "opening edit" }, update: p => ({ ...p, [kind === "door" ? "doors" : "windows"]: [updated] }) });
      expect(next.present.walls).toBe(state.present.walls);
      expect(kind === "door" ? next.present.windows : next.present.doors).toBe(kind === "door" ? state.present.windows : state.present.doors);
      const result = (kind === "door" ? next.present.doors : next.present.windows)[0];
      expect(result.polygon).not.toEqual(items[0].polygon);
      expect(result.planSegment).not.toEqual(items[0].planSegment);
      expect(projectHistoryReducer(next, { type: "undo" }).present).toEqual(state.present);
      expect(projectHistoryReducer(projectHistoryReducer(next, { type: "undo" }), { type: "redo" }).present).toEqual(next.present);
    }
  });

  it("rejects a host height reduction that would shrink an opening", () => {
    const previous = initialHistory({ ...emptyProject(), planW: 10, planH: 10, walls: [wall], doors: [door] }).present;
    expect(syncOpeningRecords({ ...previous, walls: [{ ...wall, wallHeight: 1 }] }, previous)).toBe(previous);
  });
});


it("preserves opening depth when moving after calibration", () => {
  const previous = initialHistory({ ...emptyProject(), walls: [wall], doors: [door] }).present;
  const calibrated = syncOpeningRecords({ ...previous, planW: 10, planH: 10 }, previous);
  const before = calibrated.doors[0];
  const moved = editOpening(before, "door", { mode: "move", value: 0.2 }, [wall], [before], [], 10, 10)!;
  expect(moved.bbox.w).toBeCloseTo(before.bbox.w, 10);
  expect(moved.bbox.h).toBeCloseTo(before.bbox.h, 10);
  const viaControl = syncOpeningRecords({ ...calibrated, doors: [{ ...before, wallSpan: moved.wallSpan }] }, calibrated);
  expect(viaControl.doors[0].bbox.h).toBeCloseTo(before.bbox.h, 10);
});

it("applies window defaults when materializing geometry created by the shared point helper", () => {
  const placed = openingAtPoints({ id: "window", bbox: door.bbox }, wall, { x: 0.3, y: 0.2 }, { x: 0.5, y: 0.2 }, 10, 10);
  const project = initialHistory({ ...emptyProject(), walls: [wall], windows: [placed], planW: 10, planH: 10 }).present;
  expect(project.windows[0].heightM).toBe(1.2);
  expect(project.windows[0].sillHeightM).toBe(0.9);
});

it("changes and persists the new-wall default without changing existing walls or openings", () => {
  const state = initialHistory({ ...emptyProject(), walls: [{ ...wall, wallHeight: undefined }, { ...wall, id: "override", wallHeight: 4 }], doors: [door] });
  const next = projectHistoryReducer(state, { type: "edit", info: { label: "default wall height" }, update: p => withDefaultWallHeight(p, 3.5) });
  expect(next.present.wallHeightMeter).toBe(3.5);
  expect(next.present.walls.map(w => w.wallHeight)).toEqual([2.8, 4]);
  expect(next.present.doors).toBe(state.present.doors);
  const saved = createFloorPlanProject({ ...next.present, planWidth: 10, planHeight: 10 });
  expect(parseFloorPlanProject(JSON.parse(JSON.stringify(saved))).meta.wallHeightMeter).toBe(3.5);
  expect(projectHistoryReducer(next, { type: "undo" }).present).toEqual(state.present);
});
