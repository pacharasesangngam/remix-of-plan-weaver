export type AppMode = "simple" | "pro";

export type DimensionUnit = "m" | "cm" | "mm" | "ft";

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface Room {
  id: string;
  name: string;
  width: number;   // normalized 0â€“1 (fraction of image width) â€” à¸„à¸¹à¸“ imgWidth Ã— scale â†’ à¹€à¸¡à¸•à¸£
  height: number;  // normalized 0â€“1 (fraction of image height)
  confidence: "high" | "low" | "manual";
  polygon?: NormalizedPoint[];
  wallPolygon?: NormalizedPoint[];
  center?: NormalizedPoint;
  bbox?: BBox;     // normalized bbox derived from polygon
  areaSqm?: number;
  // Pro mode fields
  material?: string;
  floorColor?: string;
  tileCode?: string;
  tileName?: string;
  finishCost?: number;
  wallHeight?: number;
}

export interface FloorPlanMeta {
  unit: string;
  scale: number;
}

export interface FloorPlanData {
  meta: FloorPlanMeta;
  rooms: Room[];
}

export const MATERIALS = [
  { id: "none",     label: "â€” à¹„à¸¡à¹ˆà¸£à¸°à¸šà¸¸ â€”",        costPerSqm: 0   },
  { id: "tile",     label: "à¸à¸£à¸°à¹€à¸šà¸·à¹‰à¸­à¸‡",           costPerSqm: 350 },
  { id: "wood",     label: "à¹„à¸¡à¹‰à¸¥à¸²à¸¡à¸´à¹€à¸™à¸•",          costPerSqm: 500 },
  { id: "vinyl",    label: "Vinyl / SPC",          costPerSqm: 280 },
  { id: "concrete", label: "à¸„à¸­à¸™à¸à¸£à¸µà¸•à¸‚à¸±à¸”à¸¡à¸±à¸™",       costPerSqm: 450 },
  { id: "carpet",   label: "à¸žà¸£à¸¡",                  costPerSqm: 200 },
];

export const UNITS: { value: DimensionUnit; label: string; toMeter: number }[] = [
  { value: "m",  label: "à¹€à¸¡à¸•à¸£ (m)",        toMeter: 1      },
  { value: "cm", label: "à¹€à¸‹à¸™à¸•à¸´à¹€à¸¡à¸•à¸£ (cm)", toMeter: 0.01   },
  { value: "mm", label: "à¸¡à¸´à¸¥à¸¥à¸´à¹€à¸¡à¸•à¸£ (mm)", toMeter: 0.001  },
  { value: "ft", label: "à¸Ÿà¸¸à¸• (ft)",        toMeter: 0.3048 },
];
