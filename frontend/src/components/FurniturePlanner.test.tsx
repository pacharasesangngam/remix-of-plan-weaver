import { useReducer } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import FurniturePlanner from "./FurniturePlanner";
import { emptyProject, initialHistory, projectHistoryReducer } from "@/lib/projectHistory";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGSVGElement.prototype, "createSVGPoint", { configurable: true, value: () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } }) });
  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", { configurable: true, value: () => ({ a: 1, d: 1, inverse: () => ({}) }) });
  Object.defineProperty(SVGSVGElement.prototype, "setPointerCapture", { configurable: true, value: () => {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Editor({ calibrated = true }: { calibrated?: boolean }) {
  const [history, dispatch] = useReducer(projectHistoryReducer, initialHistory({ ...emptyProject(), planW: 20, planH: 10, scale: 0.02, calibrationStatus: calibrated ? "calibrated" : "uncalibrated" }));
  return <><FurniturePlanner project={history.present} imageUrl="/plan.png" onEdit={(update, info) => dispatch({ type: "edit", update, info })}
    onBack={() => {}} onGenerate={() => {}} onUndo={() => dispatch({ type: "undo" })} onRedo={() => dispatch({ type: "redo" })}
    canUndo={history.past.length > 0} canRedo={history.future.length > 0} /><output data-testid="state">{JSON.stringify(history.present)}</output></>;
}
const read = () => JSON.parse(screen.getByTestId("state").textContent!);

it("pans with either mouse button without editing furniture and stops on release", () => {
  render(<Editor />);
  const canvas = screen.getByLabelText("แปลนสำหรับวางเฟอร์นิเจอร์");
  const before = read();
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 150, clientY: 130 });
  fireEvent.pointerUp(canvas);
  expect(canvas).toHaveAttribute("viewBox", "-50 -30 2000 1000");
  fireEvent.pointerMove(canvas, { clientX: 900, clientY: 900 });
  expect(canvas).toHaveAttribute("viewBox", "-50 -30 2000 1000");
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 2 });
  fireEvent.pointerMove(canvas, { clientX: 50, clientY: 70 });
  fireEvent.pointerCancel(canvas);
  expect(canvas).toHaveAttribute("viewBox", "0 0 2000 1000");
  expect(read()).toEqual(before);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("shows rotation controls when furniture is selected, rotates in one undo step and hides on blank click", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: /โซฟา/ }));
  const canvas = screen.getByLabelText("แปลนสำหรับวางเฟอร์นิเจอร์");
  fireEvent.pointerDown(canvas, { clientX: 600, clientY: 400, button: 0 });
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  expect(screen.queryByRole("slider", { name: "ลากเพื่อหมุนเฟอร์นิเจอร์" })).not.toBeInTheDocument();
  fireEvent.pointerUp(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerDown(screen.getByLabelText("เฟอร์นิเจอร์ โซฟา"), { clientX: 600, clientY: 400, button: 0 });
  fireEvent.pointerUp(canvas, { clientX: 600, clientY: 400 });
  const handle = screen.getByRole("slider", { name: "ลากเพื่อหมุนเฟอร์นิเจอร์" });
  expect(screen.queryByLabelText("วงนำทางการหมุน")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("คำแนะนำการหมุน")).not.toBeInTheDocument();
  fireEvent.pointerEnter(handle);
  expect(screen.getByLabelText("คำแนะนำการหมุน")).toHaveTextContent("ลากเพื่อหมุน");
  fireEvent.pointerLeave(handle);
  expect(screen.queryByLabelText("คำแนะนำการหมุน")).not.toBeInTheDocument();
  fireEvent.pointerDown(handle, { clientX: 600, clientY: 300, button: 0 });
  expect(screen.getByLabelText("วงนำทางการหมุน")).toBeInTheDocument();
  fireEvent.pointerMove(handle, { clientX: 700, clientY: 400 });
  expect(handle).toHaveAttribute("aria-valuenow", "90");
  expect(read().furniture[0].rotation).toBe(0);
  fireEvent.pointerUp(handle);
  expect(screen.queryByLabelText("วงนำทางการหมุน")).not.toBeInTheDocument();
  expect(read().furniture[0]).toMatchObject({ rotation: 90, x: 0.3, y: 0.4 });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(read().furniture[0].rotation).toBe(0);
  fireEvent.pointerDown(handle, { clientX: 600, clientY: 300, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 700, clientY: 400 });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(read().furniture[0].rotation).toBe(0);
  expect(handle).toHaveAttribute("aria-valuenow", "0");
});

it("places furniture at real scale on a rectangular uploaded plan and supports edits and undo", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: /โซฟา/ }));
  const canvas = screen.getByLabelText("แปลนสำหรับวางเฟอร์นิเจอร์");
  expect(canvas).toHaveAttribute("viewBox", "0 0 2000 1000");
  fireEvent.pointerDown(canvas, { clientX: 600, clientY: 400, button: 0 });
  expect(read().furniture[0]).toMatchObject({ kind: "sofa", width: 2.1, x: 0.3, y: 0.4 });
  fireEvent.change(screen.getByLabelText("ความกว้าง (m)"), { target: { value: "2.5" } });
  fireEvent.click(screen.getByRole("button", { name: "ใช้ขนาดนี้" }));
  fireEvent.click(screen.getByRole("button", { name: "หมุน 90°" }));
  expect(read().furniture[0]).toMatchObject({ width: 2.5, rotation: 90 });
  expect(screen.getByLabelText("เฟอร์นิเจอร์ โซฟา")).toHaveAttribute("transform", "translate(600 400) rotate(90)");
  fireEvent.pointerDown(screen.getByLabelText("เฟอร์นิเจอร์ โซฟา"), { clientX: 600, clientY: 400, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 800, clientY: 500 });
  expect(read().furniture[0].x).toBe(0.3);
  fireEvent.pointerUp(canvas);
  expect(read().furniture[0].x).toBeCloseTo(0.4);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(read().furniture[0].x).toBeCloseTo(0.3);
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(read().furniture[0].x).toBeCloseTo(0.4);
  fireEvent.click(screen.getByRole("button", { name: "ลบเฟอร์นิเจอร์" }));
  expect(read().furniture).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(read().furniture).toHaveLength(1);
});

it("requires calibration before placing real-size furniture", () => {
  render(<Editor calibrated={false} />);
  expect(screen.getByRole("button", { name: /โซฟา/ })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Calibrate Scale");
});

it("cancels dragging without committing a move", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: /โซฟา/ }));
  const canvas = screen.getByLabelText("แปลนสำหรับวางเฟอร์นิเจอร์");
  fireEvent.pointerDown(canvas, { clientX: 600, clientY: 400, button: 0 });
  fireEvent.pointerDown(screen.getByLabelText("เฟอร์นิเจอร์ โซฟา"), { clientX: 600, clientY: 400, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 800, clientY: 500 });
  fireEvent.pointerCancel(canvas);
  expect(read().furniture[0].x).toBe(0.3);
  expect(screen.getByLabelText("เฟอร์นิเจอร์ โซฟา")).toHaveAttribute("transform", "translate(600 400) rotate(0)");
});
