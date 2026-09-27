import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import OpeningDimensions from "./OpeningDimensions";
import { newOpeningRecord } from "@/lib/openingModel";
import type { DetectedWallSegment } from "@/types/detection";
const wall: DetectedWallSegment = { id: "host", x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.2, type: "interior", wallHeight: 3 };
afterEach(cleanup);
it.each(["door", "window"] as const)("edits independent %s dimensions with the shared Review/3D controls", kind => {
  const opening = newOpeningRecord(kind, "opening", wall, { x: 0.3, y: 0.2 }, { x: 0.5, y: 0.2 }, 10, 10)!;
  const onEdit = vi.fn();
  const props = { opening, kind, walls: [wall], doors: kind === "door" ? [opening] : [], windows: kind === "window" ? [opening] : [], pw: 10, ph: 10, wallHeight: 3, onEdit };
  const view = render(<OpeningDimensions {...props} calibrated={false} />);
  expect(view.getByLabelText("Opening width (m)")).toBeDisabled();
  expect(view.getByLabelText("Opening width (m)")).toHaveAttribute("placeholder", "\u2014");
  expect(view.getByLabelText("Opening width (m)")).toHaveValue(null);
  expect(view.getByLabelText("Opening height (m)")).toHaveValue(kind === "door" ? 2.2 : 1.2);
  view.rerender(<OpeningDimensions {...props} calibrated />);
  expect(view.getByLabelText("Opening width (m)")).toHaveValue(2);
  for (const [field, value, property] of [["width", "1.5", "wallSpan"], ["height", "1.4", "heightM"], ...(kind === "window" ? [["sill", "0.7", "sillHeightM"]] : [])]) {
    const input = view.getByLabelText(`Opening ${field} (m)`);
    fireEvent.change(input, { target: { value } }); fireEvent.blur(input);
    expect(onEdit).toHaveBeenLastCalledWith(property, property === "wallSpan" ? { start: expect.closeTo(0.25, 10), end: expect.closeTo(0.4375, 10) } : Number(value));
  }
  expect(wall.x2).toBe(0.9); expect(wall.wallHeight).toBe(3);
});
