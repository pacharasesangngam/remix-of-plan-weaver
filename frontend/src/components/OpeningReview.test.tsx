import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WallReview from "./WallReview";
import { openingGeometry, rehostOpening, type Opening, type OpeningKind } from "@/lib/openingModel";
import { computeGapIntervals } from "@/lib/wallRenderGeometry";
import type { DetectedWallSegment as Wall } from "@/types/detection";
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("PointerEvent", class extends MouseEvent { pointerId = 1; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(wall: Wall, kind: OpeningKind = "door", extraWalls: Wall[] = []) {
  const walls = [wall, ...extraWalls];
  const initial: Opening = { id: "opening", wallId: wall.id, wallSpan: { start: 0.2, end: 0.4 },
    bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }] };
  const commit = vi.fn();
  function Editor() {
    const [opening, setOpening] = useState(initial);
    const update = (id: string, field: keyof Opening, value: Opening[keyof Opening]) => { commit(id, field, value); setOpening(o => ({ ...o, [field]: value })); };
    const doors = kind === "door" ? [opening] : [], windows = kind === "window" ? [opening] : [];
    return <><WallReview rooms={[]} walls={walls} doors={doors} windows={windows} scale={0.02} calibrationStatus="calibrated"
      planWidth={10} planHeight={10} unit="m" imageUrl="plan.png" onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()}
      onDoorUpdate={update} onWindowUpdate={update}
      onOpeningRehost={(type, id, target, point) => {
        const updated = rehostOpening(opening, type, target, point, walls, doors, windows, 10, 10, 3);
        if (updated) { commit(id, "rehost", updated); setOpening(updated); }
      }} />
      <output data-testid="record">{JSON.stringify(opening)}</output>
      <output data-testid="cuts">{JSON.stringify(computeGapIntervals(wall, Math.hypot(wall.x2-wall.x1, wall.y2-wall.y1)*10, 3, doors, windows, [wall], 10, 10))}</output></>;
  }
  const view = render(<Editor />);
  const svg = view.container.querySelector('svg[viewBox="0 0 100 100"]') as SVGSVGElement;
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: -80, top: 30, width: 1000, height: 600 } as DOMRect);
  svg.setPointerCapture = vi.fn(); svg.hasPointerCapture = vi.fn(() => true); svg.releasePointerCapture = vi.fn();
  const at = (t: number) => ({ clientX: -80 + (wall.x1 + (wall.x2-wall.x1)*t)*1000,
    clientY: 30 + (wall.y1 + (wall.y2-wall.y1)*t)*600, pointerId: 1, button: 0 });
  fireEvent.click(svg, at(0.3));
  return { ...view, svg, at, commit, read: () => JSON.parse(view.getByTestId("record").textContent!) as Opening };
}
const horizontal: Wall = { id: "wall", x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.2, type: "interior", thickness: 0.15, wallHeight: 3 };
describe("Review opening editing", () => {
  it.each([horizontal, { ...horizontal, x2: 0.1, y2: 0.9 }, { ...horizontal, x2: 0.8, y2: 0.8 }])("selects actual geometry, moves and resizes on host %j", wall => {
    const { svg, at, commit, read, getByTestId } = setup(wall);
    const group = svg.querySelector('[data-opening-geometry="door:opening"]')!;
    expect(group.querySelectorAll("rect")).toHaveLength(0);
    expect(group.querySelectorAll('[data-opening-handle]')).toHaveLength(2);
    const before = openingGeometry(read(), "door", [wall], 10, 10)!;
    expect(group.querySelector("path")?.getAttribute("d")).not.toContain("0.9 0.9"); // No swing polygon selection.
    fireEvent.pointerDown(svg, at(0.3));
    fireEvent.pointerMove(svg, at(0.4));
    expect(commit).not.toHaveBeenCalled();
    fireEvent.pointerUp(svg, at(0.4));
    expect(commit).toHaveBeenCalledOnce();
    expect(read().wallSpan!.start).toBeCloseTo(0.3); expect(read().wallSpan!.end).toBeCloseTo(0.5);
    expect(openingGeometry(read(), "door", [wall], 10, 10)!.width).toBeCloseTo(before.width);
    fireEvent.pointerDown(svg, at(0.5));
    fireEvent.pointerMove(svg, at(0.6));
    fireEvent.pointerUp(svg, at(0.6));
    expect(read().wallSpan!.end).toBeCloseTo(0.6);
    const g = openingGeometry(read(), "door", [wall], 10, 10)!;
    expect(JSON.parse(getByTestId("cuts").textContent!)[0]).toMatchObject({ tStart: g.tStart, tEnd: g.tEnd });
    expect(read().wallId).toBe(wall.id);
  });
  it("uses numeric width/height/sill for the same span and 3D wall cut", () => {
    const view = setup(horizontal, "window");
    const edit = (field: string, value: string) => { fireEvent.change(view.getByLabelText(`Opening ${field} (m)`), { target: { value } }); fireEvent.blur(view.getByLabelText(`Opening ${field} (m)`)); };
    edit("width", "1.25"); edit("height", "1.1"); edit("sill", "0.7");
    const g = openingGeometry(view.read(), "window", [horizontal], 10, 10)!;
    expect(g.width).toBeCloseTo(1.25); expect(g.height).toBe(1.1); expect(g.sill).toBe(0.7);
    expect(JSON.parse(view.getByTestId("cuts").textContent!)[0]).toMatchObject({ tStart: g.tStart, tEnd: g.tEnd, height: 1.1, yStart: 0.7 });
  });
  it("clamps to the wall and cancels a drag without committing a geometry update", () => {
    const { svg, at, commit, read } = setup(horizontal);
    fireEvent.pointerDown(svg, at(0.4)); fireEvent.pointerMove(svg, at(2)); fireEvent.pointerUp(svg, at(2));
    expect(read().wallSpan!.end).toBe(1);
    const before = read(); commit.mockClear();
    fireEvent.pointerDown(svg, at(0.2)); fireEvent.pointerMove(svg, at(-1)); fireEvent.pointerCancel(svg, at(-1));
    expect(read()).toEqual(before); expect(commit).not.toHaveBeenCalled();
  });
});


