import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Scene } from "./RightPanel";
const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 100);
vi.mock("@react-three/fiber", () => ({ Canvas: () => null, useFrame: () => {}, useThree: () => ({ camera, size: { width: 1000, height: 500 } }) }));
vi.mock("@react-three/drei", () => ({ OrbitControls: () => null, Grid: () => null, PointerLockControls: () => null, Text: () => null, useGLTF: vi.fn() }));
vi.mock("@/lib/wallTextures", () => ({ createWallTexture: () => null }));
beforeEach(() => {
  // R3F intrinsic elements are rendered in jsdom solely to exercise event wiring.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each(["endpoint", "junction"])("previews and commits an exact %s in the 3D wall tool", kind => {
  const wall = { id: "host", x1: 0.2, y1: 0.3, x2: 0.6, y2: 0.3, type: "interior" as const, thickness: 0.2 };
  const add = vi.fn(), complete = vi.fn(), noop = vi.fn();
  const view = render(<Scene defaultWallHeight={3.6} rooms={[]} walls={[wall]} doors={[]} windows={[]} walkMode={false}
    viewPreset="perspective" cameraDistance={20} buildMode="wall" placementPreview={null} openingDraft={null}
    selectedTarget={null} hoverTarget={null} onHoverChange={noop} onSelect={noop} onHoverTargetChange={noop}
    onPlacementHover={noop} onWallAdd={add} onToolComplete={complete} onWallEndpointDrag={noop}
    onWallMoveDrag={noop} onWallHeightDrag={noop} onDragStart={noop} onDragEnd={noop} onDragCancel={noop} onWalkExit={noop} />);
  camera.updateMatrixWorld();
  const plane = view.container.querySelector("planeGeometry")!.parentElement!;
  const at = (type: string, x: number, y: number) => {
    // Invoke the R3F handler with a raycast hit, bypassing React DOM's mouse-event wrapper.
    const propsKey = Object.keys(plane).find(key => key.startsWith("__reactProps$"))!;
    const handlers = (plane as unknown as Record<string, Record<string, (event: unknown) => void>>)[propsKey];
    act(() => handlers[type === "click" ? "onClick" : "onPointerMove"]({
      point: new THREE.Vector3((x - 0.5) * 20, 0.06, (y - 0.5) * 20), stopPropagation: () => {},
    }));
  };
  const x = kind === "endpoint" ? 0.2 : 0.4;
  at("pointermove", x + 0.001, 0.301);
  expect(view.container.querySelector("ringGeometry")).not.toBeNull();
  expect(add).not.toHaveBeenCalled();
  at("click", x + 0.001, 0.301);
  at("pointermove", 0.4, 0.7);
  // The starting connection stays visible while the free endpoint moves away.
  expect(view.container.querySelector("ringGeometry")).not.toBeNull();
  at("click", 0.4, 0.7);
  expect(add).toHaveBeenCalledOnce();
  const created = add.mock.calls[0][0];
  expect(created.y1).toBeCloseTo(0.3, 10);
  if (kind === "endpoint") expect(created.x1).toBe(0.2);
  expect(created.x2).toBeCloseTo(0.4, 10); expect(created.y2).toBeCloseTo(0.7, 10);
  expect(created.wallHeight).toBe(3.6);
  expect(complete).toHaveBeenCalledOnce();
});
