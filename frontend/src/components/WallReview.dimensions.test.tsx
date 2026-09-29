import { useReducer } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import WallReview from "./WallReview";
import { emptyProject, initialHistory, projectHistoryReducer } from "@/lib/projectHistory";
import { proposeWallLength } from "@/lib/wallLengthEdit";
import type { DetectedWallSegment as Wall } from "@/types/detection";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall =>
  ({ id, type: "interior", x1: x1 / 20, y1: y1 / 20, x2: x2 / 20, y2: y2 / 20, thickness: 0.15 });
function setup() {
  const walls = [wall("top", 0, 0, 13.2, 0), wall("right", 13.2, 0, 13.2, 6), wall("bottom", 0, 6, 13.2, 6), wall("left", 0, 0, 0, 6), wall("divider", 5.5, 0, 5.5, 6)];
  const committed = vi.fn();
  function Editor() {
    const [history, dispatch] = useReducer(projectHistoryReducer, undefined, () => initialHistory({ ...emptyProject(), walls, planW: 20, planH: 20, scale: 1, calibrationStatus: "calibrated" }));
    const p = history.present;
    return <><button onClick={() => dispatch({ type: "undo" })}>Test undo</button><button onClick={() => dispatch({ type: "redo" })}>Test redo</button>
      <output data-testid="project">{JSON.stringify(p)}</output><output data-testid="steps">{history.past.length}</output>
      <WallReview rooms={p.rooms} walls={p.walls} doors={p.doors} windows={p.windows} confirmedDimensions={p.confirmedDimensions}
        planWidth={p.planW} planHeight={p.planH} scale={p.scale} calibrationStatus={p.calibrationStatus} unit="m" imageUrl="plan.png"
        onRoomUpdate={vi.fn()} onScaleChange={vi.fn()} onGenerate={vi.fn()} onWallLengthCommit={(request, base, pw, ph) => {
          committed(request);
          dispatch({ type: "edit", info: { label: "wall length change" }, update: current => {
            const candidate = proposeWallLength(base, request, pw, ph);
            return candidate.ok ? { ...current, ...candidate.geometry } : current;
          } });
        }} />
    </>;
  }
  const view = render(<Editor />);
  const svg = view.container.querySelector('svg[viewBox="0 0 100 100"]')!;
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 600 } as DOMRect);
  const selectRoom = () => fireEvent.click(svg, { clientX: 150, clientY: 90 });
  const selectWall = () => fireEvent.click(svg, { clientX: 450, clientY: 0 });
  const topDimension = () => svg.querySelector('[data-dimension-wall="top"]')!;
  const read = () => JSON.parse(view.getByTestId("project").textContent!);
  const beginBoundary = () => fireEvent.click(view.getAllByRole("button", { name: /Edit boundary length 5\.50 m/ })[0]);
  return { ...view, svg, selectRoom, selectWall, topDimension, beginBoundary, read, committed };
}

it("keeps the default clean and highlights exactly the selected room's partial wall", () => {
  const view = setup();
  expect(view.svg.querySelectorAll('[data-plan-dimension]')).toHaveLength(0);
  expect(view.svg.textContent).toContain("33.00 m²");
  view.selectRoom();
  expect(view.svg.querySelectorAll('[data-plan-dimension]')).toHaveLength(4);
  const boundary = view.topDimension().querySelector('[data-room-boundary-span]')!;
  expect(boundary).toHaveAttribute("x2", "0.275");
  expect(boundary).toHaveAttribute("stroke", "#7c3aed");
  expect(view.topDimension().querySelectorAll("ellipse")).toHaveLength(0);
  expect(view.topDimension().querySelector("rect")).toBeNull();
  const label = within(view.topDimension() as HTMLElement).getByRole("button");
  expect(label.querySelector("text")).toHaveTextContent(/^5.50$/);
  fireEvent.mouseEnter(label);
  const highlight = view.topDimension().querySelector('[data-dimension-highlight]')!;
  expect(highlight.querySelector("line")).toHaveAttribute("x1", "0");
  expect(highlight.querySelector("line")).toHaveAttribute("x2", "0.275");
  expect(highlight.querySelectorAll("ellipse")).toHaveLength(0);
  fireEvent.mouseLeave(label);
  expect(view.topDimension().querySelector('[data-dimension-highlight]')).toBeNull();
  const span = view.topDimension().querySelector('[data-boundary-hit-target]')!;
  fireEvent.mouseEnter(span);
  expect(view.topDimension().querySelectorAll("ellipse")).toHaveLength(0);
  fireEvent.click(view.getAllByRole("button", { name: /Edit boundary length 5\.50 m/ })[0]);
  expect(view.getAllByRole("spinbutton", { name: "Boundary length (m)" })[0]).toHaveValue(5.5);
  expect(view.read().walls).toHaveLength(5);
});

