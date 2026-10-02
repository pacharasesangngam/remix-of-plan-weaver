import { useReducer } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DrawPlan from "./DrawPlan";
import { emptyProject, initialHistory, projectHistoryReducer } from "@/lib/projectHistory";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGSVGElement.prototype, "createSVGPoint", { configurable: true, value: () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } }) });
  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", { configurable: true, value: () => ({ a: 1, d: 1, inverse: () => ({}) }) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps dimensions in one layer and allows a clean canvas without changing geometry", () => {
  render(<Editor />);
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 400, button: 0 });
  const before = screen.getByTestId("project").textContent;
  expect(screen.getByLabelText("ความกว้างรวม 6.00 เมตร")).toBeInTheDocument();
  expect(screen.queryByLabelText(/ระยะแนวนอนด้านบน/)).not.toBeInTheDocument();
  expect(canvas.querySelectorAll("text")).toHaveLength(4); // name, room size, two totals
  fireEvent.click(screen.getByRole("button", { name: "รายละเอียด" }));
  expect(screen.getByLabelText("ระยะแนวนอนด้านบน 6.00 เมตร")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "ซ่อน" }));
  expect(screen.queryByLabelText(/ความกว้างรวม/)).not.toBeInTheDocument();
  expect(screen.getByTestId("project").textContent).toBe(before);
});

it("fits drawn geometry with a margin and hides room labels when zoomed too far out", () => {
  render(<Editor />);
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 300, button: 0 });
  fireEvent.click(screen.getByRole("button", { name: "ดูเต็มแปลน" }));
  const [x, y, width, height] = canvas.getAttribute("viewBox")!.split(" ").map(Number);
  expect(x).toBeLessThan(100);
  expect(y).toBeLessThan(100);
  expect(x + width).toBeGreaterThan(300);
  expect(y + height).toBeGreaterThan(300);
  expect(width).toBeLessThan(1000);
  for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole("button", { name: "ซูมออก" }));
  expect(canvas.querySelectorAll("text")).toHaveLength(2); // only totals remain readable
});

function Editor({ withFurniture = false }: { withFurniture?: boolean }) {
  const [history, dispatch] = useReducer(projectHistoryReducer, initialHistory({ ...emptyProject(), planW: 30, planH: 30, scale: 0.03, furniture: withFurniture ? [{ id: "sofa", kind: "sofa", x: 0.2, y: 0.2, width: 2.1, depth: 0.9, height: 0.85, rotation: 0, color: "#888888" }] : [] }));
  return <><DrawPlan project={history.present} onEdit={(update, info) => dispatch({ type: "edit", update, info })}
    onGenerate={() => {}} onUndo={() => dispatch({ type: "undo" })} onRedo={() => dispatch({ type: "redo" })}
    canUndo={history.past.length > 0} canRedo={history.future.length > 0} /><output data-testid="project">{JSON.stringify(history.present)}</output></>;
}

it("pans empty space in select mode and right-drags while drawing without creating geometry", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "วาดผนัง" }));
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  const before = screen.getByTestId("project").textContent;
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 2 });
  fireEvent.pointerMove(canvas, { clientX: 150, clientY: 180 });
  fireEvent.pointerUp(canvas, { button: 2 });
  expect(canvas).toHaveAttribute("viewBox", "-50 -80 1000 1000");
  fireEvent.click(screen.getByRole("button", { name: "เลือก" }));
  fireEvent.pointerDown(canvas, { clientX: 150, clientY: 180, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 100, clientY: 100 });
  fireEvent.pointerUp(canvas);
  expect(canvas).toHaveAttribute("viewBox", "0 0 1000 1000");
  fireEvent.pointerMove(canvas, { clientX: 500, clientY: 500 });
  expect(canvas).toHaveAttribute("viewBox", "0 0 1000 1000");
  expect(screen.getByTestId("project").textContent).toBe(before);
});

