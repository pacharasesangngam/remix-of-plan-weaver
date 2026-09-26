import { describe, expect, it } from "vitest";
import { createFloorPlanProject, parseFloorPlanProject } from "./projectIO";
import { getMeasuredRoomArea, hasCalibration } from "./wallMetrics";
import type { Room } from "@/types/floorplan";

const room: Room = { id: "r", name: "Room", confidence: "high", width: 0.4, height: 0.3, areaSqm: 9999,
  polygon: [{ x: 0, y: 0 }, { x: 0.4, y: 0 }, { x: 0.4, y: 0.3 }, { x: 0, y: 0.3 }] };
const data = { unit: "m" as const, scale: 0.02, planWidth: 12, planHeight: 8, rooms: [room], walls: [], doors: [], windows: [] };

describe("calibration provenance", () => {
  it("round trips explicit calibration and respects an uncalibrated status with positive dimensions", () => {
    for (const calibrationStatus of ["calibrated", "uncalibrated"] as const) {
      const saved = createFloorPlanProject({ ...data, calibrationStatus });
      const loaded = parseFloorPlanProject(JSON.parse(JSON.stringify(saved)));
      expect(loaded.meta.calibrationStatus).toBe(calibrationStatus);
      expect(loaded.rooms).toEqual(data.rooms);
      expect(loaded.meta.planWidth).toBe(12);
    }
  });
  it("requires recalibration for legacy uploads but retains the metric canvas of legacy drawings", () => {
    const saved = createFloorPlanProject(data);
    delete saved.meta.calibrationStatus;
    expect(parseFloorPlanProject(saved).meta.calibrationStatus).toBe("uncalibrated");
    saved.meta.editorMode = "draw";
    expect(parseFloorPlanProject(saved).meta.calibrationStatus).toBe("calibrated");
  });
  it.each([0, -1, NaN, Infinity, undefined])("rejects invalid calibration metadata (%s)", value => {
    const saved = createFloorPlanProject({ ...data, calibrationStatus: "calibrated" });
    for (const key of ["scale", "planWidth", "planHeight"] as const) {
      expect(parseFloorPlanProject({ ...saved, meta: { ...saved.meta, [key]: value } }).meta.calibrationStatus).toBe("uncalibrated");
    }
    expect(hasCalibration("calibrated", 0.02, value, 8)).toBe(false);
  });
});

it("uses current geometry and dimensions for areas, ignoring stale backend areas", () => {
  expect(getMeasuredRoomArea(room, 20, 20, false)).toBeNull();
  expect(getMeasuredRoomArea(room, 12, 8, true)).toBeCloseTo(11.52);
  expect(getMeasuredRoomArea(room, 18, 12, true)).toBeCloseTo(25.92);
  const changed = { ...room, polygon: room.polygon!.map(point => ({ ...point, x: point.x * 2 })) };
  expect(getMeasuredRoomArea(changed, 12, 8, true)).toBeCloseTo(23.04);
});
