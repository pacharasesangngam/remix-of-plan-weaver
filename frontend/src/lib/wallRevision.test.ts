import { describe, expect, it } from "vitest";
import type { DetectedWallSegment as Wall } from "@/types/detection";
import { buildRevision, buildWallGraph, chainFor, junctionKey, resolveWallGraph } from "./wallTopology";
import { proposeWallEndpoint, proposeWallLength, chooseLengthAnchor, type GeometrySnapshot, type Anchor } from "./wallLengthEdit";

/** Metric fixture: coordinates are metres divided by 20, so planW = planH = 20. */
const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall =>
  ({ id, x1: x1 / 20, y1: y1 / 20, x2: x2 / 20, y2: y2 / 20, type: "interior", thickness: 0.15, wallHeight: 2.8 });

/** One 13.2 x 6 outer rectangle split at 5.5 m into two rooms, like the boundary fixtures. */
const divided = (): GeometrySnapshot => ({ walls: [
  wall("top", 0, 0, 13.2, 0), wall("right", 13.2, 0, 13.2, 6), wall("bottom", 0, 6, 13.2, 6),
  wall("left", 0, 0, 0, 6), wall("divider", 5.5, 0, 5.5, 6)], rooms: [], doors: [], windows: [] });

const accepted = (result: ReturnType<typeof proposeWallLength>) => {
  if (result.ok === false) throw new Error(result.reason);
  return result.geometry;
};
const byId = (walls: Wall[], id: string) => walls.find(w => w.id === id)!;
const metres = (value: number) => value * 20;
/** Compare plans independently of wall order, so an order-dependent edit becomes visible. */
const canonical = (walls: Wall[]) => [...walls].sort((a, b) => a.id.localeCompare(b.id))
  .map(w => `${w.id}:${w.x1.toFixed(9)},${w.y1.toFixed(9)},${w.x2.toFixed(9)},${w.y2.toFixed(9)}`).join("|");

describe("four intents stay distinct", () => {
  it("moves exactly one endpoint and lets the shared junction disconnect", () => {
    const source = divided();
    const dragged = source.walls.map(w => w.id === "top" ? { ...w, x2: 12 / 20, y2: 0 } : w);
    const candidate = proposeWallEndpoint(source, dragged, 20, 20, { exact: true });
    if (!candidate || candidate.ok === false) throw new Error("endpoint drag was refused");
    const { walls } = candidate.geometry;
    // The wall the user grabbed is the only one that changed.
    expect(byId(walls, "right")).toBe(source.walls[1]);
    expect(byId(walls, "bottom")).toBe(source.walls[2]);
    expect(byId(walls, "left")).toBe(source.walls[3]);
    expect(byId(walls, "divider")).toBe(source.walls[4]);
    expect(metres(byId(walls, "top").x2)).toBeCloseTo(12, 9);
    // Rigidly moving both endpoints is the *other* intent, never this one.
    const body = source.walls.map(w => w.id === "top" ? { ...w, x1: w.x1 + 0.5, x2: w.x2 + 0.5 } : w);
    expect(proposeWallEndpoint(source, body, 20, 20, { exact: true })).toBeNull();
  });

  it("reshapes connected geometry for a whole-wall length", () => {
    const source = divided();
    const anchor = chooseLengthAnchor(source, "top", 14, 20, 20);
    const { walls } = accepted(proposeWallLength(source, { wallId: "top", length: 14, anchor }, 20, 20));
    expect(metres(byId(walls, "top").x2)).toBeCloseTo(14, 9);
    expect(metres(byId(walls, "top").x1)).toBeCloseTo(0, 9);
    // Right is perpendicular, so it follows by translation and keeps its length and axis.
    expect(metres(byId(walls, "right").x1)).toBeCloseTo(14, 9);
    expect(metres(byId(walls, "right").x2)).toBeCloseTo(14, 9);
    expect(metres(byId(walls, "right").y2) - metres(byId(walls, "right").y1)).toBeCloseTo(6, 9);
    // Bottom is axis-parallel: it keeps its far end and resizes to the moved junction.
    expect(metres(byId(walls, "bottom").x2)).toBeCloseTo(14, 9);
    expect(metres(byId(walls, "bottom").x1)).toBeCloseTo(0, 9);
    // A T-stub in the interior of the edited wall is not dragged by it.
    expect(byId(walls, "divider")).toBe(source.walls[4]);
    expect(byId(walls, "left")).toBe(source.walls[3]);
  });

  it("reshapes the shared topology for a segment length", () => {
    const source = divided();
    const span = { start: { x: 0, y: 0 }, end: { x: 5.5 / 20, y: 0 } };
    const anchor: Anchor = chooseLengthAnchor(source, "top", 5.7, 20, 20, { span, confirm: true });
    const { walls } = accepted(proposeWallLength(source, { wallId: "top", length: 5.7, anchor, span, confirm: true }, 20, 20));
    // The divider is the shared junction: it moves, and the outer wall keeps its far end.
    expect(metres(byId(walls, "divider").x1)).toBeCloseTo(5.7, 9);
    expect(metres(byId(walls, "divider").x2)).toBeCloseTo(5.7, 9);
    expect(byId(walls, "top")).toBe(source.walls[0]);
  });
});

