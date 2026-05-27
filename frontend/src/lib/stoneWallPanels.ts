import * as THREE from "three";

const STONE_COLORS = ["#5f6258", "#4f534c", "#6b6d62", "#474b45", "#737266"];

export interface StoneBlockSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  color: string;
}

export const createStoneBlockSpecs = (width: number, height: number): StoneBlockSpec[] => {
  const specs: StoneBlockSpec[] = [];
  const rowH = 0.34;
  const gap = 0.018;
  let y = 0;
  let row = 0;

  while (y < height - 0.04) {
    const h = Math.min(rowH + ((row % 3) - 1) * 0.05, height - y);
    let x = row % 2 === 0 ? 0 : -0.24;
    let col = 0;

    while (x < width - 0.04) {
      const rawW = 0.32 + (((row * 7 + col * 5) % 5) * 0.12);
      const blockX = Math.max(0, x);
      const blockW = Math.min(rawW, width - blockX);
      if (blockW > 0.12 && h > 0.12) {
        specs.push({
          x: blockX + blockW / 2 - width / 2,
          y: y + h / 2,
          w: Math.max(0.05, blockW - gap),
          h: Math.max(0.05, h - gap),
          depth: 0.028 + ((row + col) % 4) * 0.008,
          color: STONE_COLORS[(row * 3 + col) % STONE_COLORS.length],
        });
      }
      x += rawW;
      col += 1;
    }

    y += h;
    row += 1;
  }

  return specs;
};

export const createStoneMaterial = (color: string): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color,
    roughness: 0.92,
    metalness: 0.01,
  });
