import type { NormalizedPoint } from "@/types/floorplan";

export type OpeningKind = "door" | "window";
export interface OpeningDraftState {
  kind: OpeningKind;
  wallId: string;
  start: NormalizedPoint;
}

/** The first click starts a draft; only a second click on that wall confirms it. */
export const advanceOpeningDraft = (
  draft: OpeningDraftState | null,
  kind: OpeningKind,
  wallId: string,
  point: NormalizedPoint,
): { draft: OpeningDraftState | null; confirms: boolean } => {
  if (!draft) return { draft: { kind, wallId, start: point }, confirms: false };
  if (draft.kind === kind && draft.wallId === wallId) return { draft, confirms: true };
  return { draft, confirms: false };
};

export const openingPreviewIsOnWall = (draft: OpeningDraftState | null, wallId: string): boolean =>
  draft?.wallId === wallId;

/** A draft may only be confirmed on its original wall. */
export const isValidOpeningTarget = (draft: OpeningDraftState | null, wallId: string | null): boolean =>
  Boolean(wallId) && (!draft || draft.wallId === wallId);

export const cancelOpeningDraft = (): null => null;
