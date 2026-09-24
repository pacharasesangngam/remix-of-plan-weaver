import type { DimensionUnit, Room } from "@/types/floorplan";
import type { DetectedDoor, DetectedWallSegment, DetectedWindow } from "@/types/detection";

export interface FloorPlanProject {
  app: "remix-of-plan-weaver";
  version: 1;
  meta: {
    editorMode?: "upload" | "draw";
    unit: DimensionUnit;
    scale: number;
    planWidth: number;
    planHeight: number;
  };
  image?: {
    dataUrl: string;
    cleanDataUrl?: string | null;
    fileType: string | null;
    name?: string;
  } | null;
  rooms: Room[];
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
}

export const createFloorPlanProject = ({
  editorMode,
  unit,
  scale,
  planWidth,
  planHeight,
  rooms,
  walls,
  doors,
  windows,
  image,
}: {
  editorMode?: "upload" | "draw";
  unit: DimensionUnit;
  scale: number;
  planWidth: number;
  planHeight: number;
  rooms: Room[];
  walls: DetectedWallSegment[];
  doors: DetectedDoor[];
  windows: DetectedWindow[];
  image?: FloorPlanProject["image"];
}): FloorPlanProject => ({
  app: "remix-of-plan-weaver",
  version: 1,
  meta: {
    ...(editorMode ? { editorMode } : {}),
    unit,
    scale,
    planWidth,
    planHeight,
  },
  image: image ?? null,
  rooms,
  walls,
  doors,
  windows,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isDimensionUnit = (value: unknown): value is DimensionUnit =>
  value === "m" || value === "cm" || value === "mm" || value === "ft";

export const parseFloorPlanProject = (value: unknown): FloorPlanProject => {
  if (!isObject(value)) throw new Error("Project file is not a JSON object.");

  const meta = isObject(value.meta) ? value.meta : {};
  const rooms = Array.isArray(value.rooms) ? value.rooms : null;
  const walls = Array.isArray(value.walls) ? value.walls : null;
  const doors = Array.isArray(value.doors) ? value.doors : null;
  const windows = Array.isArray(value.windows) ? value.windows : null;

  if (!rooms || !walls || !doors || !windows) {
    throw new Error("Project file must include rooms, walls, doors, and windows arrays.");
  }

  return {
    app: "remix-of-plan-weaver",
    version: 1,
    meta: {
      ...(meta.editorMode === "draw" || meta.editorMode === "upload" ? { editorMode: meta.editorMode } : {}),
      unit: isDimensionUnit(meta.unit) ? meta.unit : "m",
      scale: typeof meta.scale === "number" ? meta.scale : 0,
      planWidth: typeof meta.planWidth === "number" ? meta.planWidth : 0,
      planHeight: typeof meta.planHeight === "number" ? meta.planHeight : 0,
    },
    image: isObject(value.image) && typeof value.image.dataUrl === "string"
      ? {
          dataUrl: value.image.dataUrl,
          cleanDataUrl: typeof value.image.cleanDataUrl === "string" ? value.image.cleanDataUrl : null,
          fileType: typeof value.image.fileType === "string" ? value.image.fileType : null,
          name: typeof value.image.name === "string" ? value.image.name : undefined,
        }
      : null,
    rooms: rooms as Room[],
    walls: walls as DetectedWallSegment[],
    doors: doors as DetectedDoor[],
    windows: windows as DetectedWindow[],
  };
};

export const downloadProjectJson = (project: FloorPlanProject, filename = "floorplan-project.json"): void => {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
