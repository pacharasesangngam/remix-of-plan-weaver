import { Children, isValidElement, useReducer, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import RightPanel, { Scene } from "./RightPanel";
import { emptyProject, initialHistory, projectHistoryReducer } from "@/lib/projectHistory";
import { rectangleRoom } from "@/lib/manualPlan";
import { setRoomWallHeight } from "@/lib/roomWallHeight";
import { newOpeningRecord, openingGeometry } from "@/lib/openingModel";

const canvas = vi.hoisted(() => ({ children: null as ReactNode }));
vi.mock("@react-three/fiber", () => ({ Canvas: ({ children }: { children: ReactNode }) => {
  canvas.children = children; return <div data-testid="canvas" />;
}, useFrame: () => {}, useThree: () => ({}) }));
vi.mock("@react-three/drei", () => ({ OrbitControls: () => null, Grid: () => null, PointerLockControls: () => null, Text: () => null, useGLTF: vi.fn() }));
vi.mock("@/lib/wallTextures", () => ({ createWallTexture: () => null }));
afterEach(cleanup);

const rectangle = rectangleRoom({ x: 0.1, y: 0.1 }, { x: 0.7, y: 0.7 }, "room", "Living room", 10, 10, 2.8)!;
const door = newOpeningRecord("door", "door", rectangle.walls[0], { x: 0.2, y: 0.1 }, { x: 0.3, y: 0.1 }, 10, 10)!;
function Editor() {
  const [history, dispatch] = useReducer(projectHistoryReducer, initialHistory({ ...emptyProject(), calibrationStatus: "calibrated", scale: 0.01,
    planW: 10, planH: 10, rooms: [rectangle.room], walls: rectangle.walls, doors: [door] }));
  const p = history.present;
  return <RightPanel generated rooms={p.rooms} walls={p.walls} doors={p.doors} windows={p.windows} planWidth={p.planW} planHeight={p.planH}
    calibrationStatus={p.calibrationStatus} scale={p.scale} wallHeightMeter={p.wallHeightMeter}
    onRoomUpdate={(id, field, value) => dispatch({ type: "edit", info: { label: "room edit" }, update: state => field === "wallHeight"
      ? setRoomWallHeight(state, id, Number(value)) : { ...state, rooms: state.rooms.map(r => r.id === id ? { ...r, [field]: value } : r) } })}
    onRoomPatch={(id, patch) => dispatch({ type: "edit", info: { label: "room decoration" }, update: state => ({ ...state, rooms: state.rooms.map(r => r.id === id ? { ...r, ...patch } : r) }) })}
    onUndo={() => dispatch({ type: "undo" })} onRedo={() => dispatch({ type: "redo" })} canUndo={history.past.length > 0} canRedo={history.future.length > 0} />;
}
function scene() {
  const element = Children.toArray(canvas.children).find(child => isValidElement(child) && child.type === Scene);
  if (!isValidElement<ComponentProps<typeof Scene>>(element)) throw new Error("Scene missing");
  return element.props;
}

it("reserves a fixed sidebar beside the canvas with scrollable controls and an independent bottom summary", () => {
  render(<Editor />);
  const sidebar = screen.getByRole("complementary", { name: "3D properties and decoration" });
  const viewport = screen.getByRole("region", { name: "3D canvas" });
  expect(viewport.parentElement).toBe(sidebar.parentElement);
  expect(sidebar).toHaveClass("w-[280px]", "shrink-0", "border-l");
  expect(sidebar).not.toHaveClass("absolute");
  expect(within(sidebar).queryByTestId("canvas")).toBeNull();
  // Without a selection the sidebar starts at Decoration and the two top bars collapse into the 3D toolbar.
  expect(within(sidebar).queryByRole("region", { name: "Properties" })).toBeNull();
  const decoration = within(sidebar).getByRole("region", { name: "Decoration" });
  expect(within(decoration).getByText(/Select a floor, wall, door, or window/)).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "3D canvas" }).closest(".w-full")).toBeNull();
  expect(screen.getAllByRole("button", { name: /Export GLB/ })
    .some(button => button.closest(".w-full")?.className.includes("w-full"))).toBe(true);
  act(() => scene().onSelect({ type: "room", id: "room" }));
  const properties = within(sidebar).getByRole("region", { name: "Properties" });
  expect(properties.compareDocumentPosition(decoration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(properties.parentElement).toHaveClass("flex-1", "min-h-0", "overflow-y-auto");
  const summary = within(sidebar).getByText("Material Summary").closest("details")!;
  expect(summary).toHaveAttribute("open");
  expect(properties.parentElement).not.toContainElement(summary);
  fireEvent.click(within(summary).getByText("Material Summary"));
  expect(summary).not.toHaveAttribute("open");
  expect(within(sidebar).queryByRole("tab")).toBeNull();
});

it("updates room boundary geometry and finish quantities immediately without scaling the door, and preserves decoration", () => {
  render(<Editor />);
  act(() => scene().onSelect({ type: "room", id: "room" }));
  const properties = screen.getByRole("region", { name: "Properties" });
  const decoration = screen.getByRole("region", { name: "Decoration" });
  expect(screen.getByRole("heading", { name: "Properties · Floor" })).toBeInTheDocument();
  expect(screen.queryByText(/\bdoor-|\bwall-|\bwindow-/)).toBeNull();
  expect(within(properties).getByLabelText("Room Wall Height (m)")).toHaveValue(2.8);
  const before = openingGeometry(scene().doors[0], "door", scene().walls, 10, 10)!;
  const area = parseFloat(screen.getByLabelText("Wall finish area").textContent!);
  fireEvent.change(within(properties).getByLabelText("Room Wall Height (m)"), { target: { value: "" } });
  expect(within(properties).getByLabelText("Room Wall Height (m)")).toHaveValue(null);
  expect(scene().walls.every(wall => wall.wallHeight === 2.8)).toBe(true);
  fireEvent.change(within(properties).getByLabelText("Room Wall Height (m)"), { target: { value: "3.4" } });
  expect(scene().walls.every(wall => wall.wallHeight === 3.4)).toBe(true);
  expect(parseFloat(screen.getByLabelText("Wall finish area").textContent!) - area).toBeCloseTo(24 * 0.6, 8);
  const after = openingGeometry(scene().doors[0], "door", scene().walls, 10, 10)!;
  expect(after.width).toBeCloseTo(before.width, 10);
  expect([after.height, after.sill]).toEqual([before.height, before.sill]);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(scene().walls.every(wall => wall.wallHeight === 2.8)).toBe(true);
  const tiles = within(decoration).getByLabelText(/Floor tile code/) as HTMLSelectElement;
  fireEvent.change(tiles, { target: { value: tiles.options[1].value } });
  expect(scene().rooms[0].tileCode).toBe(tiles.options[1].value);
  expect(screen.queryByText("No materials assigned yet. Select an object to start decorating.")).toBeNull();
});

it("places wall and opening dimensions in Properties while keeping their materials in Decoration", () => {
  render(<Editor />);
  act(() => scene().onSelect({ type: "wall", id: rectangle.walls[0].id }));
  expect(within(screen.getByRole("region", { name: "Properties" })).getByLabelText("Wall height (m)")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Decoration" })).getByLabelText("Wall color")).toBeInTheDocument();
  act(() => scene().onSelect({ type: "door", id: "door" }));
  expect(within(screen.getByRole("region", { name: "Properties" })).getByLabelText("Opening width (m)")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Decoration" })).getByRole("combobox")).toBeInTheDocument();
});
