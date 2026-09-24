import { describe, expect, it } from "vitest";
import { resolveOpeningWall } from "./openingAttachment";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number) => ({ id, x1, y1, x2, y2, type: "interior" as const, thickness: 0.15 });

describe("resolveOpeningWall", () => {
  it("resolves a geometrically valid host without changing the detection bbox", () => {
    const bbox = { x: 0.35, y: 0.2925, w: 0.1, h: 0.015 };
    const result = resolveOpeningWall(bbox, [wall("host", .2, .3, .8, .3)], 10, 10);
    expect(result).toMatchObject({ status: "resolved", wall: { id: "host" } });
    expect(bbox).toEqual({ x: 0.35, y: 0.2925, w: 0.1, h: 0.015 });
  });

  it("does not choose between equally valid crossing walls", () => {
    const result = resolveOpeningWall({ x: .49, y: .49, w: .02, h: .02 }, [wall("a", .2, .5, .8, .5), wall("b", .5, .2, .5, .8)], 10, 10);
    expect(result.status).toBe("ambiguous");
  });
});
