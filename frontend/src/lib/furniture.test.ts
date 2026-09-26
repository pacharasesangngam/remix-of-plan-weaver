import { expect, it } from "vitest";
import { Box3, Vector3, Mesh } from "three";
import { FURNITURE_CATALOG, fitFurniture } from "@/types/furniture";
import { createFloorPlanProject, parseFloorPlanProject } from "./projectIO";
import { createFurnitureGroup } from "./furnitureGeometry";

it("creates an empty project without requiring furniture", () => {
  const project = createFloorPlanProject({ unit: "m", scale: 0, planWidth: 0, planHeight: 0, rooms: [], walls: [], doors: [], windows: [] });
  expect(project.furniture).toEqual([]);
});

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

it("builds detailed local models and keeps small and large custom sizes exact", () => {
  const detail = { sofa: "seat-cushion", bed: "pillow", table: "long-apron", chair: "back-post", cabinet: "handle" };
  for (const option of FURNITURE_CATALOG) {
    for (const size of [0.2, 20]) {
      const item = { ...option, id: option.kind, x: 0.5, y: 0.5, width: size, depth: size / 2, height: size / 3, rotation: 0 };
      const group = createFurnitureGroup(item, 100, 100);
      expect(group.getObjectByName(detail[option.kind])).toBeInstanceOf(Mesh);
      const bounds = new Box3().setFromObject(group);
      const dims = bounds.getSize(new Vector3());
      expect(dims.x).toBeCloseTo(item.width, 5);
      expect(dims.y).toBeCloseTo(item.height, 5);
      expect(dims.z).toBeCloseTo(item.depth, 5);
      expect(bounds.min.y).toBeCloseTo(0.03, 5);
      group.traverse(child => {
        if (child instanceof Mesh) {
          expect(Array.from(child.geometry.attributes.position.array).every(Number.isFinite)).toBe(true);
          child.geometry.dispose();
          (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => m.dispose());
        }
      });
    }
  }
});
