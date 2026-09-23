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

function setup(initialWalls = [wall, neighbor]) {
    const commit = vi.fn();
    function Editor() {
        const [walls, setWalls] = useState(initialWalls);
        return <WallReview rooms={[]} walls={walls} unit="m" imageUrl="plan.png"
            scale={1} onScaleChange={vi.fn()} onRoomUpdate={vi.fn()} onGenerate={vi.fn()} onWallGeometryCommit={updated => {
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
        const { container, getByText } = render(<WallReview rooms={[]} walls={[wall]} unit="m" imageUrl="plan.png"
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
        const { container, getByText } = render(<WallReview rooms={[]} walls={[wall]} unit="m" imageUrl="plan.png"
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
        const { container, getByText } = render(<WallReview rooms={[]} walls={[wall, neighbor]} unit="m" imageUrl="plan.png"
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
        <WallReview
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
            <WallReview
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
            <WallReview rooms={[reviewRoom]} walls={[wall]} windows={[attachedWindow]} unit="m" imageUrl="plan.png"
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
            <WallReview
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
