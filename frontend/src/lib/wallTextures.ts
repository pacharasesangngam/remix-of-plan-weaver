import * as THREE from "three";
import type { WallTextureId } from "@/types/materialCatalog";

const hexToRgb = (hex: string): [number, number, number] => {
  const value = hex.replace("#", "");
  const n = parseInt(value.length === 3 ? value.split("").map((c) => c + c).join("") : value, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgb = ([r, g, b]: [number, number, number], offset = 0, alpha = 1): string =>
  `rgba(${Math.max(0, Math.min(255, r + offset))}, ${Math.max(0, Math.min(255, g + offset))}, ${Math.max(0, Math.min(255, b + offset))}, ${alpha})`;

export const createWallTexture = (
  textureId: WallTextureId | undefined,
  baseHex: string,
): THREE.CanvasTexture | null => {
  if (!textureId || textureId === "painted" || textureId === "stone-block-panel") return null;

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const base = hexToRgb(baseHex);
  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (textureId === "plaster") {
    for (let i = 0; i < 1800; i += 1) {
      const x = (i * 73) % 512;
      const y = (i * 151) % 512;
      ctx.fillStyle = rgb(base, (i % 17) - 8, 0.12);
      ctx.fillRect(x, y, 1 + (i % 3), 1 + (i % 2));
    }
  }

  if (textureId === "concrete") {
    for (let i = 0; i < 90; i += 1) {
      ctx.fillStyle = rgb(base, i % 2 === 0 ? -18 : 16, 0.08);
      ctx.fillRect((i * 47) % 512, (i * 89) % 512, 120 + (i % 70), 18 + (i % 42));
    }
    ctx.strokeStyle = rgb(base, -30, 0.28);
    ctx.lineWidth = 2;
    for (let i = 0; i < 7; i += 1) {
      ctx.beginPath();
      ctx.moveTo((i * 81) % 512, 0);
      ctx.bezierCurveTo(50 + i * 20, 150, 420 - i * 11, 250, (i * 97) % 512, 512);
      ctx.stroke();
    }
  }

  if (textureId === "brick") {
    const brickH = 56;
    const brickW = 132;
    ctx.strokeStyle = rgb(base, -38, 0.5);
    ctx.lineWidth = 5;
    for (let y = 0; y <= 512; y += brickH) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(512, y);
      ctx.stroke();
      const offset = (Math.floor(y / brickH) % 2) * (brickW / 2);
      for (let x = -offset; x <= 512; x += brickW) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + brickH);
        ctx.stroke();
      }
    }
    ctx.fillStyle = rgb(base, 18, 0.08);
    for (let i = 0; i < 100; i += 1) {
      ctx.fillRect((i * 61) % 512, (i * 97) % 512, 44, 10);
    }
  }

  if (textureId === "vertical-panel") {
    for (let x = 0; x <= 512; x += 64) {
      ctx.fillStyle = rgb(base, x % 128 === 0 ? 10 : -8, 0.18);
      ctx.fillRect(x, 0, 64, 512);
      ctx.strokeStyle = rgb(base, -42, 0.55);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 512);
      ctx.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.8, 1.2);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};
