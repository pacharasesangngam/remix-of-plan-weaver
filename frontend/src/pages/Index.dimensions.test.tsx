import { Children, type ComponentProps, type ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type Sidebar from "@/components/Sidebar";
import type StartScreen from "@/components/StartScreen";
import type { FloorPlanProject } from "@/lib/projectIO";
import Index from "./Index";
import RightPanel from "@/components/RightPanel";
import { SCG_TILE_CATALOG } from "@/types/materialCatalog";

const project: FloorPlanProject = {
  app: "remix-of-plan-weaver", version: 1,
  meta: { calibrationStatus: "calibrated", unit: "m", scale: 0.02, planWidth: 12, planHeight: 8 },
  image: { dataUrl: "plan.png", cleanDataUrl: "clean.png", fileType: "image/png" },
  walls: [
    { id: "horizontal", type: "interior", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.2 },
    { id: "vertical", type: "interior", x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.5 },
    { id: "diagonal", type: "interior", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.5 },
  ],
  rooms: [{ id: "room", name: "Test room", confidence: "high", width: 0.4, height: 0.3,
    polygon: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.1, y: 0.5 }] }],
  doors: [], windows: [],
};
const rectangleProject: FloorPlanProject = { ...project,
  meta: { ...project.meta, planWidth: 10, planHeight: 10 },
  walls: [
    { id: "top", type: "interior", x1: 0.1, y1: 0.1, x2: 0.515, y2: 0.1 },
    { id: "right", type: "interior", x1: 0.515, y1: 0.1, x2: 0.515, y2: 0.4 },
    { id: "bottom", type: "interior", x1: 0.1, y1: 0.4, x2: 0.515, y2: 0.4 },
    { id: "left", type: "interior", x1: 0.1, y1: 0.1, x2: 0.1, y2: 0.4 },
  ],
  rooms: [{ id: "room", name: "Room", confidence: "high", width: 0.415, height: 0.3,
    polygon: [{ x: 0.1, y: 0.1 }, { x: 0.515, y: 0.1 }, { x: 0.515, y: 0.4 }, { x: 0.1, y: 0.4 }] }],
  doors: [{ id: "door", wallId: "right", bbox: { x: 0.51, y: 0.2, w: 0.01, h: 0.08 } }],
};
const chainProject: FloorPlanProject = { ...rectangleProject, rooms: [], doors: [],
  walls: [
    { id: "edited", type: "interior", x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.1 },
    { id: "diagonal", type: "interior", x1: 0.5, y1: 0.1, x2: 0.8, y2: 0.4 },
    { id: "branch", type: "interior", x1: 0.65, y1: 0.25, x2: 0.65, y2: 0.5 },
    { id: "leaf", type: "interior", x1: 0.65, y1: 0.375, x2: 0.5, y2: 0.5 },
    { id: "anchor", type: "interior", x1: 0.1, y1: 0.1, x2: 0.1, y2: 0.3 },
  ],
  windows: [{ id: "window", wallId: "branch", bbox: { x: 0.645, y: 0.3, w: 0.01, h: 0.04 } }],
};
const spanProject: FloorPlanProject = { ...project, rooms: [], doors: [], windows: [],
  meta: { ...project.meta, planWidth: 20, planHeight: 40 / 3 },
  walls: [
    { id: "a", type: "interior", x1: 0.1, y1: 0.2, x2: 0.304, y2: 0.2 },
    { id: "b", type: "interior", x1: 0.304, y1: 0.2, x2: 0.76, y2: 0.2 },
    { id: "branch", type: "interior", x1: 0.304, y1: 0.2, x2: 0.304, y2: 0.6 },
  ],
};

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
vi.mock("@/components/SplashScreen", () => ({ default: () => null }));
vi.mock("@/components/StartScreen", () => ({ default: (props: ComponentProps<typeof StartScreen>) => <>
  <button onClick={() => props.onImport(project)}>Import test plan</button>
  <button onClick={() => props.onImport(rectangleProject)}>Import rectangle</button>
  <button onClick={() => props.onImport(spanProject)}>Import span</button>
  <button onClick={() => props.onImport(chainProject)}>Import chain</button>
  <button onClick={() => props.onImport({ ...project,
    meta: { ...project.meta, calibrationStatus: undefined, scale: 1, planWidth: 20, planHeight: 20 },
    rooms: project.rooms.map(room => ({ ...room, areaSqm: 9999 })),
  })}>Import legacy plan</button>
</> }));
vi.mock("@/components/Sidebar", () => ({ default: (props: ComponentProps<typeof Sidebar>) => <>
  <button onClick={() => props.onScaleChange(props.scale * 1.5)}>Scale only</button>
  <output data-testid="project">{JSON.stringify(props.projectData)}</output>
</> }));
// Replace only WebGL rendering/picking. Index, Review, and the 3D inspector are real.
vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children: ReactElement }) => {
    const scene = Children.only(children) as ReactElement<{
      walls: FloorPlanProject["walls"];
      onSelect: (target: { type: "wall" | "room"; id: string }) => void;
    }>;
    return <div><button onClick={() => scene.props.onSelect({ type: "room", id: "room" })}>Pick room</button>{scene.props.walls.map(wall => <button key={wall.id}
      onClick={() => scene.props.onSelect({ type: "wall", id: wall.id })}>Pick {wall.id}</button>)}</div>;
  }, useFrame: vi.fn(), useThree: vi.fn(),
}));

