import { describe, expect, it } from "vitest";
import { targetPreviewShowsOutline } from "./wallHighlightState";

describe("wall target highlight state", () => {
  it("keeps the hover preview outline, but leaves a selected wall outline to WallEditGizmo", () => {
    const selected = { type: "wall", id: "branch" };

    // Hovering another wall still needs its own blue fill and outline.
    expect(targetPreviewShowsOutline({ type: "wall", id: "host" }, selected)).toBe(true);
    // A selected wall retains DeletePreviewMesh's blue fill, but its edit gizmo is
    // the sole finished-geometry outline.
    expect(targetPreviewShowsOutline(selected, selected)).toBe(false);
    // Opening/room previews never share a wall edit-gizmo outline.
    expect(targetPreviewShowsOutline({ type: "door", id: "door-1" }, selected)).toBe(true);
  });
});