it.each(["door", "window"] as const)("previews and re-hosts a %s on release, preserving dimensions and moving the cut", kind => {
  const target: Wall = { ...horizontal, id: "target", x1: 0.8, y1: 0.3, x2: 0.8, y2: 0.9, wallHeight: 4 };
  const view = setup(horizontal, kind, [target]);
  const before = openingGeometry(view.read(), kind, [horizontal], 10, 10)!;
  const near = { clientX: -80 + 0.795 * 1000, clientY: 30 + 0.6 * 600, button: 0, pointerId: 1 };
  fireEvent.pointerDown(view.svg, view.at(0.3));
  fireEvent.pointerMove(view.svg, near);
  expect(view.svg.querySelector('[data-opening-rehost-target="target"]')).toHaveAttribute("stroke", "#22c55e");
  expect(view.commit).not.toHaveBeenCalled();
  fireEvent.pointerUp(view.svg, near);
  expect(view.commit).toHaveBeenCalledOnce();
  expect(view.read().wallId).toBe("target");
  const after = openingGeometry(view.read(), kind, [horizontal, target], 10, 10)!;
  expect(after.width).toBeCloseTo(before.width); expect(after.height).toBe(before.height); expect(after.sill).toBe(before.sill);
  expect(after.start.x).toBe(0.8); expect(after.end.x).toBe(0.8);
  expect(JSON.parse(view.getByTestId("cuts").textContent!)).toEqual([]);
  expect(view.svg.querySelector('[data-opening-rehost-target]')).toBeNull();
});

it("clears re-host feedback when leaving range and releases on the original valid host", () => {
  const target: Wall = { ...horizontal, id: "target", x1: 0.8, y1: 0.3, x2: 0.8, y2: 0.9 };
  const view = setup(horizontal, "door", [target]);
  fireEvent.pointerDown(view.svg, view.at(0.3));
  fireEvent.pointerMove(view.svg, { clientX: 720, clientY: 390, button: 0 });
  expect(view.svg.querySelector('[data-opening-rehost-target]')).not.toBeNull();
  fireEvent.pointerMove(view.svg, { clientX: 500, clientY: 390, button: 0 });
  expect(view.svg.querySelector('[data-opening-rehost-target]')).toBeNull();
  fireEvent.pointerUp(view.svg, { clientX: 500, clientY: 390, button: 0 });
  expect(view.read().wallId).toBe(horizontal.id);
  expect(openingGeometry(view.read(), "door", [horizontal, target], 10, 10)).not.toBeNull();
});

it("uses release position to discard a stale new-host preview and cancels without re-hosting", () => {
  const target: Wall = { ...horizontal, id: "target", x1: 0.8, y1: 0.3, x2: 0.8, y2: 0.9 };
  const view = setup(horizontal, "door", [target]);
  fireEvent.pointerDown(view.svg, view.at(0.3));
  fireEvent.pointerMove(view.svg, { clientX: 720, clientY: 390, button: 0 });
  fireEvent.pointerCancel(view.svg, { clientX: 720, clientY: 390, button: 0 });
  expect(view.commit).not.toHaveBeenCalled(); expect(view.read().wallId).toBe(horizontal.id);
  fireEvent.pointerDown(view.svg, view.at(0.3));
  fireEvent.pointerMove(view.svg, { clientX: 720, clientY: 390, button: 0 });
  fireEvent.pointerUp(view.svg, view.at(0.4));
  expect(view.read().wallId).toBe(horizontal.id);
});
