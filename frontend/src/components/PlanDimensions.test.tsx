import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import PlanDimensions from "./PlanDimensions";
import { emptyProject } from "@/lib/projectHistory";
import { rectangleRoom } from "@/lib/manualPlan";

afterEach(cleanup);
it("does not project the middle room recess onto the outside vertical chains", () => {
  const a = rectangleRoom({ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.4 }, "a", "A", 30, 30, 2.8)!;
  const b = rectangleRoom({ x: 0.3, y: 0.1 }, { x: 0.5, y: 0.3 }, "b", "B", 30, 30, 2.8)!;
  const c = rectangleRoom({ x: 0.5, y: 0.1 }, { x: 0.7, y: 0.4 }, "c", "C", 30, 30, 2.8)!;
  render(<svg><PlanDimensions uiScale={1} project={{ ...emptyProject(), planW: 30, planH: 30, rooms: [a.room, b.room, c.room], walls: [...a.walls, ...b.walls, ...c.walls] }} /></svg>);
  expect(screen.getAllByLabelText(/ระยะแนวนอนด้านล่าง/)).toHaveLength(3);
  expect(screen.getAllByLabelText(/ระยะแนวตั้งด้านขวา/)).toHaveLength(1);
  expect(screen.getAllByLabelText(/ระยะแนวตั้งด้านซ้าย/)).toHaveLength(1);
  expect(screen.getByLabelText("ความกว้างรวม 18.00 เมตร")).toBeInTheDocument();
});
it("puts the chain outside every room and the total beyond that chain", () => {
  const a = rectangleRoom({ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.4 }, "a", "A", 30, 30, 2.8)!;
  const b = rectangleRoom({ x: 0.4, y: 0.2 }, { x: 0.6, y: 0.35 }, "b", "B", 30, 30, 2.8)!;
  render(<svg><PlanDimensions uiScale={1} project={{ ...emptyProject(), planW: 30, planH: 30, rooms: [a.room, b.room], walls: [...a.walls, ...b.walls] }} /></svg>);
  const bottom = screen.getAllByLabelText(/ระยะแนวนอนด้านล่าง/);
  expect(bottom).toHaveLength(2); // room A and room B; leave the empty gap unlabelled
  expect(screen.queryByLabelText("ระยะแนวนอนด้านล่าง 3.00 เมตร")).not.toBeInTheDocument();
  const lines = bottom.map(g => g.querySelector("line")!);
  lines.forEach(line => expect(Number(line.getAttribute("y1"))).toBe(428));
  const total = screen.getByLabelText("ความกว้างรวม 15.00 เมตร").querySelector("line")!;
  expect(Number(total.getAttribute("y1"))).toBeGreaterThan(428);
  expect(screen.queryByLabelText(/ความกว้างกรอบ/)).not.toBeInTheDocument();
});
