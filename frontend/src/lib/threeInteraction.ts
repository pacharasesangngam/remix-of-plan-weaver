export type ThreeToolMode = "select" | "wall" | "door" | "window";
export type ThreeTargetKind = "room" | "wall" | "door" | "window";

/** Only the active tool may consume a pointer event from a scene object. */
export const capturesThreeTargetPointer = (mode: ThreeToolMode, target: ThreeTargetKind): boolean =>
  mode === "select" || ((mode === "door" || mode === "window") && target === "wall");

/** Creation tools are one-shot; the user explicitly starts each new creation. */
export const nextThreeToolAfterCreation = (mode: ThreeToolMode): ThreeToolMode =>
  mode === "wall" || mode === "door" || mode === "window" ? "select" : mode;

/** Hover is deliberately separate from selection: leaving a target never deselects it. */
export const nextThreeSelection = <T>(
  current: T | null,
  mode: ThreeToolMode,
  event: "target" | "empty" | "leave",
  target?: T,
): T | null => {
  if (event === "leave" || mode !== "select") return current;
  return event === "empty" ? null : target ?? current;
};
