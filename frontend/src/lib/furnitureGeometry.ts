import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { FurnitureItem } from "@/types/furniture";

export function createFurnitureGroup(item: FurnitureItem, planW: number, planH: number) {
  const group = new THREE.Group();
  group.name = item.kind;
  group.position.set((item.x - 0.5) * planW, 0.03, (item.y - 0.5) * planH);
  group.rotation.y = -item.rotation * Math.PI / 180;
  const { width: w, depth: d, height: h } = item;
  const tint = (offset: number) => new THREE.Color(item.color).offsetHSL(0, 0, offset);
  const fabric = new THREE.MeshStandardMaterial({ color: item.color, roughness: 0.95 });
  const light = new THREE.MeshStandardMaterial({ color: tint(0.08), roughness: 0.95 });
  const dark = new THREE.MeshStandardMaterial({ color: tint(-0.12), roughness: 0.8 });
  const wood = new THREE.MeshStandardMaterial({ color: "#70513a", roughness: 0.65 });
  const linen = new THREE.MeshStandardMaterial({ color: "#f3eee4", roughness: 1 });
  const metal = new THREE.MeshStandardMaterial({ color: "#555b61", roughness: 0.3, metalness: 0.8 });
  // Build in fractions of the requested dimensions. Bevels are computed in metres.
  // Every part, including handles, stays inside the real-size bounding box.
  const box = (name: string, x: number, y: number, z: number, width: number, height: number, depth: number, material: THREE.Material = fabric, rounded = false) => {
    const dims: [number, number, number] = [width * w, height * h, depth * d];
    const geometry = rounded ? new RoundedBoxGeometry(...dims, 2, Math.min(...dims) * 0.18) : new THREE.BoxGeometry(...dims);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name; mesh.position.set(x * w, y * h, z * d);
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  };
  const legs = (top: number, insetX: number, insetZ: number, thickness = 0.055) => {
    for (const x of [-1, 1]) for (const z of [-1, 1]) box("leg", x * insetX, top / 2, z * insetZ, thickness, top, thickness, wood, true);
  };
  if (item.kind === "sofa") {
    legs(0.14, 0.4, 0.35);
    box("upholstered-base", 0, 0.27, 0, 1, 0.26, 1, dark, true);
    box("back-frame", 0, 0.7, -0.405, 1, 0.6, 0.19, fabric, true);
    for (const side of [-1, 1]) box("armrest", side * 0.445, 0.5, 0.035, 0.11, 0.4, 0.93, fabric, true);
    for (const side of [-1, 1]) {
      box("seat-cushion", side * 0.193, 0.455, 0.085, 0.37, 0.17, 0.76, light, true);
      box("back-cushion", side * 0.193, 0.75, -0.265, 0.37, 0.44, 0.15, light, true);
    }
    box("accent-pillow", -0.28, 0.67, -0.09, 0.16, 0.27, 0.16, linen, true);
  } else if (item.kind === "bed") {
    legs(0.12, 0.4, 0.38);
    box("bed-frame", 0, 0.23, 0, 1, 0.22, 1, dark, true);
    box("headboard", 0, 0.61, -0.455, 1, 0.78, 0.09, fabric, true);
    box("headboard-panel", 0, 0.75, -0.398, 0.9, 0.38, 0.024, light, true);
    box("mattress", 0, 0.46, 0.035, 0.95, 0.24, 0.89, linen, true);
    box("duvet", 0, 0.6, 0.18, 0.96, 0.08, 0.6, light, true);
    box("folded-throw", 0, 0.652, 0.35, 0.97, 0.024, 0.15, dark, true);
    for (const side of [-1, 1]) box("pillow", side * 0.235, 0.63, -0.28, 0.4, 0.1, 0.22, linen, true);
  } else if (item.kind === "table") {
    legs(0.89, 0.41, 0.39, 0.065);
    box("table-top", 0, 0.945, 0, 1, 0.11, 1, fabric, true);
    for (const side of [-1, 1]) {
      box("long-apron", 0, 0.825, side * 0.39, 0.85, 0.13, 0.035, dark);
      box("short-apron", side * 0.41, 0.825, 0, 0.035, 0.13, 0.8, dark);
    }
  } else if (item.kind === "chair") {
    legs(0.43, 0.38, 0.36, 0.085);
    box("seat-frame", 0, 0.46, 0, 1, 0.06, 1, wood, true);
    box("seat-cushion", 0, 0.53, 0.03, 0.94, 0.08, 0.9, fabric, true);
    for (const side of [-1, 1]) box("back-post", side * 0.38, 0.7, -0.4, 0.075, 0.6, 0.08, wood, true);
    box("backrest", 0, 0.845, -0.405, 1, 0.31, 0.19, fabric, true);
  } else {
    box("plinth", 0, 0.04, 0, 0.9, 0.08, 0.86, dark);
    box("cabinet-body", 0, 0.54, -0.025, 1, 0.92, 0.95, dark);
    for (const side of [-1, 1]) {
      box("door-panel", side * 0.248, 0.54, 0.448, 0.486, 0.895, 0.035, fabric, true);
      box("door-inset", side * 0.248, 0.54, 0.469, 0.412, 0.81, 0.007, light);
      box("handle", side * 0.042, 0.55, 0.488, 0.012, 0.11, 0.024, metal, true);
    }
  }
  const used = new Set(group.children.map(child => (child as THREE.Mesh).material));
  for (const material of [fabric, light, dark, wood, linen, metal]) if (!used.has(material)) material.dispose();
  return group;
}