describe("geometry resolution does not depend on wall order", () => {
  it("produces one result for a numeric edit whatever order the walls are stored in", () => {
    const source = divided();
    const reversed: GeometrySnapshot = { ...source, walls: [...source.walls].reverse() };
    const anchor = chooseLengthAnchor(source, "top", 14, 20, 20);
    const forward = accepted(proposeWallLength(source, { wallId: "top", length: 14, anchor }, 20, 20));
    const backward = accepted(proposeWallLength(reversed, { wallId: "top", length: 14, anchor }, 20, 20));
    expect(canonical(backward.walls)).toBe(canonical(forward.walls));
  });

  it("produces one result for a refusal whatever order the walls are stored in", () => {
    const source = divided();
    const reversed: GeometrySnapshot = { ...source, walls: [...source.walls].reverse() };
    const anchor = chooseLengthAnchor(source, "top", 14, 20, 20);
    const forward = proposeWallLength(source, { wallId: "top", length: 14, anchor, confirm: true }, 20, 20);
    const backward = proposeWallLength(reversed, { wallId: "top", length: 14, anchor, confirm: true }, 20, 20);
    expect(forward.ok).toBe(backward.ok);
  });
});

describe("a junction owns one position", () => {
  const coincident = (walls: Wall[], a: { id: string; end: "start" | "end" }, b: { id: string; end: "start" | "end" }) => {
    const pick = (ref: { id: string; end: "start" | "end" }) => {
      const wall = byId(walls, ref.id);
      return ref.end === "start" ? { x: wall.x1, y: wall.y1 } : { x: wall.x2, y: wall.y2 };
    };
    const p = pick(a), q = pick(b);
    // Bitwise equal, not merely close: a tolerance here is what lets a junction vanish.
    expect(Object.is(p.x, q.x)).toBe(true);
    expect(Object.is(p.y, q.y)).toBe(true);
  };

  /** A T-stub ends strictly inside its host, so this one is a containment check, not equality. */
  const sitsOn = (stub: Wall, end: "start" | "end", host: Wall) => {
    const p = end === "start" ? { x: stub.x1, y: stub.y1 } : { x: stub.x2, y: stub.y2 };
    const dx = host.x2 - host.x1, dy = host.y2 - host.y1, len = Math.hypot(dx, dy);
    const off = Math.abs(dx * (p.y - host.y1) - dy * (p.x - host.x1)) / len;
    const t = ((p.x - host.x1) * dx + (p.y - host.y1) * dy) / (len * len);
    expect(off).toBeLessThan(1e-12);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
  };

  it("keeps the endpoints of one junction identical after a numeric reshape", () => {
    const source = divided();
    const anchor = chooseLengthAnchor(source, "top", 14, 20, 20);
    const { walls } = accepted(proposeWallLength(source, { wallId: "top", length: 14, anchor }, 20, 20));
    coincident(walls, { id: "top", end: "end" }, { id: "right", end: "start" });
    coincident(walls, { id: "right", end: "end" }, { id: "bottom", end: "end" });
    coincident(walls, { id: "top", end: "start" }, { id: "left", end: "start" });
    sitsOn(byId(walls, "divider"), "end", byId(walls, "bottom"));
  });

  it("keeps the endpoints of one junction identical after a segment reshape", () => {
    const source = divided();
    const span = { start: { x: 0, y: 0 }, end: { x: 5.5 / 20, y: 0 } };
    const anchor: Anchor = chooseLengthAnchor(source, "top", 5.7, 20, 20, { span, confirm: true });
    const { walls } = accepted(proposeWallLength(source, { wallId: "top", length: 5.7, anchor, span, confirm: true }, 20, 20));
    coincident(walls, { id: "top", end: "start" }, { id: "left", end: "start" });
    coincident(walls, { id: "top", end: "end" }, { id: "right", end: "start" });
    // The reshaped junction is an interior node of the host, so it must land exactly on it.
    sitsOn(byId(walls, "divider"), "start", byId(walls, "top"));
    sitsOn(byId(walls, "divider"), "end", byId(walls, "bottom"));
    expect(byId(walls, "divider").x1).toBe(byId(walls, "divider").x2);
  });
});


