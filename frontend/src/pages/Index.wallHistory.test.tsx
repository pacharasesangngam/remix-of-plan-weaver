import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type WallReview from "@/components/WallReview";
import type Sidebar from "@/components/Sidebar";
import type RightPanel from "@/components/RightPanel";
import { editWallGeometry } from "@/lib/wallGeometry";
import type { FloorPlanProject } from "@/lib/projectIO";
import Index from "./Index";

const project: FloorPlanProject = {
    app: "remix-of-plan-weaver", version: 1,
    meta: { unit: "m", scale: 1, planWidth: 10, planHeight: 10 },
    rooms: [], doors: [], windows: [],
    furniture: [{ id: "sofa", kind: "sofa", x: 0.3, y: 0.4, width: 2.1, depth: 0.9, height: 0.85, rotation: 0, color: "#888888" }],
    walls: [
        { id: "a", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.2, type: "interior" },
        { id: "b", x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.8, type: "interior" },
    ],
};
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
vi.mock("@/components/SplashScreen", () => ({ default: () => null }));
vi.mock("@/services/floorplanAI", () => ({ detectFloorPlan: vi.fn() }));
vi.mock("@/components/Sidebar", () => ({ default: (props: ComponentProps<typeof Sidebar>) => <>
    <button onClick={() => props.onProjectImport(project)}>Import</button>
    <output data-testid="json">{JSON.stringify(props.projectData.walls)}</output>
    <output data-testid="json-furniture">{JSON.stringify(props.projectData.furniture)}</output>
</> }));
vi.mock("@/components/RightPanel", () => ({ default: (props: ComponentProps<typeof RightPanel>) =>
    <output data-testid="3d">{JSON.stringify({ walls: props.walls, doors: props.doors, windows: props.windows, furniture: props.furniture })}</output> }));
vi.mock("@/components/WallReview", () => ({ default: (props: ComponentProps<typeof WallReview>) => <>
    <button onClick={() => {
        const walls = props.walls!;
        props.onWallGeometryCommit!(editWallGeometry(walls, { ...walls[0], x2: 0.6, y2: 0.3 }, "end")!);
    }}>Commit drag</button>
    <button disabled={!props.canUndo} onClick={props.onUndo}>Undo</button>
    <button disabled={!props.canRedo} onClick={props.onRedo}>Redo</button>
    <button onClick={props.onGenerate}>Generate</button>
    <button onClick={() => props.onDoorAdd?.({ id: "manual-door", wallId: "a", bbox: { x: 0.2, y: 0.19, w: 0.2, h: 0.02 } })}>Create door</button>
    <button onClick={() => props.onDoorUpdate?.("manual-door", "bbox", { x: 0.3, y: 0.19, w: 0.2, h: 0.02 })}>Move door</button>
    <output data-testid="2d">{JSON.stringify(props.walls)}</output>
    <output data-testid="2d-openings">{JSON.stringify(props.doors)}</output>
</> }));
afterEach(cleanup);

it("commits only the edited wall as one action and synchronizes undo, redo, JSON and Generate 3D", () => {
    render(<Index />);
    fireEvent.click(screen.getByText("อัปโหลดแปลน"));
    fireEvent.click(screen.getByText("Import"));
    fireEvent.click(screen.getByText("Back to Review"));
    expect(screen.getByText("Undo")).toBeDisabled();
    fireEvent.click(screen.getByText("Commit drag"));
    const after = JSON.parse(screen.getByTestId("json").textContent!);
    expect(after[0]).toMatchObject({ x2: 0.6, y2: 0.3 });
    expect(after[1]).toEqual(project.walls[1]);
    expect(screen.getByTestId("2d").textContent).toBe(JSON.stringify(after));
    fireEvent.click(screen.getByText("Undo"));
    expect(screen.getByTestId("json").textContent).toBe(JSON.stringify(project.walls));
    expect(screen.getByText("Undo")).toBeDisabled();
    fireEvent.click(screen.getByText("Redo"));
    expect(screen.getByTestId("2d").textContent).toBe(JSON.stringify(after));
    expect(screen.getByTestId("json").textContent).toBe(JSON.stringify(after));
    expect(screen.getByText("Redo")).toBeDisabled();
    fireEvent.click(screen.getByText("Generate"));
    expect(JSON.parse(screen.getByTestId("3d").textContent!).walls).toEqual(after);
    expect(JSON.parse(screen.getByTestId("json-furniture").textContent!)).toEqual(project.furniture);
    expect(JSON.parse(screen.getByTestId("3d").textContent!).furniture).toEqual(project.furniture);
});

it("persists a wall-attached opening edited in Review into 3D", () => {
    render(<Index />);
    fireEvent.click(screen.getByText("อัปโหลดแปลน"));
    fireEvent.click(screen.getByText("Import"));
    fireEvent.click(screen.getByText("Back to Review"));
    fireEvent.click(screen.getByText("Create door"));
    fireEvent.click(screen.getByText("Move door"));

    expect(JSON.parse(screen.getByTestId("2d-openings").textContent!)).toEqual([
        { id: "manual-door", wallId: "a", bbox: { x: 0.3, y: 0.19, w: 0.2, h: 0.02 } },
    ]);
    fireEvent.click(screen.getByText("Generate"));
    expect(JSON.parse(screen.getByTestId("3d").textContent!).doors).toEqual([
        { id: "manual-door", wallId: "a", bbox: { x: 0.3, y: 0.19, w: 0.2, h: 0.02 } },
    ]);
});
