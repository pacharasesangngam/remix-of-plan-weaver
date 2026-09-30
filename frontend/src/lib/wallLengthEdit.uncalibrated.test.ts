import { describe, expect, it } from "vitest";
import { proposeWallEndpoint, proposeWallLength, type GeometrySnapshot } from "./wallLengthEdit";
import type { DetectedWallSegment as Wall } from "@/types/detection";

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall =>
    ({ id, x1, y1, x2, y2, type: "interior", thickness: 0.15 });
const snap = (walls: Wall[]): GeometrySnapshot => ({ walls, doors: [], windows: [], rooms: [] });
/** Uncalibrated plans carry no metric scale. */
const UNCALIBRATED: readonly [number, number] = [0, 0];
const CALIBRATED: readonly [number, number] = [10, 10];
const drag = (source: GeometrySnapshot, id: string, x2: number, y2: number, scale: readonly [number, number] = UNCALIBRATED) =>
    proposeWallEndpoint(source, source.walls.map(w => w.id === id ? { ...w, x2, y2 } : w), scale[0], scale[1]);
const accepted = (result: ReturnType<typeof drag>) => {
    if (!result) throw new Error("proposeWallEndpoint returned null");
    if (result.ok !== true) throw new Error(result.reason);
    return result.geometry;
};

describe("uncalibrated endpoint dragging", () => {
    it("projects a 2D drag onto the wall axis with planW=0 and planH=0", () => {
        const source = snap([wall("solo", 0.1, 0.5, 0.5, 0.5)]);
        const result = accepted(drag(source, "solo", 0.75, 0.4));
        // The wall is horizontal, so D1 keeps it horizontal. Uncalibrated plans
        // edit normally; they just never produce a metric length.
        expect(result.walls[0].x2).toBe(0.75);
        expect(result.walls[0].y2).toBe(0.5);
    });

    it("creates an endpoint connection while uncalibrated", () => {
        const source = snap([wall("moving", 0.1, 0.5, 0.5, 0.5), wall("target", 0.75, 0.5, 0.9, 0.5)]);
        const result = accepted(drag(source, "moving", 0.75, 0.4));
        expect(result.walls[0].x2).toBe(result.walls[1].x1);
        expect(result.walls[0].y2).toBe(result.walls[1].y1);
    });

    it("creates a T-junction on a host interior while uncalibrated", () => {
        const source = snap([wall("stub", 0.5, 0.1, 0.5, 0.4), wall("host", 0.1, 0.6, 0.9, 0.6)]);
        const result = accepted(drag(source, "stub", 0.5, 0.6));
        expect(result.walls[0].x1).toBe(result.walls[0].x2);
        expect(result.walls[0].y2).toBeCloseTo(0.6, 8);
        // Landing on the host makes a junction, so the host itself does not move.
        expect(result.walls[1]).toEqual(source.walls[1]);
    });

    it("disconnects and repositions a T-junction endpoint while uncalibrated", () => {
        const source = snap([wall("stub", 0.5, 0.2, 0.5, 0.5), wall("host", 0.1, 0.5, 0.9, 0.5)]);
        const result = accepted(drag(source, "stub", 0.75, 0.4));
        // The stub leaves the host across its own vertical axis and the host is
        // left completely alone (D4).
        expect(result.walls[0].x2).toBe(0.5);
        expect(result.walls[0].y2).toBe(0.4);
        expect(result.walls[1]).toEqual(source.walls[1]);
    });

    it("refuses to slide a perpendicular stub along its host", () => {
        const source = snap([wall("stub", 0.5, 0.2, 0.5, 0.5), wall("host", 0.1, 0.5, 0.9, 0.5)]);
        // Walking a vertical stub sideways along a horizontal host is a diagonal,
        // so D1 refuses it instead of quietly doing nothing. The host is intact
        // and the caller gets a reason. The calibrated suite covers the
        // supported way to move a T node: shorten the host.
        expect(drag(source, "stub", 0.72, 0.5)?.ok).toBe(false);
    });

    it("keeps a shared junction where it is while uncalibrated", () => {
        const source = snap([wall("a", 0.1, 0.5, 0.5, 0.5), wall("b", 0.5, 0.5, 0.5, 0.9)]);
        const result = accepted(drag(source, "a", 0.75, 0.4));
        // The direct drag moves one endpoint; the wall it used to share a corner
        // with is not dragged along, so the two are simply no longer joined.
        expect(result.walls[0].x2).toBe(0.75);
        expect(result.walls[0].y2).toBe(0.5);
        expect(result.walls[1]).toEqual(source.walls[1]);
    });

    it("still blocks sweeping a dragged endpoint through an unrelated wall", () => {
        const source = snap([wall("mover", 0.1, 0.2, 0.3, 0.2), wall("obstacle", 0.5, 0.1, 0.5, 0.3)]);
        expect(drag(source, "mover", 0.55, 0.2)?.ok).toBe(false);
        expect(accepted(drag(source, "mover", 0.5, 0.2)).walls[0].x2).toBe(0.5);
    });

    it("produces the same topology uncalibrated as it does calibrated", () => {
        const source = snap([wall("a", 0.1, 0.5, 0.5, 0.5), wall("b", 0.5, 0.5, 0.5, 0.9)]);
        const uncalibrated = accepted(drag(source, "a", 0.75, 0.4, UNCALIBRATED));
        const calibrated = accepted(drag(source, "a", 0.75, 0.4, CALIBRATED));
        expect(uncalibrated.walls).toEqual(calibrated.walls);
    });

    it("never records a measurement from an uncalibrated drag", () => {
        const source = snap([wall("solo", 0.1, 0.5, 0.5, 0.5)]);
        expect(accepted(drag(source, "solo", 0.75, 0.4)).confirmedDimensions).toBeUndefined();
    });

    it("keeps a typed metric length rejected before calibration", () => {
        const source = snap([wall("solo", 0.1, 0.5, 0.5, 0.5)]);
        const result = proposeWallLength(source, { wallId: "solo", length: 4, anchor: "start" }, 0, 0);
        expect(result.ok).toBe(false);
    });
});
