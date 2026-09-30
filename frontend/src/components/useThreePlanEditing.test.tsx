import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { DetectedWallSegment as Wall } from "@/types/detection";
import { newOpeningRecord, openingGeometry } from "@/lib/openingModel";
import { useThreePlanEditing } from "./useThreePlanEditing";

afterEach(cleanup);
const moving: Wall = { id: "moving", x1: 0.1, y1: 0.6, x2: 0.4, y2: 0.6, type: "interior", thickness: 0.2, wallHeight: 3.6 };
const host: Wall = { id: "host", x1: 0.8, y1: 0.2, x2: 0.8, y2: 0.8, type: "interior", thickness: 0.2, wallHeight: 3.6 };
const capture = () => ({ setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
function setup(kind?: "door" | "window", extraWalls: Wall[] = [], zoom = 1) {
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 100);
  camera.position.set(0, 18, 12); camera.lookAt(0, 0, 0); camera.zoom = zoom;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const sizeAt = (height: number) => ({ width: 20, height: 20,
    project: (p: { x: number; y: number }) => {
      const v = new THREE.Vector3((p.x - 0.5) * 20, height, (p.y - 0.5) * 20).project(camera);
      return { x: (v.x + 1) * 500, y: (1 - v.y) * 250 };
    },
    unproject: (p: { x: number; y: number }) => {
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(p.x / 500 - 1, 1 - p.y / 250), camera);
      const v = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -height), new THREE.Vector3())!;
      return { x: v.x / 20 + 0.5, y: v.z / 20 + 0.5 };
    },
  });
  const opening = kind ? newOpeningRecord(kind, "opening", moving, { x: 0.2, y: 0.6 }, { x: 0.3, y: 0.6 }, 20, 20, 3.6)! : null;
  const props = { walls: [moving, host, ...extraWalls], doors: kind === "door" ? [opening!] : [], windows: kind === "window" ? [opening!] : [],
    pw: 20, ph: 20, wallHeight: 3.6, enabled: true, sizeAt, onWallCommit: vi.fn(), onOpeningCommit: vi.fn() };
  const hook = renderHook(useThreePlanEditing, { initialProps: props });
  const target = capture();
  const event = (x: number, y: number, height = 1.5, pointerId = 1) => {
    const point = new THREE.Vector3((x - 0.5) * 20, height, (y - 0.5) * 20);
    return { point, ray: new THREE.Ray(camera.position.clone(), point.clone().sub(camera.position).normalize()),
      pointerId, button: 0, target, clientY: sizeAt(height).project({ x, y }).y, stopPropagation: vi.fn() } as unknown as ThreeEvent<PointerEvent>;
  };
  return { ...hook, props, opening, event, target };
}

it.each([1, 2])("snaps a whole wall rigidly to an endpoint and commits only on release at zoom %s", zoom => {
  const { result, props, event, target } = setup(undefined, [], zoom);
  act(() => result.current.beginWall(moving, "move", event(0.25, 0.6)));
  act(() => result.current.move(event(0.649, 0.201)));
  const preview = result.current.walls[0];
  expect(preview.x2).toBe(host.x1); expect(preview.y2).toBe(host.y1);
  expect(preview.x2 - preview.x1).toBeCloseTo(moving.x2 - moving.x1, 12);
  expect(preview.y2 - preview.y1).toBe(0);
  expect(result.current.feedback).toContainEqual(expect.objectContaining({ kind: "endpoint", x: host.x1, y: host.y1 }));
  expect(props.onWallCommit).not.toHaveBeenCalled();
  act(() => result.current.events.onPointerUp(event(0.649, 0.201)));
  // A resolved snap is committed exactly, so the commit and the preview cannot
  // disagree about where the wall landed.
  expect(props.onWallCommit).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining([preview]), { exact: true });
  expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
});

