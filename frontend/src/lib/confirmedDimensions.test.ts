import { expect, it } from "vitest";
import { confirmCalibration, parseConfirmedDimensions, rebindConfirmedDimensions } from "./confirmedDimensions";
import { createFloorPlanProject, parseFloorPlanProject } from "./projectIO";
import type { DetectedWallSegment } from "@/types/detection";
const walls: DetectedWallSegment[] = [{ id: "a", type: "interior", x1: 0, y1: 0, x2: 0.204, y2: 0 },
  { id: "b", type: "interior", x1: 0.204, y1: 0, x2: 0.66, y2: 0 }];
it("persists confirmed endpoint references, their span and entered metres", () => {
  const confirmedDimensions = confirmCalibration([{ x: 0, y: 0 }, { x: 0.66, y: 0 }], walls, 13.2);
  const project = createFloorPlanProject({ confirmedDimensions, calibrationStatus: "calibrated", unit: "m", scale: 0.02,
    planWidth: 20, planHeight: 10, walls, rooms: [], doors: [], windows: [] });
  const loaded = parseFloorPlanProject(JSON.parse(JSON.stringify(project)));
  expect(loaded.meta.confirmedDimensions).toEqual(confirmedDimensions);
  expect(confirmedDimensions[0].end.wallId).toBe("b");
  expect(() => parseConfirmedDimensions(confirmedDimensions, walls, 10, 10)).toThrow();
  expect(() => parseConfirmedDimensions([{ ...confirmedDimensions[0], start: null }], walls, 20, 10)).toThrow();
});
it("does not turn free-point calibration or legacy dimensions into confirmed spans", () => {
  expect(confirmCalibration([{ x: 0, y: 0.01 }, { x: 0.66, y: 0 }], walls, 13.2)).toEqual([]);
  expect(parseConfirmedDimensions(undefined, walls, 20, 10)).toEqual([]);
});
it("keeps references valid after deletion without leaving an unloadable saved project", () => {
  const dimensions = confirmCalibration([{ x: 0, y: 0 }, { x: 0.66, y: 0 }], walls, 13.2);
  const remaining = [walls[1], { ...walls[0], id: "replacement" }];
  const rebound = rebindConfirmedDimensions(dimensions, remaining);
  expect(rebound[0].start.wallId).toBe("replacement");
  expect(parseConfirmedDimensions(rebound, remaining, 20, 10)).toEqual(rebound);
  expect(rebindConfirmedDimensions(dimensions, [walls[1]])).toEqual([]);
});
