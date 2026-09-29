import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Scene } from "./RightPanel";
import type { ComponentProps } from "react";
import { newOpeningRecord, openingGeometry } from "@/lib/openingModel";
import { rectangleRoom } from "@/lib/manualPlan";
const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 100);
vi.mock("@react-three/fiber", () => ({ Canvas: () => null, useFrame: () => {}, useThree: () => ({ camera, size: { width: 1000, height: 500 } }) }));
vi.mock("@react-three/drei", () => ({ OrbitControls: () => null, Grid: () => null, PointerLockControls: () => null, Text: () => null, useGLTF: vi.fn() }));
vi.mock("@/lib/wallTextures", () => ({ createWallTexture: () => null }));
beforeEach(() => {
  camera.position.set(0, 18, 12);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  // R3F intrinsic elements are rendered in jsdom solely to exercise event wiring.
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.defineProperty(HTMLElement.prototype, "color", { configurable: true, value: new THREE.Color() });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLElement.prototype, "color"); vi.restoreAllMocks(); });
function sceneProps(): ComponentProps<typeof Scene> {
  const noop = vi.fn();
  return { defaultWallHeight: 3.6, rooms: [], walls: [], doors: [], windows: [], walkMode: false,
    viewPreset: "perspective", cameraDistance: 20, buildMode: "select", placementPreview: null, openingDraft: null,
    selectedTarget: null, hoverTarget: null, onHoverChange: noop, onSelect: noop, onHoverTargetChange: noop,
    onPlacementHover: noop, onWallAdd: vi.fn(), onToolComplete: vi.fn(), onWalkExit: noop };
}
function propsOf(element: Element) {
  const key = Object.keys(element).find(key => key.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, any>>)[key];
}
it.each(["room", "wall", "door", "window"] as const)("keeps the selected %s highlighted when another target is hovered or left", type => {
  const room = rectangleRoom({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.7 }, "room", "Room", 20, 20, 3.6)!;
  const wall = room.walls[0];
  const door = newOpeningRecord("door", "door", wall, { x: 0.25, y: 0.3 }, { x: 0.3, y: 0.3 }, 20, 20, 3.6)!;
  const window = newOpeningRecord("window", "window", wall, { x: 0.45, y: 0.3 }, { x: 0.5, y: 0.3 }, 20, 20, 3.6)!;
  const selected = { type, id: type === "wall" ? wall.id : type };
  const props = { ...sceneProps(), rooms: [room.room], walls: room.walls, doors: [door], windows: [window], selectedTarget: selected };
  const view = render(<Scene {...props} />);
  const previews = () => [...view.container.querySelectorAll("group")].map(group => propsOf(group).userData?.targetPreview).filter(Boolean);
  expect(previews()).toEqual([selected]);
  const hover = { type: "wall" as const, id: room.walls[1].id };
  view.rerender(<Scene {...props} hoverTarget={hover} />);
  expect(previews()).toEqual([hover, selected]);
  const selectedPreview = [...view.container.querySelectorAll("group")].find(group => propsOf(group).userData?.targetPreview === selected)!;
  expect(selectedPreview.querySelector('meshBasicMaterial[color="#3b82f6"]')).not.toBeNull();
  view.rerender(<Scene {...props} hoverTarget={{ ...selected }} />);
  expect(previews()).toEqual([selected]);
  view.rerender(<Scene {...props} hoverTarget={null} />);
  expect(previews()).toEqual([selected]);
  view.rerender(<Scene {...props} selectedTarget={null} hoverTarget={hover} />);
  expect(previews()).toEqual([hover]);
});

it.each(["door", "window"] as const)("wires %s body movement and both width handles to the shared edit geometry", kind => {
  const wall = { id: "wall", x1: 0.1, y1: 0.3, x2: 0.8, y2: 0.3, type: "interior" as const, wallHeight: 3.6 };
  const opening = newOpeningRecord(kind, kind, wall, { x: 0.3, y: 0.3 }, { x: 0.4, y: 0.3 }, 20, 20, 3.6)!;
  const commit = vi.fn();
  const props = { ...sceneProps(), walls: [wall], doors: kind === "door" ? [opening] : [], windows: kind === "window" ? [opening] : [],
    selectedTarget: { type: kind, id: kind }, onOpeningCommit: commit };
  const view = render(<Scene {...props} />);
  const group = (key: string, value: string) => [...view.container.querySelectorAll("group")].find(g => propsOf(g).userData?.[key] === value)!;
  const root = view.container.firstElementChild!;
  const target = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
  const event = (x: number) => {
    const point = new THREE.Vector3((x - 0.5) * 20, 1.5, -4);
    return { point, ray: new THREE.Ray(camera.position.clone(), point.clone().sub(camera.position).normalize()),
      pointerId: 1, button: 0, clientY: 100, target, stopPropagation: vi.fn() };
  };
  expect(group("editHandle", `${kind}:start`)).toBeDefined();
  expect(group("editHandle", `${kind}:end`)).toBeDefined();
  act(() => propsOf(group("openingBody", kind)).onPointerDown(event(0.35)));
  act(() => propsOf(root).onPointerMove(event(0.45)));
  expect(commit).not.toHaveBeenCalled();
  act(() => propsOf(root).onPointerUp(event(0.45)));
  expect(commit).toHaveBeenCalledOnce();
  expect(openingGeometry(commit.mock.calls[0][2], kind, [wall], 20, 20, 3.6)!.width).toBeCloseTo(2, 10);
  commit.mockClear();
  act(() => propsOf(group("editHandle", `${kind}:start`)).onPointerDown(event(0.3)));
  act(() => propsOf(root).onPointerUp(event(0.25)));
  expect(commit).toHaveBeenCalledOnce();
  const geometry = openingGeometry(commit.mock.calls[0][2], kind, [wall], 20, 20, 3.6)!;
  expect(geometry.width).toBeCloseTo(3, 10);
  expect(geometry.end.x).toBeCloseTo(0.4, 10);
});

