import { describe, expect, it } from "vitest";
import { advanceOpeningDraft, cancelOpeningDraft, isValidOpeningTarget, openingPreviewIsOnWall } from "./openingInteraction";

describe("opening draft interaction", () => {
  const start = { x: 0.2, y: 0.5 };

  it("starts a draft for preview without confirming an element", () => {
    const result = advanceOpeningDraft(null, "door", "wall-a", start);
    expect(result.confirms).toBe(false);
    expect(result.draft).toEqual({ kind: "door", wallId: "wall-a", start });
    expect(openingPreviewIsOnWall(result.draft, "wall-a")).toBe(true);
  });

  it("confirms only with a second point on the same wall", () => {
    const draft = advanceOpeningDraft(null, "window", "wall-a", start).draft;
    expect(isValidOpeningTarget(draft, "wall-a")).toBe(true);
    expect(isValidOpeningTarget(draft, "wall-b")).toBe(false);
    expect(isValidOpeningTarget(draft, null)).toBe(false);
    expect(advanceOpeningDraft(draft, "window", "wall-b", { x: 0.8, y: 0.5 })).toEqual({ draft, confirms: false });
    expect(advanceOpeningDraft(draft, "window", "wall-a", { x: 0.6, y: 0.5 }).confirms).toBe(true);
  });

  it("cancels by discarding the draft without confirming an element", () => {
    const draft = advanceOpeningDraft(null, "door", "wall-a", start).draft;
    expect(cancelOpeningDraft()).toBeNull();
    expect(openingPreviewIsOnWall(cancelOpeningDraft(), "wall-a")).toBe(false);
    expect(draft).not.toBeNull();
  });
});
