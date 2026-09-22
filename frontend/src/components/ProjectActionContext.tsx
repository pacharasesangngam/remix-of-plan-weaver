import { createContext, useContext, useRef, type ReactNode } from "react";
import type { ActionInfo } from "@/lib/projectHistory";

export interface ProjectActions {
    begin: (info?: ActionInfo) => void;
    commit: () => void;
    cancel: () => void;
    run: (info: ActionInfo, update: () => void) => void;
}
export const ProjectActionContext = createContext<ProjectActions>({ begin: () => {}, commit: () => {}, cancel: () => {}, run: (_, update) => update() });
export const useProjectActions = () => useContext(ProjectActionContext);
export const isNativeUndoTarget = (target: EventTarget | null) => target instanceof HTMLElement &&
    (target.isContentEditable || !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));

/** Group a focused text/number/color edit; leave native input undo untouched. */
export function ProjectInputActions({ children }: { children: ReactNode }) {
    const actions = useProjectActions();
    const editing = useRef<EventTarget | null>(null);
    return <div className="contents" onFocusCapture={event => {
        const target = event.target;
        if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !["checkbox", "radio", "file", "button", "submit"].includes(target.type))) {
            editing.current = target;
            actions.begin();
        }
    }} onBlur={event => {
        if (editing.current === event.target) { editing.current = null; actions.commit(); }
    }} onKeyDownCapture={event => {
        if (event.key === "Escape" && editing.current === event.target) {
            actions.cancel();
            editing.current = null;
            // Restore the committed value even for an uncontrolled inspector input.
            if (event.target instanceof HTMLInputElement) event.target.value = event.target.defaultValue;
            event.stopPropagation();
            event.preventDefault();
            (event.target as HTMLElement).blur();
        }
    }} onKeyDown={event => {
        if (event.key === "Enter" && editing.current === event.target && event.target instanceof HTMLInputElement) event.target.blur();
    }}>{children}</div>;
}
