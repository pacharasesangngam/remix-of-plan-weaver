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

function Editor() {
  const [history, dispatch] = useReducer(projectHistoryReducer, initialHistory({ ...emptyProject(), planW: 30, planH: 30, scale: 0.03 }));
  return <><DrawPlan project={history.present} onEdit={(update, info) => dispatch({ type: "edit", update, info })}
    onGenerate={() => {}} onUndo={() => dispatch({ type: "undo" })} onRedo={() => dispatch({ type: "redo" })}
    canUndo={history.past.length > 0} canRedo={history.future.length > 0} /><output data-testid="project">{JSON.stringify(history.present)}</output></>;
}

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
  expect(screen.getByRole("button", { name: "ดู 3D" })).toBeDisabled();
  const canvas = screen.getByRole("img", { name: "พื้นที่วาดแปลน 2D" });
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 300, clientY: 300 });
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 300, button: 0 });
  const project = JSON.parse(screen.getByTestId("project").textContent!);
  expect(project.rooms).toHaveLength(1);
  expect(project.walls).toHaveLength(4);
  expect(project.rooms[0].width * 30).toBeCloseTo(6);
  expect(screen.getByRole("button", { name: "ดู 3D" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(JSON.parse(screen.getByTestId("project").textContent!).walls).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(JSON.parse(screen.getByTestId("project").textContent!).walls).toHaveLength(4);
});

it("places a door on a wall and prevents overlapping openings", () => {
  render(<Editor />);
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