it("cancels with Escape, commits Enter/blur once, shares sidebar edits and restores geometry/area/constraints with undo", () => {
  const view = setup();
  view.selectRoom(); view.beginBoundary();
  const input = () => view.getAllByRole("spinbutton", { name: "Boundary length (m)" })[0];
  fireEvent.change(input(), { target: { value: "5.7" } });
  fireEvent.keyDown(input(), { key: "Escape" });
  expect(view.committed).not.toHaveBeenCalled();
  expect(view.read().walls[4].x1).toBe(0.275);
  view.beginBoundary();
  fireEvent.change(input(), { target: { value: "5.7" } });
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(view.committed).toHaveBeenCalledTimes(1);
  expect(view.getByTestId("steps")).toHaveTextContent("1");
  expect(view.read().walls[4].x1).toBeCloseTo(0.285);
  expect(view.svg.textContent).toContain("34.20 m²");
  const side = view.getAllByRole("button", { name: /Edit boundary length 5\.70 m/ })[0];
  fireEvent.click(side);
  const sideInput = view.getAllByRole("spinbutton", { name: "Boundary length (m)" }).at(-1)!;
  fireEvent.change(sideInput, { target: { value: "5.8" } });
  expect(sideInput).toBeInTheDocument();
  fireEvent.blur(sideInput);
  expect(view.getByTestId("steps")).toHaveTextContent("2");
  expect(view.read().walls[4].x1).toBeCloseTo(0.29);
  fireEvent.click(view.getByText("Test undo"));
  expect(view.read().walls[4].x1).toBeCloseTo(0.285);
  expect(view.read().confirmedDimensions[0].lengthM).toBe(5.7);
  fireEvent.click(view.getByText("Test undo"));
  expect(view.read().walls[4].x1).toBeCloseTo(0.275);
  expect(view.svg.textContent).toContain("33.00 m²");
  fireEvent.click(view.getByText("Test redo"));
  expect(view.read().walls[4].x1).toBeCloseTo(0.285);
});

it("edits the entire continuous wall from the canvas and sidebar without changing calibration", () => {
  const view = setup(); view.selectWall();
  expect(within(view.topDimension() as HTMLElement).getByRole("button")).toHaveTextContent("13.20");
  fireEvent.click(within(view.topDimension() as HTMLElement).getByRole("button"));
  const input = view.getByRole("spinbutton", { name: "Canvas wall length (m)" });
  fireEvent.change(input, { target: { value: "14" } }); fireEvent.blur(input);
  expect(view.read().walls[0].x2 * 20).toBeCloseTo(14);
  expect(view.getByRole("spinbutton", { name: "Wall length (m)" })).toHaveValue(14);
  const sidebar = view.getByRole("spinbutton", { name: "Wall length (m)" });
  fireEvent.change(sidebar, { target: { value: "13.5" } }); fireEvent.keyDown(sidebar, { key: "Enter" }); fireEvent.blur(sidebar);
  expect(view.committed).toHaveBeenCalledTimes(2);
  expect(view.read()).toMatchObject({ scale: 1, planW: 20, planH: 20 });
  expect(view.read().confirmedDimensions).toHaveLength(1);
  expect(view.read().walls).toHaveLength(5);
});
