import { describe, expect, it } from "vitest";
import { capturesThreeTargetPointer, nextThreeSelection, nextThreeToolAfterCreation } from "./threeInteraction";

describe("3D interaction policy", () => {
  it("keeps selection when a hovered target is left, changes it on another target, and clears it on empty space", () => {
    expect(nextThreeSelection("wall-a", "select", "leave")).toBe("wall-a");
    expect(nextThreeSelection("wall-a", "select", "target", "door-a")).toBe("door-a");
    expect(nextThreeSelection("door-a", "select", "empty")).toBeNull();
  });

  it("routes each add tool to the correct 3D surface", () => {
    expect(capturesThreeTargetPointer("wall", "room")).toBe(false);
    expect(capturesThreeTargetPointer("wall", "wall")).toBe(false);
    expect(capturesThreeTargetPointer("door", "wall")).toBe(true);
    expect(capturesThreeTargetPointer("door", "door")).toBe(false);
    expect(capturesThreeTargetPointer("window", "wall")).toBe(true);
    expect(capturesThreeTargetPointer("window", "window")).toBe(false);
  });

  it("returns to Select after creating one wall, door, or window", () => {
    expect(nextThreeToolAfterCreation("wall")).toBe("select");
    expect(nextThreeToolAfterCreation("door")).toBe("select");
    expect(nextThreeToolAfterCreation("window")).toBe("select");
  });
});
