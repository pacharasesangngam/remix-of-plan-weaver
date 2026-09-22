import { describe, expect, it } from "vitest";
import type { DetectedWallSegment } from "@/types/detection";
import {
  DEFAULT_WALL_THICKNESS_M,
  getWallThicknessM,
  initializeDetectedWalls,
  rescalePlanDimensions,
  uniformWallThicknessM,
  wallStrokeWidthNormalized,
} from "./wallMetrics";

const ratioWall: DetectedWallSegment = {
  id: "ratio-wall",
  x1: 0.1,
  y1: 0.5,
  x2: 0.9,
  y2: 0.5,
  type: "interior",
  thicknessRatio: 0.01,
};

describe("shared wall metrics", () => {
  it("rescales measured plan dimensions with Advanced scale edits", () => {
    const resized = rescalePlanDimensions(12, 8, 0.012, 0.018);
    expect(resized.planWidth).toBeCloseTo(18);
    expect(resized.planHeight).toBeCloseTo(12);
  });

  it("preserves explicit metre thickness", () => {
    expect(getWallThicknessM({ ...ratioWall, thickness: 0.21 }, 12, 8)).toBe(0.21);
  });

  it("initializes new detection walls without discarding ratio metadata", () => {
    const initialized = initializeDetectedWalls([ratioWall]);
    expect(initialized[0]).toMatchObject({ thickness: 0.15, thicknessRatio: 0.01 });
    expect(initialized[0]).not.toBe(ratioWall);
  });

  it("uses the backend max-image-dimension basis for non-square plans", () => {
    expect(getWallThicknessM(ratioWall, 12, 8)).toBeCloseTo(0.12);
  });

  it("reports uniform and mixed effective thicknesses", () => {
    expect(uniformWallThicknessM([{ ...ratioWall, thickness: 0.15 }, { ...ratioWall, id: "b", thickness: 0.15 }], 12, 8)).toBe(0.15);
    expect(uniformWallThicknessM([{ ...ratioWall, thickness: 0.15 }, { ...ratioWall, id: "b", thickness: 0.2 }], 12, 8)).toBeNull();
  });

  it("projects the same physical thickness into normalized Review width", () => {
    const horizontal = wallStrokeWidthNormalized(ratioWall, 12, 8);
    const vertical = wallStrokeWidthNormalized({ ...ratioWall, x1: 0.5, y1: 0.1, x2: 0.5, y2: 0.9 }, 12, 8);
    expect(horizontal).toBeCloseTo(0.015);
    expect(vertical).toBeCloseTo(0.01);
    expect(getWallThicknessM({ id: "default", x1: 0, y1: 0, x2: 1, y2: 0, type: "interior" }, 12, 8)).toBe(DEFAULT_WALL_THICKNESS_M);
  });
});
