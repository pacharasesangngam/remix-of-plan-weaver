import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type WallReview from "@/components/WallReview";
import type Sidebar from "@/components/Sidebar";
import type RightPanel from "@/components/RightPanel";
import { editWallGeometry } from "@/lib/wallGeometry";
import { openingGeometry } from "@/lib/openingModel";
import type { DetectedDoor, DetectedWallSegment } from "@/types/detection";
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
    <button onClick={() => props.onProjectImport({ ...project, meta: { ...project.meta, calibrationStatus: "calibrated" } })}>Import calibrated</button>
    <output data-testid="json">{JSON.stringify(props.projectData.walls)}</output>
    <output data-testid="json-furniture">{JSON.stringify(props.projectData.furniture)}</output>
</> }));
vi.mock("@/components/RightPanel", () => ({ default: (props: ComponentProps<typeof RightPanel>) =>
    <><output data-testid="3d">{JSON.stringify({ walls: props.walls, doors: props.doors, windows: props.windows, furniture: props.furniture })}</output>
      <output data-testid="3d-scale">{JSON.stringify([props.scale, props.planWidth, props.planHeight, props.calibrationStatus])}</output>
      <button onClick={() => props.onWallGeometryCommit?.(props.walls!.map((wall, i) => i ? wall : { ...wall, x1: wall.x1 + 0.1, x2: wall.x2 + 0.1 }))}>3D move wall</button>
      <button onClick={() => props.onOpeningRehost?.("door", "manual-door", "b", { x: 0.5, y: 0.5 })}>3D rehost door</button>
      <button onClick={props.onUndo}>3D undo</button><button onClick={props.onRedo}>3D redo</button>
    </> }));
