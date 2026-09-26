import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WallReview from "./WallReview";
import type { DetectedDoor, DetectedWallSegment, DetectedWindow } from "@/types/detection";
import { useState } from "react";

const wall: DetectedWallSegment = { id: "wall-a", x1: 0.2, y1: 0.3, x2: 0.6, y2: 0.3, type: "interior" };
const neighbor: DetectedWallSegment = { ...wall, id: "wall-b", x1: 0.6, y1: 0.3, x2: 0.8, y2: 0.7 };

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) {
            super(type, init);
            this.pointerId = init.pointerId ?? 1;
        }
    });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(initialWalls = [wall, neighbor], calibrated = true) {
    const commit = vi.fn();
    function Editor() {
        const [walls, setWalls] = useState(initialWalls);
        return <WallReview calibrationStatus={calibrated ? "calibrated" : "uncalibrated"} rooms={[]} walls={walls} unit="m" imageUrl="plan.png"
            scale={1} planWidth={20} planHeight={20} onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()} onWallGeometryCommit={updated => {
                commit(updated);
                setWalls(updated);
            }} />;
    }
    const { container } = render(<Editor />);
    const svg = container.querySelector('svg[viewBox="0 0 100 100"]') as SVGSVGElement;
    // Non-square transformed bounds represent a zoomed and panned canvas.
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: -100, top: 80, width: 1000, height: 500 } as DOMRect);
    svg.setPointerCapture = vi.fn();
    svg.hasPointerCapture = vi.fn(() => true);
    svg.releasePointerCapture = vi.fn();
    const at = (x: number, y: number) => ({ clientX: -100 + x * 1000, clientY: 80 + y * 500, pointerId: 1, button: 0 });
    fireEvent.click(svg, at(0.4, 0.3));
    const handles = () => svg.querySelectorAll('[data-wall-endpoint]');
    const begin = (index: number, altKey = false) => {
        const handle = handles()[index];
        fireEvent.pointerDown(handle, { ...at(Number(handle.getAttribute("cx")), Number(handle.getAttribute("cy"))), altKey });
    };
    const move = (x: number, y: number) => fireEvent.pointerMove(svg, at(x, y));
    const end = (x: number, y: number) => fireEvent.pointerUp(svg, at(x, y));
    return { svg, container, commit, at, handles, begin, move, end };
}

