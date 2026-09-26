import type { FurnitureItem } from "@/types/furniture";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { createFurnitureGroup } from "@/lib/furnitureGeometry";

export function FurnitureSymbol({ item, planW, planH }: { item: FurnitureItem; planW: number; planH: number }) {
  const w = item.width / planW * 1000, d = item.depth / planH * 1000;
  return <g>
    <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={Math.min(w, d) * 0.05} fill={item.color} stroke="#475569" strokeWidth={1} />
    {item.kind === "bed" && <><rect x={-w * 0.43} y={-d * 0.43} width={w * 0.38} height={d * 0.2} rx={2} fill="#fffaf0" /><rect x={w * 0.05} y={-d * 0.43} width={w * 0.38} height={d * 0.2} rx={2} fill="#fffaf0" /><path d={`M ${-w / 2} ${-d * 0.12} H ${w / 2}`} stroke="#fffaf0" strokeWidth={2} /></>}
    {(item.kind === "sofa" || item.kind === "chair") && <rect x={-w * 0.4} y={-d * 0.35} width={w * 0.8} height={d * 0.2} rx={1} fill="#ffffff77" />}
    {item.kind === "cabinet" && <path d={`M 0 ${-d / 2} V ${d / 2}`} stroke="#475569" />}
  </g>;
}

export function FurnitureMeshes({ items, planW, planH }: { items: FurnitureItem[]; planW: number; planH: number }) {
  return <group name="Furniture">{items.map(item => <FurnitureMesh key={item.id} item={item} planW={planW} planH={planH} />)}</group>;
}

function FurnitureMesh({ item, planW, planH }: { item: FurnitureItem; planW: number; planH: number }) {
  const object = useMemo(() => createFurnitureGroup(item, planW, planH), [item, planW, planH]);
  useEffect(() => () => object.traverse(node => {
    if (node instanceof THREE.Mesh) {
      node.geometry.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(material => material.dispose());
    }
  }), [object]);
  return <primitive object={object} />;
}
