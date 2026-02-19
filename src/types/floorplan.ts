export interface Room {
  id: string;
  name: string;
  width: number;
  height: number;
  confidence: "high" | "low" | "manual";
}

export interface FloorPlanMeta {
  unit: string;
  scale: number;
}

export interface FloorPlanData {
  meta: FloorPlanMeta;
  rooms: Room[];
}
