export interface ScgPaintOption {
  code: string;
  name: string;
  hex: string;
  finish: string;
}

export interface ScgTileOption {
  code: string;
  name: string;
  baseHex: string;
  groutHex: string;
  accentHex: string;
  sizeCm: string;
  pattern: "plain" | "marble" | "terrazzo" | "stone";
}

export interface ScgDoorOption {
  code: string;
  name: string;
  material: "WPC" | "HDF" | "UPVC" | "PVC" | "Melamine" | "Plywood" | "Fiberglass" | "Polystyrene";
  usage: "interior" | "exterior" | "bathroom" | "interior/exterior";
  sizeCm: string;
  doorHex: string;
  panelHex: string;
  frameHex: string;
  style: "flat" | "panel" | "groove" | "modern";
}

export const SCG_PAINT_CATALOG: ScgPaintOption[] = [
  { code: "SCG-WH-101", name: "Warm White", hex: "#f1eee5", finish: "matte" },
  { code: "SCG-GR-214", name: "Soft Greige", hex: "#d8d1c4", finish: "matte" },
  { code: "SCG-GN-332", name: "Sage Mist", hex: "#cbd7c8", finish: "eggshell" },
  { code: "SCG-BL-426", name: "Pale Blue", hex: "#cbd8e4", finish: "eggshell" },
  { code: "SCG-GY-518", name: "Urban Grey", hex: "#b9bec3", finish: "satin" },
  { code: "SCG-CL-702", name: "Clay Beige", hex: "#d6bfa4", finish: "matte" },
];

export const SCG_TILE_CATALOG: ScgTileOption[] = [
  {
    code: "SCG-TILE-6060-ASH",
    name: "Ash Stone 60x60",
    baseHex: "#b9b4aa",
    groutHex: "#8f8a82",
    accentHex: "#d7d2c8",
    sizeCm: "60x60",
    pattern: "stone",
  },
  {
    code: "SCG-TILE-6060-CAL",
    name: "Calacatta 60x60",
    baseHex: "#eee9df",
    groutHex: "#cfc8bb",
    accentHex: "#a9a29a",
    sizeCm: "60x60",
    pattern: "marble",
  },
  {
    code: "SCG-TILE-3030-TZ",
    name: "Terrazzo Light 30x30",
    baseHex: "#d8d6cf",
    groutHex: "#a9a59b",
    accentHex: "#6f8b92",
    sizeCm: "30x30",
    pattern: "terrazzo",
  },
  {
    code: "SCG-TILE-6090-SAND",
    name: "Sand Plain 60x90",
    baseHex: "#cdbfae",
    groutHex: "#9c8e7e",
    accentHex: "#e1d4c5",
    sizeCm: "60x90",
    pattern: "plain",
  },
];

export const SCG_DOOR_CATALOG: ScgDoorOption[] = [
  {
    code: "SCG-DOOR-WPC-RIGA-80200",
    name: "RIGA WPC Oak",
    material: "WPC",
    usage: "interior",
    sizeCm: "80x200",
    doorHex: "#b6783f",
    panelHex: "#d39a5c",
    frameHex: "#7c4a24",
    style: "groove",
  },
  {
    code: "SCG-DOOR-HDF-6MV1-80200",
    name: "HDF 6MV1 Primer",
    material: "HDF",
    usage: "interior",
    sizeCm: "80x200",
    doorHex: "#e8e3d8",
    panelHex: "#f4efe6",
    frameHex: "#b9aa98",
    style: "panel",
  },
  {
    code: "SCG-DOOR-UPVC-WHITE-70200",
    name: "UPVC White Bathroom",
    material: "UPVC",
    usage: "bathroom",
    sizeCm: "70x200",
    doorHex: "#f0f4f5",
    panelHex: "#ffffff",
    frameHex: "#c7d1d4",
    style: "flat",
  },
  {
    code: "SCG-DOOR-FG-TEAK-90200",
    name: "Fiberglass Teak",
    material: "Fiberglass",
    usage: "exterior",
    sizeCm: "90x200",
    doorHex: "#8f552d",
    panelHex: "#b8743c",
    frameHex: "#5f351d",
    style: "panel",
  },
  {
    code: "SCG-DOOR-MEL-WALNUT-80200",
    name: "Melamine Walnut",
    material: "Melamine",
    usage: "interior",
    sizeCm: "80x200",
    doorHex: "#6f432a",
    panelHex: "#8b5a3c",
    frameHex: "#4f2f1e",
    style: "modern",
  },
  {
    code: "SCG-DOOR-PS-BEECH-90200",
    name: "Polystyrene Beech",
    material: "Polystyrene",
    usage: "interior",
    sizeCm: "90x200",
    doorHex: "#c69258",
    panelHex: "#e0b37a",
    frameHex: "#8a5f36",
    style: "groove",
  },
];

export const findScgPaint = (code?: string) =>
  SCG_PAINT_CATALOG.find((item) => item.code === code) ?? SCG_PAINT_CATALOG[0];

export const findScgTile = (code?: string) =>
  SCG_TILE_CATALOG.find((item) => item.code === code) ?? SCG_TILE_CATALOG[0];

export const findScgDoor = (code?: string) =>
  SCG_DOOR_CATALOG.find((item) => item.code === code) ?? SCG_DOOR_CATALOG[0];
