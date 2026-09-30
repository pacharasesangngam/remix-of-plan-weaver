import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WallReview from "./WallReview";
import type { DetectedDoor, DetectedWallSegment, DetectedWindow } from "@/types/detection";
import { newOpeningRecord } from "@/lib/openingModel";
import { proposeWallLength } from "@/lib/wallLengthEdit";
import { confirmCalibration } from "@/lib/confirmedDimensions";
import { useState, type ComponentProps } from "react";

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

function setup(initialWalls = [wall, neighbor], calibrated = true, extra: Partial<ComponentProps<typeof WallReview>> = {}) {
    const commit = vi.fn();
    function Editor() {
        const [walls, setWalls] = useState(initialWalls);
        return <WallReview calibrationStatus={calibrated ? "calibrated" : "uncalibrated"} rooms={[]} walls={walls} unit="m" imageUrl="plan.png"
            scale={1} planWidth={20} planHeight={20} onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()} onWallGeometryCommit={updated => {
                commit(updated);
                setWalls(updated);
            }} onWallLengthCommit={(request, base, pw, ph) => {
                const candidate = proposeWallLength(base, request, pw, ph);
                if (candidate.ok) setWalls(candidate.geometry.walls);
            }} {...extra} />;
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
        expect(marker()?.parentElement?.querySelector('circle[stroke="#2563eb"]')).toHaveAttribute("fill", "#fff");
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

    it("commits the green snap preview even when pointer-up drifts outside the snap radius", () => {
        const target = { ...wall, id: "target", x1: 0.75, y1: 0.6, x2: 0.9, y2: 0.6 };
        const { svg, begin, move, end, commit } = setup([wall, target]);
        begin(1);
        move(0.745, 0.59);
        expect(svg.querySelector('[data-wall-snap-target="target:start"]')).not.toBeNull();
        end(0.73, 0.56);
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: target.x1, y2: target.y1 }, target]);
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
            expect(marker?.parentElement?.querySelector('circle[stroke="#2563eb"]')).toHaveAttribute("fill", "#fff");
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

    it("shows an interior connection and commits the endpoint where it lands", () => {
        // A host crossing the dragged wall's own axis, so the junction is still
        // offered now that an axis wall's endpoint is projected (D1).
        const target = { ...wall, id: "target", x1: 0.4, y1: 0.2, x2: 0.4, y2: 0.4 };
        const { svg, begin, move, end, commit, at } = setup([wall, target]);
        fireEvent.click(svg, at(0.25, 0.3)); // Select the dragged wall, not the crossing host.
        begin(1);
        move(0.4, 0.3);
        expect([...svg.querySelectorAll('[data-wall-snap-target]')].map(m => m.getAttribute('data-wall-snap-target'))).toEqual(['target:segment']);
        end(0.4, 0.3);
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.4, y2: 0.3 }, target]);
    });

    it("shows all connections from pointer-down and restores their feedback when a collapsed preview is rejected", () => {
        const branch = { ...wall, id: "branch", x1: 0.35, y1: 0.3, x2: 0.35, y2: 0.6 };
        const { svg, begin, move, end, commit } = setup([wall, neighbor, branch]);
        const markers = () => svg.querySelectorAll('[data-wall-snap-target]');
        begin(1);
        expect(markers()).toHaveLength(2);
        expect(svg.querySelector('[data-wall-snap-target="branch:start"]')).not.toBeNull();
        // Both neighbours sit on the wall's axis, so dragging past both of them
        // leaves the wall touching neither.
        move(0.3, 0.5);
        expect(markers()).toHaveLength(0);
        move(0.2, 0.3); // Invalid zero-length draft restores the original preview.
        expect(markers()).toHaveLength(2);
        for (const marker of markers()) {
            expect(marker).toHaveAttribute("stroke", "#22c55e");
            expect(marker.parentElement?.querySelector('circle[stroke="#2563eb"]')).toHaveAttribute("fill", "#fff");
        }
        end(0.2, 0.3);
        expect(commit).not.toHaveBeenCalled();
        expect(markers()).toHaveLength(0);
    });

    it("only highlights actual interior contacts, clears on cancellation, and never pulls nearby endpoints onto the wall", () => {
        const touching = { ...wall, id: "touching", x1: 0.4, y1: 0.2, x2: 0.4, y2: 0.4 };
        const nearby = { ...wall, id: "nearby", x1: 0.6, y1: 0.6, x2: 0.6, y2: 0.95 };
        const { svg, at, begin, move, commit } = setup([wall, touching, nearby]);
        fireEvent.click(svg, at(0.25, 0.3)); // Select the dragged wall, not the crossing host.
        begin(1);
        move(0.4, 0.3);
        expect([...svg.querySelectorAll('[data-wall-snap-target]')].map(m => m.getAttribute('data-wall-snap-target'))).toEqual(['touching:segment']);
        expect(svg.querySelector('[data-wall-snap-target="nearby:start"]')).toBeNull();
        fireEvent.pointerCancel(svg, at(0.4, 0.3));
        expect(svg.querySelectorAll('[data-wall-snap-target]')).toHaveLength(0);
        expect(commit).not.toHaveBeenCalled();
    });

    it("keeps a committed endpoint snap when release coordinates drift", () => {
        const target = { ...wall, id: "target", x1: 0.75, y1: 0.6, x2: 0.9, y2: 0.6 };
        const { begin, move, end, commit } = setup([wall, target]);
        begin(1);
        move(0.744, 0.592);
        end(0.7, 0.5);
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: target.x1, y2: target.y1 }, target]);
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
        expect(svg.querySelectorAll('[data-measurement-endpoint]')).toHaveLength(0);
        expect(svg.querySelector('[data-dimension-label] text')).toHaveTextContent(/^8.00$/);
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
        // The wall is horizontal, so the dropped 0.5 is projected back to its own
        // axis. Uncalibrated plans edit normally, they just show no length.
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.7, y2: 0.3 }, neighbor]);
        expect(svg.querySelector('[data-plan-dimension]')).toBeNull();
    });

    it("commits and rerenders a free endpoint move after calibration without locking it", () => {
        const calibrationWall = { ...wall, id: "calibration", x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.1 };
        const confirmedDimensions = confirmCalibration([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }], [calibrationWall], 16);
        const { begin, move, end, handles, commit } = setup([wall, calibrationWall], true, { confirmedDimensions });
        begin(1);
        move(0.7, 0.3);
        end(0.7, 0.3);
        expect(commit).toHaveBeenCalledOnce();
        expect(handles()[1]).toHaveAttribute("cx", "0.7");
        expect(handles()[1]).toHaveAttribute("cy", "0.3");
    });

    it("keeps endpoint dragging available after a numeric wall edit", () => {
        const { svg, begin, move, end, handles, commit } = setup();
        fireEvent.click(svg.querySelector('[data-dimension-wall="wall-a"] [role="button"]')!);
        const input = svg.querySelector('input[aria-label="Canvas wall length (m)"]')!;
        fireEvent.change(input, { target: { value: "7" } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(handles()[0]).toHaveAttribute("cx", "0.25");
        begin(0);
        move(0.2, 0.3);
        end(0.2, 0.3);
        expect(commit).toHaveBeenCalledOnce();
        expect(handles()[0]).toHaveAttribute("cx", "0.2");
        expect(handles()[0]).toHaveAttribute("cy", "0.3");
    });
    it("freely leaves an existing T-junction without a modifier or host movement", () => {
        const host = { ...wall, id: "host", x1: 0.6, y1: 0.1, x2: 0.6, y2: 0.8 };
        const { begin, move, end, handles, commit } = setup([wall, host]);
        begin(1);
        // Nudging along the wall's own axis keeps the stub on the host line, so
        // the off-axis component is dropped rather than turning it diagonal.
        move(0.604, 0.308);
        expect(handles()[1]).toHaveAttribute("cx", "0.604");
        expect(handles()[1]).toHaveAttribute("cy", "0.3");
        move(0.7, 0.5);
        end(0.7, 0.5);
        expect(commit).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.7, y2: 0.3 }, host]);
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
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.7, y2: 0.3 }, neighbor]);
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
        expect(marker()?.parentElement?.querySelector('circle[stroke="#2563eb"]')).toHaveAttribute("fill", "#fff");
        expect(svg.querySelector('[data-measurement-endpoint="end"]')).toBeNull();
        expect(svg.querySelectorAll('circle[stroke="#2563eb"]')).toHaveLength(2);
        expect(svg.querySelectorAll('[data-wall-endpoint]')).toHaveLength(2); // Hit areas remain available.
        expect(commit).not.toHaveBeenCalled();
        move(0.52, 0.4);
        expect(marker()).toBeNull();
        expect(svg.querySelector('[data-measurement-endpoint="end"]')).toBeNull();
        expect(svg.querySelectorAll('circle[stroke="#2563eb"]')).toHaveLength(2);
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
            expect(marker.parentElement?.querySelector('circle[stroke="#2563eb"]')).toHaveAttribute("fill", "#fff");
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
        fireEvent.click(svg, at(0.35, 0.5)); // Re-select the snapped wall itself.
        begin(1);
        // The snapped wall is genuinely diagonal now, so it follows the pointer
        // exactly. Dragging it clear of the host must not drag the host along.
        move(0.8, 0.3);
        end(0.8, 0.3);
        const updated = commit.mock.calls[1][0] as DetectedWallSegment[];
        expect(updated[0].x2).toBeCloseTo(0.8);
        expect(updated[0].y2).toBeCloseTo(0.3);
        expect(updated[1]).toEqual(host);
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
        // The off-axis part of the drag is dropped so the wall stays horizontal.
        expect(handles()[1]).toHaveAttribute("cy", "0.3");
        move(0.7, 0.5);
        expect(handles()[0]).toHaveAttribute("cx", "0.2");
        expect(handles()[0]).toHaveAttribute("cy", "0.3");
        expect(svg.textContent).not.toBe(initialLabel);
        end(0.7, 0.5);
        expect(commit).toHaveBeenCalledWith([{ ...wall, x2: 0.7, y2: 0.3 }, neighbor]);
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

    it("moves the start beyond the image without changing the end", () => {
        const { begin, move, end, commit } = setup();
        begin(0);
        move(-0.1, 1.1);
        end(-0.1, 1.1);
        // Free movement along the wall's own axis, even outside the image.
        expect(commit).toHaveBeenCalledWith([{ ...wall, x1: -0.1, y1: 0.3 }, neighbor]);
    });

    it("preserves endpoint identity and the latest opposite endpoint across consecutive reversed edits", () => {
        const { begin, move, end, commit, handles } = setup([wall]);
        begin(0);
        move(0.9, 0.3); // Start now lies to the right of the end.
        end(0.9, 0.3);
        begin(1);
        move(0.1, 0.1);
        expect(handles()[0]).toHaveAttribute("cx", "0.9");
        expect(handles()[0]).toHaveAttribute("cy", "0.3");
        end(0.1, 0.1);
        expect(commit).toHaveBeenLastCalledWith([{ ...wall, x1: 0.9, y1: 0.3, x2: 0.1, y2: 0.3 }]);
        begin(0);
        move(0.5, 0.6);
        end(0.5, 0.6);
        expect(commit).toHaveBeenLastCalledWith([{ ...wall, x1: 0.5, y1: 0.3, x2: 0.1, y2: 0.3 }]);
    });

    it("chooses the nearest physical endpoint when endpoint hit areas overlap", () => {
        const shortWall = { ...wall, x1: 0.395, x2: 0.405 };
        const { svg, at, handles, move, end, commit } = setup([shortWall]);
        // Even if the end's ellipse receives the event, the press is at the start.
        fireEvent.pointerDown(handles()[1], at(shortWall.x1, shortWall.y1));
        move(0.2, 0.6);
        end(0.2, 0.6);
        expect(commit).toHaveBeenCalledWith([{ ...shortWall, x1: 0.2, y1: 0.3 }]);
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

    // A door whose end sits exactly under the wall's end handle.
    const overlappingDoor: DetectedDoor = { id: "door-a", wallId: "wall-a", bbox: { x: 0.56, y: 0.2925, w: 0.04, h: 0.015 } };

    it("edits the selected wall when its endpoint handle overlaps a door", () => {
        const onDoorUpdate = vi.fn();
        const { svg, at, handles, move, end, commit } = setup([wall], true, { doors: [overlappingDoor], onDoorUpdate });
        expect(handles()).toHaveLength(2);
        fireEvent.pointerDown(handles()[1], at(0.6, 0.3)); // The handle sits on the door.
        move(0.9, 0.3);
        end(0.9, 0.3);
        expect(commit).toHaveBeenCalledExactlyOnceWith([{ ...wall, x2: 0.9, y2: 0.3 }]);
        expect(onDoorUpdate).not.toHaveBeenCalled();
        expect(svg.querySelector("[data-opening-handle]")).toBeNull(); // The door never took the selection.
    });

    it("still grabs an overlapping door outside the wall endpoint handle radius", () => {
        const onDoorUpdate = vi.fn();
        const { svg, at, move, end, commit } = setup([wall], true, { doors: [overlappingDoor], onDoorUpdate });
        fireEvent.pointerDown(svg, at(0.57, 0.3)); // 30 px inside the door, outside the 12 px handle.
        move(0.47, 0.3);
        end(0.47, 0.3);
        expect(commit).not.toHaveBeenCalled();
        expect(onDoorUpdate).toHaveBeenCalledOnce();
        const [id, field, span] = onDoorUpdate.mock.calls[0] as [string, string, { start: number; end: number }];
        expect([id, field]).toEqual(["door-a", "wallSpan"]);
        expect(span.start).toBeCloseTo(0.65, 5);
        expect(span.end).toBeCloseTo(0.75, 5);
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

        expect(view.getByLabelText("Opening width (m)")).toHaveValue(2);
        expect(view.getByLabelText("Opening height (m)")).toBeInTheDocument();
        expect(view.queryByText("Advanced Geometry")).toBeNull();
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

    it("previews a T-junction highlight on a wall interior and snaps the committed wall exactly onto its centerline", () => {
        const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1032);
        const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(532);
        try {
            const onWallAdd = vi.fn();
            const { container, getByText, getByAltText } = render(<WallReview rooms={[]} walls={[wall]} unit="m" imageUrl="plan.png"
                scale={1} onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()} onWallAdd={onWallAdd} />);
            const image = getByAltText("Floor plan");
            Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 500 } });
            fireEvent.load(image);
            fireEvent.click(getByText("Add Element"));
            fireEvent.click(getByText("Wall"));
            const overlay = container.querySelector("div.absolute.inset-0.z-20")!;
            vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: -100, top: 80, width: 1000, height: 500 } as DOMRect);
            const at = (x: number, y: number) => ({ clientX: -100 + x * 1000, clientY: 80 + y * 500 });
            const endpointMarker = () => container.querySelector("[data-wall-draw-snap-endpoint]");
            const junctionMarker = () => container.querySelector("[data-wall-draw-junction-highlight]");

            // Hover near the interior of wall (midpoint x=0.4, y=0.3), offset slightly in Y
            fireEvent.pointerMove(overlay, at(0.404, 0.312));
            expect(endpointMarker()).toBeNull();
            expect(junctionMarker()).not.toBeNull();
            // The outer/inner ring is rendered at the exact projection on wall's centerline (y=0.3)
            const outer = container.querySelector("[data-wall-draw-junction-outer]");
            expect(outer).toHaveAttribute("cy", "0.3");

            // Click start at this T-junction
            fireEvent.pointerDown(overlay, at(0.404, 0.312));

            // Drag down to free space (x=0.404, y=0.65)
            fireEvent.pointerMove(overlay, at(0.404, 0.65));
            expect(junctionMarker()).toBeNull();

            expect(container.querySelector('[data-wall-draw-connection="junction"]')).toHaveAttribute("cy", "0.3");
            // Click end to finish
            fireEvent.pointerDown(overlay, at(0.404, 0.65));
            expect(onWallAdd).toHaveBeenCalledOnce();
            const committed = onWallAdd.mock.calls[0][0];
            // Exactly on the host's centerline, no gap
            expect(committed.y1).toBe(0.3);
            expect(committed.x1).toBeCloseTo(0.404, 6);
            expect(committed.y2).toBe(0.65);
            expect(junctionMarker()).toBeNull();
        } finally { width.mockRestore(); height.mockRestore(); }
    });
});


