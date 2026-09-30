import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReducer, useState } from "react";
import WallReview from "@/components/WallReview";
import { proposeWallEndpoint } from "@/lib/wallLengthEdit";
import { isCalibrationDimension, preservesConfirmedDimensions, type ConfirmedDimension } from "@/lib/confirmedDimensions";
import { projectHistoryReducer, type HistoryState, type ProjectState } from "@/lib/projectHistory";
import { geometryChanged, validWall } from "@/lib/wallGeometry";
import type { DetectedWallSegment as Wall } from "@/types/detection";

/** Regression coverage for uncalibrated endpoint dragging through the real
 * WallReview -> onWallGeometryCommit -> reducer -> rerender path, mirroring
 * Index.handleWallGeometryCommit. */
const WALLS: Wall[] = [
    { id: "a", x1: 0.1, y1: 0.5, x2: 0.5, y2: 0.5, type: "interior" },
    { id: "b", x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.9, type: "interior" },
];
const W = (id: string, x1: number, y1: number, x2: number, y2: number): Wall =>
    ({ id, x1, y1, x2, y2, type: "interior" });

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
    });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

let latest: Wall[] = [];
let renders = 0;

function Editor({ walls = WALLS, planW = 0, planH = 0, calibrationStatus = "uncalibrated", dims }:
{ walls?: Wall[]; planW?: number; planH?: number; calibrationStatus?: string; dims?: ConfirmedDimension[] }) {
    const [history, dispatch] = useReducer(projectHistoryReducer, undefined, () =>
        ({ past: [], future: [], pending: null, notice: null,
            present: { walls, planW, planH, calibrationStatus, scale: 1, rooms: [], doors: [], windows: [], furniture: [], unit: "m", ...(dims ? { confirmedDimensions: dims } : {}) } }) as unknown as HistoryState);
    const [, force] = useState(0);
    const p = history.present as unknown as ProjectState & { walls: Wall[] };
    latest = p.walls;
    renders += 1;
    const commit = (updatedWalls: Wall[]) => dispatch({
        type: "edit", info: { label: "wall geometry change" },
        update: (prev: ProjectState) => {
            if (updatedWalls.length !== prev.walls.length || updatedWalls.some((w, i) => w.id !== prev.walls[i].id || (geometryChanged(prev.walls[i], w) && !validWall(w)))) return prev;
            const c = proposeWallEndpoint(prev, updatedWalls, prev.planW, prev.planH);
            if (c) return c.ok ? { ...prev, ...c.geometry } : prev;
            if (!preservesConfirmedDimensions(updatedWalls, prev.confirmedDimensions?.filter(isCalibrationDimension), prev.planW, prev.planH)) return prev;
            return { ...prev, walls: updatedWalls };
        }
    });
    void force;
    return <WallReview calibrationStatus={(p.calibrationStatus as never)} rooms={[]} walls={p.walls} unit="m" imageUrl="plan.png"
        scale={1} planWidth={p.planW} planHeight={p.planH} onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()}
        confirmedDimensions={dims} onWallGeometryCommit={commit} onWallLengthCommit={vi.fn()} />;
}

function dragTo(walls: Wall[], to: [number, number], handleIndex = 1, props: Parameters<typeof Editor>[0] = {}, select: [number, number] = [0.3, 0.5]) {
    renders = 0;
    const { container } = render(<Editor walls={walls} {...props} />);
    const svg = container.querySelector('svg[viewBox="0 0 100 100"]') as SVGSVGElement;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 1000 } as DOMRect);
    svg.setPointerCapture = vi.fn(); svg.hasPointerCapture = vi.fn(() => true); svg.releasePointerCapture = vi.fn();
    const at = (x: number, y: number) => ({ clientX: x * 1000, clientY: y * 1000, pointerId: 1, button: 0 });
    fireEvent.click(svg, at(select[0], select[1]));
    const h = svg.querySelectorAll('[data-wall-endpoint]')[handleIndex];
    expect(h).toBeDefined();
    fireEvent.pointerDown(h!, at(Number(h!.getAttribute("cx")), Number(h!.getAttribute("cy"))));
    fireEvent.pointerMove(svg, at(to[0], to[1]));
    fireEvent.pointerUp(svg, at(to[0], to[1]));
    return { walls: latest, renders };
}

describe("uncalibrated endpoint dragging through the real reducer", () => {
    it("commits a drag with planW=0 and planH=0 and rerenders with it", () => {
        const { walls } = dragTo([W("a", 0.1, 0.5, 0.5, 0.5)], [0.75, 0.4]);
        expect(walls).toHaveLength(1);
        expect(walls[0].x2).toBeCloseTo(0.75, 8);
        // The wall is horizontal, so the dropped 0.4 is projected back onto its
        // own axis. Uncalibrated plans still edit normally.
        expect(walls[0].y2).toBeCloseTo(0.5, 8);
    });

    it("commits an endpoint connection before calibration", () => {
        const { walls } = dragTo([W("a", 0.1, 0.5, 0.5, 0.5), W("t", 0.75, 0.5, 0.9, 0.5)], [0.75, 0.4]);
        expect(walls[0].x2).toBeCloseTo(walls[1].x1, 8);
        expect(walls[0].y2).toBeCloseTo(walls[1].y1, 8);
    });

    it("commits a T-junction before calibration", () => {
        const { walls } = dragTo([W("stub", 0.5, 0.1, 0.5, 0.4), W("host", 0.1, 0.6, 0.9, 0.6)], [0.5, 0.6], 1, {}, [0.5, 0.25]);
        expect(walls[0].y2).toBeCloseTo(0.6, 8);
        expect(walls[1]).toEqual(W("host", 0.1, 0.6, 0.9, 0.6));
    });

    it("commits a disconnect before calibration", () => {
        const { walls } = dragTo([W("stub", 0.5, 0.2, 0.5, 0.5), W("host", 0.1, 0.5, 0.9, 0.5)], [0.75, 0.4], 1, {}, [0.5, 0.35]);
        // The vertical stub leaves the host along its own axis; the host stays.
        expect(walls[0].x2).toBeCloseTo(0.5, 8);
        expect(walls[0].y2).toBeCloseTo(0.4, 8);
        expect(walls[1]).toEqual(W("host", 0.1, 0.5, 0.9, 0.5));
    });

    it("leaves a shared junction where it is before calibration", () => {
        const { walls } = dragTo(WALLS, [0.75, 0.4]);
        // A drag moves one endpoint; the wall it used to share a corner with is not
        // dragged along, so the two are simply no longer joined. Uncalibrated
        // geometry behaves exactly like calibrated geometry here.
        expect(walls[0].x2).toBeCloseTo(0.75, 8);
        expect(walls[0].y2).toBeCloseTo(0.5, 8);
        expect(walls[1]).toEqual(WALLS[1]);
    });

    it("records no measurement when dragging before calibration", () => {
        const { container } = render(<Editor walls={[W("a", 0.1, 0.5, 0.5, 0.5)]} />);
        const svg = container.querySelector('svg[viewBox="0 0 100 100"]') as SVGSVGElement;
        // The uncalibrated plan must not render plan-derived metric wall lengths.
        expect(svg.textContent).not.toMatch(/\d+(\.\d+)?\s*m/);
    });

    it("still uses the metric scale and confirmed spans after calibration", () => {
        const { walls } = dragTo(WALLS, [0.75, 0.4], 1, { planW: 10, planH: 10, calibrationStatus: "calibrated" });
        expect(walls[0].x2).toBeCloseTo(0.75, 8);
        expect(walls[0].y2).toBeCloseTo(0.5, 8);
    });
});
