import { expect, it, vi } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three-stdlib";
import { PLAN_3D_MOUSE_BUTTONS } from "./threeNavigation";

function scene() {
  const element = document.createElement("canvas");
  Object.defineProperties(element, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  element.releasePointerCapture = vi.fn();
  const camera = new PerspectiveCamera(45, 800 / 600, 0.1, 100);
  camera.position.set(10, 8, 10);
  const controls = new OrbitControls(camera, element);
  controls.mouseButtons = { ...PLAN_3D_MOUSE_BUTTONS };
  controls.screenSpacePanning = true;
  controls.update();
  const pointer = (target: EventTarget, type: string, button: number, x: number, y: number) => {
    const event = new MouseEvent(type, { button, clientX: x, clientY: y, bubbles: true });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  };
  const drag = (button: number) => {
    pointer(element, "pointerdown", button, 100, 100);
    pointer(document, "pointermove", button, 180, 140);
    pointer(document, "pointerup", button, 180, 140);
  };
  return { camera, controls, drag, element };
}

it.each([0, 2])("pans with mouse button %s without rotating and stops after release", button => {
  const { camera, controls, drag } = scene();
  try {
    const offset = camera.position.clone().sub(controls.target);
    drag(button);
    expect(controls.target.length()).toBeGreaterThan(0);
    expect(camera.position.clone().sub(controls.target).distanceTo(offset)).toBeLessThan(1e-6);
    const after = camera.position.clone();
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 300 }));
    expect(camera.position.distanceTo(after)).toBeLessThan(1e-6);
  } finally { controls.dispose(); }
});

it("keeps orbit on the middle button and zoom on the wheel", () => {
  const { camera, controls, drag, element } = scene();
  try {
    const before = camera.position.clone();
    drag(1);
    expect(controls.target.distanceTo(new Vector3())).toBeLessThan(1e-6);
    expect(camera.position.distanceTo(before)).toBeGreaterThan(0.1);
    const distance = camera.position.distanceTo(controls.target);
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, cancelable: true }));
    expect(camera.position.distanceTo(controls.target)).toBeLessThan(distance);
  } finally { controls.dispose(); }
});
