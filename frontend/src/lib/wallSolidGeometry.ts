import { BufferGeometry, Float32BufferAttribute } from "three";
import type { DetectedWallSegment } from "@/types/detection";

type Point = { x: number; z: number };
export interface WallSolid { tStart: number; tEnd: number; yStart: number; yEnd: number }
export interface WallSolidInput {
    wall: DetectedWallSegment;
    thickness: number;
    solids: WallSolid[];
}
export interface WallPrism { wallId: string; polygon: Point[]; yStart: number; yEnd: number }
const EPS = 1e-9;
const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
const area = (points: Point[]) => points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + p.x * q.z - p.z * q.x;
}, 0) / 2;
const usable = (points: Point[]) => points.length >= 3 && Math.abs(area(points)) > EPS * EPS;

function clip(polygon: Point[], a: Point, b: Point, inside: boolean): Point[] {
    const result: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i], q = polygon[(i + 1) % polygon.length];
        const dp = cross(a, b, p), dq = cross(a, b, q);
        const pin = inside ? dp >= 0 : dp <= 0, qin = inside ? dq >= 0 : dq <= 0;
        if (pin) result.push(p);
        if (pin !== qin) {
            const t = dp / (dp - dq);
            result.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
        }
    }
    return result;
}

// Convex subtraction partitions the difference into disjoint convex polygons.
function subtract(polygon: Point[], cutter: Point[]): Point[][] {
    if (Math.max(...polygon.map(p => p.x)) <= Math.min(...cutter.map(p => p.x)) ||
        Math.min(...polygon.map(p => p.x)) >= Math.max(...cutter.map(p => p.x)) ||
        Math.max(...polygon.map(p => p.z)) <= Math.min(...cutter.map(p => p.z)) ||
        Math.min(...polygon.map(p => p.z)) >= Math.max(...cutter.map(p => p.z))) return [polygon];
    const pieces: Point[][] = [];
    let remaining = polygon;
    for (let i = 0; i < cutter.length && usable(remaining); i++) {
        const a = cutter[i], b = cutter[(i + 1) % cutter.length];
        const outside = clip(remaining, a, b, false);
        if (usable(outside)) pieces.push(outside);
        remaining = clip(remaining, a, b, true);
    }
    return pieces;
}

interface CornerJoin {
    wallId: string;
    endpoint: Point;
    polygon: Point[];
    yStart: number;
    yEnd: number;
}

function lineIntersection(a: Point, directionA: Point, b: Point, directionB: Point): Point | null {
    const determinant = directionA.x * directionB.z - directionA.z * directionB.x;
    if (Math.abs(determinant) <= EPS) return null;
    const offsetX = b.x - a.x;
    const offsetZ = b.z - a.z;
    const t = (offsetX * directionB.z - offsetZ * directionB.x) / determinant;
    return { x: a.x + directionA.x * t, z: a.z + directionA.z * t };
}

function cornerJoinPolygon(a: Point, aDirection: Point, aThickness: number, bDirection: Point, bThickness: number): Point[] | null {
    const aLength = Math.hypot(aDirection.x, aDirection.z);
    const bLength = Math.hypot(bDirection.x, bDirection.z);
    if (aLength <= EPS || bLength <= EPS) return null;
    const au = { x: aDirection.x / aLength, z: aDirection.z / aLength };
    const bu = { x: bDirection.x / bLength, z: bDirection.z / bLength };
    const aNormal = { x: -au.z, z: au.x };
    const bNormal = { x: -bu.z, z: bu.x };
    const aSide = aThickness / 2;
    const bSide = bThickness / 2;
    const aLeft = { x: a.x + aNormal.x * aSide, z: a.z + aNormal.z * aSide };
    const aRight = { x: a.x - aNormal.x * aSide, z: a.z - aNormal.z * aSide };
    const bLeft = { x: a.x + bNormal.x * bSide, z: a.z + bNormal.z * bSide };
    const bRight = { x: a.x - bNormal.x * bSide, z: a.z - bNormal.z * bSide };
    const outerA = lineIntersection(aLeft, au, bRight, bu);
    const outerB = lineIntersection(aRight, au, bLeft, bu);
    if (!outerA || !outerB) return null;
    return [aLeft, outerA, bRight, aRight, outerB, bLeft];
}

export function wallFrame(wall: DetectedWallSegment, pw: number, ph: number) {
    const a = { x: wall.x1 * pw - pw / 2, z: wall.y1 * ph - ph / 2 };
    const b = { x: wall.x2 * pw - pw / 2, z: wall.y2 * ph - ph / 2 };
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const ux = (b.x - a.x) / (length || 1), uz = (b.z - a.z) / (length || 1);
    return { a, b, length, ux, uz, cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2 };
}

