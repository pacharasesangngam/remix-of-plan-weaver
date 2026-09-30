import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { DetectedWallSegment as Wall, DetectedDoor, DetectedWindow } from "@/types/detection";
import type { NormalizedPoint as Point } from "@/types/floorplan";
import { editWallGeometry, endpointPoint, findWallSnap, projectToWall, screenDistance, snapWallTranslation,
  wallSnapTargets, SNAP_PX, type Endpoint, type ScreenSize } from "@/lib/wallGeometry";
import { wallDrawConnections } from "@/lib/wallDrawing";
import { editOpening, findOpeningRehost, openingGeometry, syncOpeningRecords, type Opening, type OpeningKind } from "@/lib/openingModel";

type Pointer = ThreeEvent<PointerEvent>;
type WallMode = Endpoint | "move" | "height";
type Snapshot = { walls: Wall[]; doors: DetectedDoor[]; windows: DetectedWindow[]; planW: number; planH: number; wallHeightMeter: number };
type Capture = { setPointerCapture: (id: number) => void; releasePointerCapture: (id: number) => void; hasPointerCapture?: (id: number) => boolean };
type Drag = {
  pointerId: number; capture?: Capture; base: Snapshot; origin: Point; plane: THREE.Plane; height: number;
  clientY: number; moved: boolean; latest: Snapshot; exact: boolean;
} & ({ kind: "wall"; original: Wall; mode: WallMode; blocked: Record<Endpoint, Set<string>>; reverseBlocked: Set<string> }
  | { kind: OpeningKind; original: Opening; mode: Endpoint | "move"; originT: number });

/** R3F pointer/camera adapter for Review's geometry rules. All previews are local;
 * the same complete geometry is committed once on release. */