describe("wall endpoint dragging", () => {
    it("highlights another stored endpoint in screen-space range, clears on exit, and commits its exact coordinates", () => {
        const target = { ...wall, id: "target", x1: 0.75, y1: 0.6, x2: 0.9, y2: 0.6 };
        const { svg, begin, move, end, commit } = setup([wall, target]);
        begin(1);
        move(0.744, 0.592); // 6 px horizontally and 4 px vertically on transformed bounds.
        const marker = () => svg.querySelector('[data-wall-snap-target="target:start"]');
        expect(marker()).toHaveAttribute("cx", "0.75");
        expect(marker()).toHaveAttribute("cy", "0.6");
        expect(marker()).toHaveAttribute("stroke", "#22c55e");
        expect(marker()).toHaveAttribute("fill", "none");
        expect(marker()?.parentElement?.querySelector('circle[stroke="#f59e0b"]')).toHaveAttribute("fill", "#fff");
        expect(commit).not.toHaveBeenCalled();
        move(0.73, 0.56);
        expect(marker()).toBeNull();
        move(0.745, 0.59);
        expect(marker()).not.toBeNull();
        end(0.745, 0.59);
        expect(commit).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: target.x1, y2: target.y1 }, target]);
        expect(marker()).toBeNull();
    });

    it.each([false, true])("shows every preview connection during endpoint dragging, reversed=%s", reversed => {
        const moving = reversed ? { ...wall, x1: wall.x2, y1: wall.y2, x2: wall.x1, y2: wall.y1 } : wall;
        const interior = [
            { ...wall, id: "interior-a", x1: 0.4, y1: 0.5, x2: 0.4, y2: 0.8 },
            { ...wall, id: "interior-b", x1: 0.6, y1: 0.7, x2: 0.6, y2: 0.95 },
        ];
        const target = { ...wall, id: "target", x1: 0.8, y1: 0.9, x2: 0.95, y2: 0.9 };
        const { svg, begin, move, end, commit } = setup([moving, ...interior, target]);
        begin(reversed ? 0 : 1);
        move(0.795, 0.892);
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(3);
        for (const key of ["interior-a:start", "interior-b:start", "target:start"]) {
            const marker = svg.querySelector(`[data-wall-snap-target="${key}"]`);
            expect(marker).toHaveAttribute("stroke", "#22c55e");
            expect(marker?.parentElement?.querySelector('circle[stroke="#f59e0b"]')).toHaveAttribute("fill", "#fff");
        }
        expect(commit).not.toHaveBeenCalled();
        move(0.75, 0.5);
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(0);
        move(0.795, 0.892);
        end(0.795, 0.892);
        expect(commit).toHaveBeenCalledOnce();
        expect(commit.mock.calls[0][0]).toEqual([
            { ...moving, ...(reversed ? { x1: 0.8, y1: 0.9 } : { x2: 0.8, y2: 0.9 }) }, ...interior, target,
        ]);
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(0);
    });

    it("shows interior connections without snapping or changing the dragged endpoint", () => {
        const target = { ...wall, id: "target", x1: 0.4, y1: 0.5, x2: 0.4, y2: 0.8 };
        const { svg, begin, move, end, commit } = setup([wall, target]);
        begin(1);
        move(0.8, 0.9);
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(1);
        expect(svg.querySelector('[data-wall-snap-target="target:start"]')).not.toBeNull();
        end(0.8, 0.9);
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.8, y2: 0.9 }, target]);
    });

    it("shows all connections from pointer-down and restores their feedback when a collapsed preview is rejected", () => {
        const branch = { ...wall, id: "branch", x1: 0.35, y1: 0.3, x2: 0.35, y2: 0.6 };
        const { svg, begin, move, end, commit } = setup([wall, neighbor, branch]);
        const markers = () => svg.querySelectorAll('[data-wall-snap-target]');
        begin(1);
        expect(markers()).toHaveLength(2);
        expect(svg.querySelector('[data-wall-snap-target="branch:start"]')).not.toBeNull();
        move(0.75, 0.5);
        expect(markers()).toHaveLength(0);
        move(0.2, 0.3); // Invalid zero-length draft restores the original preview.
        expect(markers()).toHaveLength(2);
        for (const marker of markers()) {
            expect(marker).toHaveAttribute("stroke", "#22c55e");
            expect(marker.parentElement?.querySelector('circle[stroke="#f59e0b"]')).toHaveAttribute("fill", "#fff");
        }
        end(0.2, 0.3);
        expect(commit).not.toHaveBeenCalled();
        expect(markers()).toHaveLength(0);
    });

    it("only highlights actual interior contacts, clears on cancellation, and never pulls nearby endpoints onto the wall", () => {
        const touching = { ...wall, id: "touching", x1: 0.4, y1: 0.5, x2: 0.4, y2: 0.8 };
        const nearby = { ...wall, id: "nearby", x1: 0.6, y1: 0.705, x2: 0.6, y2: 0.95 };
        const { svg, at, begin, move, commit } = setup([wall, touching, nearby]);
        begin(1);
        move(0.8, 0.9);
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(1);
        expect(svg.querySelector('[data-wall-snap-target="touching:start"]')).not.toBeNull();
        expect(svg.querySelector('[data-wall-snap-target="nearby:start"]')).toBeNull();
        fireEvent.pointerCancel(svg, at(0.8, 0.9));
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(0);
        expect(commit).not.toHaveBeenCalled();
    });

    it("uses release coordinates rather than a stale snap preview", () => {
        const target = { ...wall, id: "target", x1: 0.75, y1: 0.6, x2: 0.9, y2: 0.6 };
        const { begin, move, end, commit } = setup([wall, target]);
        begin(1);
        move(0.744, 0.592);
        end(0.7, 0.5);
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.7, y2: 0.5 }, target]);
    });
    it("renders a physical footprint and a separate exact endpoint span without a selection stroke", () => {
        const isolated = { ...wall, thickness: 0.2 };
        const { svg, container } = setup([isolated]);
        expect(svg).toHaveStyle({ overflow: "visible" });
        const footprint = svg.querySelector('[data-wall-footprint="wall-a"]')!;
        const originalPath = footprint.getAttribute("d");
        expect(footprint).toHaveAttribute("stroke", "none");
        const points = [...originalPath!.matchAll(/[ML]([^, ]+),([^ ]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
        expect(Math.min(...points.map(p => p[0]))).toBeCloseTo(0.2);
        expect(Math.max(...points.map(p => p[0]))).toBeCloseTo(0.6);
        expect(Math.min(...points.map(p => p[1]))).toBeCloseTo(0.295);
        expect(Math.max(...points.map(p => p[1]))).toBeCloseTo(0.305);
        const span = svg.querySelector('[data-measurement-span]')!;
        expect(span).toHaveAttribute("x1", "0.2");
        expect(span).toHaveAttribute("x2", "0.6");
        expect(span).toHaveAttribute("y1", "0.3");
        expect(span).toHaveAttribute("y2", "0.3");
        expect(svg.querySelectorAll('[data-measurement-endpoint]')).toHaveLength(2);
        expect(svg.textContent).toContain("8.00m");
        fireEvent.click([...container.querySelectorAll("button")].find(b => b.textContent?.includes("m/px"))!);
        expect(footprint.getAttribute("d")).toBe(originalPath);
        expect(footprint).toHaveAttribute("stroke", "none");
        expect(svg.querySelector('[data-measurement-span]')).toHaveAttribute("x2", "0.6");
    });
    it("keeps geometry editing available before calibration without displaying provisional lengths", () => {
        const { begin, move, end, commit, svg } = setup([wall, neighbor], false);
        expect(svg.textContent).not.toContain("8.00m");
        begin(1);
        move(0.7, 0.5);
        end(0.7, 0.5);
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.7, y2: 0.5 }, neighbor]);
        expect(svg.textContent).toContain("—");
    });
    it("freely leaves an existing T-junction without a modifier or host movement", () => {
        const host = { ...wall, id: "host", x1: 0.6, y1: 0.1, x2: 0.6, y2: 0.8 };
        const { begin, move, end, handles, commit } = setup([wall, host]);
        begin(1);
        move(0.604, 0.308);
        expect(handles()[1]).toHaveAttribute("cx", "0.604");
        expect(handles()[1]).toHaveAttribute("cy", "0.308");
        move(0.7, 0.5);
        end(0.7, 0.5);
        expect(commit).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.7, y2: 0.5 }, host]);
    });
    it("previews and commits only the selected wall at a shared junction exactly once", () => {
        const { begin, move, end, commit, svg } = setup();
        begin(1);
        move(0.65, 0.4);
        move(0.7, 0.5);
        expect(commit).not.toHaveBeenCalled();
        const neighborLine = svg.querySelectorAll('line[stroke="transparent"]')[1];
        expect(neighborLine).toHaveAttribute("x1", "0.6");
        expect(neighborLine).toHaveAttribute("y1", "0.3");
        end(0.7, 0.5);
        expect(commit).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.7, y2: 0.5 }, neighbor]);
    });

    it("translates a selected wall body without changing adjacent walls", () => {
        const { svg, at, move, end, commit } = setup();
        fireEvent.pointerDown(svg, at(0.4, 0.3));
        move(0.5, 0.4);
        expect(commit).not.toHaveBeenCalled();
        end(0.5, 0.4);
        expect(commit).toHaveBeenCalledOnce();
        const updated = commit.mock.calls[0][0] as DetectedWallSegment[];
        expect(updated[0].x1).toBeCloseTo(0.3);
        expect(updated[0].x2).toBeCloseTo(0.7);
        expect(updated[0].y1).toBeCloseTo(0.4);
        expect(updated[1]).toBe(neighbor);
    });

    it("highlights both compatible body-drag targets, clears on exit, and connects exactly once", () => {
        const left = { ...wall, id: "left", x1: 0.3, y1: 0.6, x2: 0.3, y2: 0.8 };
        const right = { ...left, id: "right", x1: 0.7, x2: 0.7 };
        const { svg, at, move, end, commit } = setup([wall, left, right]);
        fireEvent.pointerDown(svg, at(0.4, 0.3));
        move(0.494, 0.592);
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(2);
        expect(svg.querySelector('[data-wall-snap-target="left:start"]')).toHaveAttribute("stroke", "#22c55e");
        expect(svg.querySelector('[data-wall-snap-target="right:start"]')).not.toBeNull();
        expect(commit).not.toHaveBeenCalled();
        move(0.46, 0.55);
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(0);
        move(0.494, 0.592);
        end(0.494, 0.592);
        expect(commit).toHaveBeenCalledOnce();
        expect(commit.mock.calls[0][0]).toEqual([{ ...wall, x1: 0.3, y1: 0.6, x2: 0.7, y2: 0.6 }, left, right]);
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(0);
    });

    it("chooses one incompatible body-drag target without stretching and updates snapping on release", () => {
        const left = { ...wall, id: "left", x1: 0.3, y1: 0.6, x2: 0.3, y2: 0.8 };
        const right = { ...left, id: "right", x1: 0.71, x2: 0.71 };
        const { svg, at, move, end, commit } = setup([wall, left, right]);
        fireEvent.pointerDown(svg, at(0.4, 0.3));
        move(0.502, 0.596);
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(1);
        expect(svg.querySelector('[data-wall-snap-target="left:start"]')).not.toBeNull();
        end(0.509, 0.596); // The end target is nearer at release.
        const updated = commit.mock.calls[0][0][0];
        expect(updated.x2).toBe(right.x1);
        expect(updated.y2).toBe(right.y1);
        expect(updated.x2 - updated.x1).toBeCloseTo(wall.x2 - wall.x1, 12);
        expect(updated.y2 - updated.y1).toBe(0);
    });

    it("cancels a snapped body drag without committing", () => {
        const target = { ...wall, id: "target", x1: 0.7, y1: 0.6, x2: 0.9, y2: 0.6 };
        const { svg, at, move, commit } = setup([wall, target]);
        fireEvent.pointerDown(svg, at(0.4, 0.3));
        move(0.494, 0.592);
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(1);
        fireEvent.pointerCancel(svg, at(0.494, 0.592));
        expect(commit).not.toHaveBeenCalled();
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(0);
    });

    it("snaps a whole wall to a T junction with the endpoint highlight and clears on exit", () => {
        const host = { ...wall, id: "host", x1: 0.75, y1: 0.1, x2: 0.75, y2: 0.9 };
        const { svg, at, move, end, commit } = setup([wall, host]);
        fireEvent.pointerDown(svg, at(0.4, 0.3));
        move(0.544, 0.4);
        const marker = () => svg.querySelector('[data-wall-snap-target="wall-a:end"]');
        expect(marker()?.tagName).toBe("circle");
        expect(marker()).toHaveAttribute("cx", "0.75");
        expect(marker()).toHaveAttribute("fill", "none");
        expect(marker()?.parentElement?.querySelector('circle[stroke="#f59e0b"]')).toHaveAttribute("fill", "#fff");
        expect(svg.querySelector('[data-measurement-endpoint="end"]')).toBeNull();
        expect(svg.querySelectorAll('circle[stroke="#f59e0b"]')).toHaveLength(2);
        expect(svg.querySelectorAll('[data-wall-endpoint]')).toHaveLength(2); // Hit areas remain available.
        expect(commit).not.toHaveBeenCalled();
        move(0.52, 0.4);
        expect(marker()).toBeNull();
        expect(svg.querySelector('[data-measurement-endpoint="end"]')).not.toBeNull();
        expect(svg.querySelectorAll('circle[stroke="#f59e0b"]')).toHaveLength(2);
        move(0.544, 0.4);
        end(0.544, 0.45);
        expect(commit).toHaveBeenCalledOnce();
        const updated = commit.mock.calls[0][0];
        expect(updated[0].x2).toBe(host.x1);
        expect(updated[0].y2).toBeCloseTo(0.45);
        expect(updated[0].x2 - updated[0].x1).toBeCloseTo(wall.x2 - wall.x1, 12);
        expect(updated[0].y2 - updated[0].y1).toBe(0);
        expect(updated[1]).toBe(host);
        expect(marker()).toBeNull();
    });

    it("highlights stationary endpoints at the moving wall interior and commits every highlighted connection", () => {
        const targets = [0.35, 0.55].map((x, i) => ({ ...wall, id: `target${i}`, x1: x, y1: 0.6, x2: x, y2: 0.9 }));
        const { svg, at, move, end, commit } = setup([wall, ...targets]);
        fireEvent.pointerDown(svg, at(0.4, 0.3));
        move(0.4, 0.59);
        const markers = () => svg.querySelectorAll('[data-wall-snap-target]');
        expect(markers()).toHaveLength(2);
        for (const marker of markers()) {
            expect(marker.tagName).toBe("circle");
            expect(marker).toHaveAttribute("cy", "0.6");
            expect(marker).toHaveAttribute("fill", "none");
            expect(marker.parentElement?.querySelector('circle[stroke="#f59e0b"]')).toHaveAttribute("fill", "#fff");
            expect(marker).toHaveAttribute("stroke", "#22c55e");
        }
        move(0.4, 0.55);
        expect(markers()).toHaveLength(0);
        move(0.4, 0.59);
        end(0.4, 0.59);
        expect(commit).toHaveBeenCalledOnce();
        const updated = commit.mock.calls[0][0];
        expect(updated[0].y1).toBe(0.6);
        expect(updated[0].y2).toBe(0.6);
        expect(updated[0].x1).toBeCloseTo(wall.x1, 12);
        expect(updated[0].x2).toBeCloseTo(wall.x2, 12);
        expect(updated[1]).toBe(targets[0]);
        expect(updated[2]).toBe(targets[1]);
        expect(markers()).toHaveLength(0);
    });

    it("snaps to a segment without coupling future host edits", () => {
        const host = { ...wall, id: "host", x1: 0.2, y1: 0.7, x2: 0.8, y2: 0.7 };
        const { begin, move, end, commit, svg, at, handles } = setup([wall, host]);
        begin(1);
        move(0.5, 0.69);
        expect(handles()[1]).toHaveAttribute("cy", "0.7");
        expect(svg.querySelector('circle[stroke="#22c55e"]')).toHaveAttribute("cy", "0.7");
        end(0.5, 0.69);
        expect(commit.mock.calls[0][0][1]).toBe(host);
        fireEvent.click(svg, at(0.5, 0.69)); // Suppress the drag's synthesized click.
        fireEvent.click(svg, at(0.7, 0.7));
        begin(1);
        move(0.8, 0.9);
        end(0.8, 0.9);
        const updated = commit.mock.calls[1][0] as DetectedWallSegment[];
        expect(updated[0].x2).toBeCloseTo(0.5);
        expect(updated[0].y2).toBeCloseTo(0.7);
    });

    it("cancels an endpoint drag without committing geometry or history", () => {
        const { svg, at, begin, move, commit, handles } = setup();
        begin(1);
        move(0.7, 0.5);
        fireEvent.pointerCancel(svg, at(0.7, 0.5));
        expect(commit).not.toHaveBeenCalled();
        expect(handles()[1]).toHaveAttribute("cx", "0.6");
    });
    it("detaches from a shared endpoint, previews both axes and length, and retains selection", () => {
        const { svg, commit, at, handles, begin, move, end } = setup();
        const initialLabel = svg.textContent;
        begin(1);
        expect(svg.setPointerCapture).toHaveBeenCalledWith(1);
        move(0.604, 0.308); // Still inside the original connection's snap radius.
        expect(handles()[1]).toHaveAttribute("cx", "0.604");
        expect(handles()[1]).toHaveAttribute("cy", "0.308");
        move(0.7, 0.5);
        expect(handles()[0]).toHaveAttribute("cx", "0.2");
        expect(handles()[0]).toHaveAttribute("cy", "0.3");
        expect(svg.textContent).not.toBe(initialLabel);
        end(0.7, 0.5);
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.7, y2: 0.5 }, neighbor]);
        fireEvent.click(svg, at(0.7, 0.5));
        expect(handles()).toHaveLength(2);
    });

    it("snaps exactly to another endpoint and allows returning to the original connection", () => {
        const { handles, begin, move, end, commit } = setup();
        begin(1);
        move(0.75, 0.6);
        move(0.795, 0.69);
        expect(handles()[1]).toHaveAttribute("cx", "0.8");
        expect(handles()[1]).toHaveAttribute("cy", "0.7");
        move(0.603, 0.305);
        end(0.603, 0.305);
        expect(commit).not.toHaveBeenCalled();
    });

    it("moves the start freely beyond the image without changing the end", () => {
        const { begin, move, end, commit } = setup();
        begin(0);
        move(-0.1, 1.1);
        end(-0.1, 1.1);
        expect(commit).toHaveBeenCalledWith([{ ...wall, x1: -0.1, y1: 1.1 }, neighbor]);
    });

    it("preserves endpoint identity and the latest opposite endpoint across consecutive reversed edits", () => {
        const { begin, move, end, commit, handles } = setup([wall]);
        begin(0);
        move(0.9, 0.8); // Start now lies to the right and below the end.
        end(0.9, 0.8);
        begin(1);
        move(0.1, 0.1);
        expect(handles()[0]).toHaveAttribute("cx", "0.9");
        expect(handles()[0]).toHaveAttribute("cy", "0.8");
        end(0.1, 0.1);
        expect(commit).toHaveBeenLastCalledWith([{ ...wall, x1: 0.9, y1: 0.8, x2: 0.1, y2: 0.1 }]);
        begin(0);
        move(0.5, 0.6);
        end(0.5, 0.6);
        expect(commit).toHaveBeenLastCalledWith([{ ...wall, x1: 0.5, y1: 0.6, x2: 0.1, y2: 0.1 }]);
    });

    it("chooses the nearest physical endpoint when endpoint hit areas overlap", () => {
        const shortWall = { ...wall, x1: 0.395, x2: 0.405 };
        const { svg, at, handles, move, end, commit } = setup([shortWall]);
        // Even if the end's ellipse receives the event, the press is at the start.
        fireEvent.pointerDown(handles()[1], at(shortWall.x1, shortWall.y1));
        move(0.2, 0.6);
        end(0.2, 0.6);
        expect(commit).toHaveBeenCalledWith([{ ...shortWall, x1: 0.2, y1: 0.6 }]);
        expect(svg.setPointerCapture).toHaveBeenCalledOnce();
    });

    it("does not give endpoints priority beyond their screen-space radius", () => {
        const { svg, at, move, end, commit } = setup();
        fireEvent.pointerDown(svg, at(0.58, 0.34)); // Outside both the handle and wall body hit areas.
        move(0.7, 0.5);
        end(0.7, 0.5);
        expect(svg.setPointerCapture).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
    });
});