/** Derived mesh cells only: never snap, merge, split or mutate editor walls. */
export function buildWallPrisms(inputs: WallSolidInput[], pw: number, ph: number): WallPrism[] {
    const ordered = [...inputs].sort((a, b) => a.wall.id.localeCompare(b.wall.id));
    const prisms: WallPrism[] = [];
    const joins: CornerJoin[] = [];
    for (const input of ordered) {
        const { a, b, length, ux, uz } = wallFrame(input.wall, pw, ph);
        if (!Number.isFinite(length) || length <= EPS || !Number.isFinite(input.thickness) || input.thickness <= 0) continue;
        const offset = input.thickness / 2;
        const at = (t: number, side: number): Point => ({ x: a.x + ux * t - uz * offset * side, z: a.z + uz * t + ux * offset * side });
        for (const solid of input.solids) {
            if (![solid.tStart, solid.tEnd, solid.yStart, solid.yEnd].every(Number.isFinite) || solid.tEnd <= solid.tStart || solid.yEnd <= solid.yStart) continue;
            prisms.push({ wallId: input.wall.id, polygon: [at(solid.tStart, -1), at(solid.tEnd, -1), at(solid.tEnd, 1), at(solid.tStart, 1)], yStart: solid.yStart, yEnd: solid.yEnd });
        }
    }
    for (let i = 0; i < ordered.length; i += 1) for (let j = i + 1; j < ordered.length; j += 1) {
        const first = ordered[i], second = ordered[j];
        const firstFrame = wallFrame(first.wall, pw, ph), secondFrame = wallFrame(second.wall, pw, ph);
        const endpointPairs = [
            [firstFrame.a, secondFrame.a, firstFrame.b, secondFrame.b],
            [firstFrame.a, secondFrame.b, firstFrame.b, secondFrame.a],
            [firstFrame.b, secondFrame.a, firstFrame.a, secondFrame.b],
            [firstFrame.b, secondFrame.b, firstFrame.a, secondFrame.a],
        ];
        const shared = endpointPairs.find(([firstEndpoint, secondEndpoint]) =>
            Math.hypot(firstEndpoint.x - secondEndpoint.x, firstEndpoint.z - secondEndpoint.z) <= EPS);
        if (!shared) continue;
        const [endpoint, , firstOther, secondOther] = shared;
        const polygon = cornerJoinPolygon(endpoint, { x: firstOther.x - endpoint.x, z: firstOther.z - endpoint.z }, first.thickness, { x: secondOther.x - endpoint.x, z: secondOther.z - endpoint.z }, second.thickness);
        if (!polygon) continue;
        const yStart = 0;
        const yEnd = Math.min(first.wall.wallHeight ?? 2.8, second.wall.wallHeight ?? 2.8);
        joins.push({ wallId: first.wall.id, endpoint, polygon, yStart, yEnd });
    }
    prisms.push(...joins);
    // Slice at height/opening boundaries, then assign each occupied volume once.
    const heights = [...new Set(prisms.flatMap(p => [p.yStart, p.yEnd]))].sort((a, b) => a - b);
    const result: WallPrism[] = [];
    for (let i = 1; i < heights.length; i++) {
        const yStart = heights[i - 1], yEnd = heights[i];
        const occupied: Point[][] = [];
        for (const prism of prisms) {
            if (prism.yStart > yStart || prism.yEnd < yEnd) continue;
            let pieces = [prism.polygon];
            for (const polygon of occupied) pieces = pieces.flatMap(piece => subtract(piece, polygon));
            result.push(...pieces.map(polygon => ({ wallId: prism.wallId, polygon, yStart, yEnd })));
            occupied.push(prism.polygon);
        }
    }
    return result;
}

/** Mesh coordinates are local to the original wall center and direction. */
export function buildWallSolidGeometries(inputs: WallSolidInput[], pw: number, ph: number): Map<string, BufferGeometry> {
    const cells = buildWallPrisms(inputs, pw, ph);
    const result = new Map<string, BufferGeometry>();
    for (const { wall } of inputs) {
        const frame = wallFrame(wall, pw, ph);
        const positions: number[] = [], uvs: number[] = [];
        const vertex = (p: Point, y: number) => {
            const dx = p.x - frame.cx, dz = p.z - frame.cz;
            const x = dx * frame.ux + dz * frame.uz, z = -dx * frame.uz + dz * frame.ux;
            positions.push(x, y, z);
            uvs.push(x, y + z);
        };
        for (const cell of cells.filter(cell => cell.wallId === wall.id)) {
            const p = cell.polygon, lo = cell.yStart, hi = cell.yEnd;
            for (let i = 1; i < p.length - 1; i++) {
                vertex(p[0], lo); vertex(p[i], lo); vertex(p[i + 1], lo);
                vertex(p[0], hi); vertex(p[i + 1], hi); vertex(p[i], hi);
            }
            for (let i = 0; i < p.length; i++) {
                const a = p[i], b = p[(i + 1) % p.length];
                vertex(a, lo); vertex(a, hi); vertex(b, hi);
                vertex(a, lo); vertex(b, hi); vertex(b, lo);
            }
        }
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
        geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
        geometry.computeVertexNormals();
        result.set(wall.id, geometry);
    }
    return result;
}