it("snaps whole-wall translation to a T-junction without changing length or angle", () => {
  const { result, props, event } = setup();
  act(() => result.current.beginWall(moving, "move", event(0.25, 0.6)));
  act(() => result.current.move(event(0.649, 0.55)));
  const preview = result.current.walls[0];
  expect(preview.x2).toBeCloseTo(0.8, 12);
  expect(preview.x2 - preview.x1).toBeCloseTo(0.3, 12);
  expect(preview.y2 - preview.y1).toBe(0);
  expect(result.current.feedback).toContainEqual(expect.objectContaining({ kind: "junction", x: 0.8 }));
  act(() => result.current.events.onPointerUp(event(0.649, 0.55)));
  expect(props.onWallCommit.mock.calls[0][0][0]).toEqual(preview);
});

it("allows endpoint rotation, previews a T-junction, and uses the latest release position", () => {
  const { result, props, event } = setup();
  act(() => result.current.beginWall(moving, "end", event(0.4, 0.6)));
  act(() => result.current.move(event(0.799, 0.4)));
  expect(result.current.walls[0]).toMatchObject({ x1: 0.1, y1: 0.6, x2: 0.8 });
  expect(result.current.feedback.some(p => p.kind === "junction")).toBe(true);
  act(() => result.current.events.onPointerUp(event(0.799, 0.5)));
  const wall = props.onWallCommit.mock.calls[0][0][0];
  expect(wall.x2).toBeCloseTo(0.8, 12);
  expect(wall.y2).toBeGreaterThan(0.49);
});

it("lets an attached endpoint detach before it becomes eligible to snap back, as in Review", () => {
  const { result, props, event, rerender } = setup();
  const linked = { ...moving, x2: 0.8 };
  rerender({ ...props, walls: [linked, host] });
  act(() => result.current.beginWall(linked, "end", event(0.8, 0.6)));
  act(() => result.current.move(event(0.799, 0.601)));
  expect(result.current.walls[0].x2).toBeCloseTo(0.799, 12);
  expect(result.current.feedback).toHaveLength(0);
  act(() => result.current.move(event(0.5, 0.5)));
  act(() => result.current.move(event(0.799, 0.5)));
  expect(result.current.walls[0].x2).toBeCloseTo(0.8, 12);
  expect(result.current.feedback.some(p => p.kind === "junction")).toBe(true);
});

it("supports fine opening width drags smaller than the whole-wall movement threshold", () => {
  const { result, props, opening, event } = setup("door");
  act(() => result.current.beginOpening("door", opening!, "end", event(0.3, 0.6)));
  act(() => result.current.events.onPointerUp(event(0.301, 0.6)));
  expect(props.onOpeningCommit).toHaveBeenCalledOnce();
  expect(openingGeometry(props.onOpeningCommit.mock.calls[0][2], "door", props.walls, 20, 20, 3.6)!.width).toBeCloseTo(2.02, 10);
});

it.each(["door", "window"] as const)("moves a %s along its host without changing its size or its wall", kind => {
  const { result, props, opening, event } = setup(kind);
  const before = openingGeometry(opening!, kind, props.walls, 20, 20, 3.6)!;
  act(() => result.current.beginOpening(kind, opening!, "move", event(0.25, 0.6)));
  act(() => result.current.move(event(0.32, 0.75)));
  const updated = (kind === "door" ? result.current.doors : result.current.windows)[0];
  const after = openingGeometry(updated, kind, props.walls, 20, 20, 3.6)!;
  expect(updated.wallId).toBe(moving.id);
  expect(after.width).toBeCloseTo(before.width, 12);
  expect(after.height).toBe(before.height); expect(after.sill).toBe(before.sill);
  expect(after.start.y).toBe(0.6);
  expect(result.current.walls).toBe(props.walls);
  expect(props.onOpeningCommit).not.toHaveBeenCalled();
  act(() => result.current.events.onPointerUp(event(0.32, 0.75)));
  expect(props.onOpeningCommit).toHaveBeenCalledExactlyOnceWith(kind, opening, updated);
  expect(props.onWallCommit).not.toHaveBeenCalled();
});

