import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { EdgesGeometry, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three";
import WallMeshHighlight from "./WallMeshHighlight";
import { buildWallSolidGeometries, wallFrame } from "@/lib/wallSolidGeometry";
import type { DetectedWallSegment } from "@/types/detection";

const children = (element: ReactElement) => Children.toArray(element.props.children).filter(isValidElement) as ReactElement[];

describe("finished wall highlighting", () => {
  it("can retain the preview fill while omitting its outline for a selected wall", () => {
    const geometry = buildWallSolidGeometries([{
      wall: { id: "wall", type: "interior", x1: 0, y1: 0, x2: 1, y2: 0, thickness: .2, wallHeight: 3 },
      thickness: .2,
      solids: [{ tStart: 0, tEnd: 1, yStart: 0, yEnd: 3 }],
    }], 1, 1).get("wall")!;
    const hover = children(WallMeshHighlight({ geometry, color: "blue" }));
    const selected = children(WallMeshHighlight({ geometry, color: "blue", showOutline: false }));
    expect(hover).toHaveLength(2);
    expect(selected).toHaveLength(1);
    expect(selected[0].type).toBe("mesh");
    expect(children(selected[0])[0].props.object).toBe(geometry);
    geometry.dispose();
  });

  it("highlights only w4/w10 owned geometry, including the extension and excluding door openings", () => {
    // Coordinates and door bounds from the current 12-wall export; uncalibrated 20 x 20 plan.
    const walls: DetectedWallSegment[] = [
      { id: "w4", type: "interior", x1: 0.0777, y1: 0.7391, x2: 0.447, y2: 0.7391, thickness: 0.15, wallHeight: 2.8 },
      { id: "w10", type: "interior", x1: 0.447, y1: 0.2307, x2: 0.447, y2: 0.7391, thickness: 0.15, wallHeight: 2.8 },
    ];
    const openings = [[(0.2569839015151515 - 0.0777) * 20, (0.3477746212121212 - 0.0777) * 20],
      [(0.46875 - 0.2307) * 20, (0.5427083333333333 - 0.2307) * 20]];
    const inputs = walls.map((wall, i) => ({ wall, thickness: 0.15, solids: [
      { tStart: 0, tEnd: openings[i][0], yStart: 0, yEnd: 2.8 },
      { tStart: openings[i][0], tEnd: openings[i][1], yStart: 2.2, yEnd: 2.8 },
      { tStart: openings[i][1], tEnd: wallFrame(wall, 20, 20).length, yStart: 0, yEnd: 2.8 },
    ] }));
    const before = structuredClone(inputs);
    const geometries = buildWallSolidGeometries(inputs, 20, 20);
    for (const wall of walls) {
      const geometry = geometries.get(wall.id)!;
      const positions = Array.from(geometry.getAttribute("position").array);
      const [fill, outline] = children(WallMeshHighlight({ geometry, color: "blue" }));
      const [borrowed, materialElement] = children(fill);
      expect(borrowed.type).toBe("primitive");
      expect(borrowed.props.object).toBe(geometry);
      expect(borrowed.props.attach).toBe("geometry");
      expect(fill.props.position).toBeUndefined();
      expect(fill.props.scale).toBeUndefined();
      expect(fill.props.raycast()).toBeNull();
      expect(outline.props.raycast()).toBeNull();
      expect(materialElement.props.depthWrite).toBe(false);
      expect(materialElement.props.polygonOffset).toBe(true);

      const material = new MeshBasicMaterial();
      const mesh = new Mesh(borrowed.props.object, material);
      const frame = wallFrame(wall, 20, 20);
      mesh.position.set(frame.cx, 0, frame.cz);
      mesh.rotation.y = -Math.atan2(frame.uz, frame.ux);
      mesh.updateMatrixWorld(true);
      const hit = (x: number, z: number) => new Raycaster(new Vector3(x, 4, z), new Vector3(0, -1, 0)).intersectObject(mesh).length > 0;
      expect(hit(-1.02, 4.82)).toBe(wall.id === "w10"); // new exterior corner
      expect(hit(-1.10, 4.82)).toBe(wall.id === "w10"); // old w4 box incorrectly covered this
      expect(hit(-1.17, 4.82)).toBe(wall.id === "w4");
      const doorRay = wall.id === "w4"
        ? new Raycaster(new Vector3(-4, 1, 6), new Vector3(0, 0, -1))
        : new Raycaster(new Vector3(0, 1, 0), new Vector3(-1, 0, 0));
      expect(doorRay.intersectObject(mesh)).toEqual([]);

      // Both the hover outline and persistent selection outline follow the same finished boundaries.
      const selection = children(WallMeshHighlight({ geometry, color: "cyan", outlineOnly: true }));
      expect(selection).toHaveLength(1);
      for (const line of [outline, selection[0]]) {
        const edgeElement = children(line)[0];
        expect(edgeElement.type).toBe("edgesGeometry");
        expect(edgeElement.props.args[0]).toBe(geometry);
        expect(line.props.position).toBeUndefined();
        const edges = new EdgesGeometry(edgeElement.props.args[0]);
        edges.applyMatrix4(mesh.matrixWorld);
        edges.computeBoundingBox();
        expect(edges.boundingBox!.max.x).toBeCloseTo(wall.id === "w4" ? -1.135 : -0.985, 6);
        expect(edges.boundingBox!.max.z).toBeCloseTo(4.857, 6);
        edges.dispose();
      }
      expect(Array.from(geometry.getAttribute("position").array)).toEqual(positions);
      material.dispose();
    }
    expect(inputs).toEqual(before);
    geometries.forEach(g => g.dispose());
  });
});
