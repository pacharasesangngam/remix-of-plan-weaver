export type AppMode = "simple" | "pro";

export type DimensionUnit = "m" | "cm" | "mm" | "ft";

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Room {
  id: string;
  name: string;
  width: number;   // normalized 0–1 (fraction of image width) — คูณ imgWidth × scale → เมตร
  height: number;  // normalized 0–1 (fraction of image height)
  confidence: "high" | "low" | "manual";
  bbox?: BBox;     // normalized bbox จาก polygon (เพิ่มเพื่อไม่ต้อง cast dirty ใน WallReview)
  // Pro mode fields
  material?: string;
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
  { id: "none",     label: "— ไม่ระบุ —",        costPerSqm: 0   },
  { id: "tile",     label: "กระเบื้อง",           costPerSqm: 350 },
  { id: "wood",     label: "ไม้ลามิเนต",          costPerSqm: 500 },
  { id: "vinyl",    label: "Vinyl / SPC",          costPerSqm: 280 },
  { id: "concrete", label: "คอนกรีตขัดมัน",       costPerSqm: 450 },
  { id: "carpet",   label: "พรม",                  costPerSqm: 200 },
];

export const UNITS: { value: DimensionUnit; label: string; toMeter: number }[] = [
  { value: "m",  label: "เมตร (m)",        toMeter: 1      },
  { value: "cm", label: "เซนติเมตร (cm)", toMeter: 0.01   },
  { value: "mm", label: "มิลลิเมตร (mm)", toMeter: 0.001  },
  { value: "ft", label: "ฟุต (ft)",        toMeter: 0.3048 },
];