it.each(["door", "window"] as const)("resizes a %s end handle, keeping the opposite end and host fixed", kind => {
  const { result, props, opening, event } = setup(kind);
  act(() => result.current.beginOpening(kind, opening!, "end", event(0.3, 0.6)));
  act(() => result.current.move(event(0.36, 0.7)));
  const updated = (kind === "door" ? result.current.doors : result.current.windows)[0];
  const g = openingGeometry(updated, kind, props.walls, 20, 20, 3.6)!;
  expect(g.width).toBeCloseTo(3.2, 10); expect(g.start.x).toBeCloseTo(0.2, 10);
  expect(result.current.walls).toBe(props.walls);
  act(() => result.current.events.onPointerUp(event(0.36, 0.7)));
  expect(props.onOpeningCommit).toHaveBeenCalledExactlyOnceWith(kind, opening, updated);
  expect(props.onWallCommit).not.toHaveBeenCalled();
});

it.each(["door", "window"] as const)("rehosts a %s only to a valid host, with feedback and unchanged dimensions", kind => {
  const { result, props, opening, event } = setup(kind);
  act(() => result.current.beginOpening(kind, opening!, "move", event(0.25, 0.6)));
  act(() => result.current.move(event(0.801, 0.5)));
  expect(result.current.rehostWallId).toBe(host.id);
  const updated = (kind === "door" ? result.current.doors : result.current.windows)[0];
  const g = openingGeometry(updated, kind, props.walls, 20, 20, 3.6)!;
  expect(g.wall.id).toBe(host.id); expect(g.width).toBeCloseTo(2, 10);
  expect(g.height).toBe(opening!.heightM);
  expect(g.start.x).toBe(0.8); expect(g.end.x).toBe(0.8);
  act(() => result.current.events.onPointerUp(event(0.801, 0.5)));
  expect(props.onOpeningCommit).toHaveBeenCalledExactlyOnceWith(kind, opening, updated);
});

it("does not rehost to a wall too short or too low for the opening", () => {
  const short = { ...host, id: "short", x1: 0.5, x2: 0.5, y1: 0.45, y2: 0.5 };
  const low = { ...host, id: "low", x1: 0.6, x2: 0.6, wallHeight: 0.5 };
  const { result, props, opening, event } = setup("window", [short, low]);
  act(() => result.current.beginOpening("window", opening!, "move", event(0.25, 0.6)));
  for (const point of [[0.501, 0.48], [0.601, 0.48], [0.95, 0.95]]) {
    act(() => result.current.move(event(point[0], point[1])));
    expect(result.current.windows[0].wallId).toBe(moving.id);
    expect(result.current.rehostWallId).toBeUndefined();
    expect(openingGeometry(result.current.windows[0], "window", props.walls, 20, 20, 3.6)!.width).toBeCloseTo(2, 10);
  }
});

it("keeps opening size during wall movement, rotation and extension, and rejects a host too short", () => {
  const { result, props, opening, event } = setup("door");
  act(() => result.current.beginWall(moving, "end", event(0.4, 0.6)));
  for (const point of [[0.6, 0.6], [0.6, 0.8]]) {
    act(() => result.current.move(event(point[0], point[1])));
    const g = openingGeometry(result.current.doors[0], "door", result.current.walls, 20, 20, 3.6)!;
    expect(g.width).toBeCloseTo(2, 10); expect(g.height).toBe(opening!.heightM);
  }
  act(() => result.current.move(event(0.15, 0.6)));
  expect(result.current.walls).toBe(props.walls);
  act(() => result.current.events.onPointerUp(event(0.15, 0.6)));
  expect(props.onWallCommit).not.toHaveBeenCalled();
});

it.each(["escape", "cancel", "capture", "external"])("discards previews on %s without committing", how => {
  const { result, props, event, rerender } = setup("door");
  act(() => result.current.beginWall(moving, "move", event(0.25, 0.6)));
  act(() => result.current.move(event(0.35, 0.6)));
  expect(result.current.walls).not.toBe(props.walls);
  act(() => {
    if (how === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    if (how === "cancel") result.current.events.onPointerCancel(event(0.35, 0.6));
    if (how === "capture") result.current.events.onLostPointerCapture(event(0.35, 0.6));
    if (how === "external") rerender({ ...props, walls: [...props.walls] });
  });
  expect(result.current.active).toBe(false);
  expect(result.current.walls).toEqual(props.walls);
  act(() => result.current.events.onPointerUp(event(0.35, 0.6)));
  expect(props.onWallCommit).not.toHaveBeenCalled();
  expect(props.onOpeningCommit).not.toHaveBeenCalled();
});