let resizeCallbacks: Set<() => void>;
let viewport: { width: number; height: number };
beforeEach(() => {
  viewport = { width: 632, height: 432 }; // fitted image is initially 600 x 400
  resizeCallbacks = new Set();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewport.width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewport.height);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe() { resizeCallbacks.add(this.callback); }
    disconnect() { resizeCallbacks.delete(this.callback); }
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function loadReviewImage() {
  const image = screen.getByAltText("Floor plan");
  Object.defineProperties(image, { naturalWidth: { configurable: true, value: 1200 }, naturalHeight: { configurable: true, value: 800 } });
  fireEvent.load(image);
  return image;
}

function assertReviewLengths(container: HTMLElement, horizontal: string, vertical: string, diagonal: string) {
  const svg = container.querySelector('svg[viewBox="0 0 100 100"]')!;
  if (!screen.queryByRole("button", { name: /^Wall 1 / })) {
    if (!screen.queryByRole("button", { name: /^Walls\s*3/ })) fireEvent.click(screen.getByText("Other Elements"));
    fireEvent.click(screen.getByRole("button", { name: /^Walls\s*3/ }));
  }
  for (const [index, length] of [horizontal, vertical, diagonal].entries()) {
    const row = screen.getByRole("button", { name: new RegExp(`^Wall ${index + 1} `) });
    expect(row).toHaveTextContent(`${length} m`);
    fireEvent.click(row);
    expect(screen.getByDisplayValue(length)).toBeInTheDocument();
    expect(svg.textContent).toContain(`${length}m`);
  }
  fireEvent.click(container.querySelector('[data-plan-selection="room:room"]')!);
  const sideLabels = [...svg.querySelectorAll("text")].map(node => node.textContent);
  expect(sideLabels.filter(label => label === `${horizontal}m`)).toHaveLength(2);
  expect(sideLabels.filter(label => label === `${vertical}m`)).toHaveLength(2);
}

function assertThreeLengths(horizontal: number, vertical: number, diagonal: number) {
  for (const [id, length] of [["horizontal", horizontal], ["vertical", vertical], ["diagonal", diagonal]] as const) {
    fireEvent.click(screen.getByText(`Pick ${id}`));
    expect(screen.getByLabelText("Length (m)")).toHaveTextContent(length.toFixed(2));
  }
}

it("records snapped calibration and preserves its outer span through progressive corrections and Undo", () => {
  render(<Index />);
  fireEvent.click(screen.getByText("Import span"));
  fireEvent.click(screen.getByText("Back to Review"));
  const image = loadReviewImage();
  fireEvent.click(screen.getByRole("button", { name: /m\/px/ }));
  const overlay = image.parentElement!.querySelector("div.absolute.inset-0.z-20")!;
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 50, top: 30, width: 600, height: 400 } as DOMRect);
  fireEvent.pointerDown(overlay, { clientX: 114, clientY: 114 });
  fireEvent.pointerDown(overlay, { clientX: 502, clientY: 114 });
  fireEvent.change(screen.getByPlaceholderText("3.5"), { target: { value: "13.20" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  const saved = () => JSON.parse(screen.getByTestId("project").textContent!) as FloorPlanProject;
  const calibrated = saved();
  expect(calibrated.meta.confirmedDimensions?.[0].lengthM).toBe(13.2);
  fireEvent.click(screen.getByText("Other Elements"));
  fireEvent.click(screen.getByRole("button", { name: /^Walls\s*3/ }));
  const edit = (number: number, value: string) => {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Wall ${number} `) }));
    fireEvent.change(screen.getByLabelText("Wall length (m)"), { target: { value } });
    fireEvent.blur(screen.getByLabelText("Wall length (m)"));
  };
  edit(1, "4.00");
  const first = saved();
  expect(first.meta).toEqual(calibrated.meta);
  expect((first.walls[1].x2 - first.walls[1].x1) * first.meta.planWidth).toBeCloseTo(9.2);
  expect(first.walls[2].x1).toBe(first.walls[0].x2);
  edit(2, "9.00");
  const second = saved();
  expect((second.walls[0].x2 - second.walls[0].x1) * second.meta.planWidth).toBeCloseTo(4.2);
  expect(second.walls[0].x1).toBe(0.1);
  expect(second.walls[1].x2).toBe(0.76);
  expect(second.meta).toEqual(calibrated.meta);
  fireEvent.click(screen.getByTitle("Undo (Ctrl/Cmd + Z)"));
  expect(saved()).toEqual(first);
  fireEvent.click(screen.getByTitle("Undo (Ctrl/Cmd + Z)"));
  expect(saved()).toEqual(calibrated);
});

it("applies successive length corrections immediately without locks, anchor prompts or scale changes, one Undo per edit", () => {
  render(<Index />);
  fireEvent.click(screen.getByText("Import rectangle"));
  fireEvent.click(screen.getByText("Back to Review"));
  loadReviewImage();
  fireEvent.click(screen.getByText("Other Elements"));
  fireEvent.click(screen.getByRole("button", { name: /^Walls\s*4/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Wall 1 / }));
  const saved = () => JSON.parse(screen.getByTestId("project").textContent!) as FloorPlanProject;
  const before = saved();
  const enter = (value: string) => {
    const input = screen.getByLabelText("Wall length (m)");
    act(() => input.focus());
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
  };
  enter("4.00");
  const first = saved();
  expect(first.meta).toEqual(before.meta);
  expect(first.walls[0].x2).toBeCloseTo(0.5);
  expect(first.walls[2].x2).toBeCloseTo(0.5);
  expect(first.doors[0].bbox.x).toBeCloseTo(0.495);
  expect(first.rooms[0].width).toBeCloseTo(0.4);
  expect(screen.queryByText("Apply length")).not.toBeInTheDocument();
  expect(screen.queryByText("Keep start", { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Wall 3 / }));
  const input = screen.getByLabelText("Wall length (m)");
  fireEvent.change(input, { target: { value: "4.30" } });
  fireEvent.blur(input);
  const second = saved();
  expect(second.meta).toEqual(before.meta);
  // The later bottom-wall correction changes the previously edited top wall too.
  expect(second.walls[0].x2).toBeCloseTo(0.53);
  expect(second.walls[2].x2).toBeCloseTo(0.53);
  expect(second.doors[0].bbox.x).toBeCloseTo(0.525);
  fireEvent.click(screen.getByTitle("Undo (Ctrl/Cmd + Z)"));
  expect(saved()).toEqual(first);
  fireEvent.click(screen.getByTitle("Undo (Ctrl/Cmd + Z)"));
  expect(saved()).toEqual(before);
  expect(screen.getByTitle("Undo (Ctrl/Cmd + Z)")).toBeDisabled();
  fireEvent.click(screen.getByTitle("Redo (Ctrl/Cmd + Shift + Z)"));
  expect(saved()).toEqual(first);
});

it("commits propagated interior junctions and openings immediately as one Undo step without changing calibration", () => {
  render(<Index />);
  fireEvent.click(screen.getByText("Import chain"));
  fireEvent.click(screen.getByText("Back to Review"));
  loadReviewImage();
  const saved = () => JSON.parse(screen.getByTestId("project").textContent!) as FloorPlanProject;
  const before = saved();
  fireEvent.click(screen.getByText("Other Elements"));
  fireEvent.click(screen.getByRole("button", { name: /^Walls\s*5/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Wall 1 / }));
  fireEvent.change(screen.getByLabelText("Wall length (m)"), { target: { value: "3.8" } });
  fireEvent.blur(screen.getByLabelText("Wall length (m)"));
  expect(screen.queryByRole("alert")).toBeNull();
  const after = saved();
  expect(after.walls[0].x2).toBeCloseTo(0.48);
  expect(after.walls[2].x1).toBeCloseTo(0.64);
  expect(after.walls[3].x1).toBeCloseTo(0.645);
  expect(after.windows[0].bbox.x).not.toBe(before.windows[0].bbox.x);
  expect(after.meta).toEqual(before.meta);
  fireEvent.click(screen.getByTitle("Undo (Ctrl/Cmd + Z)"));
  expect(saved()).toEqual(before);
  expect(screen.getByTitle("Undo (Ctrl/Cmd + Z)")).toBeDisabled();
});

it("edits a diagonal from the existing length field and keeps the connected endpoint shared", () => {
  render(<Index />);
  fireEvent.click(screen.getByText("Import test plan"));
  fireEvent.click(screen.getByText("Back to Review"));
  loadReviewImage();
  fireEvent.click(screen.getByText("Other Elements"));
  fireEvent.click(screen.getByRole("button", { name: /^Walls\s*3/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Wall 3 / }));
  fireEvent.change(screen.getByLabelText("Wall length (m)"), { target: { value: "4.00" } });
  fireEvent.blur(screen.getByLabelText("Wall length (m)"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const saved = JSON.parse(screen.getByTestId("project").textContent!) as FloorPlanProject;
  const d = saved.walls[2], v = saved.walls[1];
  const dx = (d.x2 - d.x1) * saved.meta.planWidth, dy = (d.y2 - d.y1) * saved.meta.planHeight;
  expect(Math.hypot(dx, dy)).toBeCloseTo(4);
  expect(dx / dy).toBeCloseTo(2);
  expect(v.x2).toBe(d.x2);
  expect(v.y2).toBe(d.y2);
  expect(saved.meta.scale).toBe(project.meta.scale);
});

it.each([1, 1.25])("snaps nearby calibration clicks to exact wall endpoints at zoom %s and measures 13.20 m", zoom => {
  const { container } = render(<Index />);
  fireEvent.click(screen.getByText("Import test plan"));
  fireEvent.click(screen.getByText("Back to Review"));
  const image = loadReviewImage();
  if (zoom > 1) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.click(screen.getByRole("button", { name: /m\/px/ }));
  const overlay = image.parentElement!.querySelector("div.absolute.inset-0.z-20")!;
  const width = 600 * zoom, height = 400 * zoom;
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 50, top: 30, width, height } as DOMRect);
  const at = (x: number, y: number, dx = 0, dy = 0) => ({ clientX: 50 + x * width + dx, clientY: 30 + y * height + dy });
  const marker = container.querySelector('[data-wall-measurement="horizontal"] [data-measurement-endpoint="start"]')!;
  const originalRadius = Number(marker.getAttribute("rx"));
  fireEvent.pointerMove(overlay, at(0.1, 0.2, 6, 4));
  expect(marker).toHaveAttribute("data-calibration-endpoint", "hovered");
  expect(Number(marker.getAttribute("rx"))).toBeGreaterThan(originalRadius);
  fireEvent.pointerDown(overlay, at(0.1, 0.2, 6, 4));
  fireEvent.pointerMove(overlay, at(0.5, 0.2, -7, 3));
  expect(marker).toHaveAttribute("data-calibration-endpoint", "selected");
  fireEvent.pointerDown(overlay, at(0.5, 0.2, -7, 3));
  for (const [i, x] of [0.1, 0.5].entries()) {
    const point = container.querySelector(`[data-calibration-point="${i}"]`)!;
    expect(point).toHaveAttribute("data-snapped", "true");
    expect(point.querySelector("circle")).toHaveAttribute("cx", String(x));
    expect(point.querySelector("circle")).toHaveAttribute("cy", "0.2");
  }
  fireEvent.change(screen.getByPlaceholderText("3.5"), { target: { value: "13.20" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  assertReviewLengths(container, "13.20", "6.60", "14.76");
  const saved = JSON.parse(screen.getByTestId("project").textContent!) as FloorPlanProject;
  expect(saved.walls).toEqual(project.walls);
});

it("keeps free calibration points outside the screen-pixel snap radius", () => {
  const { container } = render(<Index />);
  fireEvent.click(screen.getByText("Import test plan"));
  fireEvent.click(screen.getByText("Back to Review"));
  const image = loadReviewImage();
  fireEvent.click(screen.getByRole("button", { name: /m\/px/ }));
  const overlay = image.parentElement!.querySelector("div.absolute.inset-0.z-20")!;
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 600, height: 400 } as DOMRect);
  // 15 px from the start endpoint; still close in normalized coordinates.
  fireEvent.pointerMove(overlay, { clientX: 75, clientY: 80 });
  expect(container.querySelector('[data-calibration-endpoint="hovered"]')).toBeNull();
  fireEvent.pointerDown(overlay, { clientX: 75, clientY: 80 });
  const point = container.querySelector('[data-calibration-point="0"]')!;
  expect(point).toHaveAttribute("data-snapped", "false");
  expect(point.querySelector("circle")).toHaveAttribute("cx", "0.125");
  expect(point.querySelector("circle")).toHaveAttribute("cy", "0.2");
  fireEvent.pointerDown(overlay, { clientX: 450, clientY: 280 });
  fireEvent.change(screen.getByPlaceholderText("3.5"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  const saved = JSON.parse(screen.getByTestId("project").textContent!) as FloorPlanProject;
  expect(saved.meta.calibrationStatus).toBe("calibrated");
  expect(saved.meta.confirmedDimensions ?? []).toEqual([]);
  expect(saved.walls).toEqual(project.walls);
});

it("keeps real Review and 3D dimensions aligned through recalibration, zoom, resize and reopening", () => {
  const { container } = render(<Index />);
  fireEvent.click(screen.getByText("Import test plan"));
  assertThreeLengths(4.8, 2.4, 5.37);
  fireEvent.click(screen.getByText("Back to Review"));
  const image = loadReviewImage();
  assertReviewLengths(container, "4.80", "2.40", "5.37");

  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(image.parentElement!.style.transform).toContain("scale(1.25)");
  assertReviewLengths(container, "4.80", "2.40", "5.37");
  fireEvent.click(screen.getByRole("button", { name: "Fit to screen" }));
  viewport = { width: 932, height: 632 };
  act(() => resizeCallbacks.forEach(callback => callback()));
  expect(image.parentElement!.style.width).toBe("900px");
  assertReviewLengths(container, "4.80", "2.40", "5.37");

  // Real calibration interaction: the horizontal wall's 0.4-image span is now 7.2 m.
  fireEvent.click(screen.getByRole("button", { name: /m\/px/ }));
  // Calibration guides identify actual stored endpoints, independent of corner surfaces.
  const span = container.querySelector('[data-wall-measurement="horizontal"] [data-measurement-span]')!;
  expect(span).toHaveAttribute("x1", "0.1");
  expect(span).toHaveAttribute("x2", "0.5");
  expect(span).toHaveAttribute("y1", "0.2");
  expect(span).toHaveAttribute("y2", "0.2");
  const overlay = image.parentElement!.querySelector("div.absolute.inset-0.z-20")!;
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 50, top: 30, width: 900, height: 600 } as DOMRect);
  fireEvent.pointerDown(overlay, { clientX: 140, clientY: 150 });
  fireEvent.pointerDown(overlay, { clientX: 500, clientY: 150 });
  fireEvent.change(screen.getByPlaceholderText("3.5"), { target: { value: "7.2" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  assertReviewLengths(container, "7.20", "3.60", "8.05");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  assertReviewLengths(container, "7.20", "3.60", "8.05");
  fireEvent.click(screen.getByRole("button", { name: "Fit to screen" }));
  viewport = { width: 1232, height: 832 };
  act(() => resizeCallbacks.forEach(callback => callback()));
  expect(image.parentElement!.style.width).toBe("1200px");
  assertReviewLengths(container, "7.20", "3.60", "8.05");

  fireEvent.click(screen.getByRole("button", { name: /Generate 3D/ }));
  assertThreeLengths(7.2, 3.6, 8.05);
  viewport = { width: 482, height: 332 };
  fireEvent.click(screen.getByText("Back to Review"));
  const reopenedImage = loadReviewImage();
  expect(reopenedImage.parentElement!.style.width).toBe("450px");
  assertReviewLengths(container, "7.20", "3.60", "8.05");
  const saved = JSON.parse(screen.getByTestId("project").textContent!) as FloorPlanProject;
  expect(saved.meta.planWidth).toBeCloseTo(18);
  expect(saved.meta.planHeight).toBeCloseTo(12);
  expect(saved.walls).toEqual(project.walls);
  expect(saved.doors).toEqual(project.doors);
  expect(saved.windows).toEqual(project.windows);
}, 15000); // This multi-stage DOM integration also runs alongside the other test files.

it("maps scale-only updates to persisted planW/planH and refreshes both inspectors", () => {
  const { container } = render(<Index />);
  fireEvent.click(screen.getByText("Import test plan"));
  fireEvent.click(screen.getByText("Scale only"));
  assertThreeLengths(7.2, 3.6, 8.05);
  fireEvent.click(screen.getByText("Back to Review"));
  loadReviewImage();
  assertReviewLengths(container, "7.20", "3.60", "8.05");
  const saved = JSON.parse(screen.getByTestId("project").textContent!) as FloorPlanProject;
  expect(saved.meta).toMatchObject({ scale: 0.03, planWidth: 18, planHeight: 12 });
  expect(saved.walls).toEqual(project.walls);
});

it("hides provisional and cached measurements while allowing materials, then estimates from calibration", () => {
  const { container } = render(<Index />);
  fireEvent.click(screen.getByText("Import legacy plan"));
  expect(screen.getByText("Calibrate scale in Review to estimate quantities")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Pick horizontal"));
  expect(screen.getByLabelText("Length (m)")).toHaveTextContent("—");
  expect(screen.queryByRole("spinbutton", { name: "Length (m)" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Pick room"));
  const valueFor = (label: string) => screen.getByText(label, { exact: true }).parentElement!.lastElementChild!;
  expect(valueFor("Area")).toHaveTextContent("—");
  expect(valueFor("Needed")).toHaveTextContent("—");
  expect(valueFor("Tile size").textContent).toContain("cm");
  const tile = SCG_TILE_CATALOG[1];
  fireEvent.change(screen.getByLabelText(/Floor tile code/), { target: { value: tile.code } });
  expect(valueFor("Tile size")).toHaveTextContent(`${tile.sizeCm} cm`);
  expect(valueFor("Needed")).toHaveTextContent("—");

  fireEvent.click(screen.getByText("Back to Review"));
  const image = loadReviewImage();
  expect(container.textContent).not.toContain("9999.00 m²");
  expect(screen.getByText("Total Area").parentElement).toHaveTextContent("—");
  fireEvent.click(screen.getByRole("button", { name: "Calibrate Scale" }));
  const overlay = image.parentElement!.querySelector("div.absolute.inset-0.z-20")!;
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 600, height: 400 } as DOMRect);
  fireEvent.pointerDown(overlay, { clientX: 60, clientY: 80 });
  fireEvent.pointerDown(overlay, { clientX: 300, clientY: 80 });
  fireEvent.change(screen.getByPlaceholderText("3.5"), { target: { value: "4.8" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(screen.getByText("Total Area").parentElement).toHaveTextContent("11.52");
  let saved = JSON.parse(screen.getByTestId("project").textContent!) as FloorPlanProject;
  expect(saved.meta.calibrationStatus).toBe("calibrated");
  expect(saved.walls).toEqual(project.walls);
  expect(saved.rooms[0].tileCode).toBe(tile.code);

  fireEvent.click(screen.getByRole("button", { name: /Generate 3D/ }));
  fireEvent.click(screen.getByText("Pick room"));
  expect(valueFor("Area")).toHaveTextContent("11.52");
  const [tileWidth, tileHeight] = tile.sizeCm.split(/[x×]/).map(Number);
  const count = Math.ceil(11.52 / (tileWidth * tileHeight / 10000) * 1.1);
  expect(valueFor("Needed")).toHaveTextContent(count.toLocaleString());
  expect(screen.queryByText("Calibrate scale in Review to estimate quantities")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Scale only"));
  expect(valueFor("Area")).toHaveTextContent("25.92");
  expect(valueFor("Needed")).toHaveTextContent(Math.ceil(25.92 / (tileWidth * tileHeight / 10000) * 1.1).toLocaleString());
  saved = JSON.parse(screen.getByTestId("project").textContent!) as FloorPlanProject;
  expect(saved.meta.calibrationStatus).toBe("calibrated");
});

it("refreshes Decoration area and quantities when room geometry changes", () => {
  const props = { generated: true, calibrationStatus: "calibrated" as const, scale: 0.02,
    planWidth: 12, planHeight: 8, walls: project.walls, rooms: project.rooms, onRoomUpdate: vi.fn() };
  const view = render(<RightPanel {...props} />);
  fireEvent.click(screen.getByText("Pick room"));
  const area = () => screen.getByText("Area", { exact: true }).parentElement!.lastElementChild!;
  const needed = () => screen.getByText("Needed", { exact: true }).parentElement!.lastElementChild!;
  expect(area()).toHaveTextContent("11.52");
  const initialCount = needed().textContent;
  view.rerender(<RightPanel {...props} rooms={project.rooms.map(room => ({ ...room, areaSqm: 9999,
    polygon: room.polygon!.map(point => ({ ...point, x: point.x * 2 })),
  }))} />);
  expect(area()).toHaveTextContent("23.04");
  expect(needed().textContent).not.toBe(initialCount);
  view.rerender(<RightPanel {...props} calibrationStatus="uncalibrated" />);
  expect(area()).toHaveTextContent("—");
  expect(needed()).toHaveTextContent("—");
});