it("hides furniture tools and symbols without removing existing project data", () => {
  render(<Editor withFurniture />);
  const before = screen.getByTestId("project").textContent;
  expect(JSON.parse(before!).furniture).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /Furniture|เฟอร์นิเจอร์/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("เฟอร์นิเจอร์ โซฟา")).not.toBeInTheDocument();
  expect(screen.queryByRole("slider", { name: "ลากเพื่อหมุนเฟอร์นิเจอร์" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "วาดห้อง" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("button", { name: "วาดห้อง" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("project").textContent).toBe(before);
});

it("preserves existing furniture through room creation, movement, deletion, undo and redo", () => {
  render(<Editor withFurniture />);
  const read = () => JSON.parse(screen.getByTestId("project").textContent!);
  const furniture = read().furniture;
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  fireEvent.click(screen.getByRole("button", { name: "วาดห้อง" }));
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 300, button: 0 });
  expect(read().rooms).toHaveLength(1);
  expect(read().furniture).toEqual(furniture);
  fireEvent.click(screen.getByRole("button", { name: "เลือก" }));
  fireEvent.pointerDown(canvas.querySelector("polygon")!, { clientX: 200, clientY: 200, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 300, clientY: 300 });
  fireEvent.pointerUp(canvas, { clientX: 300, clientY: 300, button: 0 });
  expect(read().rooms[0].bbox.x).toBeCloseTo(0.2);
  expect(read().furniture).toEqual(furniture);
  fireEvent.click(screen.getByRole("button", { name: "ลบที่เลือก" }));
  expect(read().rooms).toHaveLength(0);
  expect(read().furniture).toEqual(furniture);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(read().rooms).toHaveLength(1);
  expect(read().furniture).toEqual(furniture);
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(read().rooms).toHaveLength(0);
  expect(read().furniture).toEqual(furniture);
});

it("shows total dimensions and pans without changing geometry or sticking after release", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "วาดห้อง" }));
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 400, button: 0 });
  expect(screen.getByLabelText("ความกว้างรวม 6.00 เมตร")).toBeInTheDocument();
  expect(screen.getByLabelText("ความลึกรวม 9.00 เมตร")).toBeInTheDocument();
  const before = screen.getByTestId("project").textContent;
  fireEvent.click(screen.getByRole("button", { name: "เลื่อนแปลน" }));
  fireEvent.pointerDown(canvas, { clientX: 200, clientY: 200, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 250, clientY: 280 });
  expect(canvas.getAttribute("viewBox")).toBe("-50 -80 1000 1000");
  fireEvent.pointerUp(canvas, { clientX: 250, clientY: 280, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 400, clientY: 400 });
  expect(canvas.getAttribute("viewBox")).toBe("-50 -80 1000 1000");
  expect(screen.getByTestId("project").textContent).toBe(before);
  fireEvent.pointerDown(canvas, { clientX: 250, clientY: 280, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 200, clientY: 200 });
  fireEvent.pointerUp(canvas, { clientX: 200, clientY: 200, button: 0 });
  expect(canvas.getAttribute("viewBox")).toBe("0 0 1000 1000");
});

it("zooms with the wheel while keeping the pointer's anchor in place", () => {
  render(<Editor />);
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  fireEvent.wheel(canvas, { clientX: 200, clientY: 300, deltaY: -100 });
  const [x, y, size] = canvas.getAttribute("viewBox")!.split(" ").map(Number);
  expect(size).toBeLessThan(1000);
  expect((200 - x) / size).toBeCloseTo(0.2);
  expect((300 - y) / size).toBeCloseTo(0.3);
  fireEvent.wheel(canvas, { clientX: 200, clientY: 300, deltaY: 100 });
  expect(Number(canvas.getAttribute("viewBox")!.split(" ")[2])).toBeCloseTo(1000);
});

it("previews a room drag, commits on release, and restores it with one undo", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "วาดห้อง" }));
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 300, button: 0 });
  fireEvent.click(screen.getByRole("button", { name: "เลือก" }));
  const floor = canvas.querySelector("polygon")!;
  fireEvent.pointerDown(floor, { clientX: 200, clientY: 200, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 300, clientY: 400 });
  expect(JSON.parse(screen.getByTestId("project").textContent!).rooms[0].bbox.x).toBeCloseTo(0.1);
  fireEvent.pointerUp(canvas, { clientX: 300, clientY: 400, button: 0 });
  let state = JSON.parse(screen.getByTestId("project").textContent!);
  expect(state.rooms[0].bbox.x).toBeCloseTo(0.2);
  expect(state.walls[0].y1).toBeCloseTo(0.3);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  state = JSON.parse(screen.getByTestId("project").textContent!);
  expect(state.rooms).toHaveLength(1);
  expect(state.rooms[0].bbox.x).toBeCloseTo(0.1);
  fireEvent.pointerDown(canvas.querySelector("polygon")!, { clientX: 200, clientY: 200, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 400, clientY: 400 });
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(canvas, { clientX: 400, clientY: 400, button: 0 });
  expect(JSON.parse(screen.getByTestId("project").textContent!).rooms[0].bbox.x).toBeCloseTo(0.1);
});

