import { parseConfirmedDimensions, type ConfirmedDimension } from "./confirmedDimensions";
import type { DimensionUnit, Room } from "@/types/floorplan";
import { FURNITURE_CATALOG, type FurnitureItem } from "@/types/furniture";
import type { DetectedDoor, DetectedWallSegment, DetectedWindow } from "@/types/detection";

import { hasCalibration, type CalibrationStatus } from "./wallMetrics";

export const savedCalibrationStatus = (meta: { calibrationStatus?: unknown; editorMode?: unknown; scale: number; planWidth: number; planHeight: number }): CalibrationStatus => {
  // Legacy manual drawings have a metric canvas. Uploaded legacy plans need
  // recalibration because positive dimensions alone do not establish provenance.
  const status = meta.calibrationStatus ?? (meta.editorMode === "draw" ? "calibrated" : "uncalibrated");
  return hasCalibration(status, meta.scale, meta.planWidth, meta.planHeight) ? "calibrated" : "uncalibrated";
};

export interface FloorPlanProject {
  furniture?: FurnitureItem[];
  app: "remix-of-plan-weaver";
  version: 1;
  meta: {
    confirmedDimensions?: ConfirmedDimension[];
    calibrationStatus?: CalibrationStatus;
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
  confirmedDimensions,
  calibrationStatus,
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
  confirmedDimensions?: ConfirmedDimension[];
  calibrationStatus?: CalibrationStatus;
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
  furniture,
  app: "remix-of-plan-weaver",
  version: 1,
  meta: {
    ...(confirmedDimensions?.length ? { confirmedDimensions } : {}),
    calibrationStatus: savedCalibrationStatus({ calibrationStatus, editorMode, scale, planWidth, planHeight }),
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

const safeDimension = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

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
    furniture: Array.isArray(value.furniture) ? value.furniture.filter((item): item is FurnitureItem => isObject(item) && typeof item.id === "string" && FURNITURE_CATALOG.some(p => p.kind === item.kind) && [item.x, item.y, item.width, item.depth, item.height, item.rotation].every(n => typeof n === "number" && Number.isFinite(n)) && Number(item.width) > 0 && Number(item.depth) > 0 && Number(item.height) > 0 && typeof item.color === "string") : [],
    app: "remix-of-plan-weaver",
    version: 1,
    meta: {
      ...(meta.confirmedDimensions ? { confirmedDimensions: parseConfirmedDimensions(meta.confirmedDimensions, walls as DetectedWallSegment[], safeDimension(meta.planWidth), safeDimension(meta.planHeight)) } : {}),
      calibrationStatus: savedCalibrationStatus({ calibrationStatus: meta.calibrationStatus, editorMode: meta.editorMode,
        scale: meta.scale as number, planWidth: meta.planWidth as number, planHeight: meta.planHeight as number }),
      ...(meta.editorMode === "draw" || meta.editorMode === "upload" ? { editorMode: meta.editorMode } : {}),
      unit: isDimensionUnit(meta.unit) ? meta.unit : "m",
      scale: safeDimension(meta.scale),
      planWidth: safeDimension(meta.planWidth),
      planHeight: safeDimension(meta.planHeight),
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
