import { expect, it } from "vitest";
import { rectangleRoom } from "./manualPlan";
import { furnitureClearances } from "./furnitureClearance";
import type { FurnitureItem } from "@/types/furniture";

const room = rectangleRoom({ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, "r", "Room", 10, 10, 2.8)!;
const item: FurnitureItem = { id: "f", kind: "table", width: 2, depth: 1, height: 0.8, x: 0.5, y: 0.5, rotation: 0, color: "#ffffff" };
it("measures from object edges to wall faces, not wall centre lines", () => {
  const gaps = furnitureClearances(item, room.walls, 10, 10);
  expect(gaps).toHaveLength(4);
  expect(gaps.find(g => g.direction === "ซ้าย")!.metres).toBeCloseTo(2.925);
  expect(gaps.find(g => g.direction === "บน")!.metres).toBeCloseTo(3.425);
});
it("updates after rotating or moving and does not invent a wall for an open side", () => {
  const rotated = furnitureClearances({ ...item, rotation: 90 }, room.walls, 10, 10);
  expect(rotated.find(g => g.direction === "ซ้าย")!.metres).toBeCloseTo(3.425);
  const moved = furnitureClearances({ ...item, x: 0.6 }, room.walls, 10, 10);
  expect(moved.find(g => g.direction === "ขวา")!.metres).toBeCloseTo(1.925);
  expect(furnitureClearances(item, [], 10, 10)).toEqual([]);
  expect(furnitureClearances(item, room.walls.slice(1), 10, 10).some(g => g.direction === "บน")).toBe(false);
});
it("supports angled walls and does not report negative free space", () => {
  const wall = { id: "diagonal", x1: 0.7, y1: 0.2, x2: 0.9, y2: 0.8, thickness: 0.2, type: "interior" as const };
  const gap = furnitureClearances(item, [wall], 10, 10).find(g => g.direction === "ขวา")!;
  expect(gap.metres).toBeCloseTo(2 - 0.1 * Math.sqrt(10) / 3);
  expect(furnitureClearances({ ...item, x: 0.89 }, room.walls, 10, 10).every(g => g.metres >= 0)).toBe(true);
});