describe("wall selection", () => {
    it("selects the closest wall rather than the first candidate in the threshold", () => {
        const closer = { ...wall, id: "wall-c", y1: 0.32, y2: 0.32 };
        const { svg, at, handles } = setup([wall, closer]);
        fireEvent.click(svg, at(0.4, 0.318));
        expect(handles()[0]).toHaveAttribute("cy", "0.32");
    });

    it.each([false, true])("breaks equal-distance ties consistently regardless of wall order (%s)", reverse => {
        const overlapping = { ...wall, id: "wall-z", x1: 0.1 };
        const { svg, at, handles } = setup(reverse ? [wall, overlapping] : [overlapping, wall]);
        fireEvent.click(svg, at(0.4, 0.3));
        expect(handles()[0]).toHaveAttribute("cx", "0.2");
    });
});

describe("opening placement", () => {
    it("adds a door from two points on one wall with its shared wall attachment", () => {
        const onDoorAdd = vi.fn();
        const { container, getByText } = render(<WallReview calibrationStatus="calibrated" rooms={[]} walls={[wall]} unit="m" imageUrl="plan.png"
            scale={1} planWidth={10} planHeight={10} onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()} onDoorAdd={onDoorAdd} />);
        const svg = container.querySelector('svg[viewBox="0 0 100 100"]') as SVGSVGElement;
        vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);

        fireEvent.click(getByText("Add Element"));
        fireEvent.click(getByText("Door"));
        fireEvent.click(svg, { clientX: 300, clientY: 150 });
        const pointerOverlay = svg.querySelector('[data-opening-pointer-overlay]') as SVGRectElement;
        expect(pointerOverlay).not.toBeNull();
        fireEvent.pointerMove(pointerOverlay, { clientX: 450, clientY: 150 });

        expect(onDoorAdd).not.toHaveBeenCalled();
        expect(svg.querySelector('[data-opening-preview="door"]')).not.toBeNull();
        expect(svg.querySelector('[data-opening-preview-width]')).toHaveTextContent("1.50m");
        expect(svg.style.cursor).toBe("cell");
        expect(pointerOverlay.style.cursor).toBe("cell");
        fireEvent.pointerMove(pointerOverlay, { clientX: 450, clientY: 300 });
        expect(svg.style.cursor).toBe("default");
        expect(pointerOverlay.style.cursor).toBe("default");
        fireEvent.click(svg, { clientX: 500, clientY: 150 });

        expect(onDoorAdd).toHaveBeenCalledOnce();
        expect(onDoorAdd.mock.calls[0][0]).toMatchObject({ id: expect.stringMatching(/^manual-door-/), wallId: "wall-a" });
        expect(onDoorAdd.mock.calls[0][0].bbox).toMatchObject({ x: 0.3, w: 0.2 });
    });

    it("cancels an opening preview with Escape without creating an opening", () => {
        const onWindowAdd = vi.fn();
        const { container, getByText } = render(<WallReview calibrationStatus="calibrated" rooms={[]} walls={[wall]} unit="m" imageUrl="plan.png"
            scale={1} planWidth={10} planHeight={10} onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()} onWindowAdd={onWindowAdd} />);
        const svg = container.querySelector('svg[viewBox="0 0 100 100"]') as SVGSVGElement;
        vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);

        fireEvent.click(getByText("Add Element"));
        fireEvent.click(getByText("Window"));
        fireEvent.click(svg, { clientX: 300, clientY: 150 });
        fireEvent.pointerMove(svg, { clientX: 450, clientY: 150 });
        expect(svg.querySelector('[data-opening-preview="window"]')).not.toBeNull();

        fireEvent.keyDown(window, { key: "Escape" });
        expect(onWindowAdd).not.toHaveBeenCalled();
        expect(svg.querySelector('[data-opening-preview="window"]')).toBeNull();
    });

    it("keeps the original wall draft when the second point is on another wall", () => {
        const onDoorAdd = vi.fn();
        const { container, getByText } = render(<WallReview calibrationStatus="calibrated" rooms={[]} walls={[wall, neighbor]} unit="m" imageUrl="plan.png"
            scale={1} planWidth={10} planHeight={10} onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()} onDoorAdd={onDoorAdd} />);
        const svg = container.querySelector('svg[viewBox="0 0 100 100"]') as SVGSVGElement;
        vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);

        fireEvent.click(getByText("Add Element"));
        fireEvent.click(getByText("Door"));
        fireEvent.click(svg, { clientX: 300, clientY: 150 }); // wall-a
        const pointerOverlay = svg.querySelector('[data-opening-pointer-overlay]') as SVGRectElement;
        fireEvent.pointerMove(pointerOverlay, { clientX: 700, clientY: 250 }); // wall-b
        expect(pointerOverlay.style.cursor).toBe("default");
        fireEvent.click(pointerOverlay, { clientX: 700, clientY: 250 });
        expect(onDoorAdd).not.toHaveBeenCalled();

        fireEvent.pointerMove(pointerOverlay, { clientX: 500, clientY: 150 }); // return to wall-a
        expect(pointerOverlay.style.cursor).toBe("cell");
        fireEvent.click(pointerOverlay, { clientX: 500, clientY: 150 });
        expect(onDoorAdd).toHaveBeenCalledOnce();
    });
});