it("wires whole-wall dragging and endpoint handles to exact preview commits", () => {
  const wall = { id: "wall", x1: 0.1, y1: 0.6, x2: 0.4, y2: 0.6, type: "interior" as const, wallHeight: 3.6 };
  const host = { ...wall, id: "host", x1: 0.8, y1: 0.2, x2: 0.8, y2: 0.8 };
  const commit = vi.fn();
  const view = render(<Scene {...sceneProps()} walls={[wall, host]} selectedTarget={{ type: "wall", id: wall.id }} onWallGeometryCommit={commit} />);
  const group = (key: string, value: string) => [...view.container.querySelectorAll("group")].find(g => propsOf(g).userData?.[key] === value)!;
  const root = view.container.firstElementChild!;
  const target = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
  const event = (x: number, y: number) => {
    const point = new THREE.Vector3((x - 0.5) * 20, 1.5, (y - 0.5) * 20);
    return { point, ray: new THREE.Ray(camera.position.clone(), point.clone().sub(camera.position).normalize()),
      pointerId: 1, button: 0, clientY: 100, target, stopPropagation: vi.fn() };
  };
  act(() => propsOf(group("wallBody", wall.id)).onPointerDown(event(0.25, 0.6)));
  act(() => propsOf(root).onPointerUp(event(0.35, 0.6)));
  expect(commit.mock.calls[0][0][0].x1).toBeCloseTo(0.2, 10);
  commit.mockClear();
  act(() => propsOf(group("editHandle", "wall:end")).onPointerDown(event(0.4, 0.6)));
  act(() => propsOf(root).onPointerMove(event(0.799, 0.5)));
  expect(commit).not.toHaveBeenCalled();
  const connections = [...view.container.querySelectorAll("group")].filter(g => propsOf(g).userData?.wallDrawMarker === "junction");
  expect(connections).toHaveLength(1);
  act(() => propsOf(root).onPointerUp(event(0.799, 0.5)));
  expect(commit.mock.calls[0][0][0].x2).toBeCloseTo(0.8, 12);
});
it.each(["endpoint", "junction"])("previews and commits an exact %s in the 3D wall tool", kind => {
  const wall = { id: "host", x1: 0.2, y1: 0.3, x2: 0.6, y2: 0.3, type: "interior" as const, thickness: 0.2 };
  const add = vi.fn(), complete = vi.fn(), noop = vi.fn();
  const view = render(<Scene defaultWallHeight={3.6} rooms={[]} walls={[wall]} doors={[]} windows={[]} walkMode={false}
    viewPreset="perspective" cameraDistance={20} buildMode="wall" placementPreview={null} openingDraft={null}
    selectedTarget={null} hoverTarget={null} onHoverChange={noop} onSelect={noop} onHoverTargetChange={noop}
    onPlacementHover={noop} onWallAdd={add} onToolComplete={complete} onWalkExit={noop} />);
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
  expect(view.container.querySelector("ringGeometry")).toBeNull();
  expect(view.container.querySelectorAll("circleGeometry")).toHaveLength(2);
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

it.each(["endpoint", "junction"])("highlights the finishing %s and commits the previewed connection exactly", kind => {
  const host = { id: "host", x1: 0.2, y1: 0.3, x2: 0.6, y2: 0.3, type: "interior" as const, thickness: 0.2 };
  const props = { ...sceneProps(), walls: [host], buildMode: "wall" as const };
  const view = render(<Scene {...props} />);
  const plane = view.container.querySelector("planeGeometry")!.parentElement!;
  const at = (handler: string, x: number, y: number) => act(() => propsOf(plane)[handler]({
    point: new THREE.Vector3((x - 0.5) * 20, 0.06, (y - 0.5) * 20), stopPropagation: () => {},
  }));
  at("onClick", 0.4, 0.7);
  const x = kind === "endpoint" ? 0.2 : 0.4;
  at("onPointerMove", x + 0.001, 0.301);
  const marker = [...view.container.querySelectorAll("group")].find(group => propsOf(group).userData?.active)!;
  expect(propsOf(marker).userData.wallDrawMarker).toBe(kind);
  const position = propsOf(marker).position;
  expect(position[2]).toBeCloseTo(-4, 10);
  expect(marker.querySelector("ringGeometry")).not.toBeNull();
  at("onClick", x + 0.001, 0.301);
  const created = vi.mocked(props.onWallAdd!).mock.calls[0][0];
  expect(created.x2).toBeCloseTo(position[0] / 20 + 0.5, 10);
  expect(created.y2).toBe(0.3);
  expect(props.onWallAdd).toHaveBeenCalledOnce();
  view.rerender(<Scene {...props} buildMode="select" />);
  expect(view.container.querySelector("ringGeometry")).toBeNull();
  expect(view.container.querySelector("circleGeometry")).toBeNull();
});