export function useThreePlanEditing({ walls, doors, windows, pw, ph, wallHeight, enabled, sizeAt,
  onWallCommit, onOpeningCommit }: {
  walls: Wall[]; doors: DetectedDoor[]; windows: DetectedWindow[]; pw: number; ph: number; wallHeight: number;
  enabled: boolean; sizeAt: (height: number) => ScreenSize;
  onWallCommit?: (walls: Wall[], options?: { exact?: boolean }) => void;
  onOpeningCommit?: (kind: OpeningKind, original: Opening, updated: Opening) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<Snapshot | null>(null);
  const [active, setActive] = useState<Drag | null>(null);
  const base: Snapshot = { walls, doors, windows, planW: pw, planH: ph, wallHeightMeter: wallHeight };
  const normalized = (p: THREE.Vector3): Point => ({ x: p.x / pw + 0.5, y: p.z / ph + 0.5 });
  const along = (p: Point, opening: Opening, kind: OpeningKind) => {
    const g = openingGeometry(opening, kind, walls, pw, ph, wallHeight)!;
    return ((p.x - g.wall.x1) * pw * (g.wall.x2 - g.wall.x1) * pw
      + (p.y - g.wall.y1) * ph * (g.wall.y2 - g.wall.y1) * ph) / g.length;
  };
  const release = (current: Drag) => {
    if (current.capture && (!current.capture.hasPointerCapture || current.capture.hasPointerCapture(current.pointerId))) current.capture.releasePointerCapture(current.pointerId);
  };
  const cancel = () => {
    const current = drag.current;
    drag.current = null; setPreview(null); setActive(null);
    if (current) release(current);
  };
  useEffect(() => {
    cancel();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); const current = drag.current; drag.current = null; if (current) release(current); };
  }, [walls, doors, windows, pw, ph, wallHeight, enabled]);

  const start = (event: Pointer) => {
    if (!enabled || event.button !== 0 || drag.current) return null;
    event.stopPropagation(); suppressClick.current = false;
    const target = event.target as unknown as Capture;
    const capture = typeof target?.setPointerCapture === "function" ? target : undefined;
    capture?.setPointerCapture(event.pointerId);
    const height = event.point.y;
    return { pointerId: event.pointerId, capture, base, latest: base, origin: normalized(event.point), height,
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -height), clientY: event.clientY, moved: false, exact: false };
  };
  const beginWall = (wall: Wall, mode: WallMode, event: Pointer) => {
    if (!onWallCommit) return;
    const initial = start(event); if (!initial) return;
    const size = sizeAt(initial.height), excluded = new Set([wall.id]);
    const blocked = Object.fromEntries((["start", "end"] as const).map(end => {
      const point = endpointPoint(wall, end);
      return [end, new Set(wallSnapTargets(point, walls, excluded, size)
        .filter(target => screenDistance(point, target, size) < SNAP_PX).map(target => target.key))];
    })) as Record<Endpoint, Set<string>>;
    const reverseBlocked = new Set(walls.filter(other => other.id !== wall.id).flatMap(other =>
      (["start", "end"] as const).filter(end => {
        const point = endpointPoint(other, end);
        return screenDistance(point, projectToWall(point, wall, size), size) < SNAP_PX;
      }).map(end => `${other.id}:${end}`)));
    drag.current = { ...initial, kind: "wall", original: wall, mode, blocked, reverseBlocked };
    setActive(drag.current);
  };
  const beginOpening = (kind: OpeningKind, opening: Opening, mode: Endpoint | "move", event: Pointer) => {
    if (!onOpeningCommit || !openingGeometry(opening, kind, walls, pw, ph, wallHeight)) return;
    const initial = start(event); if (!initial) return;
    drag.current = { ...initial, kind, original: opening, mode, originT: along(initial.origin, opening, kind) };
    setActive(drag.current);
  };
  const move = (event: Pointer) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return false;
    event.stopPropagation();
    if (current.base.walls !== walls || current.base.doors !== doors || current.base.windows !== windows) { cancel(); return true; }
    const hit = event.ray.intersectPlane(current.plane, new THREE.Vector3());
    if (!hit) return true;
    const point = normalized(hit), size = sizeAt(current.height);
    const threshold = current.kind === "wall" && current.mode === "move" ? 4 : 1e-7;
    if (!current.moved && screenDistance(point, current.origin, size) < threshold
      && !(current.kind === "wall" && current.mode === "height" && Math.abs(event.clientY - current.clientY) >= 4)) return true;
    current.moved = true; suppressClick.current = true;
    if (current.kind === "wall") {
      const wall = current.original;
      let updated = { ...wall };
      if (current.mode === "height") updated.wallHeight = Math.max(1, Math.min(10, (wall.wallHeight ?? wallHeight) - (event.clientY - current.clientY) * 0.025));
      else if (current.mode === "move") {
        const dx = point.x - current.origin.x, dy = point.y - current.origin.y;
        const snapped = snapWallTranslation({ ...wall, x1: wall.x1 + dx, y1: wall.y1 + dy, x2: wall.x2 + dx, y2: wall.y2 + dy },
          walls, size, current.blocked, current.reverseBlocked);
        updated = snapped.wall;
        current.exact = snapped.targets.length > 0;
      } else {
        const snap = findWallSnap(point, wallSnapTargets(point, walls, new Set([wall.id]), size), size, current.blocked[current.mode]);
        const end = snap ?? point;
        // A resolved snap is a deliberate connection and outranks the axis
        // projection the loose pointer gets, in the preview and in the commit.
        current.exact = !!snap;
        updated = { ...wall, ...(current.mode === "start" ? { x1: end.x, y1: end.y } : { x2: end.x, y2: end.y }) };
      }
      const nextWalls = current.mode === "height" ? walls.map(w => w.id === wall.id ? updated : w)
        : editWallGeometry(walls, updated, current.mode === "move" ? undefined : current.mode, { exact: current.exact });
      current.latest = nextWalls ? syncOpeningRecords({ ...current.base, walls: nextWalls }, current.base) : current.base;
    } else {
      const g = openingGeometry(current.original, current.kind, walls, pw, ph, wallHeight)!;
      const rehost = current.mode === "move" ? findOpeningRehost(current.original, current.kind, point, size,
        walls, doors, windows, pw, ph, wallHeight, current.originT - (g.tStart + g.tEnd) / 2) : null;
      const t = along(point, current.original, current.kind);
      const opening = rehost ?? editOpening(current.original, current.kind,
        { mode: current.mode, value: current.mode === "move" ? t - current.originT : t }, walls, doors, windows, pw, ph, wallHeight) ?? current.original;
      current.latest = { ...current.base, ...(current.kind === "door"
        ? { doors: doors.map(o => o.id === opening.id ? opening : o) }
        : { windows: windows.map(o => o.id === opening.id ? opening : o) }) };
    }
    setPreview(current.latest); setActive({ ...current });
    return true;
  };
  const finish = (event: Pointer) => {
    if (!drag.current || event.pointerId !== drag.current.pointerId) return;
    move(event); // Release may contain a newer position than the last move.
    const current = drag.current; if (!current) return;
    event.stopPropagation(); drag.current = null; setPreview(null); setActive(null); release(current);
    if (!current.moved) return;
    if (current.kind === "wall") {
      if (current.latest.walls !== current.base.walls) onWallCommit?.(current.latest.walls, { exact: current.exact });
    } else {
      const opening = (current.kind === "door" ? current.latest.doors : current.latest.windows).find(o => o.id === current.original.id)!;
      if (JSON.stringify(opening) !== JSON.stringify(current.original)) onOpeningCommit?.(current.kind, current.original, opening);
    }
  };
  const current = preview ?? base;
  const wall = active?.kind === "wall" ? current.walls.find(w => w.id === active.original.id) : undefined;
  const feedback = wall && active ? wallDrawConnections(wall, walls.filter(w => w.id !== wall.id), sizeAt(active.height)) : [];
  const opening = active && active.kind !== "wall" ? (active.kind === "door" ? current.doors : current.windows).find(o => o.id === active.original.id) : undefined;
  return { ...current, active: !!active, height: active?.height ?? 0.07, feedback,
    rehostWallId: opening && active && active.kind !== "wall" && opening.wallId !== active.original.wallId ? opening.wallId : undefined,
    beginWall, beginOpening, move, suppressClick,
    events: { onPointerDown: () => { suppressClick.current = false; }, onPointerMove: move, onPointerUp: finish,
      onPointerCancel: (event: Pointer) => { if (event.pointerId === drag.current?.pointerId) cancel(); },
      onLostPointerCapture: (event: Pointer) => { if (event.pointerId === drag.current?.pointerId) cancel(); } } };
}
