import { describe, expect, it } from "vitest";
import { createOpeningBboxFromWallPoints } from "./openingPlacement";

const wall = {
  id: "wall-1",
  x1: 0.1,
  y1: 0.5,
  x2: 0.9,
  y2: 0.5,
  type: "interior" as const,
  thickness: 0.2,
};

describe("createOpeningBboxFromWallPoints", () => {
  it("uses the user-selected span and the wall's actual thickness", () => {
    const bbox = createOpeningBboxFromWallPoints(wall, { x: 0.3, y: 0.48 }, { x: 0.6, y: 0.52 }, 10, 10);

    expect(bbox).toMatchObject({ y: 0.49 });
    expect(bbox!.x).toBeCloseTo(0.3);
    expect(bbox!.w).toBeCloseTo(0.3);
    expect(bbox!.h).toBeCloseTo(0.02);
  });

  it("projects both placement points onto an angled attached wall", () => {
    const angled = { ...wall, x2: 0.9, y2: 0.9 };
    const bbox = createOpeningBboxFromWallPoints(angled, { x: 0.35, y: 0.35 }, { x: 0.7, y: 0.7 }, 10, 10);

    expect(bbox).not.toBeNull();
    expect(bbox!.w).toBeGreaterThan(0);
    expect(bbox!.h).toBeGreaterThan(0);
  });

  it("does not invent an opening when the user has not supplied a span", () => {
    expect(createOpeningBboxFromWallPoints(wall, { x: 0.4, y: 0.5 }, { x: 0.4, y: 0.5 }, 10, 10)).toBeNull();
  });
});
