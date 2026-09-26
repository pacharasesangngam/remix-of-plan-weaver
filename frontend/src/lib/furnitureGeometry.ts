import * as THREE from "three";
import type { FurnitureItem } from "@/types/furniture";

export function createFurnitureGroup(item: FurnitureItem, planW: number, planH: number) {
  const group = new THREE.Group();
  group.name = item.kind;
  group.position.set((item.x - 0.5) * planW, 0.03, (item.y - 0.5) * planH);
  group.rotation.y = -item.rotation * Math.PI / 180;
  const { width: w, depth: d, height: h } = item;
  const box = (x: number, y: number, z: number, width: number, height: number, depth: number, color = item.color) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  };
  if (item.kind === "table") {
    box(0, h - 0.04, 0, w, 0.08, d);
    for (const x of [-1, 1]) for (const z of [-1, 1]) box(x * (w / 2 - 0.07), (h - 0.08) / 2, z * (d / 2 - 0.07), 0.07, h - 0.08, 0.07);
  } else if (item.kind === "bed") {
    box(0, h * 0.3, 0, w, h * 0.6, d); box(0, h * 0.75, 0, w * 0.97, h * 0.3, d * 0.97, "#eee8de");
    for (const side of [-1, 1]) box(side * w * 0.23, h * 0.95, -d * 0.32, w * 0.4, h * 0.1, d * 0.2, "#ffffff");
  } else if (item.kind === "sofa" || item.kind === "chair") {
    box(0, h * 0.25, 0, w, h * 0.5, d); box(0, h * 0.72, -d * 0.4, w, h * 0.56, d * 0.2);
  } else box(0, h / 2, 0, w, h, d);
  return group;
}
