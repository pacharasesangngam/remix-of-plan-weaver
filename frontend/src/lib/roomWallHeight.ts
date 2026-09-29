import type { ProjectState } from "./projectHistory";
import type { Room } from "@/types/floorplan";
import type { DetectedWallSegment } from "@/types/detection";
import { deriveRooms } from "./wallTopology";
import { openingGeometry } from "./openingModel";

export function roomBoundaryWalls(room: Room, walls: DetectedWallSegment[]) {
  const ids = new Set(room.topologyWallIds ?? deriveRooms(walls, [room]).find(r => r.id === room.id)?.topologyWallIds ?? []);
  return walls.filter(wall => ids.has(wall.id));
}

type RoomGeometry = Pick<ProjectState, "rooms" | "walls" | "doors" | "windows" | "planW" | "planH" | "wallHeightMeter">;
export function roomWallHeightMinimum(project: RoomGeometry, roomId: string) {
  const room = project.rooms.find(r => r.id === roomId);
  const ids = new Set(room ? roomBoundaryWalls(room, project.walls).map(w => w.id) : []);
  const openings = [...project.doors.map(opening => ({ opening, kind: "door" as const })), ...project.windows.map(opening => ({ opening, kind: "window" as const }))];
  return Math.max(0.5, ...openings.map(({ opening, kind }) => {
    const g = openingGeometry(opening, kind, project.walls, project.planW || 20, project.planH || 20, project.wallHeightMeter);
    return g && ids.has(g.wall.id) ? g.sill + g.height : 0;
  }));
}

/** Update shared boundary records once; never create room-specific wall copies. */
export function setRoomWallHeight(project: ProjectState, roomId: string, height: number): ProjectState {
  const room = project.rooms.find(r => r.id === roomId);
  if (!room || !Number.isFinite(height) || height < roomWallHeightMinimum(project, roomId)) return project;
  const ids = new Set(roomBoundaryWalls(room, project.walls).map(w => w.id));
  if (!ids.size) return project;
  return { ...project, rooms: project.rooms.map(r => r.id === roomId ? { ...r, wallHeight: height } : r),
    walls: project.walls.map(w => ids.has(w.id) ? { ...w, wallHeight: height } : w) };
}