vi.mock("@/components/WallReview", () => ({ default: (props: ComponentProps<typeof WallReview>) => <>
    <button onClick={() => props.onWallLengthCommit?.({ wallId: "a", length: 5, anchor: "start", confirm: true }, {
        walls: props.walls!, rooms: props.rooms, doors: props.doors!, windows: props.windows!, confirmedDimensions: props.confirmedDimensions,
    }, props.planWidth!, props.planHeight!)}>Commit length</button>
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

it("propagates a Review dimension edit to JSON and 3D as one undo step", () => {
    render(<Index />);
    fireEvent.click(screen.getByText("Upload Floor Plan")); fireEvent.click(screen.getByText("Import calibrated"));
    fireEvent.click(screen.getByText("Back to Review")); fireEvent.click(screen.getByText("Commit length"));
    const edited = JSON.parse(screen.getByTestId("json").textContent!);
    expect(edited[0].x2).toBeCloseTo(0.6);
    expect(edited[1]).toMatchObject({ x1: 0.6, x2: 0.6 });
    fireEvent.click(screen.getByText("Undo"));
    expect(JSON.parse(screen.getByTestId("json").textContent!)).toEqual(project.walls);
    expect(screen.getByText("Undo")).toBeDisabled();
    fireEvent.click(screen.getByText("Redo")); fireEvent.click(screen.getByText("Generate"));
    expect(JSON.parse(screen.getByTestId("3d").textContent!).walls).toEqual(edited);
    expect(JSON.parse(screen.getByTestId("3d-scale").textContent!).slice(0, 3)).toEqual([1, 10, 10]);
});

it("commits 3D wall and opening drags atomically with undo while preserving scale and opening size", () => {
    render(<Index />);
    fireEvent.click(screen.getByText("Upload Floor Plan"));
    fireEvent.click(screen.getByText("Import"));
    fireEvent.click(screen.getByText("Back to Review"));
    fireEvent.click(screen.getByText("Create door"));
    fireEvent.click(screen.getByText("Generate"));
    const read = () => JSON.parse(screen.getByTestId("3d").textContent!);
    const before = read(), scale = screen.getByTestId("3d-scale").textContent;
    fireEvent.click(screen.getByText("3D move wall"));
    const moved = read();
    expect(moved.walls[0].x1).toBeCloseTo(0.2, 10);
    expect(openingGeometry(moved.doors[0], "door", moved.walls, 10, 10)!.width).toBeCloseTo(2, 10);
    expect(moved.doors[0].bbox.x).toBeCloseTo(before.doors[0].bbox.x + 0.1, 10);
    fireEvent.click(screen.getByText("3D undo"));
    expect(read()).toEqual(before);
    fireEvent.click(screen.getByText("3D redo"));
    expect(read()).toEqual(moved);
    fireEvent.click(screen.getByText("3D rehost door"));
    const rehosted = read();
    expect(rehosted.doors[0].wallId).toBe("b");
    expect(openingGeometry(rehosted.doors[0], "door", rehosted.walls, 10, 10)!.width).toBeCloseTo(2, 10);
    expect(rehosted.walls).toEqual(moved.walls);
    fireEvent.click(screen.getByText("3D undo"));
    expect(read()).toEqual(moved);
    expect(screen.getByTestId("3d-scale").textContent).toBe(scale);
});

// The top-bar Furniture Layout action is temporarily hidden; FurniturePlanner itself is still covered by its own test.
it.skip("opens the uploaded-plan furniture editor and returns to review", () => {
    render(<Index />);
    fireEvent.click(screen.getByText("Upload Floor Plan"));
    fireEvent.click(screen.getByText("Import"));
    fireEvent.click(screen.getByRole("button", { name: "จัดวางเฟอร์นิเจอร์" }));
    expect(screen.getByRole("region", { name: "จัดวางเฟอร์นิเจอร์" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Calibrate Scale");
    fireEvent.click(screen.getAllByRole("button", { name: "กลับไปตรวจแปลน" })[0]);
    expect(screen.getByTestId("2d")).toBeInTheDocument();
});

it("commits only the edited wall as one action and synchronizes undo, redo, JSON and Generate 3D", () => {
    render(<Index />);
    fireEvent.click(screen.getByText("Upload Floor Plan"));
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

it("keeps an attached opening's size when its host wall is resized", () => {
    render(<Index />);
    fireEvent.click(screen.getByText("Upload Floor Plan"));
    fireEvent.click(screen.getByText("Import"));
    fireEvent.click(screen.getByText("Back to Review"));
    fireEvent.click(screen.getByText("Create door"));
    fireEvent.click(screen.getByText("Move door"));
    const plan = { width: 10, height: 10 };
    const width = (opening: DetectedDoor, walls: DetectedWallSegment[]) =>
        openingGeometry(opening, "door", walls, plan.width, plan.height)!.width;
    const walls = JSON.parse(screen.getByTestId("2d").textContent!) as DetectedWallSegment[];
    const before = JSON.parse(screen.getByTestId("2d-openings").textContent!)[0] as DetectedDoor;
    expect(width(before, walls)).toBeCloseTo(2, 8);

    fireEvent.click(screen.getByText("Commit drag"));
    const resized = JSON.parse(screen.getByTestId("2d").textContent!) as DetectedWallSegment[];
    const after = JSON.parse(screen.getByTestId("2d-openings").textContent!)[0] as DetectedDoor;
    expect(resized[0]).toMatchObject({ x2: 0.6, y2: 0.3 });
    expect(after.wallId).toBe("a");
    // A proportional wall scale would have grown the 2 m door to ~2.55 m.
    expect(width(after, resized)).toBeCloseTo(2, 8);
});

it("persists a wall-attached opening edited in Review into 3D", () => {
    render(<Index />);
    fireEvent.click(screen.getByText("Upload Floor Plan"));
    fireEvent.click(screen.getByText("Import"));
    fireEvent.click(screen.getByText("Back to Review"));
    fireEvent.click(screen.getByText("Create door"));
    fireEvent.click(screen.getByText("Move door"));

    const review = JSON.parse(screen.getByTestId("2d-openings").textContent!);
    expect(review[0]).toMatchObject({ id: "manual-door", wallId: "a", wallSpan: { start: expect.closeTo(0.5, 10), end: expect.closeTo(1, 10) } });
    expect(review[0].bbox.x).toBeCloseTo(0.3);
    expect(review[0].bbox.w).toBeCloseTo(0.2);
    fireEvent.click(screen.getByText("Generate"));
    expect(JSON.parse(screen.getByTestId("3d").textContent!).doors).toEqual(review);
});


it("returns to Start without losing the project and hides download until a project is ready", () => {
    render(<Index />);
    expect(screen.queryByRole("button", { name: "Download Project" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Upload Floor Plan"));
    expect(screen.queryByRole("button", { name: "Download Project" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Import"));
    const before = screen.getByTestId("json").textContent;
    expect(screen.getByRole("button", { name: "Download Project" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sketch to Spec" }));
    expect(screen.getByText("Start a new project")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download Project" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Upload Floor Plan"));
    expect(screen.getByTestId("json").textContent).toBe(before);
    expect(screen.getByRole("button", { name: "Download Project" })).toBeInTheDocument();
});
