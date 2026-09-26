import { expect, it } from "vitest";
import { Box3, Vector3 } from "three";
import { FURNITURE_CATALOG, fitFurniture } from "@/types/furniture";
import { createFloorPlanProject, parseFloorPlanProject } from "./projectIO";
import { createFurnitureGroup } from "./furnitureGeometry";

it("uses exact metre dimensions for every furniture mesh, including rotated models", () => {
  for (const option of FURNITURE_CATALOG) {
    const item = { ...option, id: option.kind, x: 0.5, y: 0.5, width: 2.4, depth: 1.2, height: 0.9, rotation: 0 };
    const bounds = new Box3().setFromObject(createFurnitureGroup(item, 100, 100)).getSize(new Vector3());
    expect(bounds.x).toBeCloseTo(2.4);
    expect(bounds.z).toBeCloseTo(1.2);
    expect(bounds.y).toBeCloseTo(0.9);
    const rotated = new Box3().setFromObject(createFurnitureGroup({ ...item, rotation: 90 }, 100, 100)).getSize(new Vector3());
    expect(rotated.x).toBeCloseTo(1.2);
    expect(rotated.z).toBeCloseTo(2.4);
  }
});

it("round trips furniture into the project and builds matching export geometry", () => {
  const item = { ...FURNITURE_CATALOG[0], id: "sofa", x: 0.2, y: 0.3, rotation: 90 };
  const project = createFloorPlanProject({ unit: "m", scale: 0.03, planWidth: 30, planHeight: 30, rooms: [], walls: [], doors: [], windows: [], furniture: [item] });
  expect(parseFloorPlanProject(JSON.parse(JSON.stringify(project))).furniture).toEqual([item]);
  const group = createFurnitureGroup(item, 30, 30);
  expect(group.position.x).toBeCloseTo(-9);
  expect(group.rotation.y).toBeCloseTo(-Math.PI / 2);
  expect(group.children.length).toBeGreaterThan(0);
  const bounded = fitFurniture({ ...item, x: 0, y: 0 }, 30, 30);
  expect(bounded.x).toBeCloseTo(item.depth / 60);
  expect(bounded.y).toBeCloseTo(item.width / 60);
});