it("draws continuous walls and closes the loop into a room", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "วาดผนัง" }));
  expect(screen.getByText("วิธีวาดผนัง")).toBeInTheDocument();
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  for (const [clientX, clientY] of [[100, 100], [300, 100], [300, 300], [100, 300]]) fireEvent.pointerDown(canvas, { clientX, clientY, button: 0 });
  expect(screen.getByText("คลิกเพื่อปิดห้อง")).toBeInTheDocument();
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  const state = JSON.parse(screen.getByTestId("project").textContent!);
  expect(state.rooms).toHaveLength(1);
  expect(state.rooms[0].polygon).toHaveLength(4);
  expect(state.walls).toHaveLength(4);
  expect(screen.getByRole("button", { name: "ดู 3D" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(JSON.parse(screen.getByTestId("project").textContent!).rooms).toHaveLength(0);
});

it("finishes an open wall chain without creating a floor", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "วาดผนัง" }));
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  for (const [clientX, clientY] of [[100, 100], [300, 100], [300, 300]]) fireEvent.pointerDown(canvas, { clientX, clientY, button: 0 });
  fireEvent.click(screen.getByRole("button", { name: "จบแนวผนัง (ไม่สร้างพื้น)" }));
  const state = JSON.parse(screen.getByTestId("project").textContent!);
  expect(state.rooms).toHaveLength(0);
  expect(state.walls).toHaveLength(2);
});

it("creates a room with two clicks, enables 3D, and undoes the whole room", () => {
  render(<Editor />);
  expect(screen.getByRole("button", { name: "วาดห้อง" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "ดู 3D" })).toBeDisabled();
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 300, clientY: 300 });
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 300, button: 0 });
  const project = JSON.parse(screen.getByTestId("project").textContent!);
  expect(project.rooms).toHaveLength(1);
  expect(project.walls).toHaveLength(4);
  expect(project.rooms[0].width * 30).toBeCloseTo(6);
  expect(screen.getByRole("button", { name: "วาดห้อง" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "ดู 3D" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(JSON.parse(screen.getByTestId("project").textContent!).walls).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(JSON.parse(screen.getByTestId("project").textContent!).walls).toHaveLength(4);
});

it("expands the sheet without changing physical room or furniture dimensions and supports undo", () => {
  render(<Editor withFurniture />);
  const read = () => JSON.parse(screen.getByTestId("project").textContent!);
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  const expand = screen.getByRole("button", { name: "ขยายพื้นที่วาด 2 เท่า" });
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  expect(expand).toBeDisabled();
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 300, button: 0 });
  const before = read();
  fireEvent.click(expand);
  const after = read();
  expect(after.planW).toBe(60);
  expect(after.planH).toBe(60);
  expect(after.rooms[0].width * after.planW).toBeCloseTo(before.rooms[0].width * before.planW);
  expect(after.rooms[0].height * after.planH).toBeCloseTo(before.rooms[0].height * before.planH);
  expect(after.furniture[0]).toEqual({ ...before.furniture[0], x: 0.1, y: 0.1 });
  expect(screen.queryByRole("button", { name: /Furniture|เฟอร์นิเจอร์/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(read()).toEqual(before);
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(read()).toEqual(after);
});

it("cancels a wall draft with Escape while keeping the wall tool and allows reopening help", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "วาดผนัง" }));
  fireEvent.click(screen.getByRole("button", { name: "ปิดคำแนะนำ" }));
  expect(screen.queryByText("วิธีวาดผนัง")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "ดูวิธีวาดผนัง" }));
  expect(screen.getByText("วิธีวาดผนัง")).toBeInTheDocument();
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 100, button: 0 });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("button", { name: "วาดผนัง" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "จบแนวผนัง (ไม่สร้างพื้น)" })).not.toBeInTheDocument();
  expect(JSON.parse(screen.getByTestId("project").textContent!).walls).toHaveLength(0);
});

it("places a door on a wall and prevents overlapping openings", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "วาดห้อง" }));
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 300, button: 0 });
  fireEvent.click(screen.getByRole("button", { name: "ประตู" }));
  fireEvent.pointerDown(canvas, { clientX: 200, clientY: 100, button: 0 });
  const project = JSON.parse(screen.getByTestId("project").textContent!);
  expect(project.doors).toHaveLength(1);
  expect(project.doors[0].wallId).toBe(project.walls[0].id);
  fireEvent.pointerDown(canvas, { clientX: 200, clientY: 100, button: 0 });
  expect(JSON.parse(screen.getByTestId("project").textContent!).doors).toHaveLength(1);
  expect(screen.getByText("ตำแหน่งนี้ทับช่องเปิดเดิม กรุณาเลือกตำแหน่งอื่น")).toBeInTheDocument();
});