describe("opening dimensions", () => {
    const attachedDoor: DetectedDoor = {
        id: "door-a",
        wallId: "wall-a",
        bbox: { x: 0.3, y: 0.2925, w: 0.1, h: 0.015 },
    };
    const attachedWindow: DetectedWindow = {
        id: "window-a",
        wallId: "wall-a",
        bbox: { x: 0.3, y: 0.2925, w: 0.1, h: 0.015 },
    };
    const reviewRoom = {
        id: "room-a",
        name: "Room A",
        width: 0.2,
        height: 0.2,
        confidence: "manual" as const,
        bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    };

    const renderOpeningInspector = (scale: number, planWidth: number) => render(
        <WallReview calibrationStatus="calibrated"
            rooms={[reviewRoom]}
            walls={[wall]}
            doors={[attachedDoor]}
            unit="m"
            imageUrl="plan.png"
            scale={scale}
            planWidth={planWidth}
            planHeight={10}
            onScaleChange={vi.fn()}
            onRoomUpdate={vi.fn()}
            onGenerate={vi.fn()}
        />,
    );

    const selectDoorFromList = (view: ReturnType<typeof render>) => {
        fireEvent.click(view.getByText("Other Elements"));
        fireEvent.click(view.getByRole("button", { name: /Doors\s*1/ }));
        fireEvent.click(view.getByText("Door 1"));
    };

    it("keeps opening dimensions off the floorplan and requests calibration in the inspector", () => {
        const view = renderOpeningInspector(0, 0);
        const svg = view.container.querySelector('svg[viewBox="0 0 100 100"]') as SVGSVGElement;
        expect(svg.textContent).not.toContain("W ");

        selectDoorFromList(view);
        expect(view.getByText("Calibrate scale to view dimensions")).toBeInTheDocument();
        expect(view.queryByText("Normalized Plan Width")).not.toBeInTheDocument();
    });

    it("derives attached opening width from shared geometry and recalculates it with plan scale", () => {
        const view = renderOpeningInspector(1, 10);
        selectDoorFromList(view);
        expect(view.getByText("1.00 m")).toBeInTheDocument();

        view.rerender(
            <WallReview calibrationStatus="calibrated"
                rooms={[reviewRoom]}
                walls={[wall]}
                doors={[attachedDoor]}
                unit="m"
                imageUrl="plan.png"
                scale={1}
                planWidth={20}
                planHeight={20}
                onScaleChange={vi.fn()}
                onRoomUpdate={vi.fn()}
                onGenerate={vi.fn()}
            />,
        );
        expect(view.getByText("2.00 m")).toBeInTheDocument();

        fireEvent.click(view.getByText("Advanced Geometry"));
        expect(view.getByText("Normalized Plan Width")).toBeInTheDocument();
        expect(view.getByText(/not meters or physical element height/i)).toBeInTheDocument();
    });

    it("uses the same calibrated wall span for a selected window", () => {
        const view = render(
            <WallReview calibrationStatus="calibrated" rooms={[reviewRoom]} walls={[wall]} windows={[attachedWindow]} unit="m" imageUrl="plan.png"
                scale={1} planWidth={10} planHeight={10} onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()} />,
        );
        const svg = view.container.querySelector('svg[viewBox="0 0 100 100"]') as SVGSVGElement;
        expect(svg.textContent).not.toContain("W 1.00m");
        fireEvent.click(view.getByText("Other Elements"));
        fireEvent.click(view.getByRole("button", { name: /Windows\s*1/ }));
        fireEvent.click(view.getByText("Window 1"));
        expect(view.getByText("1.00 m")).toBeInTheDocument();
    });

    it("shows no estimated wall length before calibration and refreshes the list and inspector after recalibration", () => {
        const view = renderOpeningInspector(0, 0);
        fireEvent.click(view.getByText("Other Elements"));
        fireEvent.click(view.getByRole("button", { name: /Walls\s*1/ }));
        const wallRow = view.getByText("Wall 1").closest("button");
        expect(wallRow).toHaveTextContent("—");
        fireEvent.click(wallRow!);
        expect(view.getByText("Calibrate scale to view dimensions")).toBeInTheDocument();

        view.rerender(
            <WallReview calibrationStatus="calibrated"
                rooms={[reviewRoom]}
                walls={[wall]}
                doors={[attachedDoor]}
                unit="m"
                imageUrl="plan.png"
                scale={1}
                planWidth={20}
                planHeight={20}
                onScaleChange={vi.fn()}
                onRoomUpdate={vi.fn()}
                onGenerate={vi.fn()}
            />,
        );
        expect(view.getByDisplayValue("8.00")).toBeInTheDocument();
        const refreshedWallRow = view.getAllByText("Wall 1").find(element => element.closest("button"));
        expect(refreshedWallRow?.closest("button")).toHaveTextContent("8.00 m");
    });
});


