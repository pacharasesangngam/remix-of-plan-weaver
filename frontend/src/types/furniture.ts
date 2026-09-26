export const FURNITURE_CATALOG = [
  { kind: "sofa", name: "โซฟา", width: 2.1, depth: 0.9, height: 0.85, color: "#79988a" },
  { kind: "bed", name: "เตียงนอน", width: 1.8, depth: 2, height: 0.55, color: "#d2b89b" },
  { kind: "table", name: "โต๊ะ", width: 1.4, depth: 0.8, height: 0.75, color: "#b58760" },
  { kind: "chair", name: "เก้าอี้", width: 0.5, depth: 0.5, height: 0.85, color: "#8197ab" },
  { kind: "cabinet", name: "ตู้เสื้อผ้า", width: 1.8, depth: 0.6, height: 2, color: "#bcaa93" },
] as const;
export type FurnitureKind = typeof FURNITURE_CATALOG[number]["kind"];
export interface FurnitureItem {
  id: string; kind: FurnitureKind; x: number; y: number;
  width: number; depth: number; height: number; rotation: number; color: string; roomId?: string;
}
export function furnitureHalfSize(item: FurnitureItem, planW: number, planH: number) {
  const angle = item.rotation * Math.PI / 180;
  return { x: (Math.abs(Math.cos(angle)) * item.width + Math.abs(Math.sin(angle)) * item.depth) / (2 * planW),
    y: (Math.abs(Math.sin(angle)) * item.width + Math.abs(Math.cos(angle)) * item.depth) / (2 * planH) };
}
export function fitFurniture(item: FurnitureItem, planW: number, planH: number): FurnitureItem {
  const half = furnitureHalfSize(item, planW, planH);
  return { ...item, x: Math.max(half.x, Math.min(1 - half.x, item.x)), y: Math.max(half.y, Math.min(1 - half.y, item.y)) };
}
