import type { ConfirmedDimension } from "./confirmedDimensions";
import type { Room, DimensionUnit } from "@/types/floorplan";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";

import type { CalibrationStatus } from "./wallMetrics";

export interface ProjectState {
    confirmedDimensions?: ConfirmedDimension[];
    calibrationStatus: CalibrationStatus;
    rooms: Room[]; walls: DetectedWallSegment[]; doors: DetectedDoor[]; windows: DetectedWindow[];
    scale: number; planW: number; planH: number; screenPpm: number; unit: DimensionUnit; wallHeightMeter: number;
}
export const emptyProject = (): ProjectState => ({ calibrationStatus: "uncalibrated", rooms: [], walls: [], doors: [], windows: [], scale: 0,
    planW: 0, planH: 0, screenPpm: 0, unit: "m", wallHeightMeter: 2.8 });
export interface ActionInfo { label: string; threeOnly?: boolean }
interface Entry extends ActionInfo { before: ProjectState; after: ProjectState }
export interface HistoryState {
    present: ProjectState; past: Entry[]; future: Entry[];
    pending: { before: ProjectState; info?: ActionInfo } | null;
    notice: (ActionInfo & { direction: "Undid" | "Redid" }) | null;
}
export const initialHistory = (present = emptyProject()): HistoryState => ({ present, past: [], future: [], pending: null, notice: null });
export type HistoryAction =
    | { type: "edit"; update: (project: ProjectState) => ProjectState; info: ActionInfo }
    | { type: "begin"; info?: ActionInfo }
    | { type: "commit" | "cancel" | "undo" | "redo" }
    | { type: "reset"; project: ProjectState };
const equal = (a: ProjectState, b: ProjectState) => a === b || JSON.stringify(a) === JSON.stringify(b);
function finish(state: HistoryState): HistoryState {
    if (!state.pending) return state;
    const { before, info } = state.pending;
    if (equal(before, state.present)) return { ...state, present: before, pending: null };
    return { ...state, pending: null, future: [], past: [...state.past.slice(-49), {
        before, after: state.present, ...(info ?? { label: "project change" }),
    }] };
}
export function projectHistoryReducer(state: HistoryState, action: HistoryAction): HistoryState {
    switch (action.type) {
        case "reset": return initialHistory(action.project);
        case "begin": {
            const settled = finish(state);
            return { ...settled, pending: { before: settled.present, info: action.info }, notice: null };
        }
        case "edit": {
            const present = action.update(state.present);
            if (equal(present, state.present)) return state;
            if (state.pending) return { ...state, present, notice: null,
                pending: { ...state.pending, info: state.pending.info ?? action.info } };
            return finish({ ...state, present, notice: null, pending: { before: state.present, info: action.info } });
        }
        case "commit": return finish(state);
        case "cancel": return state.pending ? { ...state, present: state.pending.before, pending: null } : state;
        case "undo": {
            if (state.pending) return { ...state, present: state.pending.before, pending: null };
            const entry = state.past.at(-1);
            return entry ? { ...state, present: entry.before, past: state.past.slice(0, -1), future: [entry, ...state.future],
                notice: { label: entry.label, threeOnly: entry.threeOnly, direction: "Undid" } } : state;
        }
        case "redo": {
            if (state.pending) return state;
            const entry = state.future[0];
            return entry ? { ...state, present: entry.after, past: [...state.past, entry], future: state.future.slice(1),
                notice: { label: entry.label, threeOnly: entry.threeOnly, direction: "Redid" } } : state;
        }
    }
}
