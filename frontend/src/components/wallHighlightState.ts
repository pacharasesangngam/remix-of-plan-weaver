export type HighlightTarget = { type: string; id: string } | null;

/** The edit gizmo owns a selected wall's outline; the preview still owns its fill. */
export const targetPreviewShowsOutline = (target: HighlightTarget, selected: HighlightTarget) =>
  target?.type !== "wall" || selected?.type !== "wall" || target.id !== selected.id;