describe("drawing walls from existing endpoints", () => {
    it.each([false, true])("highlights endpoints like calibration and keeps free end placement available (%s)", freeEnd => {
        const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1032);
        const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(532);
        try {
            const onWallAdd = vi.fn();
            const target = { ...wall, id: "target", x1: 0.8, y1: 0.6, x2: 0.9, y2: 0.6 };
            const { container, getByText, getByAltText } = render(<WallReview rooms={[]} walls={[wall, target]} unit="m" imageUrl="plan.png"
                scale={1} onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()} onWallAdd={onWallAdd} />);
            const image = getByAltText("Floor plan");
            Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 500 } });
            fireEvent.load(image);
            fireEvent.click(getByText("Add Element"));
            fireEvent.click(getByText("Wall"));
            const overlay = container.querySelector('div.absolute.inset-0.z-20')!;
            vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: -100, top: 80, width: 1000, height: 500 } as DOMRect);
            const at = (x: number, y: number) => ({ clientX: -100 + x * 1000, clientY: 80 + y * 500 });
            const marker = () => container.querySelector('[data-wall-draw-snap-endpoint]');
            fireEvent.pointerMove(overlay, at(0.206, 0.308));
            expect(marker()).toHaveAttribute("cx", "0.2");
            expect(marker()).toHaveAttribute("cy", "0.3");
            expect(marker()).toHaveAttribute("fill", "#fff");
            expect(marker()).toHaveAttribute("stroke", "#22c55e");
            expect(onWallAdd).not.toHaveBeenCalled();
            fireEvent.pointerMove(overlay, at(0.23, 0.3));
            expect(marker()).toBeNull();
            fireEvent.pointerMove(overlay, at(0.206, 0.308));
            fireEvent.pointerLeave(overlay);
            expect(marker()).toBeNull();
            fireEvent.pointerDown(overlay, at(0.206, 0.308));
            const end = freeEnd ? { x: 0.85, y: 0.7 } : { x: 0.806, y: 0.608 };
            fireEvent.pointerMove(overlay, at(end.x, end.y));
            if (freeEnd) expect(marker()).toBeNull();
            else expect(marker()).toHaveAttribute("cx", "0.8");
            fireEvent.pointerDown(overlay, at(end.x, end.y));
            expect(onWallAdd).toHaveBeenCalledOnce();
            expect(onWallAdd.mock.calls[0][0]).toMatchObject({ x1: 0.2, y1: 0.3,
                x2: freeEnd ? end.x : 0.8, y2: freeEnd ? end.y : 0.6 });
            expect(marker()).toBeNull();
        } finally { width.mockRestore(); height.mockRestore(); }
    });
});