describe("Review room selection and naming", () => {
    it("keeps one violet selection per room while the name alone renames inline", () => {
        const update = vi.fn();
        function Editor() {
            const [rooms, setRooms] = useState([0, 1].map(i => ({
                id: `room-${i}`, name: `Room ${i + 1}`, confidence: "high" as const,
                width: 0.3, height: 0.3, bbox: { x: 0.1 + i * 0.4, y: 0.2, w: 0.3, h: 0.3 },
            })));
            return <WallReview rooms={rooms} unit="m" imageUrl="plan.png" scale={1}
                onScaleChange={vi.fn()} onGenerate={vi.fn()} onRoomUpdate={(id, field, value) => {
                    update(id, field, value);
                    setRooms(previous => previous.map(room => room.id === id ? { ...room, [field]: value } : room));
                }} />;
        }
        const view = render(<Editor />);
        for (const id of ["room-0", "room-1"]) {
            const row = view.container.querySelector(`[data-plan-selection="room:${id}"]`)!;
            fireEvent.click(row);
            expect(row.querySelector(".rounded-sm")).toBeNull();
            expect(view.container.querySelector(`[data-room-geometry="${id}"] polygon`)).toHaveAttribute("fill", "rgba(139,92,246,0.10)");
            // Room area click only selects: no icon chrome and no inline field appear.
            expect(row.querySelector("svg")).toBeNull();
            expect(row.querySelector("button.cursor-pointer")).not.toBeNull();
            expect(view.queryByRole("textbox", { name: "Room name" })).toBeNull();
        }
        fireEvent.click(view.getByRole("button", { name: "Rename Room 2" }));
        const input = view.getByRole("textbox", { name: "Room name" });
        expect(input).toHaveFocus();
        fireEvent.change(input, { target: { value: "  Kitchen  " } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(update).toHaveBeenCalledExactlyOnceWith("room-1", "name", "Kitchen");
        expect(view.container.querySelector('[data-room-geometry="room-1"]')).toHaveTextContent("Kitchen");
        fireEvent.click(view.getByRole("button", { name: "Rename Kitchen" }));
        fireEvent.change(view.getByRole("textbox", { name: "Room name" }), { target: { value: "Discard" } });
        fireEvent.keyDown(view.getByRole("textbox", { name: "Room name" }), { key: "Escape" });
        expect(update).toHaveBeenCalledTimes(1);
        expect(view.getByRole("button", { name: "Rename Kitchen" })).toBeInTheDocument();
        fireEvent.click(view.getByRole("button", { name: "Rename Kitchen" }));
        fireEvent.change(view.getByRole("textbox", { name: "Room name" }), { target: { value: "  " } });
        fireEvent.blur(view.getByRole("textbox", { name: "Room name" }));
        expect(update).toHaveBeenCalledTimes(1);
        fireEvent.click(view.getByRole("button", { name: "Rename Kitchen" }));
        fireEvent.change(view.getByRole("textbox", { name: "Room name" }), { target: { value: "Balcony" } });
        fireEvent.blur(view.getByRole("textbox", { name: "Room name" }));
        expect(update).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenLastCalledWith("room-1", "name", "Balcony");
        expect(view.getByRole("button", { name: "Rename Balcony" })).toBeInTheDocument();
    });
});

describe("batch opening sizes", () => {
    const doorA = newOpeningRecord("door", "door-a", wall, { x: 0.25, y: 0.3 }, { x: 0.32, y: 0.3 }, 20, 10)!;
    const doorB = newOpeningRecord("door", "door-b", wall, { x: 0.45, y: 0.3 }, { x: 0.52, y: 0.3 }, 20, 10)!;
    const windowA = newOpeningRecord("window", "window-a", neighbor, { x: 0.65, y: 0.35 }, { x: 0.7, y: 0.4 }, 20, 10)!;
    const windowB = newOpeningRecord("window", "window-b", neighbor, { x: 0.72, y: 0.55 }, { x: 0.77, y: 0.6 }, 20, 10)!;

    const renderBatch = (handlers: Partial<ComponentProps<typeof WallReview>>) => render(
        <WallReview calibrationStatus="calibrated" rooms={[]} walls={[wall, neighbor]}
            doors={[doorA, doorB]} windows={[windowA, windowB]}
            unit="m" imageUrl="plan.png" scale={1} planWidth={20} planHeight={10}
            onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()} {...handlers} />,
    );
    const openBatchEditor = (view: ReturnType<typeof render>, category: "Doors" | "Windows") => {
        if (view.queryByRole("button", { name: new RegExp(`${category}\\s*2`) }) === null) {
            fireEvent.click(view.getByText("Other Elements"));
            fireEvent.click(view.getByRole("button", { name: new RegExp(`${category}\\s*2`) }));
        }
        fireEvent.click(view.getByText("Edit"));
    };
    const updatedFields = (mock: { mock: { calls: unknown[][] } }) =>
        mock.mock.calls.map(([id, field, value]) => [id, field, value]);

    it("applies one height to every door without touching width or the host wall", () => {
        const onDoorUpdate = vi.fn();
        const view = renderBatch({ onDoorUpdate });
        openBatchEditor(view, "Doors");
        expect(view.queryByLabelText("Sill Height")).toBeNull();
        expect(view.getByLabelText("Height")).toHaveValue(2.2);
        fireEvent.change(view.getByLabelText("Height"), { target: { value: "2.4" } });
        fireEvent.click(view.getByText("Apply"));

        expect(updatedFields(onDoorUpdate)).toEqual([
            ["door-a", "heightM", 2.4],
            ["door-b", "heightM", 2.4],
        ]);
        // The draft closes so a later single-door edit can still override the batch value.
        expect(view.queryByLabelText("Height")).toBeNull();
    });

    it("applies height and sill height to every window", () => {
        const onWindowUpdate = vi.fn();
        const view = renderBatch({ onWindowUpdate });
        openBatchEditor(view, "Windows");
        fireEvent.change(view.getByLabelText("Sill Height"), { target: { value: "0.6" } });
        fireEvent.change(view.getByLabelText("Height"), { target: { value: "1.5" } });
        fireEvent.click(view.getByText("Apply"));

        expect(updatedFields(onWindowUpdate)).toEqual([
            ["window-a", "sillHeightM", 0.6],
            ["window-a", "heightM", 1.5],
            ["window-b", "sillHeightM", 0.6],
            ["window-b", "heightM", 1.5],
        ]);
    });

    it("discards a cancelled draft and clamps a height the host wall cannot hold", () => {
        const onDoorUpdate = vi.fn();
        const view = renderBatch({ onDoorUpdate });
        openBatchEditor(view, "Doors");
        fireEvent.change(view.getByLabelText("Height"), { target: { value: "9" } });
        fireEvent.click(view.getByText("Cancel"));
        expect(onDoorUpdate).not.toHaveBeenCalled();

        openBatchEditor(view, "Doors");
        fireEvent.change(view.getByLabelText("Height"), { target: { value: "9" } });
        fireEvent.click(view.getByText("Apply"));
        // The wall is 2.8 m, so each door keeps the largest height that still fits.
        expect(updatedFields(onDoorUpdate)).toEqual([
            ["door-a", "heightM", 2.8],
            ["door-b", "heightM", 2.8],
        ]);
    });

    it("still allows a single door to override the batched height", () => {
        const onDoorUpdate = vi.fn();
        const view = renderBatch({ onDoorUpdate });
        openBatchEditor(view, "Doors");
        fireEvent.change(view.getByLabelText("Height"), { target: { value: "2.4" } });
        fireEvent.click(view.getByText("Apply"));
        onDoorUpdate.mockClear();

        fireEvent.click(view.getByText("Door 1"));
        fireEvent.change(view.getByLabelText("Opening height (m)"), { target: { value: "2.05" } });
        fireEvent.blur(view.getByLabelText("Opening height (m)"));
        expect(onDoorUpdate).toHaveBeenCalledExactlyOnceWith("door-a", "heightM", 2.05);
    });
});
