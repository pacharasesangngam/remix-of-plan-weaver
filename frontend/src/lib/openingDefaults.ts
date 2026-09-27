/**
 * Physical sizes for new openings. Review and 3D both create and display a
 * door or window from these values, so a new opening always starts with the
 * same real size in either workspace.
 */
export const DEFAULT_DOOR_HEIGHT_M = 2.2;
export const DEFAULT_WINDOW_HEIGHT_M = 1.2;
export const DEFAULT_WINDOW_SILL_M = 0.9;
/** Every opening keeps at least this much clearance inside its host wall. */
export const OPENING_CLEARANCE_M = 0.01;

type OpeningKindName = "door" | "window";

export const defaultOpeningSill = (kind: OpeningKindName, wallHeight: number): number =>
  kind === "door" ? 0 : Math.max(0, Math.min(DEFAULT_WINDOW_SILL_M, wallHeight - OPENING_CLEARANCE_M));

/** The default height never exceeds what the host wall can hold above the sill. */
export const defaultOpeningHeight = (kind: OpeningKindName, wallHeight: number): number => {
  const ceiling = Math.max(OPENING_CLEARANCE_M, wallHeight - defaultOpeningSill(kind, wallHeight));
  return Math.min(kind === "door" ? DEFAULT_DOOR_HEIGHT_M : DEFAULT_WINDOW_HEIGHT_M, ceiling);
};