describe("topology identity survives a rebuild", () => {
  it("names a junction by the endpoints that meet there, not by an array index", () => {
    const graph = buildWallGraph(divided().walls);
    // (13.2, 0) is top's end and right's start.
    const corner = graph.junctionNodes.get("right:start|top:end");
    expect(corner).toBeTypeOf("number");
    expect(junctionKey(graph.topology.nodes[corner!])).toBe("right:start|top:end");
    // A reorder rebuilds different indices but the same identity.
    const reordered = buildWallGraph([...divided().walls].reverse());
    expect(reordered.junctionNodes.get("right:start|top:end")).toBeTypeOf("number");
    expect([...reordered.junctionIds.values()].sort()).toEqual([...graph.junctionIds.values()].sort());
  });

  it("keys a segment by its wall and its two junctions, and resolves it back", () => {
    const graph = buildWallGraph(divided().walls);
    const chain = chainFor(graph.segmentation, "top");
    // Two endpoints plus the divider T make three cuts, so two logical segments.
    expect(chain).toHaveLength(2);
    expect(chain.map(segment => segment.index)).toEqual([0, 1]);
    for (const segment of chain) {
      const key = segment.key;
      expect(graph.segmentation.byKey.get(key)).toBe(segment);
      // Reordering the stored walls yields the same segment ids.
      const other = buildWallGraph([...divided().walls].reverse()).segmentation.byKey.get(key);
      expect(other).toBeDefined();
      expect(other!.wallId).toBe(segment.wallId);
      expect(other!.x1).toBe(segment.x1);
      expect(other!.y1).toBe(segment.y1);
      expect(other!.x2).toBe(segment.x2);
      expect(other!.y2).toBe(segment.y2);
    }
  });

  it("builds one revision with the rooms the walls enclose", () => {
    const revision = buildRevision(divided().walls);
    expect(revision.rooms).toHaveLength(2);
    expect(revision.rooms.map(room => Math.round(room.width * 20 * 100) / 100).sort()).toContain(5.5);
  });

  it("trusts a graph only for the wall array it was built from", () => {
    const walls = divided().walls;
    const graph = buildWallGraph(walls);
    expect(resolveWallGraph(walls, graph)).toBe(graph);
    const rebuilt = resolveWallGraph([...walls].reverse(), graph);
    expect(rebuilt).not.toBe(graph);
    expect(resolveWallGraph([...walls].reverse(), undefined).walls).toHaveLength(5);
  });
});
