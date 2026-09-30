import OpeningDimensions from "./OpeningDimensions";
import { openingGeometry, resolveOpenings, findOpeningRehost, editOpening, openingAtPoints, uniformOpeningM, type Opening, type OpeningKind, type OpeningEdit } from "@/lib/openingModel";
import { confirmCalibration, type ConfirmedDimension } from "@/lib/confirmedDimensions";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
    CheckCircle2, AlertCircle, Pencil, Check, X,
    ArrowRight, Zap, ChevronLeft, ChevronRight,
    DoorOpen, AppWindow, Layers, Eye, EyeOff, Ruler,
    Crosshair, RotateCcw, Building2, ZoomIn, ZoomOut, Maximize, Plus, ChevronDown,
} from "lucide-react";
import type { Room, DimensionUnit } from "@/types/floorplan";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import { UNITS } from "@/types/floorplan";
import { Button } from "@/components/ui/button";
import { useProjectActions } from "@/components/ProjectActionContext";
import { Input } from "@/components/ui/input";
import { editWallGeometry, endpointPoint, findWallSnap, geometryChanged, projectToWall, screenDistance, snapWallTranslation, wallConnectionTargets, SNAP_PX, wallSnapTargets, type WallSnap } from "@/lib/wallGeometry";
import { finishWallDraw, snapWallDrawPoint, wallDrawConnections, wallDraftGeometry, type WallDrawSnap } from "@/lib/wallDrawing";
import { newOpeningRecord } from "@/lib/openingModel";
import { DEFAULT_WALL_THICKNESS_M, getWallThicknessM, resolvePlanDimensions, uniformWallThicknessM, wallStrokeWidthNormalized } from "@/lib/wallMetrics";
import { defaultOpeningHeight, defaultOpeningSill } from "@/lib/openingDefaults";
import { defaultRenderWallHeight, wallSolidInputs, wallFootprintPaths } from "@/lib/wallRenderGeometry";
import { proposeWallLength, chooseLengthAnchor, type GeometrySnapshot, type LengthRequest } from "@/lib/wallLengthEdit";
import { ringsToPathD, buildWallTopology, roomBoundarySpans } from "@/lib/wallTopology";
import { ReviewDimensions, type DimensionDraft, type PlanDimension } from "./ReviewDimensions";
import { RoomNameBadge } from "./RoomNameBadge";
import { createOpeningBboxFromWallPoints } from "@/lib/openingPlacement";
import { advanceOpeningDraft, cancelOpeningDraft, isValidOpeningTarget, type OpeningDraftState } from "@/lib/openingInteraction";
import { resolveOpeningWall } from "@/lib/openingAttachment";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
import { getMeasuredRoomArea, hasCalibration, type CalibrationStatus } from "@/lib/wallMetrics";

interface WallReviewProps {
    confirmedDimensions?: ConfirmedDimension[];
    onConfirmedCalibration?: (dimensions: ConfirmedDimension[]) => void;
    calibrationStatus?: CalibrationStatus;
    rooms: Room[];
    unit: DimensionUnit;
    imageUrl: string | null;
    backgroundImageUrl?: string | null;
    walls?: DetectedWallSegment[];
    doors?: DetectedDoor[];
    windows?: DetectedWindow[];
    scale: number; 
    planWidth?: number;
    planHeight?: number;
    onScaleChange: (s: number) => void;
    onPlanSizeChange?: (pw: number, ph: number) => void;
    onPpmChange?: (ppm: number) => void;  
    onRoomUpdate: (id: string, field: keyof Room, value: number | string) => void;
    onRoomDelete?: (id: string) => void;
    onWallUpdate?: (id: string, field: keyof DetectedWallSegment, value: number | string) => void;
    onWallAdd?: (wall: DetectedWallSegment) => void;
    onWallDelete?: (id: string) => void;
    onWallLengthCommit?: (request: LengthRequest, base: GeometrySnapshot, width: number, height: number) => void;
    onWallGeometryCommit?: (walls: DetectedWallSegment[], options?: { exact?: boolean }) => void;
    onDoorAdd?: (door: DetectedDoor) => void;
    onOpeningRehost?: (kind: OpeningKind, id: string, wallId: string, center: CalibPoint) => void;
    onDoorUpdate?: (id: string, field: keyof DetectedDoor, value: DetectedDoor[keyof DetectedDoor]) => void;
    onDoorDelete?: (id: string) => void;
    onWindowAdd?: (windowItem: DetectedWindow) => void;
    onWindowUpdate?: (id: string, field: keyof DetectedWindow, value: DetectedWindow[keyof DetectedWindow]) => void;
    onWindowDelete?: (id: string) => void;
    canUndo?: boolean;
    canRedo?: boolean;
    onUndo?: () => void;
    onRedo?: () => void;
    onGenerate: () => void;
    wallHeightMeter?: number;
    onWallHeightChange?: (h: number) => void;
}

interface EditState {
    roomId: string;
    field: "width" | "height" | "wallHeight";
    value: string;
}

interface WallEditState {
    wallId: string;
    field: "thickness" | "wallHeight";
    value: string;
}

interface CalibPoint { x: number; y: number; }

interface OpeningDrag {
    kind: OpeningKind; original: Opening; preview: Opening; mode: "move" | "start" | "end";
    origin: number; pointerId: number; walls: DetectedWallSegment[];
}

interface EndpointDrag {
    wall: DetectedWallSegment;
    endpoint?: "start" | "end";
    baseWalls: DetectedWallSegment[];
    previewWalls: DetectedWallSegment[];
    origin: CalibPoint;
    pointerId: number;
    preview: DetectedWallSegment;
    snapTarget: WallSnap | null;
    connectionTargets: WallSnap[];
    feedbackSize: { width: number; height: number };
    reverseBlocked: Set<string>;
    blockedEndpoints: Record<"start" | "end", Set<string>>;
    blockedTargets: Set<string>;
}

type SelectionType = "room" | "wall" | "door" | "window";
type OverlayLayer  = "rooms" | "walls" | "doors" | "windows" | "image";
// idle → placing (dropping points) → ready (both down, enter real dist) → applied
type CalibPhase    = "idle" | "placing" | "ready" | "applied";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const ROOM_SELECTION = { stroke: "#7c3aed", badge: "rgba(139,92,246,0.12)", fill: "rgba(139,92,246,0.10)", text: "#6d28d9" };

const CONF_STYLE: Record<Room["confidence"], { stroke: string; label: string; labelBg: string }> = {
    high:   { stroke: "#34d399", label: "High",   labelBg: "rgba(52,211,153,0.85)"  },
    low:    { stroke: "#fbbf24", label: "Low",    labelBg: "rgba(251,191,36,0.85)"  },
    manual: { stroke: "#94a3b8", label: "Manual", labelBg: "rgba(148,163,184,0.85)" },
};

// Hit radius (normalised coords) — ใหญ่พอที่จะจับจุดได้ง่าย โดยเฉพาะ touch screen
const DRAG_HIT = 0.045;
const ENDPOINT_HIT_RADIUS_PX = 12;
const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const EMPTY_WALLS: DetectedWallSegment[] = [];
const EMPTY_DOORS: DetectedDoor[] = [];
const EMPTY_WINDOWS: DetectedWindow[] = [];

// ─────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────
const WallReview = ({
    rooms: storedRooms, unit, imageUrl, confirmedDimensions, onConfirmedCalibration,
    backgroundImageUrl,
    walls = EMPTY_WALLS, doors: storedDoors = EMPTY_DOORS, windows: storedWindows = EMPTY_WINDOWS,
    calibrationStatus = "uncalibrated", scale, planWidth = 0, planHeight = 0, onScaleChange, onPlanSizeChange,
    onPpmChange, onRoomUpdate, onRoomDelete, onWallUpdate, onWallAdd, onWallDelete, onWallGeometryCommit, onWallLengthCommit, onDoorAdd, onOpeningRehost, onDoorUpdate, onDoorDelete, onWindowAdd, onWindowUpdate, onWindowDelete, canUndo = false, canRedo = false, onUndo, onRedo, onGenerate,
    wallHeightMeter = 2.8, onWallHeightChange,
}: WallReviewProps) => {

    const [roomNameEdit, setRoomNameEdit] = useState<{ id: string; value: string } | null>(null);
    // Escape must win even if the field also loses focus while it unmounts.
    const roomNameCancelled = useRef(false);
    /** The room name itself is the edit affordance: click selects the room and opens an inline field. */
    const startRoomNameEdit = (room: Room) => {
        roomNameCancelled.current = false;
        selectRoom(room.id);
        setRoomNameEdit({ id: room.id, value: room.name });
    };
    const commitRoomName = () => {
        if (roomNameCancelled.current) { roomNameCancelled.current = false; setRoomNameEdit(null); return; }
        if (!roomNameEdit) return;
        const name = roomNameEdit.value.trim();
        if (name && name !== rooms.find(room => room.id === roomNameEdit.id)?.name) onRoomUpdate(roomNameEdit.id, "name", name);
        setRoomNameEdit(null);
    };
    const [editState,      setEditState]      = useState<EditState | null>(null);
    const [wallEditState,  setWallEditState]  = useState<WallEditState | null>(null);
    const [selectedId,     setSelectedId]     = useState<string | null>(null);
    const [selectionType,  setSelectionType]  = useState<SelectionType>("room");
    const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
    const [selectedDoorId, setSelectedDoorId] = useState<string | null>(null);
    const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null);
    const [imgSize,        setImgSize]        = useState({ w: 1, h: 1 });
    const [sourceSize,     setSourceSize]     = useState({ w: 0, h: 0 });
    const [viewZoom,       setViewZoom]       = useState(1);
    const [viewPan,        setViewPan]        = useState({ x: 0, y: 0 });
    const [isEditingZoom,  setIsEditingZoom]  = useState(false);
    const [zoomInput,      setZoomInput]      = useState("100");
    const [layers,         setLayers]         = useState<Set<OverlayLayer>>(
        new Set(["rooms", "walls", "doors", "windows", "image"])
    );

    // Global wall height
    const [localWallH, setLocalWallH] = useState(() => wallHeightMeter);
    const [localWallThickness, setLocalWallThickness] = useState(DEFAULT_WALL_THICKNESS_M);
    const [wallDefaultsEditing, setWallDefaultsEditing] = useState(false);
    /** Batch opening sizes follow the Walls defaults pattern: one shared draft per kind. */
    const [openingEdit, setOpeningEdit] = useState<{ kind: OpeningKind; height: string; sill: string } | null>(null);
    const [lengthDraft, updateLengthDraft] = useState<DimensionDraft | null>(null);
    const lengthDraftRef = useRef<DimensionDraft | null>(null);
    const setLengthDraft = (draft: DimensionDraft | null) => { lengthDraftRef.current = draft; updateLengthDraft(draft); };
    const [lengthError, setLengthError] = useState<string | null>(null);
    const [openingDrag, setOpeningDrag] = useState<OpeningDrag | null>(null);
    const openingDragRef = useRef<OpeningDrag | null>(null);
    const [endpointDrag, setEndpointDrag] = useState<EndpointDrag | null>(null);
    const endpointDragRef = useRef<EndpointDrag | null>(null);
    const suppressEndpointClickRef = useRef(false);
    useEffect(() => {
        if (endpointDragRef.current && endpointDragRef.current.baseWalls !== walls) {
            endpointDragRef.current = null;
            setEndpointDrag(null);
        }
    }, [walls]);

    // Calibration — restore "applied" state when returning from 3D view
    const [calibPhase,  setCalibPhase]  = useState<CalibPhase>(() => hasCalibration(calibrationStatus, scale, planWidth, planHeight) ? "applied" : "idle");
    const [calibrationEndpoint, setCalibrationEndpoint] = useState<CalibPoint | null>(null);
    const [calibPts,    setCalibPts]    = useState<CalibPoint[]>([]);
    const [calibLength, setCalibLength] = useState("");
    const [calibUnit, setCalibUnit] = useState<DimensionUnit>(unit);
    const [mousePos,    setMousePos]    = useState<CalibPoint | null>(null);
    const [wallDrawMode, setWallDrawMode] = useState(false);
    const [openingDrawMode, setOpeningDrawMode] = useState<"door" | "window" | null>(null);
    const [openingDraft, setOpeningDraft] = useState<OpeningDraftState | null>(null);
    const [attachmentCandidate, setAttachmentCandidate] = useState<{ kind: "door" | "window"; id: string; wallId: string | null } | null>(null);
    const [openingHoverWallId, setOpeningHoverWallId] = useState<string | null>(null);
    const [wallDrawSnap, setWallDrawSnap] = useState<WallDrawSnap | null>(null);
    const [wallDraftStart, setWallDraftStart] = useState<CalibPoint | null>(null);
    const [wallDraftMouse, setWallDraftMouse] = useState<CalibPoint | null>(null);
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const [otherElementsOpen, setOtherElementsOpen] = useState(false);
    const [elementCategory, setElementCategory] = useState<"walls" | "doors" | "windows" | null>(null);
    const [advancedOpen, setAdvancedOpen] = useState(false);

    // Drag state
    // useRef สำหรับ logic ที่ต้องการ sync ทันที (ไม่ผ่าน re-render)
    // useState สำหรับ cursor / visual feedback ที่ต้องการ re-render
    const draggingIdx  = useRef<number | null>(null);
    const [isDragging, setIsDragging] = useState(false);

    const imgRef     = useRef<HTMLImageElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const workspaceRef = useRef<HTMLDivElement>(null);
    const sidebarScrollRef = useRef<HTMLDivElement>(null);
    const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number; captured: boolean } | null>(null);
    const manualWallHistoryRef = useRef<string[]>([]);
    const addMenuRef = useRef<HTMLDivElement>(null);
    const fittedImageRef = useRef<string | null>(null);
    const isAtFitRef = useRef(true);
    const [isPanning, setIsPanning] = useState(false);
    const projectActions = useProjectActions();
    const currentUnit = UNITS.find((u) => u.value === unit) ?? UNITS[0];

    useEffect(() => {
        const closeAddMenuOnOutsideClick = (event: PointerEvent) => {
            if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) setAddMenuOpen(false);
        };
        document.addEventListener("pointerdown", closeAddMenuOnOutsideClick);
        return () => document.removeEventListener("pointerdown", closeAddMenuOnOutsideClick);
    }, []);

    // ── scale ใช้งานได้จริงเมื่อ calibrate แล้วเท่านั้น ──────
    const planDimensions = resolvePlanDimensions(planWidth, planHeight);
    const calibrated = hasCalibration(calibrationStatus, scale, planWidth, planHeight);
    const sourceGeometry = useMemo(() => ({ walls, rooms: storedRooms, doors: storedDoors, windows: storedWindows, confirmedDimensions }), [walls, storedRooms, storedDoors, storedWindows, confirmedDimensions]);
    const rooms = storedRooms;
    const doors = openingDrag?.kind === "door" ? storedDoors.map(o => o.id === openingDrag.original.id ? openingDrag.preview : o) : storedDoors;
    const windows = openingDrag?.kind === "window" ? storedWindows.map(o => o.id === openingDrag.original.id ? openingDrag.preview : o) : storedWindows;
    const openingSet = resolveOpenings(doors, windows, walls, planDimensions.width, planDimensions.height, wallHeightMeter);
    const renderWalls = endpointDrag?.previewWalls ?? walls;
    // Feedback follows the displayed preview, including pointer-down and a
    // rejected move that restores the original wall. It never selects a snap.
    const dragConnectionTargets = useMemo(() => {
        if (!endpointDrag) return [];
        const connections = endpointDrag.endpoint
            ? wallConnectionTargets(endpointDrag.preview, endpointDrag.previewWalls, endpointDrag.feedbackSize)
            : endpointDrag.connectionTargets;
        return [...(endpointDrag.snapTarget ? [endpointDrag.snapTarget] : []), ...connections];
    }, [endpointDrag]);
    // A connection marker supplies the endpoint decoration without stacking dots.
    const hasDragConnectionAt = (point: CalibPoint) => dragConnectionTargets.some(target =>
        Math.hypot(target.x - point.x, target.y - point.y) < 1e-10);
    const defaultWallHeight = defaultRenderWallHeight(rooms);
    useEffect(() => { setLengthDraft(null); setLengthError(null); }, [sourceGeometry, planWidth, planHeight, scale, selectedWallId, selectedId]);
    const cancelLength = () => { setLengthDraft(null); setLengthError(null); };
    const commitLength = () => {
        const draft = lengthDraftRef.current;
        if (!draft || !calibrated) return;
        const target = Number(draft.value);
        const options = { span: draft.span, segmentKey: draft.segmentKey, confirm: true, automatic: true };
        const anchor = chooseLengthAnchor(sourceGeometry, draft.wallId, target, planDimensions.width, planDimensions.height, options);
        const request = { wallId: draft.wallId, length: target, anchor, ...options };
        const candidate = proposeWallLength(sourceGeometry, request, planDimensions.width, planDimensions.height);
        if (candidate.ok === false) { setLengthError(candidate.reason); return; }
        setLengthDraft(null);
        setLengthError(null);
        onWallLengthCommit?.(request, sourceGeometry, planDimensions.width, planDimensions.height);
    };
    const footprintPaths = useMemo(() => wallFootprintPaths(wallSolidInputs(
        renderWalls, doors, windows, defaultWallHeight, planDimensions.width, planDimensions.height),
        planDimensions.width, planDimensions.height),
        [renderWalls, doors, windows, defaultWallHeight, planDimensions.width, planDimensions.height]);

    useEffect(() => {
        setCalibPhase(calibrated ? "applied" : "idle");
    }, [calibrated]);

    // The base plane is fitted to the workspace. Zoom and pan are applied later as
    // a shared visual transform, so they never alter plan coordinates.
    const fitToScreen = useCallback(() => {
        const workspace = workspaceRef.current;
        if (!workspace || !sourceSize.w || !sourceSize.h) return;
        const padding = 32;
        const fitScale = Math.min(
            Math.max(1, workspace.clientWidth - padding) / sourceSize.w,
            Math.max(1, workspace.clientHeight - padding) / sourceSize.h,
        );
        setImgSize({ w: sourceSize.w * fitScale, h: sourceSize.h * fitScale });
        setViewZoom(1);
        setViewPan({ x: 0, y: 0 });
        isAtFitRef.current = true;
    }, [sourceSize]);

    useEffect(() => {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        const ro = new ResizeObserver(() => {
            if (isAtFitRef.current && fittedImageRef.current === (backgroundImageUrl ?? imageUrl)) fitToScreen();
        });
        ro.observe(workspace);
        return () => ro.disconnect();
    }, [backgroundImageUrl, fitToScreen, imageUrl]);

    useEffect(() => {
        if (!sourceSize.w || !sourceSize.h) return;
        fitToScreen();
        fittedImageRef.current = backgroundImageUrl ?? imageUrl;
    }, [backgroundImageUrl, fitToScreen, imageUrl, sourceSize]);

    useEffect(() => {
        setLocalWallH(wallHeightMeter);
    }, [wallHeightMeter]);

    // ── Coord helpers ────────────────────────────────────────
    const evToNorm = (e: React.PointerEvent | React.MouseEvent): CalibPoint | null => {
        const el = overlayRef.current;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };

    const normDist = (a: CalibPoint, b: CalibPoint) =>
        Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

    const pixelDist = (a: CalibPoint, b: CalibPoint) => {
        const dx = (b.x - a.x) * imgSize.w;
        const dy = (b.y - a.y) * imgSize.h;
        return Math.sqrt(dx * dx + dy * dy);
    };

    // หา index ของจุดที่ใกล้ที่สุด ถ้าอยู่ใน radius คืน index, ไม่อยู่คืน -1
    const nearestPointIdx = useCallback((pt: CalibPoint, pts: CalibPoint[], radius: number): number => {
        let best = -1, bestD = radius;
        for (let i = 0; i < pts.length; i++) {
            const d = normDist(pt, pts[i]);
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }, []);

    const livePixelDist = calibPts.length === 2 ? pixelDist(calibPts[0], calibPts[1]) : null;

    // Cursor style — อิง isDragging state + hover detection
    const cursorStyle = (() => {
        if (wallDrawMode) return "cell";
        if (openingDrawMode) return isValidOpeningTarget(openingDraft, openingHoverWallId) ? "cell" : "default";
        if (!mousePos) return "crosshair";
        if (isDragging) return "grabbing";
        if (nearestPointIdx(mousePos, calibPts, DRAG_HIT) !== -1) return "grab";
        return "crosshair";
    })();

    const stopWallDraw = () => {
        setWallDrawMode(false);
        setWallDraftStart(null);
        setWallDraftMouse(null);
        setWallDrawSnap(null);
    };

    const stopOpeningDraw = () => {
        setOpeningDrawMode(null);
        setOpeningDraft(cancelOpeningDraft());
        setOpeningHoverWallId(null);
    };

    const startOpeningDraw = (kind: "door" | "window") => {
        stopWallDraw();
        setOpeningDrawMode(kind);
        setOpeningDraft(null);
        setOpeningHoverWallId(null);
        setLayers(prev => new Set(prev).add(kind === "door" ? "doors" : "windows"));
    };

    const startWallDraw = () => {
        stopOpeningDraw();
        if (inCalibMode) {
            setCalibPhase("idle");
            setCalibPts([]);
            setCalibLength("");
            setMousePos(null);
            draggingIdx.current = null;
            setIsDragging(false);
        }
        setLayers(prev => new Set(prev).add("walls"));
        setWallDrawMode(true);
        setWallDraftStart(null);
        setWallDraftMouse(null);
        setWallDrawSnap(null);
    };

    const undoLastManualWall = () => {
        if (!onWallDelete) return;
        let wallId = manualWallHistoryRef.current.pop();
        while (wallId && !walls.some(wall => wall.id === wallId)) wallId = manualWallHistoryRef.current.pop();
        if (wallId) onWallDelete(wallId);
    };

    const resolveDrawSnap = useCallback((point: CalibPoint): { point: CalibPoint; snap: WallDrawSnap | null } => {
        const bounds = overlayRef.current?.getBoundingClientRect();
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return { point, snap: null };
        return snapWallDrawPoint(point, walls, { width: bounds.width, height: bounds.height });
    }, [walls]);

    const createManualWall = (start: CalibPoint, end: CalibPoint) => {
        if (!onWallAdd) return false;
        const bounds = overlayRef.current?.getBoundingClientRect();
        const size = bounds && bounds.width > 0 && bounds.height > 0
            ? { width: bounds.width, height: bounds.height }
            : { width: 1000, height: 1000 };
        const id = `manual-wall-${Date.now()}`;
        const committed = finishWallDraw(start, end, walls, size, planDimensions.width, planDimensions.height, {
            id,
            thickness: localWallThickness,
            wallHeight: wallHeightMeter,
            type: "interior",
        });
        if (!committed) return false;
        onWallAdd(committed.wall);
        manualWallHistoryRef.current.push(id);
        selectWall(id);
        return true;
    };

    const onWallDrawPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const raw = evToNorm(e);
        if (!raw) return;
        const { point: snappedPoint, snap } = resolveDrawSnap(raw);
        setWallDrawSnap(snap);
        if (!wallDraftStart) {
            setWallDraftStart(snappedPoint);
            setWallDraftMouse(snappedPoint);
            return;
        }
        const created = createManualWall(wallDraftStart, snappedPoint);
        setWallDraftStart(null);
        setWallDraftMouse(null);
        setWallDrawSnap(null);
        if (created) stopWallDraw();
    }, [wallDraftStart, walls, imgSize, onWallAdd, resolveDrawSnap, localWallThickness, wallHeightMeter, planDimensions]);

    const onWallDrawPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const raw = evToNorm(e);
        if (!raw) {
            setWallDrawSnap(null);
            return;
        }
        const { point: snappedPoint, snap } = resolveDrawSnap(raw);
        setWallDrawSnap(snap);
        setWallDraftMouse(snappedPoint);
    }, [resolveDrawSnap]);

    const onWallDrawPointerLeave = useCallback(() => {
        setWallDraftMouse(null);
        setWallDrawSnap(null);
    }, []);

    // CSS-pixel radius stays consistent across fit, zoom and aspect ratio.
    const nearestCalibrationEndpoint = useCallback((point: CalibPoint): CalibPoint | null => {
        const bounds = overlayRef.current?.getBoundingClientRect();
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
        let closest: CalibPoint | null = null;
        let distance = ENDPOINT_HIT_RADIUS_PX;
        for (const wall of walls) for (const endpoint of ["start", "end"] as const) {
            const candidate = endpointPoint(wall, endpoint);
            const d = Math.hypot((candidate.x - point.x) * bounds.width, (candidate.y - point.y) * bounds.height);
            if (d < distance) { closest = candidate; distance = d; }
        }
        return closest;
    }, [walls]);

    // ── Calibration pointer handlers ─────────────────────────
    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const raw = evToNorm(e);
        if (!raw) return;
        const endpoint = nearestCalibrationEndpoint(raw);
        const pt = endpoint ?? raw;
        setCalibrationEndpoint(endpoint);

        // ① Grab priority — ถ้าใกล้จุดไหนพอ → drag ทันที ไม่ place ใหม่
        const idx = endpoint
            ? calibPts.findIndex(point => point.x === endpoint.x && point.y === endpoint.y)
            : nearestPointIdx(pt, calibPts, DRAG_HIT);
        if (idx !== -1) {
            if (endpoint) setCalibPts(prev => prev.map((point, i) => i === idx ? endpoint : point));
            draggingIdx.current = idx;
            setIsDragging(true);
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
            return;
        }

        // ② Place new point (เฉพาะตอนยังไม่ครบ 2 จุด)
        if (calibPts.length < 2) {
            const next = [...calibPts, pt];
            setCalibPts(next);
            setCalibPhase(next.length === 2 ? "ready" : "placing");
            return;
        }

        // ③ ครบ 2 จุดแล้ว คลิกที่อื่น → ย้ายจุดที่ใกล้ที่สุดไปที่คลิก
        const closest = normDist(pt, calibPts[0]) <= normDist(pt, calibPts[1]) ? 0 : 1;
        draggingIdx.current = closest;
        setIsDragging(true);
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        setCalibPts(prev => {
            const next = [...prev];
            next[closest] = pt;
            return next;
        });
    }, [calibPts, nearestPointIdx, nearestCalibrationEndpoint]);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const raw = evToNorm(e);
        if (!raw) return;
        const endpoint = nearestCalibrationEndpoint(raw);
        const pt = endpoint ?? raw;
        setCalibrationEndpoint(endpoint);
        setMousePos(pt);

        if (draggingIdx.current !== null) {
            e.preventDefault();
            setCalibPts(prev => {
                const next = [...prev];
                next[draggingIdx.current!] = pt;
                return next;
            });
        }
    }, [nearestCalibrationEndpoint]);

    const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
        draggingIdx.current = null;
        setIsDragging(false);
    }, []);

    const onPointerLeave = useCallback(() => {
        setMousePos(null);
        setCalibrationEndpoint(null);
        if (!isDragging) {
            draggingIdx.current = null;
        }
    }, [isDragging]);

    const inCalibMode = calibPhase === "placing" || calibPhase === "ready";
    const inPointerMode = inCalibMode || wallDrawMode;

    const clampPan = useCallback((pan: { x: number; y: number }, zoom = viewZoom) => {
        const workspace = workspaceRef.current;
        if (!workspace) return pan;
        const maxX = Math.max(0, (imgSize.w * zoom - workspace.clientWidth) / 2);
        const maxY = Math.max(0, (imgSize.h * zoom - workspace.clientHeight) / 2);
        return {
            x: Math.max(-maxX, Math.min(maxX, pan.x)),
            y: Math.max(-maxY, Math.min(maxY, pan.y)),
        };
    }, [imgSize, viewZoom]);

    const setZoom = useCallback((nextZoom: number, anchor?: { x: number; y: number }) => {
        const clampedZoom = Math.max(0.25, Math.min(4, nextZoom));
        isAtFitRef.current = clampedZoom === 1 && !anchor;
        if (anchor && workspaceRef.current) {
            const rect = workspaceRef.current.getBoundingClientRect();
            const anchorFromCenter = { x: anchor.x - rect.left - rect.width / 2, y: anchor.y - rect.top - rect.height / 2 };
            const ratio = clampedZoom / viewZoom;
            setViewPan(current => clampPan({
                x: anchorFromCenter.x - (anchorFromCenter.x - current.x) * ratio,
                y: anchorFromCenter.y - (anchorFromCenter.y - current.y) * ratio,
            }, clampedZoom));
        } else {
            setViewPan(current => clampPan(current, clampedZoom));
        }
        setViewZoom(clampedZoom);
        setZoomInput(String(Math.round(clampedZoom * 100)));
    }, [clampPan, viewZoom]);

    const stepZoom = useCallback((direction: -1 | 1) => {
        const currentIndex = direction > 0
            ? ZOOM_PRESETS.findIndex(level => level > viewZoom + 0.0001)
            : [...ZOOM_PRESETS].reverse().findIndex(level => level < viewZoom - 0.0001);
        const next = direction > 0
            ? ZOOM_PRESETS[currentIndex === -1 ? ZOOM_PRESETS.length - 1 : currentIndex]
            : ZOOM_PRESETS[currentIndex === -1 ? 0 : ZOOM_PRESETS.length - 1 - currentIndex];
        setZoom(next);
    }, [setZoom, viewZoom]);

    const commitZoomInput = useCallback(() => {
        const value = parseFloat(zoomInput.replace("%", ""));
        if (!Number.isNaN(value)) setZoom(value / 100);
        else setZoomInput(String(Math.round(viewZoom * 100)));
        setIsEditingZoom(false);
    }, [setZoom, viewZoom, zoomInput]);

    const onWorkspaceWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
        e.preventDefault();
        // Browser pinch gestures are delivered as ctrl+wheel. Trackpads normally
        // produce small pixel deltas (or horizontal deltas) for two-finger panning.
        const isTrackpadPan = !e.ctrlKey && (e.deltaX !== 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 50));
        if (!isTrackpadPan) {
            setZoom(viewZoom * Math.exp(-e.deltaY * 0.002), { x: e.clientX, y: e.clientY });
            return;
        }
        isAtFitRef.current = false;
        setViewPan(current => clampPan({ x: current.x - e.deltaX, y: current.y - e.deltaY }));
    }, [clampPan, setZoom, viewZoom]);

    // Chromium reports a trackpad pinch as Ctrl+wheel. React's delegated wheel
    // handler may be passive, so cancel it with a native non-passive listener at
    // the workspace boundary before the browser can zoom the entire page.
    useEffect(() => {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        const preventBrowserPinchZoom = (event: WheelEvent) => {
            if (event.ctrlKey) event.preventDefault();
        };
        workspace.addEventListener("wheel", preventBrowserPinchZoom, { passive: false });
        return () => workspace.removeEventListener("wheel", preventBrowserPinchZoom);
    }, []);

    const PAN_DRAG_THRESHOLD = 4; // px

    const onPanPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const target = e.target as Element;
        if (endpointDragRef.current) return;
        suppressEndpointClickRef.current = false;
        if (viewZoom <= 1 || inPointerMode || target.closest("button, input")) return;
        panStartRef.current = { x: e.clientX, y: e.clientY, panX: viewPan.x, panY: viewPan.y, captured: false };
        isAtFitRef.current = false;
        // ยังไม่ capture ตรงนี้ — รอดูก่อนว่าเป็น drag จริงหรือแค่ click
    }, [inPointerMode, viewPan, viewZoom]);

    const onPanPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (endpointDragRef.current) return;
        const start = panStartRef.current;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!start.captured) {
            if (Math.hypot(dx, dy) < PAN_DRAG_THRESHOLD) return; // ยังไม่ขยับพอ อาจเป็นแค่คลิก
            start.captured = true;
            setIsPanning(true);
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        }
        setViewPan(clampPan({ x: start.panX + dx, y: start.panY + dy }));
    }, [clampPan]);

    const onPanPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (panStartRef.current?.captured) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        panStartRef.current = null;
        setIsPanning(false);
    }, []);

    // ── Apply / reset ────────────────────────────────────────
    const applyCalibration = () => {
        const real = parseFloat(calibLength)          // เมตรที่ user ใส่
        const px   = pixelDist(calibPts[0], calibPts[1])  // pixel บนหน้าจอ
        if (!real || real <= 0 || px === 0) return

        const realMetres = real * (UNITS.find(candidate => candidate.value === calibUnit)?.toMeter ?? 1);
        const screenScale = realMetres / px
        const screenPpm = px / realMetres

        projectActions.run({ label: "calibration change" }, () => {
            onScaleChange(screenScale)
            onPlanSizeChange?.(imgSize.w * screenScale, imgSize.h * screenScale)
            onPpmChange?.(screenPpm)
            onConfirmedCalibration?.(confirmCalibration(calibPts, walls, realMetres));
        })

        setCalibPhase("applied")

    }

    const resetCalibration = () => {
        setCalibPhase("idle");
        setCalibPts([]);
        setCalibLength("");
        setMousePos(null);
        draggingIdx.current = null;
        setIsDragging(false);
        onScaleChange(0);
        onConfirmedCalibration?.([]);
        onPlanSizeChange?.(0, 0);
    };

    const startCalibration = () => {
        setLengthDraft(null);
        setCalibrationEndpoint(null);
        stopWallDraw();
        setCalibPhase("placing");
        setCalibPts([]);
        setCalibLength("");
        setMousePos(null);
    };

    const recalibrate = () => {
        setLengthDraft(null);
        setCalibLength("");
        if (calibPts.length >= 2) {
            // Points still exist → just re-enter distance
            setCalibPhase("ready");
        } else {
            // Returning from 3D or points lost → restart from scratch
            setCalibPts([]);
            setMousePos(null);
            setCalibPhase("placing");
        }
    };

    const applyWallHeight = () => {
        const h = Math.max(0.5, Math.min(20, localWallH || 2.8));
        setLocalWallH(h);
        onWallHeightChange?.(h);
    };
    const applyWallDefaults = () => {
        const height = Math.max(0.5, Math.min(20, localWallH || 2.8));
        const thickness = Math.max(0.01, localWallThickness || DEFAULT_WALL_THICKNESS_M);
        setLocalWallH(height);
        setLocalWallThickness(thickness);
        projectActions.run({ label: "all wall thickness change" }, () => {
            onWallHeightChange?.(height);
            walls.forEach(wall => onWallUpdate?.(wall.id, "thickness", thickness));
        });
        setWallDefaultsEditing(false);
    };

    // ── Batch opening sizes ─────────────────────────────────
    // Mirrors the Walls defaults editor: one shared draft, applied to every
    // existing opening of that kind. Width and host wall geometry are untouched.
    const sharedOpeningM = (records: Opening[], kind: OpeningKind, field: "height" | "sill") =>
        uniformOpeningM(records, kind, field, walls, planDimensions.width, planDimensions.height, wallHeightMeter);
    const allDoorHeight = sharedOpeningM(storedDoors, "door", "height");
    const allWindowHeight = sharedOpeningM(storedWindows, "window", "height");
    const allWindowSill = sharedOpeningM(storedWindows, "window", "sill");
    const startOpeningBatch = (kind: OpeningKind) => setOpeningEdit({ kind,
        height: (kind === "door" ? allDoorHeight : allWindowHeight)?.toFixed(2)
            ?? defaultOpeningHeight(kind, wallHeightMeter).toFixed(2),
        sill: kind === "window" ? allWindowSill?.toFixed(2) ?? defaultOpeningSill(kind, wallHeightMeter).toFixed(2) : "0" });
    const cancelOpeningBatch = () => setOpeningEdit(null);
    const applyOpeningBatch = () => {
        if (!openingEdit) return;
        const height = Number(openingEdit.height);
        if (!Number.isFinite(height) || height <= 0) return;
        const sill = openingEdit.kind === "window" ? Number(openingEdit.sill) : 0;
        if (!Number.isFinite(sill) || sill < 0) return;
        const geometryArgs = [walls, storedDoors, storedWindows, planDimensions.width, planDimensions.height, wallHeightMeter] as const;
        if (openingEdit.kind === "door") {
            if (!onDoorUpdate) return;
            projectActions.run({ label: "all door height change" }, () => {
                storedDoors.forEach(door => {
                    // editOpening clamps the height to the host wall, so each door keeps a valid size.
                    const updated = editOpening(door, "door", { mode: "height", value: height }, ...geometryArgs);
                    if (updated) onDoorUpdate(door.id, "heightM", updated.heightM);
                });
            });
        } else {
            if (!onWindowUpdate) return;
            projectActions.run({ label: "all window height change" }, () => {
                storedWindows.forEach(record => {
                    // Sill first: the wall only fits the height left above it.
                    const raised = editOpening(record, "window", { mode: "sill", value: sill }, ...geometryArgs);
                    if (raised) onWindowUpdate(record.id, "sillHeightM", raised.sillHeightM);
                    const resized = editOpening(raised ?? record, "window", { mode: "height", value: height }, ...geometryArgs);
                    if (resized) onWindowUpdate(record.id, "heightM", resized.heightM);
                });
            });
        }
        setOpeningEdit(null);
    };

    // ── Layer toggle ─────────────────────────────────────────
    const toggleLayer = (layer: OverlayLayer) =>
        setLayers(prev => {
            const nextLayers = new Set(prev);
            if (nextLayers.has(layer)) {
                nextLayers.delete(layer);
            } else {
                nextLayers.add(layer);
            }
            return nextLayers;
        });

    // The compact element list above supersedes these retained editor sections.
    const showLegacyEditorSections = false;

    // ── Room editing ─────────────────────────────────────────
    // FIX: ถ้า calibrate แล้ว แสดงค่าจาก bbox × imgSize × scale แทน normalized width/height
    const getDisplay = (room: Room, field: "width" | "height" | "wallHeight") => {
        if (field === "wallHeight") return +(room.wallHeight ?? wallHeightMeter).toFixed(2);
        const bbox = roomBBox(room);
        if (calibrated && bbox) {
            const metres = field === "width"
                ? bbox.w * planDimensions.width
                : bbox.h * planDimensions.height;
            return +metres.toFixed(2);
        }
        // ก่อน calibrate — แสดง normalized เป็น unit ที่เลือก (fallback)
        return +((field === "width" ? room.width : room.height) / currentUnit.toMeter).toFixed(2);
    };

    const startEdit  = (roomId: string, field: EditState["field"], val: number) => setEditState({ roomId, field, value: String(val) });
    const commitEdit = () => {
        if (!editState) return;
        const v = parseFloat(editState.value);
        if (!isNaN(v) && v > 0) {
            if (editState.field === "wallHeight") onRoomUpdate(editState.roomId, "wallHeight", v);
            else onRoomUpdate(editState.roomId, editState.field, v * currentUnit.toMeter);
        }
        setEditState(null);
    };
    const isEditing = (id: string, f: EditState["field"]) => editState?.roomId === id && editState?.field === f;

    // ── Wall editing ─────────────────────────────────────────
    // FIX: คำนวณความยาวกำแพงจาก normalized coords × imgSize × scale (เมตรจริง)
    // เดิมใช้ PLAN_SIZE = 20 ซึ่งเป็นตัวเลขสุ่ม ไม่ใช่เมตร
    const getWallLength = (w: DetectedWallSegment): number | null => {
        if (!calibrated) return null;
        return Math.hypot(
            (w.x2 - w.x1) * planDimensions.width,
            (w.y2 - w.y1) * planDimensions.height,
        );
    };
    const getWallThickness = (w: DetectedWallSegment): number =>
        getWallThicknessM(w, planDimensions.width, planDimensions.height);
    const hasWallThicknessMeasurement = (w: DetectedWallSegment): boolean =>
        calibrated || w.thickness > 0 || !(w.thicknessRatio > 0);
    const getWallHeight = (w: DetectedWallSegment): number | null =>
        typeof w.wallHeight === "number" ? w.wallHeight : wallHeightMeter;
    const getWallThicknessLabel = (w: DetectedWallSegment) =>
        `${(getWallThickness(w) * 100).toFixed(0)}cm`;
    const allWallThickness = walls.every(hasWallThicknessMeasurement)
        ? uniformWallThicknessM(walls, planDimensions.width, planDimensions.height) : null;

    const startWallEdit = (wallId: string, field: WallEditState["field"], val?: number | null) =>
        setWallEditState({ wallId, field, value: val == null ? "" : String(val) });
    const commitWallEdit = () => {
        if (!wallEditState || !onWallUpdate) return;
        const v = parseFloat(wallEditState.value);
        if (!isNaN(v) && v > 0) onWallUpdate(wallEditState.wallId, wallEditState.field, wallEditState.field === "thickness" ? v / 100 : v);
        setWallEditState(null);
    };
    const isWallEditing = (id: string, f: WallEditState["field"]) => wallEditState?.wallId === id && wallEditState?.field === f;

    // ── Selection ────────────────────────────────────────────
    const clearSelection = () => {
        setSelectedId(null);
        setSelectedWallId(null);
        setSelectedDoorId(null);
        setSelectedWindowId(null);
        setAdvancedOpen(false);
        setOtherElementsOpen(false);
    };
    const dismissInspector = () => {
        setSelectedId(null);
        setSelectedWallId(null);
        setSelectedDoorId(null);
        setSelectedWindowId(null);
        setAdvancedOpen(false);
    };
    const selectRoom = (id: string) => {
        setSelectedId(id); setSelectionType("room"); setSelectedWallId(null); setSelectedDoorId(null); setSelectedWindowId(null); setAdvancedOpen(false);
    };
    const selectWall = (id: string) => {
        setSelectedWallId(id); setSelectionType("wall"); setSelectedId(null); setSelectedDoorId(null); setSelectedWindowId(null); setAdvancedOpen(false);
    };
    const selectDoor = (id: string) => {
        setSelectedDoorId(id); setSelectionType("door"); setSelectedId(null); setSelectedWallId(null); setSelectedWindowId(null); setAdvancedOpen(false);
    };
    const selectWindow = (id: string) => {
        setSelectedWindowId(id); setSelectionType("window"); setSelectedId(null); setSelectedWallId(null); setSelectedDoorId(null); setAdvancedOpen(false);
    };
    const deleteSelectedWall = () => {
        if (!selectedWallId || !onWallDelete) return;
        onWallDelete(selectedWallId);
        clearSelection();
    };
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.key !== "Delete" && event.key !== "Backspace") || !selectedWallId || !onWallDelete) return;
            const target = event.target as HTMLElement | null;
            if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
            event.preventDefault();
            deleteSelectedWall();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [selectedWallId, onWallDelete]);
    useEffect(() => {
        if (!openingDrawMode) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            stopOpeningDraw();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [openingDrawMode]);
    const selectedRoom = rooms.find(r => r.id === selectedId);
    const topology = useMemo(() => buildWallTopology(walls), [walls]);
    const boundaryDimensions: PlanDimension[] = selectedRoom && calibrated ? roomBoundarySpans(selectedRoom, topology).map((span, i) => ({
        ...span, id: `room:${selectedRoom.id}:${i}`, boundary: true,
        length: Math.hypot((span.end.x - span.start.x) * planDimensions.width, (span.end.y - span.start.y) * planDimensions.height),
    })) : [];
    const measuredWall = renderWalls.find(w => w.id === selectedWallId);
    const canvasDimensions: PlanDimension[] = selectedRoom ? boundaryDimensions : measuredWall && calibrated ? [{
        id: `wall:${measuredWall.id}`, wallId: measuredWall.id, start: { x: measuredWall.x1, y: measuredWall.y1 }, end: { x: measuredWall.x2, y: measuredWall.y2 },
        length: Math.hypot((measuredWall.x2 - measuredWall.x1) * planDimensions.width, (measuredWall.y2 - measuredWall.y1) * planDimensions.height),
    }] : [];
    const selectedIdx  = rooms.findIndex(r => r.id === selectedId);
    const palette      = ROOM_SELECTION;
    const navigate     = (dir: -1 | 1) => { const n = selectedIdx + dir; if (n >= 0 && n < rooms.length) setSelectedId(rooms[n].id); };

    const roomBBox = (room: Room) => {
        if (room.bbox) return room.bbox;
        const poly = room.wallPolygon ?? room.polygon;
        if (!poly || poly.length === 0) return null;
        const xs = poly.map((p) => p.x);
        const ys = poly.map((p) => p.y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    };

    const polygonArea = (polygon?: { x: number; y: number }[] | null, pw = 1, ph = 1): number => {
        if (!polygon || polygon.length < 3) return 0;
        let area = 0;
        for (let i = 0; i < polygon.length; i += 1) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % polygon.length];
            area += p1.x * p2.y - p2.x * p1.y;
        }
        return Math.abs(area) * 0.5 * pw * ph;
    };

    const getRoomAreaM2 = (room: Room): number | null =>
        getMeasuredRoomArea(room, planDimensions.width, planDimensions.height, calibrated);

    // Preserve the room list's shared scale conversion. Before calibration it
    // deliberately returns null, so no approximate metre values are rendered.
    const bboxToM = (normDim: number, axis: "w" | "h"): number | null =>
        calibrated ? normDim * (axis === "w" ? planDimensions.width : planDimensions.height) : null;

    // FIX: คืน null เมื่อยังไม่ calibrate เพื่อให้ panel ขวา block ตัวเลขเมตร
    // ── ค่า label บน SVG overlay ────────────────────────────
    // ถ้ายังไม่ calibrate แสดง "N/A" แทนตัวเลขเมตร
    // Opening dimensions are only meaningful when the plan is calibrated and
    // the opening is explicitly attached to a wall. Project its persisted bbox
    // onto that wall's physical axis so Review uses the same span as the 3D cutout.
    const openingWidthM = (opening: Opening): number | null => calibrated
        ? openingGeometry(opening, "door", walls, planDimensions.width, planDimensions.height, wallHeightMeter)?.width ?? null : null;
    const polygonPath = (points?: { x: number; y: number }[] | null): string | null => {
        if (!points || points.length < 3) return null;
        return points.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ") + " Z";
    };

    const openingT = (point: CalibPoint, opening: Opening, kind: OpeningKind) => {
        const g = openingGeometry(opening, kind, walls, planDimensions.width, planDimensions.height, wallHeightMeter)!;
        return ((point.x - g.wall.x1) * planDimensions.width * (g.wall.x2 - g.wall.x1) * planDimensions.width
            + (point.y - g.wall.y1) * planDimensions.height * (g.wall.y2 - g.wall.y1) * planDimensions.height) / g.length;
    };
    const openingPoint = (event: React.PointerEvent<SVGSVGElement>) => {
        const r = event.currentTarget.getBoundingClientRect();
        return { x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height };
    };
    const commitOpening = (kind: OpeningKind, opening: Opening, edit: OpeningEdit) => {
        const updated = editOpening(opening, kind, edit, walls, storedDoors, storedWindows, planDimensions.width, planDimensions.height, wallHeightMeter);
        if (!updated) return;
        const field = edit.mode === "height" ? "heightM" : edit.mode === "sill" ? "sillHeightM" : "wallSpan";
        if (kind === "door") onDoorUpdate?.(opening.id, field, updated[field]);
        else onWindowUpdate?.(opening.id, field, updated[field]);
    };
    const startOpeningDrag = (event: React.PointerEvent<SVGSVGElement>) => {
        if (event.button !== 0 || inPointerMode || openingDrawMode || attachmentCandidate || openingDragRef.current) return false;
        const point = openingPoint(event), rect = event.currentTarget.getBoundingClientRect();
        const candidates = openingSet.active.filter(item => layers.has(item.kind === "door" ? "doors" : "windows"));
        const selected = candidates.find(item => item.kind === selectionType && item.opening.id === (item.kind === "door" ? selectedDoorId : selectedWindowId));
        let mode: OpeningDrag["mode"] = "move";
        let hit = selected && (["start", "end"] as const).some(end => {
            if (screenDistance(point, selected.geometry[end], rect) <= 8) { mode = end; return true; } return false;
        }) ? selected : undefined;
        hit ??= candidates.find(item => screenDistance(point, projectToWall(point, { ...item.geometry.wall,
            x1: item.geometry.start.x, y1: item.geometry.start.y, x2: item.geometry.end.x, y2: item.geometry.end.y }, rect), rect) <= 8);
        if (!hit || (hit.kind === "door" ? !onDoorUpdate : !onWindowUpdate)) return false;
        event.preventDefault(); event.stopPropagation();
        if (hit.kind === "door") selectDoor(hit.opening.id); else selectWindow(hit.opening.id);
        const drag: OpeningDrag = { kind: hit.kind, original: hit.opening, preview: hit.opening, mode,
            origin: openingT(point, hit.opening, hit.kind), pointerId: event.pointerId, walls };
        openingDragRef.current = drag; setOpeningDrag(drag);
        suppressEndpointClickRef.current = true; panStartRef.current = null; setIsPanning(false);
        event.currentTarget.setPointerCapture(event.pointerId);
        return true;
    };
    const moveOpeningDrag = (event: React.PointerEvent<SVGSVGElement>) => {
        const drag = openingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return false;
        event.preventDefault(); event.stopPropagation();
        if (drag.walls !== walls) return true;
        const point = openingPoint(event);
        const t = openingT(point, drag.original, drag.kind);
        const originalGeometry = openingGeometry(drag.original, drag.kind, walls, planDimensions.width, planDimensions.height, wallHeightMeter)!;
        const rehost = drag.mode === "move" && onOpeningRehost ? findOpeningRehost(drag.original, drag.kind, point,
            event.currentTarget.getBoundingClientRect(), walls, storedDoors, storedWindows, planDimensions.width, planDimensions.height,
            wallHeightMeter, drag.origin - (originalGeometry.tStart + originalGeometry.tEnd) / 2) : null;
        const preview = rehost ?? editOpening(drag.original, drag.kind, { mode: drag.mode, value: drag.mode === "move" ? t - drag.origin : t }, walls,
            storedDoors, storedWindows, planDimensions.width, planDimensions.height, wallHeightMeter);
        openingDragRef.current = { ...drag, preview: preview ?? drag.original }; setOpeningDrag(openingDragRef.current);
        return true;
    };
    const finishOpeningDrag = (event: React.PointerEvent<SVGSVGElement>) => {
        if (!openingDragRef.current || openingDragRef.current.pointerId !== event.pointerId) return false;
        if (event.type === "pointerup" && openingDragRef.current.walls === walls) moveOpeningDrag(event);
        const drag = openingDragRef.current!;
        openingDragRef.current = null; setOpeningDrag(null);
        event.preventDefault(); event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (event.type === "pointerup" && drag.walls === walls && drag.preview.wallId !== drag.original.wallId) {
            const g = openingGeometry(drag.preview, drag.kind, walls, planDimensions.width, planDimensions.height, wallHeightMeter);
            if (g) onOpeningRehost?.(drag.kind, drag.original.id, g.wall.id, { x: (g.start.x + g.end.x) / 2, y: (g.start.y + g.end.y) / 2 });
        } else if (event.type === "pointerup" && drag.walls === walls && JSON.stringify(drag.preview.wallSpan) !== JSON.stringify(drag.original.wallSpan)) {
            if (drag.kind === "door") onDoorUpdate?.(drag.original.id, "wallSpan", drag.preview.wallSpan);
            else onWindowUpdate?.(drag.original.id, "wallSpan", drag.preview.wallSpan);
        }
        return true;
    };

    const endpointDistancePx = screenDistance;
    const startEndpointDrag = (event: React.PointerEvent<SVGSVGElement>, wallId: string, endpoint?: "start" | "end") => {
        if (lengthDraft || event.button !== 0 || endpointDragRef.current || !onWallGeometryCommit) return;
        const persistedWall = walls.find(wall => wall.id === wallId);
        if (!persistedWall) return;
        const wall = { ...persistedWall };
        const svg = event.currentTarget;
        const rect = svg.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        event.preventDefault();
        event.stopPropagation();
        const origin = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
        const point = endpoint ? endpointPoint(wall, endpoint) : origin;
        const blockedTargets = new Set(wallSnapTargets(point, walls, new Set([wall.id]), rect)
            .filter(target => screenDistance(point, target, rect) < SNAP_PX).map(target => target.key));
        const drag: EndpointDrag = { wall, endpoint, baseWalls: walls, previewWalls: walls, origin,
            pointerId: event.pointerId, preview: wall, snapTarget: null, blockedTargets,
            connectionTargets: [], feedbackSize: { width: rect.width, height: rect.height },
            reverseBlocked: new Set(walls.filter(other => other.id !== wall.id).flatMap(other =>
                (["start", "end"] as const).filter(end => {
                    const point = endpointPoint(other, end);
                    return screenDistance(point, projectToWall(point, wall, rect), rect) < SNAP_PX;
                }).map(end => `${other.id}:${end}`))),
            blockedEndpoints: Object.fromEntries((["start", "end"] as const).map(end => {
                const endpoint = endpointPoint(wall, end);
                return [end, new Set(wallSnapTargets(endpoint, walls, new Set([wall.id]), rect)
                    .filter(target => screenDistance(endpoint, target, rect) < SNAP_PX)
                    .map(target => target.key))];
            })) as Record<"start" | "end", Set<string>> };
        endpointDragRef.current = drag;
        setEndpointDrag(drag);
        suppressEndpointClickRef.current = true;
        panStartRef.current = null;
        setIsPanning(false);
        selectWall(wall.id);
        svg.setPointerCapture(event.pointerId);
    };
    // Endpoint handles are active affordances drawn above every overlay, so a
    // press inside one edits the selected wall even when a door or window sits on
    // top of it. Handles of a selected opening still win: only a selected wall can
    // reach this path, and a door/window selection clears the wall selection.
    const startSelectedWallEndpointDrag = (event: React.PointerEvent<SVGSVGElement>) => {
        if (inPointerMode || openingDrawMode || !layers.has("walls")) return false;
        const wall = walls.find(item => item.id === selectedWallId);
        if (!wall) return false;
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const point = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
        const startDistance = endpointDistancePx(point, { x: wall.x1, y: wall.y1 }, rect);
        const endDistance = endpointDistancePx(point, { x: wall.x2, y: wall.y2 }, rect);
        if (Math.min(startDistance, endDistance) > ENDPOINT_HIT_RADIUS_PX) return false;
        startEndpointDrag(event, wall.id, startDistance <= endDistance ? "start" : "end");
        // Only claim the gesture when the handle really became active, so a wall
        // that cannot be edited keeps the normal overlapping-element priority.
        return endpointDragRef.current !== null;
    };
    const onEndpointPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
        if (inPointerMode || openingDrawMode || !layers.has("walls")) return;
        const wall = walls.find(item => item.id === selectedWallId);
        if (!wall) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const point = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
        // A selected wall body can be translated; background gestures still pan.
        // Respect existing door/window hit priority outside endpoint handles.
        const inOpening = (bbox: { x: number; y: number; w: number; h: number }) =>
            point.x >= bbox.x - 0.012 && point.x <= bbox.x + bbox.w + 0.012 && point.y >= bbox.y - 0.012 && point.y <= bbox.y + bbox.h + 0.012;
        if ((layers.has("doors") && doors.some(item => inOpening(item.bbox))) || (layers.has("windows") && windows.some(item => inOpening(item.bbox)))) return;
        const closest = walls.map(item => ({ wall: item, distance: screenDistance(point, projectToWall(point, item, rect), rect) }))
            .filter(item => item.distance <= 12).sort((a, b) => a.distance - b.distance || a.wall.id.localeCompare(b.wall.id))[0];
        if (closest?.wall.id === wall.id) startEndpointDrag(event, wall.id);
    };
    const moveEndpointDrag = (event: React.PointerEvent<SVGSVGElement>) => {
        const drag = endpointDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        // The transformed bounds include the canvas pan and zoom; coordinates
        // stay in normalized plan space, including outside the image bounds.
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const raw = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
        if (!drag.endpoint && screenDistance(raw, drag.origin, rect) < 4 && drag.previewWalls === drag.baseWalls) return;
        let updated = drag.endpoint
            ? { ...drag.wall, ...(drag.endpoint === "start" ? { x1: raw.x, y1: raw.y } : { x2: raw.x, y2: raw.y }) }
            : { ...drag.wall, x1: drag.wall.x1 + raw.x - drag.origin.x, y1: drag.wall.y1 + raw.y - drag.origin.y,
                x2: drag.wall.x2 + raw.x - drag.origin.x, y2: drag.wall.y2 + raw.y - drag.origin.y };
        const unsnapped = editWallGeometry(drag.baseWalls, updated, drag.endpoint);
        if (!unsnapped) {
            endpointDragRef.current = { ...drag, preview: drag.wall, previewWalls: drag.baseWalls, snapTarget: null, connectionTargets: [], feedbackSize: { width: rect.width, height: rect.height } };
            setEndpointDrag(endpointDragRef.current);
            return;
        }
        let snapTarget: WallSnap | null = null;
        let connectionTargets: WallSnap[] = [];
        if (drag.endpoint) {
            const excluded = new Set([drag.wall.id]);
            snapTarget = findWallSnap(raw, wallSnapTargets(raw, drag.baseWalls, excluded, rect), rect, drag.blockedTargets);
            if (snapTarget) updated = { ...drag.wall, ...(drag.endpoint === "start" ? { x1: snapTarget.x, y1: snapTarget.y } : { x2: snapTarget.x, y2: snapTarget.y }) };
        }
        if (!drag.endpoint) {
            const snapped = snapWallTranslation(updated, drag.baseWalls, rect, drag.blockedEndpoints, drag.reverseBlocked);
            updated = snapped.wall;
            connectionTargets = snapped.targets;
        }
        const previewWalls = snapTarget || connectionTargets.length ? editWallGeometry(drag.baseWalls, updated, drag.endpoint, { exact: true }) : unsnapped;
        if (!previewWalls) return;
        const preview = previewWalls.find(wall => wall.id === drag.wall.id)!;
        endpointDragRef.current = { ...drag, preview, previewWalls, snapTarget, connectionTargets,
            feedbackSize: { width: rect.width, height: rect.height } };
        setEndpointDrag(endpointDragRef.current);
    };
    const finishEndpointDrag = (event: React.PointerEvent<SVGSVGElement>) => {
        // Pointer-up can carry a newer position than the last move event.
        const currentPreview = endpointDragRef.current;
        const hasEndpointSnapPreview = !!currentPreview?.endpoint && !!currentPreview.snapTarget;
        if (event.type === "pointerup" && currentPreview?.previewWalls !== currentPreview?.baseWalls && !hasEndpointSnapPreview) moveEndpointDrag(event);
        const drag = endpointDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        endpointDragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (event.type !== "pointercancel" && event.type !== "lostpointercapture") {
            if (drag.previewWalls.some((wall, index) => geometryChanged(drag.baseWalls[index], wall))) onWallGeometryCommit?.(drag.previewWalls, { exact: !!drag.snapTarget });
        }
        setEndpointDrag(null);
        selectWall(drag.wall.id);
    };

    const findOpeningWallAt = (point: CalibPoint, rect: DOMRect): DetectedWallSegment | null => {
        let targetWall: DetectedWallSegment | null = null;
        let closestDistance = 12;
        for (const wall of walls) {
            const ax = wall.x1 * rect.width, ay = wall.y1 * rect.height;
            const bx = wall.x2 * rect.width, by = wall.y2 * rect.height;
            const px = point.x * rect.width, py = point.y * rect.height;
            const dx = bx - ax, dy = by - ay;
            const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
            const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
            if (distance < closestDistance || (distance === closestDistance && (!targetWall || wall.id < targetWall.id))) {
                targetWall = wall;
                closestDistance = distance;
            }
        }
        return targetWall;
    };

    // Resolve selection from plan-space coordinates so direct selection remains
    // reliable for thin detected lines and at every viewport zoom/pan level.
    const onPlanClick = (e: React.MouseEvent<SVGSVGElement>) => {
        if ((e.target as Element).closest("[data-plan-dimension]")) return;
        if (suppressEndpointClickRef.current || endpointDragRef.current || openingDragRef.current) {
            suppressEndpointClickRef.current = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (inPointerMode) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const point = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
        const inRect = (bbox: { x: number; y: number; w: number; h: number }, pad = 0) =>
            point.x >= bbox.x - pad && point.x <= bbox.x + bbox.w + pad && point.y >= bbox.y - pad && point.y <= bbox.y + bbox.h + pad;
        const inPolygon = (polygon: { x: number; y: number }[]) => {
            let inside = false;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                const a = polygon[i], b = polygon[j];
                if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
            }
            return inside;
        };
        const distanceToSegmentPx = (wall: DetectedWallSegment) => {
            const ax = wall.x1 * rect.width, ay = wall.y1 * rect.height;
            const bx = wall.x2 * rect.width, by = wall.y2 * rect.height;
            const px = point.x * rect.width, py = point.y * rect.height;
            const dx = bx - ax, dy = by - ay;
            const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
            return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        };

        if (attachmentCandidate) {
            const targetWall = findOpeningWallAt(point, rect);
            if (targetWall) setAttachmentCandidate({ ...attachmentCandidate, wallId: targetWall.id });
            return;
        }

        if (openingDrawMode) {
            const targetWall = findOpeningWallAt(point, rect);
            if (!targetWall) return;
            const transition = advanceOpeningDraft(openingDraft, openingDrawMode, targetWall.id, point);
            if (!transition.confirms) {
                setOpeningDraft(transition.draft);
                return;
            }
            if (!openingDraft) return;
            const bbox = createOpeningBboxFromWallPoints(targetWall, openingDraft.start, point, planDimensions.width, planDimensions.height);
            if (!bbox) return;
            const id = `manual-${openingDrawMode}-${Date.now()}`;
            if (openingDrawMode === "door") {
                const created = newOpeningRecord<DetectedDoor>("door", id, targetWall, openingDraft.start, point,
                    planDimensions.width, planDimensions.height, wallHeightMeter);
                if (created) {
                    onDoorAdd?.(created);
                    selectDoor(id);
                }
            } else {
                const created = newOpeningRecord<DetectedWindow>("window", id, targetWall, openingDraft.start, point,
                    planDimensions.width, planDimensions.height, wallHeightMeter);
                if (created) {
                    onWindowAdd?.(created);
                    selectWindow(id);
                }
            }
            stopOpeningDraw();
            return;
        }

        const hitsOpening = (kind: OpeningKind, id: string) => openingSet.active.some(item => item.kind === kind && item.opening.id === id
            && screenDistance(point, projectToWall(point, { ...item.geometry.wall, x1: item.geometry.start.x, y1: item.geometry.start.y,
                x2: item.geometry.end.x, y2: item.geometry.end.y }, rect), rect) <= 8);
        const door = layers.has("doors") && doors.find(item => hitsOpening("door", item.id));
        if (door) return selectDoor(door.id);
        const windowItem = layers.has("windows") && windows.find(item => hitsOpening("window", item.id));
        if (windowItem) return selectWindow(windowItem.id);
        let wall: DetectedWallSegment | null = null;
        let closestDistance = 12;
        if (layers.has("walls")) {
            for (const candidate of walls) {
                const distance = distanceToSegmentPx(candidate);
                if (distance < closestDistance || (distance === closestDistance && (!wall || candidate.id < wall.id))) {
                    wall = candidate;
                    closestDistance = distance;
                }
            }
        }
        if (wall) return selectWall(wall.id);
        const room = layers.has("rooms") && rooms.find(item => {
            const polygon = item.wallPolygon ?? item.polygon;
            if (!polygon || polygon.length < 3) {
                const bbox = roomBBox(item);
                return bbox ? inRect(bbox) : false;
            }
            if (!inPolygon(polygon)) return false;
            // An enclosure inside a room is its own room, not the parent one.
            return !(item.holes ?? []).some(hole => hole.length >= 3 && inPolygon(hole));
        });
        if (room) return selectRoom(room.id);
        clearSelection();
    };

    const openingPreview = (() => {
        if (!openingDrawMode || !openingDraft || !mousePos || openingDraft.wallId !== openingHoverWallId) return null;
        const wall = walls.find(item => item.id === openingDraft.wallId);
        if (!wall) return null;
        const bbox = createOpeningBboxFromWallPoints(wall, openingDraft.start, mousePos, planDimensions.width, planDimensions.height);
        return bbox ? { bbox, kind: openingDraft.kind, wallId: wall.id } : null;
    })();
    const openingPreviewWidthM = openingPreview
        ? openingWidthM({ id: "opening-preview", bbox: openingPreview.bbox, wallId: openingPreview.wallId })
        : null;

    const updateOpeningPreview = (event: React.PointerEvent<SVGSVGElement>) => {
        if (moveOpeningDrag(event)) return;
        moveEndpointDrag(event);
        if (!openingDrawMode) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const point = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
        const targetWall = findOpeningWallAt(point, rect);
        setOpeningHoverWallId(isValidOpeningTarget(openingDraft, targetWall?.id ?? null) ? targetWall!.id : null);
        setMousePos(point);
    };

    // ─────────────────────────────────────────────────────────
    // SUB COMPONENT
    // ─────────────────────────────────────────────────────────
    const EditableCell = ({ room, field, label, suffix }: { room: Room; field: EditState["field"]; label: string; suffix: string }) => {
        const val = getDisplay(room, field);
        // ถ้ายังไม่ calibrate และไม่ใช่ wallHeight → แสดง placeholder
        const showPlaceholder = !calibrated && field !== "wallHeight";
        return (
            <div className="flex-1 min-w-0">
                <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
                {showPlaceholder ? (
                    <div className="flex items-center gap-1 px-1 py-0.5">
                        <span className="text-sm font-mono text-muted-foreground/40">—</span>
                        <span className="text-[10px] text-muted-foreground/30">m</span>
                    </div>
                ) : isEditing(room.id, field) ? (
                    <div className="flex items-center gap-0.5">
                        <Input type="number" autoFocus value={editState!.value}
                            onChange={e => setEditState(s => s ? { ...s, value: e.target.value } : s)}
                            onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditState(null); }}
                            className="h-7 text-xs font-mono px-2 border-primary/60" />
                        <button onClick={commitEdit} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400"><Check className="w-3 h-3" /></button>
                        <button onClick={() => setEditState(null)} className="p-1 rounded hover:bg-red-500/20 text-red-400"><X className="w-3 h-3" /></button>
                    </div>
                ) : (
                    <button onClick={() => startEdit(room.id, field, val)}
                        className="group flex items-center gap-1 w-full text-left px-1 py-0.5 -mx-1 rounded hover:bg-slate-100 transition-colors">
                        <span className="text-sm font-mono font-semibold text-foreground">{val}</span>
                        <span className="text-[10px] text-muted-foreground">{suffix}</span>
                        <Pencil className="w-2.5 h-2.5 opacity-0 group-hover:opacity-50 ml-auto transition-opacity" />
                    </button>
                )}
            </div>
        );
    };

    // ─────────────────────────────────────────────────────────
    // RENDER
    // ─────────────────────────────────────────────────────────
    return (
        <div className="flex-1 flex flex-col overflow-hidden">

            {/* TOP BAR */}
            <div className="shrink-0 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-border bg-card/30 px-5 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                    <div className="contents">
                        <span className="text-sm font-semibold text-foreground">Review &amp; Edit</span>
                        <span className="basis-full text-[11px] text-muted-foreground 2xl:basis-auto">
                            {rooms.length} rooms · {walls.length} walls · {doors.length} doors · {windows.length} windows
                        </span>
                    </div>
                </div>

                <div className="flex flex-nowrap items-center justify-self-end gap-3 whitespace-nowrap">

                    {/* CALIBRATION WIDGET */}
                    <div className={`flex items-center gap-2 rounded-lg px-3 py-1.5 border transition-all duration-200 ${
                        inCalibMode                ? "border-amber-500/60 bg-amber-500/10"
                        : calibPhase === "applied" ? "border-emerald-500/40 bg-emerald-500/8"
                        : "border-border bg-card/80"
                    }`}>
                        {/* IDLE */}
                        {calibPhase === "idle" && (
                            <button onClick={startCalibration}
                                className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300 hover:text-amber-200 transition-colors">
                                <Crosshair className="w-3.5 h-3.5" />
                                Calibrate Scale
                            </button>
                        )}

                        {/* APPLIED */}
                        {calibPhase === "applied" && (
                            <>
                                <button onClick={recalibrate}
                                    className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors">
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    {scale.toFixed(5)} m/px
                                </button>
                                <button onClick={resetCalibration} title="รีเซ็ต"
                                    className="hidden">
                                    <RotateCcw className="w-3 h-3" />
                                </button>
                            </>
                        )}

                        {/* PLACING */}
                        {calibPhase === "placing" && (
                            <>
                                <Crosshair className="w-3.5 h-3.5 text-amber-400 animate-pulse shrink-0" />
                                <span className="text-[11px] text-amber-300 font-medium">
                                    {calibPts.length === 0 ? "คลิก P1 บนรูป" : "คลิก P2"}
                                </span>
                                <button onClick={resetCalibration} className="p-1 rounded hover:bg-slate-100 text-muted-foreground">
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </>
                        )}

                        {/* READY */}
                        {calibPhase === "ready" && (
                            <>
                                <Crosshair className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                <span className="text-[11px] text-amber-300 font-medium whitespace-nowrap">
                                    {livePixelDist ? `${livePixelDist.toFixed(0)}px =` : "ระยะ ="}
                                </span>
                                <Input
                                    placeholder="3.5"
                                    value={calibLength}
                                    onChange={e => setCalibLength(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter") applyCalibration(); if (e.key === "Escape") resetCalibration(); }}
                                    className="h-7 w-20 text-xs font-mono border-amber-500/60 bg-background"
                                    autoFocus
                                />
                                <select value={calibUnit} onChange={e => setCalibUnit(e.target.value as DimensionUnit)} className="h-7 rounded border border-border bg-background px-1 text-[10px] text-foreground">
                                    {UNITS.map(candidate => <option key={candidate.value} value={candidate.value}>{candidate.value}</option>)}
                                </select>
                                <Button onClick={applyCalibration}
                                    disabled={!calibLength || isNaN(parseFloat(calibLength))}
                                    size="sm"
                                    className="h-7 px-3 text-xs bg-amber-500 hover:bg-amber-400 text-black font-semibold disabled:opacity-40">
                                    Apply
                                </Button>
                                <button onClick={resetCalibration} className="p-1 rounded hover:bg-slate-100 text-muted-foreground">
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </>
                        )}
                    </div>

                    {/* WALL HEIGHT GLOBAL */}
                    <div className="hidden"
                         title="ความสูงผนังรวม (พื้น-ฝ้า) ทั้งบ้าน — ใช้สำหรับ Extrude 3D">
                        <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">H ผนัง</span>
                        <input
                            type="number"
                            step="0.1"
                            min="0.5"
                            max="20"
                            value={localWallH}
                            onChange={e => setLocalWallH(parseFloat(e.target.value) || 2.8)}
                            onKeyDown={e => { if (e.key === "Enter") applyWallHeight(); }}
                            onBlur={applyWallHeight}
                            className="h-7 w-14 rounded-md border border-input bg-background px-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <span className="text-[10px] text-muted-foreground shrink-0">m</span>
                    </div>

                    {/* WALL DRAW TOOL */}
                    <div ref={addMenuRef} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 border transition-all duration-200 ${
                        (wallDrawMode || openingDrawMode) ? "border-blue-500/60 bg-blue-500/10" : "border-border bg-card/80"
                    }`}>
                        {!wallDrawMode && !openingDrawMode ? (
                            <>
                            <button onClick={() => setAddMenuOpen(open => !open)}
                                className="flex items-center gap-1.5 text-[11px] font-medium text-blue-500 hover:text-blue-400 transition-colors">
                                <Plus className="w-3.5 h-3.5" />
                                Add Element <ChevronDown className="w-3 h-3" />
                            </button>
                            {addMenuOpen && <div className="absolute z-50 mt-2 w-36 rounded-lg border border-border bg-card p-1 shadow-xl">
                                <button onClick={() => { startWallDraw(); setAddMenuOpen(false); }} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-accent"><Pencil className="w-3.5 h-3.5" />Wall</button>
                                <button onClick={() => { startOpeningDraw("door"); setAddMenuOpen(false); }} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-accent"><DoorOpen className="w-3.5 h-3.5" />Door</button>
                                <button onClick={() => { startOpeningDraw("window"); setAddMenuOpen(false); }} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-accent"><AppWindow className="w-3.5 h-3.5" />Window</button>
                            </div>}
                            </>
                        ) : (
                            <>
                                {wallDrawMode ? <Pencil className="w-3.5 h-3.5 text-blue-400 animate-pulse shrink-0" /> : openingDrawMode === "door" ? <DoorOpen className="w-3.5 h-3.5 text-blue-400 animate-pulse shrink-0" /> : <AppWindow className="w-3.5 h-3.5 text-blue-400 animate-pulse shrink-0" />}
                                <span className="text-[11px] text-blue-300 font-medium whitespace-nowrap">
                                    {wallDrawMode ? (wallDraftStart ? "Click end point" : "Click start point") : (openingDraft ? "Click opening end on the same wall" : "Click opening start on a wall")}
                                </span>
                                <button onClick={wallDrawMode ? stopWallDraw : stopOpeningDraw} className="p-1 rounded hover:bg-slate-100 text-muted-foreground">
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </>
                        )}
                    </div>

                    {/* LAYER TOGGLES */}
                    <div className="flex items-center gap-1 bg-card/80 rounded-lg p-1 border border-border shadow-sm">
                        <button onClick={() => toggleLayer("image")}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all duration-150 border ${
                                layers.has("image") ? "bg-accent text-foreground border-border" : "text-muted-foreground/50 hover:text-foreground border-transparent"
                            }`}>
                            {layers.has("image") ? <Eye className="w-3 h-3 text-emerald-400" /> : <EyeOff className="w-3 h-3" />}
                            <span className="hidden sm:inline">Image</span>
                        </button>
                        <div className="w-px h-4 bg-border mx-0.5" />
                        {([
                            { id: "rooms",   label: "Rooms",   color: "#60a5fa" },
                            { id: "walls",   label: "Walls",   color: "#94a3b8" },
                            { id: "doors",   label: "Doors",   color: "#f59e0b" },
                            { id: "windows", label: "Windows", color: "#f472b6" },
                        ] as { id: OverlayLayer; label: string; color: string }[]).map(({ id, label, color }) => (
                            <button key={id} onClick={() => toggleLayer(id)}
                                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all duration-150 ${
                                    layers.has(id) ? "bg-accent text-foreground" : "text-muted-foreground/50 hover:text-foreground"
                                }`}>
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: layers.has(id) ? color : "#374151" }} />
                                <span className="hidden sm:inline">{label}</span>
                            </button>
                        ))}
                    </div>

                    <div className="flex overflow-hidden rounded-lg border border-border bg-card/80">
                        <button onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl/Cmd + Z)" className="p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"><RotateCcw className="w-4 h-4" /></button>
                        <button onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl/Cmd + Shift + Z)" className="border-l border-border p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"><RotateCcw className="w-4 h-4 -scale-x-100" /></button>
                    </div>

                    <Button onClick={onGenerate}
                        className="gap-2 h-9 px-4 text-xs font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-[0_0_16px_rgba(59,130,246,0.35)] hover:shadow-[0_0_24px_rgba(59,130,246,0.5)] transition-all">
                        <Zap className="w-3.5 h-3.5" />Generate 3D<ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                </div>
            </div>

            {/* MAIN SPLIT */}
            <div className="flex-1 flex min-h-0">

                {/* LEFT: IMAGE */}
                <div
                    ref={workspaceRef}
                    onWheel={onWorkspaceWheel}
                    onPointerDown={onPanPointerDown}
                    onPointerMove={onPanPointerMove}
                    onPointerUp={onPanPointerUp}
                    onPointerCancel={onPanPointerUp}
                    className="flex-1 relative bg-background overflow-hidden"
                    style={{ cursor: viewZoom > 1 && !inPointerMode ? (isPanning ? "grabbing" : "grab") : undefined }}
                >
                    {(backgroundImageUrl ?? imageUrl) ? (
                        <div className="relative w-full h-full">
                            <div
                                className="absolute left-1/2 top-1/2"
                                style={{
                                    width: imgSize.w,
                                    height: imgSize.h,
                                    lineHeight: 0,
                                    transform: `translate(-50%, -50%) translate(${viewPan.x}px, ${viewPan.y}px) scale(${viewZoom})`,
                                    transformOrigin: "center center",
                                }}
                            >

                                <img ref={imgRef} src={backgroundImageUrl ?? imageUrl ?? ""} alt="Floor plan" draggable={false}
                                    className="block w-full h-full rounded-lg shadow-2xl select-none transition-opacity duration-300"
                                    style={{ filter: "brightness(0.92) contrast(1.05)", opacity: layers.has("image") ? 1 : 0, pointerEvents: "none" }}
                                    onLoad={(e) => setSourceSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                                />

                                {/* Pointer capture overlay — only active in calib mode */}
                                {inPointerMode && (
                                    <div
                                        ref={overlayRef}
                                        className="absolute inset-0 z-20"
                                        style={{
                                            cursor: cursorStyle,
                                            touchAction: "none",
                                            userSelect: "none",
                                            WebkitUserSelect: "none",
                                        }}
                                        onPointerDown={wallDrawMode ? onWallDrawPointerDown : onPointerDown}
                                        onPointerMove={wallDrawMode ? onWallDrawPointerMove : onPointerMove}
                                        onPointerUp={wallDrawMode ? undefined : onPointerUp}
                                        onPointerLeave={wallDrawMode ? onWallDrawPointerLeave : onPointerLeave}
                                        onContextMenu={e => { e.preventDefault(); if (wallDrawMode) stopWallDraw(); }}
                                    />
                                )}

                                {/* SVG overlays */}
                                <svg className="absolute inset-0 z-10" width="100%" height="100%"
                                    viewBox="0 0 100 100" preserveAspectRatio="none"
                                    style={{ overflow: "visible", pointerEvents: inPointerMode ? "none" : "all", touchAction: "none", cursor: openingDrawMode ? cursorStyle : undefined }}
                                    onPointerDownCapture={event => { if ((event.target as Element).closest("[data-plan-dimension]")) return; if (startSelectedWallEndpointDrag(event)) return; if (!startOpeningDrag(event)) onEndpointPointerDown(event); }}
                                    onPointerMove={updateOpeningPreview}
                                    onPointerUp={event => { if (!finishOpeningDrag(event)) finishEndpointDrag(event); }}
                                    onPointerCancel={event => { if (!finishOpeningDrag(event)) finishEndpointDrag(event); }}
                                    onLostPointerCapture={event => { if (!finishOpeningDrag(event)) finishEndpointDrag(event); }}
                                    onPointerLeave={() => { if (openingDrawMode) { setMousePos(null); setOpeningHoverWallId(null); } }}
                                    onClickCapture={onPlanClick}>

                                    <g transform="scale(100)">

                                    {/* WALLS */}
                                    {layers.has("walls") && walls.map(wall => {
                                        const isSel = selectedWallId === wall.id || attachmentCandidate?.wallId === wall.id;
                                        const displayWall = renderWalls.find(item => item.id === wall.id) ?? wall;
                                        const sw = Math.max(0.002, wallStrokeWidthNormalized(wall, planDimensions.width, planDimensions.height));
                                        const isManual = wall.id.startsWith("manual-wall-");
                                        const col = isSel ? "#2563eb" : isManual ? "#38bdf8" : wall.type === "exterior" ? "#1a1a1a" : "#2563eb";

                                        return (
                                            <g key={wall.id} data-wall-id={wall.id} style={{ cursor: openingDrawMode ? cursorStyle : isSel ? "move" : "pointer", pointerEvents: "all" }}>
                                                <line x1={displayWall.x1} y1={displayWall.y1} x2={displayWall.x2} y2={displayWall.y2} stroke="transparent" strokeWidth={sw + 0.025} pointerEvents="stroke" />
                                                <path data-wall-footprint={wall.id} d={footprintPaths.get(wall.id) ?? ""}
                                                    fill={col} fillRule="nonzero" stroke="none" />
                                            </g>
                                        );
                                    })}

                                    {/* MANUAL WALL DRAFT */}
                                    {wallDrawMode && wallDraftStart && wallDraftMouse && (
                                        <g style={{ pointerEvents: "none" }}>
                                            <line
                                                x1={wallDraftStart.x}
                                                y1={wallDraftStart.y}
                                                x2={wallDraftMouse.x}
                                                y2={wallDraftMouse.y}
                                                stroke="#38bdf8"
                                                strokeWidth={0.006}
                                                strokeLinecap="square"
                                                strokeDasharray="0.012 0.008"
                                                opacity={0.95}
                                            />
                                            <circle cx={wallDraftStart.x} cy={wallDraftStart.y} r={0.009} fill="#38bdf8" />
                                            <circle cx={wallDraftMouse.x} cy={wallDraftMouse.y} r={0.007} fill="#38bdf8" opacity={0.75} />
                                        </g>
                                    )}

                                    {openingPreview && (
                                        <g data-opening-preview={openingPreview.kind} style={{ pointerEvents: "none" }}>
                                            <rect x={openingPreview.bbox.x} y={openingPreview.bbox.y} width={openingPreview.bbox.w} height={openingPreview.bbox.h}
                                                fill={openingPreview.kind === "door" ? "rgba(245,158,11,0.20)" : "rgba(244,114,182,0.18)"}
                                                stroke={openingPreview.kind === "door" ? "#f59e0b" : "#f472b6"}
                                                strokeWidth={0.004} strokeDasharray={openingPreview.kind === "door" ? undefined : "0.010 0.006"} />
                                            {openingPreviewWidthM !== null && <text
                                                data-opening-preview-width
                                                x={openingPreview.bbox.x + openingPreview.bbox.w / 2}
                                                y={openingPreview.bbox.y - 0.012}
                                                textAnchor="middle"
                                                fontSize={0.013}
                                                fontWeight="700"
                                                fill={openingPreview.kind === "door" ? "#f59e0b" : "#f472b6"}
                                                fontFamily="monospace"
                                            >
                                                {`${openingPreviewWidthM.toFixed(2)}m`}
                                            </text>}
                                        </g>
                                    )}

                                    {/* ROOMS */}
                                    {layers.has("rooms") && rooms.map((room) => {
                                        const bbox = roomBBox(room);
                                        const polygon = room.wallPolygon ?? room.polygon ?? null;
                                        if (!bbox && (!polygon || polygon.length < 3)) return null;
                                        const cs = CONF_STYLE[room.confidence] ?? CONF_STYLE.manual;
                                        const pal = ROOM_SELECTION;
                                        const isSel = selectedId === room.id;
                                        const points = polygon && polygon.length >= 3
                                            ? polygon.map((p) => `${p.x},${p.y}`).join(" ")
                                            : `${bbox.x},${bbox.y} ${bbox.x + bbox.w},${bbox.y} ${bbox.x + bbox.w},${bbox.y + bbox.h} ${bbox.x},${bbox.y + bbox.h}`;
                                        const holes = (room.holes ?? []).filter(hole => hole.length >= 3);
                                        const facePath = polygon && polygon.length >= 3 && holes.length ? ringsToPathD([polygon, ...holes]) : null;
                                        const cx = room.center?.x ?? (bbox.x + bbox.w / 2);
                                        const cy = room.center?.y ?? (bbox.y + bbox.h / 2);
                                        const areaLabel = getRoomAreaM2(room);
                                        return (
                                            <g key={room.id} data-room-geometry={room.id} style={{ cursor: isSel ? "move" : "pointer", pointerEvents: "all" }}>                                               {facePath
                                                ? <path d={facePath} fillRule="evenodd" fill={isSel ? pal.fill : `${cs.stroke}18`} />
                                                : <polygon points={points} fill={isSel ? pal.fill : `${cs.stroke}18`} />}
                                                {facePath
                                                ? <path d={facePath} fillRule="evenodd" fill="none" stroke={isSel ? "none" : cs.stroke}
                                                    strokeWidth={isSel ? 0.004 : 0.002} strokeDasharray={isSel ? "none" : "0.01 0.005"} opacity={isSel ? 1 : 0.6} />
                                                : <polygon points={points} fill="none" stroke={isSel ? "none" : cs.stroke}
                                                    strokeWidth={isSel ? 0.004 : 0.002} strokeDasharray={isSel ? "none" : "0.01 0.005"} opacity={isSel ? 1 : 0.6} />}
                                                <RoomNameBadge name={room.name} x={cx} y={cy} fill={isSel ? pal.badge : cs.labelBg} />
                                                <text x={cx} y={cy + 0.024} textAnchor="middle" fontSize={0.014} fill={isSel ? pal.text : cs.stroke} fontFamily="monospace" opacity={isSel ? 1 : 0.8}>{areaLabel == null ? "— m²" : `${areaLabel.toFixed(2)} m²`}</text>

                                            </g>
                                        );
                                    })}

                                    {openingDrag && openingDrag.preview.wallId !== openingDrag.original.wallId && (() => {
                                        const target = walls.find(wall => wall.id === openingDrag.preview.wallId);
                                        return target ? <line data-opening-rehost-target={target.id} x1={target.x1} y1={target.y1} x2={target.x2} y2={target.y2}
                                            stroke="#22c55e" strokeWidth={3} vectorEffect="non-scaling-stroke" strokeDasharray="5 4" pointerEvents="none" /> : null;
                                    })()}
                                    {openingSet.active.filter(item => layers.has(item.kind === "door" ? "doors" : "windows")).map(({ opening, kind, geometry: g }) => {
                                        const selected = selectionType === kind && opening.id === (kind === "door" ? selectedDoorId : selectedWindowId);
                                        const color = kind === "door" ? "#f59e0b" : "#f472b6";
                                        return <g key={`${kind}:${opening.id}`} data-opening-geometry={`${kind}:${opening.id}`} style={{ cursor: selected ? "move" : "pointer", pointerEvents: "all" }}>
                                            <path d={polygonPath(g.polygon)!} fill={selected ? color : `${color}55`} stroke={selected ? "#fff" : color} strokeWidth={selected ? 0.002 : 0.001} />
                                            {selected && (["start", "end"] as const).map(end => <ellipse key={end}
                                                data-opening-handle={end} aria-label={`Resize ${kind} ${end}`}
                                                cx={g[end].x} cy={g[end].y} rx={4 / (imgSize.w * viewZoom)} ry={4 / (imgSize.h * viewZoom)}
                                                fill="#fff" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />)}
                                        </g>;
                                    })}

                                    {/* Measurement guides annotate the centerline; they are not wall surfaces. */}
                                    {layers.has("walls") && renderWalls.filter(wall => inCalibMode || wall.id === selectedWallId).map(wall => (
                                        <g key={`measure-${wall.id}`} data-wall-measurement={wall.id} pointerEvents="none">
                                            <title>Wall measurement: stored start to end</title>
                                            <line data-measurement-span x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2}
                                                stroke="#2563eb" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray="4 3" />
                                            {inCalibMode && [{ x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }].map((point, index) => {
                                                if (!inCalibMode && hasDragConnectionAt(point)) return null;
                                                const hovered = inCalibMode && calibrationEndpoint?.x === point.x && calibrationEndpoint?.y === point.y;
                                                const chosen = calibPts.some(p => p.x === point.x && p.y === point.y);
                                                const radius = hovered ? 7 : chosen ? 5 : 3;
                                                return <ellipse key={index} data-measurement-endpoint={index === 0 ? "start" : "end"}
                                                    data-calibration-endpoint={hovered ? "hovered" : chosen ? "selected" : undefined}
                                                    cx={point.x} cy={point.y} rx={radius / (imgSize.w * viewZoom)} ry={radius / (imgSize.h * viewZoom)}
                                                    fill="#fff"
                                                    stroke={chosen || hovered ? "#22c55e" : "#2563eb"} strokeWidth={chosen || hovered ? 2 : 1} vectorEffect="non-scaling-stroke" />;
                                            })}
                                        </g>
                                    ))}

                                    {wallDrawMode && wallDraftStart && wallDraftMouse && wallDrawConnections(
                                      wallDraftGeometry({ start: wallDraftStart, end: wallDraftMouse }), walls, { width: imgSize.w, height: imgSize.h }
                                    ).map(connection => <ellipse key={connection.key} data-wall-draw-connection={connection.kind}
                                      cx={connection.x} cy={connection.y} rx={8 / imgSize.w} ry={8 / imgSize.h}
                                      fill="#fff" stroke="#22c55e" strokeWidth={2 / imgSize.w} style={{ pointerEvents: "none" }} />)}
                                    {wallDrawMode && wallDrawSnap && wallDrawSnap.kind === "endpoint" && <ellipse
                                        data-wall-draw-snap-endpoint
                                        cx={wallDrawSnap.x} cy={wallDrawSnap.y}
                                        rx={7 / (imgSize.w * viewZoom)} ry={7 / (imgSize.h * viewZoom)}
                                        fill="#fff" stroke="#22c55e" strokeWidth={2} vectorEffect="non-scaling-stroke"
                                        style={{ pointerEvents: "none" }} />}

                                    {wallDrawMode && wallDrawSnap && wallDrawSnap.kind === "junction" && (
                                        <g data-wall-draw-junction-highlight style={{ pointerEvents: "none" }}>
                                            <ellipse
                                                data-wall-draw-junction-outer
                                                cx={wallDrawSnap.x} cy={wallDrawSnap.y}
                                                rx={8 / (imgSize.w * viewZoom)} ry={8 / (imgSize.h * viewZoom)}
                                                fill="none" stroke="#38bdf8" strokeWidth={2} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
                                            <ellipse
                                                data-wall-draw-junction-inner
                                                cx={wallDrawSnap.x} cy={wallDrawSnap.y}
                                                rx={4 / (imgSize.w * viewZoom)} ry={4 / (imgSize.h * viewZoom)}
                                                fill="#38bdf8" stroke="#0284c7" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                                        </g>
                                    )}

                                    {/* CALIBRATION GRAPHICS */}
                                    {(inCalibMode || calibPhase === "applied") && (
                                        <>
                                            {/* Ghost line: P1 → cursor */}
                                            {inCalibMode && calibPts.length === 1 && mousePos && (
                                                <line x1={calibPts[0].x} y1={calibPts[0].y} x2={mousePos.x} y2={mousePos.y}
                                                    stroke="#fbbf24" strokeWidth={0.002} strokeDasharray="0.01 0.006" opacity={0.4} />
                                            )}

                                            {/* Measurement line */}
                                            {calibPts.length === 2 && (
                                                <>
                                                    <line x1={calibPts[0].x} y1={calibPts[0].y} x2={calibPts[1].x} y2={calibPts[1].y}
                                                        stroke={calibPhase === "applied" ? "#34d399" : "#fbbf24"}
                                                        strokeWidth={calibPhase === "applied" ? 0.002 : 0.003}
                                                        strokeDasharray="0.014 0.007"
                                                        opacity={calibPhase === "applied" ? 0.35 : 0.9} />

                                                    {/* Perpendicular tick caps */}
                                                    {inCalibMode && [0, 1].map(i => {
                                                        const p = calibPts[i];
                                                        const dx = calibPts[1].x - calibPts[0].x;
                                                        const dy = calibPts[1].y - calibPts[0].y;
                                                        const len = Math.sqrt(dx * dx + dy * dy) || 1;
                                                        const nx = -dy / len * 0.014, ny = dx / len * 0.014;
                                                        return <line key={i} x1={p.x + nx} y1={p.y + ny} x2={p.x - nx} y2={p.y - ny} stroke="#fbbf24" strokeWidth={0.003} />;
                                                    })}

                                                    {/* Mid-point pixel label */}
                                                    {inCalibMode && livePixelDist && (
                                                        <g>
                                                            <rect x={(calibPts[0].x + calibPts[1].x) / 2 - 0.05} y={(calibPts[0].y + calibPts[1].y) / 2 - 0.025}
                                                                width={0.1} height={0.02} rx={0.004} fill="rgba(0,0,0,0.75)" />
                                                            <text x={(calibPts[0].x + calibPts[1].x) / 2} y={(calibPts[0].y + calibPts[1].y) / 2 - 0.011}
                                                                textAnchor="middle" fontSize={0.013} fill="#fbbf24" fontFamily="monospace">
                                                                {livePixelDist.toFixed(0)}px{calibLength && !isNaN(parseFloat(calibLength)) ? ` = ${calibLength}m` : ""}
                                                            </text>
                                                        </g>
                                                    )}
                                                </>
                                            )}

                                            {/* Draggable point handles */}
                                            {inCalibMode && calibPts.map((pt, i) => {
                                                const snapped = walls.some(wall =>
                                                    (wall.x1 === pt.x && wall.y1 === pt.y) || (wall.x2 === pt.x && wall.y2 === pt.y));
                                                const isHovered = mousePos && normDist(mousePos, pt) < DRAG_HIT;
                                                const isThisDragging = isDragging && draggingIdx.current === i;
                                                const showRing = isHovered || isThisDragging;
                                                return (
                                                    <g key={i} data-calibration-point={i} data-snapped={snapped} style={{ pointerEvents: "none" }}>
                                                        <title>{`P${i + 1}: ${snapped ? "wall endpoint" : "free point"}`}</title>
                                                        <circle cx={pt.x} cy={pt.y} r={0.022}
                                                            fill={isThisDragging ? "rgba(251,191,36,0.25)" : "rgba(251,191,36,0.15)"}
                                                            stroke="#fbbf24"
                                                            strokeWidth={isThisDragging ? 0.003 : 0.002}
                                                            opacity={showRing ? 1 : 0}
                                                            style={{ transition: "opacity 0.08s" }}
                                                        />
                                                        <circle cx={pt.x} cy={pt.y} r={0.007} fill={snapped ? "#22c55e" : "#fbbf24"} />
                                                        <line x1={pt.x - 0.02} y1={pt.y} x2={pt.x + 0.02} y2={pt.y} stroke="#fbbf24" strokeWidth={0.0015} opacity={0.55} />
                                                        <line x1={pt.x} y1={pt.y - 0.02} x2={pt.x} y2={pt.y + 0.02} stroke="#fbbf24" strokeWidth={0.0015} opacity={0.55} />
                                                        <text x={pt.x + 0.013} y={pt.y - 0.008} fontSize={0.013} fill="#fbbf24" fontFamily="monospace" fontWeight="700">P{i + 1}</text>
                                                    </g>
                                                );
                                            })}

                                            {/* Applied: faded dots */}
                                            {calibPhase === "applied" && calibPts.map((pt, i) => (
                                                <circle key={i} cx={pt.x} cy={pt.y} r={0.005} fill="#34d399" opacity={0.45} />
                                            ))}
                                        </>
                                    )}
                                    {/* Keep the existing handles above every selectable overlay. */}
                                    {layers.has("walls") && !inPointerMode && (() => {
                                        const wall = walls.find(item => item.id === selectedWallId);
                                        if (!wall) return null;
                                        const displayWall = renderWalls.find(item => item.id === wall.id) ?? wall;
                                        return <g>
                                            {(["start", "end"] as const).map(endpoint => {
                                                const point = endpoint === "start" ? { x: displayWall.x1, y: displayWall.y1 } : { x: displayWall.x2, y: displayWall.y2 };
                                                return <g key={endpoint} style={{ pointerEvents: "all" }}>
                                                    <ellipse aria-label={`${endpoint === "start" ? "Start" : "End"} endpoint; drag to edit wall`} data-wall-endpoint={endpoint} cx={point.x} cy={point.y} rx={ENDPOINT_HIT_RADIUS_PX / (imgSize.w * viewZoom)} ry={ENDPOINT_HIT_RADIUS_PX / (imgSize.h * viewZoom)} fill="rgba(0,0,0,0.001)" style={{ cursor: "grab", pointerEvents: "all", touchAction: "none" }} />
                                                    {(inCalibMode || !dragConnectionTargets
                                                        .some(target => Math.hypot(target.x - point.x, target.y - point.y) < 1e-10)) && <circle cx={point.x} cy={point.y} r={0.011} fill="#fff" stroke="#2563eb" strokeWidth={0.004} style={{ pointerEvents: "none" }} />}
                                                </g>;
                                            })}
                                            {dragConnectionTargets
                                                .filter((target, index, targets) => !targets.slice(0, index).some(other =>
                                                    Math.hypot(target.x - other.x, target.y - other.y) < 1e-10))
                                                .map(target => <g key={target.key} style={{ pointerEvents: "none" }}>
                                                    <circle cx={target.x} cy={target.y} r={0.011}
                                                        fill="#fff" stroke="#2563eb" strokeWidth={0.004} />
                                                    <circle
                                                    data-wall-snap-target={target.key}
                                                    aria-label="Release to connect walls"
                                                    cx={target.x} cy={target.y} r={0.014}
                                                    fill="none" stroke="#22c55e" strokeWidth={0.003}
                                                    strokeDasharray="0.005 0.004"
                                                    style={{ pointerEvents: "none" }} />
                                                </g>)}
                                        </g>;
                                    })()}
                                    {!inPointerMode && !openingDrawMode && (selectedRoom ? layers.has("rooms") : layers.has("walls")) && <ReviewDimensions dimensions={canvasDimensions}
                                        width={imgSize.w * viewZoom} height={imgSize.h * viewZoom} />}
                                    </g>
                                    {openingDrawMode && <rect
                                        data-opening-pointer-overlay
                                        x="0" y="0" width="100" height="100"
                                        fill="transparent"
                                        pointerEvents="all"
                                        style={{ cursor: cursorStyle }}
                                    />}
                                </svg>

                                {/* Calibration hint banner */}
                                {inCalibMode && (
                                    <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-card/92 border border-amber-500/40 text-amber-500 text-[11px] font-medium px-4 py-1.5 rounded-full shadow-lg pointer-events-none backdrop-blur-sm">
                                        <Crosshair className="w-3.5 h-3.5 shrink-0" />
                                        {calibPts.length === 0 && "คลิกวาง P1"}
                                        {calibPts.length === 1 && "คลิกวาง P2"}
                                        {calibPts.length >= 2 && "ใส่ระยะจริงแล้วกด Apply"}
                                    </div>
                                )}

                                {/* FIX: Banner แจ้งเตือนให้ calibrate เมื่อยังไม่ได้ทำ */}
                                {/* {!inCalibMode && calibPhase === "idle" && (
                                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-card/92 border border-amber-500/30 text-amber-500 text-[11px] font-medium px-4 py-1.5 rounded-full shadow pointer-events-none backdrop-blur-sm">
                                        <Crosshair className="w-3 h-3 shrink-0" />
                                        กด Calibrate Scale เพื่อคำนวณขนาดจริงเป็นเมตร
                                    </div>
                                )} */}
                            </div>

                            <div className="absolute bottom-4 right-4 z-30 flex items-center gap-1 rounded-lg border border-border bg-card/90 p-1 shadow-lg backdrop-blur-sm">
                                <button type="button" onClick={() => stepZoom(-1)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Zoom out" aria-label="Zoom out">
                                    <ZoomOut className="h-4 w-4" />
                                </button>
                                {isEditingZoom ? (
                                    <input
                                        autoFocus
                                        value={zoomInput}
                                        onChange={e => setZoomInput(e.target.value)}
                                        onBlur={commitZoomInput}
                                        onKeyDown={e => {
                                            if (e.key === "Enter") commitZoomInput();
                                            if (e.key === "Escape") {
                                                setZoomInput(String(Math.round(viewZoom * 100)));
                                                setIsEditingZoom(false);
                                            }
                                        }}
                                        className="h-6 w-11 rounded bg-transparent text-center text-[10px] font-mono text-foreground outline-none ring-1 ring-primary/50"
                                        aria-label="Zoom percentage"
                                    />
                                ) : (
                                    <button type="button" onClick={() => { setZoomInput(String(Math.round(viewZoom * 100))); setIsEditingZoom(true); }} className="min-w-10 rounded px-1 text-center text-[10px] font-mono text-muted-foreground hover:bg-accent hover:text-foreground" title="Set zoom percentage">
                                        {Math.round(viewZoom * 100)}%
                                    </button>
                                )}
                                <button type="button" onClick={() => stepZoom(1)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Zoom in" aria-label="Zoom in">
                                    <ZoomIn className="h-4 w-4" />
                                </button>
                                <span className="mx-0.5 h-4 w-px bg-border" />
                                <button type="button" onClick={fitToScreen} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Fit to screen" aria-label="Fit to screen">
                                    <Maximize className="h-4 w-4" />
                                </button>
                            </div>
                        </div>
                    ) : (
                        <span className="text-xs text-muted-foreground">No image</span>
                    )}
                </div>

                {/* RIGHT PANEL */}
                <div className="relative w-[280px] shrink-0 border-l border-border flex flex-col bg-card/30 overflow-hidden">
                    <div className="flex-1 overflow-y-auto p-3 space-y-3">
                        {(selectedWallId || selectedDoorId || selectedWindowId) && (
                            <section className="absolute bottom-3 left-3 right-3 z-20 rounded-xl border border-border bg-card p-3 space-y-3 shadow-lg">
                                {selectionType === "room" && selectedRoom && <>
                                    <div className="flex items-center justify-between"><Input value={selectedRoom.name} onChange={e => onRoomUpdate(selectedRoom.id, "name", e.target.value)} className="h-8 border-0 bg-transparent px-0 text-sm font-semibold shadow-none focus-visible:ring-0" /><button onClick={dismissInspector} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button></div>
                                    <div className="flex justify-between text-xs text-muted-foreground"><span>Area</span><span className="font-mono text-foreground">{getRoomAreaM2(selectedRoom)?.toFixed(2) ?? "—"} m²</span></div>
                                    <button onClick={() => { onRoomDelete?.(selectedRoom.id); clearSelection(); }} className="w-full rounded-md border border-red-500/30 bg-red-500/10 py-2 text-xs font-medium text-red-500">Delete Room</button>
                                </>}
                                {selectionType === "wall" && selectedWallId && (() => { const persistedWall = walls.find(w => w.id === selectedWallId); const wall = renderWalls.find(item => item.id === selectedWallId) ?? persistedWall; const index = walls.findIndex(w => w.id === selectedWallId); if (!wall) return null; const wallLength = getWallLength(wall); return <>
                                    <div className="flex items-center justify-between"><span className="text-sm font-semibold text-foreground">Wall {index + 1}</span><button onClick={dismissInspector} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button></div>
                                    <label className="block text-xs text-muted-foreground">Length
                                        {wallLength === null ? (
                                            <div className="mt-1 rounded-md border border-input bg-muted/50 px-2 py-2 text-xs text-muted-foreground"><span>—</span><span className="ml-2">Calibrate scale to view dimensions</span></div>
                                        ) : (
                                            <div className="mt-1 flex items-center rounded-md border border-input bg-background"><input aria-label="Wall length (m)" type="number" value={lengthDraft?.wallId === wall.id ? lengthDraft.value : wallLength.toFixed(2)}
                                                onChange={e => { setLengthDraft({ wallId: wall.id, value: e.target.value }); setLengthError(null); }}
                                                onBlur={commitLength}
                                                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commitLength(); } if (e.key === "Escape") { e.preventDefault(); cancelLength(); } }} className="h-8 min-w-0 flex-1 bg-transparent px-2 text-sm font-mono outline-none" /><span className="px-2 text-xs">m</span></div>
                                        )}
                                    </label>
                                    {lengthError && <p role="alert" className="text-xs text-destructive">{lengthError}</p>}
                                    <button onClick={() => setAdvancedOpen(open => !open)} className="flex w-full items-center justify-between rounded-md bg-muted/50 px-2 py-2 text-xs font-medium">Advanced <ChevronDown className={`w-3.5 h-3.5 ${advancedOpen ? "rotate-180" : ""}`} /></button>
                                    {advancedOpen && <div className="grid grid-cols-2 gap-2">{(["wallHeight", "thickness"] as const).map(field => <div key={field}><div className="mb-1 text-[10px] text-muted-foreground">{field === "wallHeight" ? "Wall Height" : "Wall Thickness"}</div><Input type="number" placeholder="—" defaultValue={field === "wallHeight" ? getWallHeight(wall) ?? wallHeightMeter : hasWallThicknessMeasurement(wall) ? getWallThickness(wall) : ""} onBlur={e => { if (e.target.value === "" && field === "thickness" && !hasWallThicknessMeasurement(wall)) return; onWallUpdate?.(wall.id, field, parseFloat(e.target.value) || (field === "wallHeight" ? wallHeightMeter : 0.15)); }} className="h-8 text-xs" /></div>)}</div>}
                                    <button onClick={deleteSelectedWall} className="w-full rounded-md border border-red-500/30 bg-red-500/10 py-2 text-xs font-medium text-red-500">Delete Wall</button>
                                </>})()}
                                {(selectionType === "door" || selectionType === "window") && (() => {
                                    const opening = selectionType === "door" ? doors.find(item => item.id === selectedDoorId) : windows.find(item => item.id === selectedWindowId);
                                    if (!opening) return null;
                                    const resolvedWall = opening.wallId
                                        ? walls.find(wall => wall.id === opening.wallId) ?? null
                                        : resolveOpeningWall(opening.bbox, walls, planDimensions.width, planDimensions.height).wall;
                                    const attachmentActive = attachmentCandidate?.kind === selectionType && attachmentCandidate.id === opening.id;
                                    const widthM = openingWidthM(opening);
                                    const geometry = openingGeometry(opening, selectionType, walls, planDimensions.width, planDimensions.height, wallHeightMeter);
                                    const conflict = openingSet.rejected.get(`${selectionType}:${opening.id}`);
                                    return <>
                                        <div className="flex items-center justify-between"><span className="text-sm font-semibold text-foreground">{selectionType === "door" ? "Door" : "Window"}</span><button onClick={dismissInspector} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button></div>
                                        {resolvedWall ? <p className="text-[11px] text-muted-foreground">Attached wall: {resolvedWall.id}</p> : <p className="text-[11px] text-muted-foreground">Attached wall: Not identified · <button onClick={() => setAttachmentCandidate({ kind: selectionType, id: opening.id, wallId: null })} className="font-medium text-primary hover:underline">Select wall</button></p>}
                                        {attachmentActive && <div className="rounded-md border border-primary/30 bg-primary/10 px-2 py-2 text-[11px] text-foreground">
                                            {attachmentCandidate.wallId ? `Previewing attachment to ${attachmentCandidate.wallId}` : "Click a wall on the plan to preview the attachment"}
                                            <div className="mt-2 flex gap-2"><button disabled={!attachmentCandidate.wallId} onClick={() => { if (!attachmentCandidate.wallId) return; if (selectionType === "door") onDoorUpdate?.(opening.id, "wallId", attachmentCandidate.wallId); else onWindowUpdate?.(opening.id, "wallId", attachmentCandidate.wallId); setAttachmentCandidate(null); }} className="rounded bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground disabled:opacity-50">Confirm</button><button onClick={() => setAttachmentCandidate(null)} className="rounded border border-border px-2 py-1 text-[10px]">Cancel</button></div>
                                        </div>}
                                        <div className="rounded-md bg-muted/50 px-2 py-2 text-xs">
                                            <span className="text-muted-foreground">Width</span>
                                            <span className="ml-2 font-mono text-foreground">
                                                {!calibrated
                                                    ? <><span>—</span><span className="ml-2">Calibrate scale to view dimensions</span></>
                                                    : widthM !== null
                                                        ? `${widthM.toFixed(2)} m`
                                                        : "Unavailable for unresolved detection"}
                                            </span>
                                        </div>
                                        {conflict === "overlap" && <p className="text-xs text-amber-500">Overlapping detection: excluded from wall cuts and 3D. Resize or delete it to resolve the conflict.</p>}
                                        {geometry && <OpeningDimensions opening={opening} kind={selectionType} walls={walls}
                                          doors={storedDoors} windows={storedWindows} pw={planDimensions.width} ph={planDimensions.height}
                                          wallHeight={wallHeightMeter} calibrated={calibrated}
                                          onEdit={(field, value) => selectionType === "door" ? onDoorUpdate?.(opening.id, field, value) : onWindowUpdate?.(opening.id, field, value)} />}
                                        <button onClick={() => { if (selectionType === "door") onDoorDelete?.(opening.id); else onWindowDelete?.(opening.id); clearSelection(); }} className="w-full rounded-md border border-red-500/30 bg-red-500/10 py-2 text-xs font-medium text-red-500">Delete {selectionType === "door" ? "Door" : "Window"}</button>
                                    </>;
                                })()}
                            </section>
                        )}
                        <section className="overflow-hidden rounded-xl border border-border/70 bg-card">
                        <p className="border-b border-border/60 px-3 py-2.5 text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                            <Layers className="w-3 h-3" /> Room Areas ({rooms.length})
                        </p>

                        {/* FIX: Banner แจ้ง calibrate ก่อนถ้ายังไม่ทำ */}
                        {!calibrated && (
                            <div className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 flex items-center gap-2">
                                <Crosshair className="w-3 h-3 text-amber-400 shrink-0" />
                                <span className="text-[10px] text-amber-400/80">Calibrate scale ก่อนเพื่อดูขนาดเป็นเมตร</span>
                            </div>
                        )}

                        <div className="divide-y divide-border/55">
                        {rooms.map((room) => {
                            const pal = ROOM_SELECTION;
                            const isSel = selectedId === room.id && selectionType === "room";
                            return (
                                <div key={room.id} data-plan-selection={`room:${room.id}`}
                                    onClick={() => selectRoom(room.id)}
                                    className={`w-full cursor-pointer px-3 py-2.5 transition-colors ${isSel ? "bg-violet-500/8 shadow-sm" : "hover:bg-accent/60"}`}>
                                    <div className="flex items-center gap-1">
                                        {roomNameEdit?.id === room.id ? <Input autoFocus aria-label="Room name"
                                            value={roomNameEdit.value} className="h-7 min-w-0 flex-1 text-xs"
                                            onFocus={e => e.target.select()}
                                            onChange={e => setRoomNameEdit({ id: room.id, value: e.target.value })}
                                            onClick={e => e.stopPropagation()}
                                            onBlur={commitRoomName}
                                            onKeyDown={e => {
                                                if (e.key === "Enter") { e.stopPropagation(); e.currentTarget.blur(); }
                                                if (e.key === "Escape") {
                                                    e.stopPropagation();
                                                    roomNameCancelled.current = true;
                                                    setRoomNameEdit(null);
                                                }
                                            }} /> : <button aria-label={`Rename ${room.name}`} title="Click to rename"
                                            onClick={e => { e.stopPropagation(); startRoomNameEdit(room); }}
                                            className="min-w-0 truncate text-left text-xs font-medium text-foreground cursor-pointer hover:text-primary">
                                            {room.name}</button>}
                                        <button onClick={e => { e.stopPropagation(); selectRoom(room.id); }} className="ml-auto shrink-0 cursor-pointer text-[11px] font-mono text-muted-foreground">
                                            {getRoomAreaM2(room)?.toFixed(2) ?? "\u2014"} m&sup2;
                                        </button>
                                    </div>
                                    {isSel && calibrated && <div className="mt-2 border-t border-border/50 pt-2" aria-label="Room boundary dimensions">
                                        <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">Boundary lengths</div>
                                        <div className="space-y-0.5">
                                            {boundaryDimensions.map(dimension => {
                                                const editing = lengthDraft?.id === dimension.id;
                                                return editing ? <input key={dimension.id} autoFocus aria-label="Boundary length (m)" type="number" min="0.01" step="0.01"
                                                    value={lengthDraft.value}
                                                    onChange={e => { setLengthDraft({ ...lengthDraft, value: e.target.value }); setLengthError(null); }}
                                                    onBlur={commitLength} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commitLength(); } if (e.key === "Escape") { e.preventDefault(); cancelLength(); } }}
                                                    className="h-8 w-full rounded-xl border-2 border-primary/70 bg-background px-3 font-mono text-xs text-foreground shadow-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" /> :
                                                    <button key={dimension.id} type="button" aria-label={`Edit boundary length ${dimension.length.toFixed(2)} m`} onClick={e => { e.stopPropagation(); setLengthDraft({ id: dimension.id, wallId: dimension.wallId, segmentKey: dimension.segmentKey, span: { start: dimension.start, end: dimension.end }, value: dimension.length.toFixed(2) }); setLengthError(null); }}
                                                        className="block w-full py-1 text-left text-xs font-mono text-muted-foreground hover:bg-accent/60 hover:text-foreground">
                                                        {dimension.length.toFixed(2)} m
                                                    </button>;
                                            })}
                                        </div>
                                        {lengthError && <p role="alert" className="mt-1 text-xs text-destructive">{lengthError}</p>}
                                    </div>}
                                </div>
                            );
                        })}
                        </div>

                        <div className="border-t border-border/60 bg-muted/30 px-3 py-2.5 text-xs font-semibold text-foreground flex justify-between"><span>Total Area</span><span className="font-mono">{calibrated ? rooms.reduce((total, room) => total + (getRoomAreaM2(room) ?? 0), 0).toFixed(2) : "—"} m²</span></div>
                        </section>

                        <button onClick={() => setOtherElementsOpen(open => !open)} className="flex w-full items-center justify-between rounded-lg border border-border/70 bg-card px-3 py-3 text-left text-xs font-semibold"><span className="flex items-center gap-2"><Building2 className="w-4 h-4 text-primary" />Other Elements</span><ChevronDown className={`w-4 h-4 transition-transform ${otherElementsOpen ? "rotate-180" : "-rotate-90"}`} /></button>
                        {otherElementsOpen && <div className="space-y-1 rounded-lg border border-border/70 bg-card/50 p-1.5">
                            {(["walls", "doors", "windows"] as const).map(category => {
                                const items = category === "walls" ? walls : category === "doors" ? doors : windows;
                                const Icon = category === "walls" ? Ruler : category === "doors" ? DoorOpen : AppWindow;
                                const label = category[0].toUpperCase() + category.slice(1);
                                const color = category === "doors" ? "text-amber-400" : category === "windows" ? "text-[#f472b6]" : "text-primary";
                                const open = elementCategory === category;
                                return <div key={category}>
                                    <button onClick={() => setElementCategory(open ? null : category)} className="flex w-full items-center justify-between rounded-md px-2 py-2 text-xs hover:bg-accent"><span className={`flex items-center gap-2 ${color}`}><Icon className="w-3.5 h-3.5" /><span className="text-foreground">{label}</span></span><span className="flex items-center gap-2 text-muted-foreground">{items.length}<ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : "-rotate-90"}`} /></span></button>
                                    {open && category === "walls" && <div className="mx-1 mb-2 rounded-md bg-muted/40 p-2 text-xs">
                                        {!wallDefaultsEditing ? <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Default&nbsp; H {localWallH.toFixed(2)} m &nbsp;·&nbsp; T {allWallThickness == null ? "—" : `${allWallThickness.toFixed(2)} m`}</span><button onClick={() => setWallDefaultsEditing(true)} className="rounded border border-primary/30 px-2 py-1 text-primary hover:bg-primary/10">Edit</button></div> : <div className="space-y-2"><div className="grid grid-cols-2 gap-2"><label>Height<Input type="number" min="0.5" step="0.1" value={localWallH} onChange={e => setLocalWallH(parseFloat(e.target.value) || 2.8)} className="mt-1 h-8 text-xs" /></label><label>Thickness<Input type="number" min="0.01" step="0.01" value={localWallThickness} onChange={e => setLocalWallThickness(parseFloat(e.target.value) || DEFAULT_WALL_THICKNESS_M)} className="mt-1 h-8 text-xs" /></label></div><p className="text-[10px] text-muted-foreground">Height applies to new walls; thickness applies to all walls.</p><div className="grid grid-cols-2 gap-2"><button onClick={() => { setLocalWallH(wallHeightMeter); setLocalWallThickness(allWallThickness ?? DEFAULT_WALL_THICKNESS_M); setWallDefaultsEditing(false); }} className="rounded border border-border bg-card py-1.5">Cancel</button><button onClick={applyWallDefaults} className="rounded bg-primary py-1.5 text-primary-foreground">Apply</button></div></div>}
                                    </div>}
                                    {open && category !== "walls" && (() => {
                                        const kind: OpeningKind = category === "doors" ? "door" : "window";
                                        const shared = kind === "door" ? allDoorHeight : allWindowHeight;
                                        const sharedSill = kind === "window" ? allWindowSill : null;
                                        const draft = openingEdit?.kind === kind ? openingEdit : null;
                                        return <div className="mx-1 mb-2 rounded-md bg-muted/40 p-2 text-xs">
                                            {!draft ? <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">All {label.toLowerCase()}&nbsp; H {shared == null ? "—" : `${shared.toFixed(2)} m`}{kind === "window" && <>&nbsp;·&nbsp; Sill {sharedSill == null ? "—" : `${sharedSill.toFixed(2)} m`}</>}</span><button onClick={() => startOpeningBatch(kind)} className="rounded border border-primary/30 px-2 py-1 text-primary hover:bg-primary/10">Edit</button></div> : <div className="space-y-2"><div className={`grid gap-2 ${kind === "window" ? "grid-cols-2" : "grid-cols-1"}`}><label>Height<Input type="number" min="0.01" step="0.01" value={draft.height} onChange={e => setOpeningEdit({ ...draft, height: e.target.value })} className="mt-1 h-8 text-xs" /></label>{kind === "window" && <label>Sill Height<Input type="number" min="0" step="0.01" value={draft.sill} onChange={e => setOpeningEdit({ ...draft, sill: e.target.value })} className="mt-1 h-8 text-xs" /></label>}</div><p className="text-[10px] text-muted-foreground">Applies to all {items.length} {label.toLowerCase()}. Width is unchanged.</p><div className="grid grid-cols-2 gap-2"><button onClick={cancelOpeningBatch} className="rounded border border-border bg-card py-1.5">Cancel</button><button onClick={applyOpeningBatch} className="rounded bg-primary py-1.5 text-primary-foreground">Apply</button></div></div>}
                                        </div>;
                                    })()}
                                    {open && <div className="space-y-0.5 px-2 pb-1">{items.length === 0 ? <div className="px-2 py-1 text-[11px] text-muted-foreground">No {label.toLowerCase()}</div> : items.map((item, index) => {
                                        const selected = category === "walls" ? selectedWallId === item.id : category === "doors" ? selectedDoorId === item.id : selectedWindowId === item.id;
                                        const length = category === "walls" ? getWallLength(endpointDrag?.previewWalls.find(wall => wall.id === item.id) ?? item as DetectedWallSegment) : null;
                                        const select = category === "walls" ? selectWall : category === "doors" ? selectDoor : selectWindow;
                                        return <button key={item.id} onClick={() => select(item.id)} className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[11px] ${selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60"}`}><span>{label.slice(0, -1)} {index + 1}</span>{category === "walls" && <span className="font-mono">{length == null ? "—" : `${length.toFixed(2)} m`}</span>}</button>;
                                    })}</div>}
                                </div>;
                            })}
                        </div>}
                        {showLegacyEditorSections && otherElementsOpen && <div className="space-y-2">
                        {walls.length > 0 && (
                            <div className="pt-3">
                                <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-2 flex items-center gap-1.5">
                                    <Ruler className="w-3 h-3" /> Walls ({walls.length})
                                </p>
                                {walls.map((wall, idx) => {
                                    const isSel = selectedWallId === wall.id && selectionType === "wall";
                                    const isExt = wall.type === "exterior";
                                    return (
                                        <button key={wall.id} data-plan-selection={`wall:${wall.id}`} onClick={() => selectWall(wall.id)}
                                            className={`w-full text-left rounded-lg px-3 py-2 border transition-all duration-200 mb-1 ${isSel ? "border-amber-500/40 bg-amber-500/10 shadow-sm" : "border-border/70 hover:border-border hover:bg-accent/60"}`}>
                                            <div className="flex items-center gap-2">
                                                <span className={`w-2 h-0.5 rounded shrink-0 ${isExt ? "bg-muted-foreground/70" : "bg-primary/70"}`} />
                                                <span className="text-[11px] font-medium text-foreground">Wall {idx + 1}</span>
                                            </div>
                                            <div className="mt-1 text-[10px] font-mono text-muted-foreground flex gap-3">
                                                {/* FIX: แสดง — ก่อน calibrate */}
                                                <span>L: {calibrated ? `${getWallLength(renderWalls.find(item => item.id === wall.id) ?? wall)?.toFixed(1) ?? "—"}m` : "—"}</span>
                                                <span>T: {getWallThicknessLabel(wall)}</span>
                                                <span>H: {getWallHeight(wall) != null ? `${getWallHeight(wall)!.toFixed(1)}m` : "N/A"}</span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {doors.length > 0 && (
                            <div className="pt-2">
                                <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-1.5 flex items-center gap-1.5">
                                    <DoorOpen className="w-3 h-3 text-amber-400" /> Doors ({doors.length})
                                </p>
                                {doors.map(d => {
                                    const wM = openingWidthM(d);
                                    const isSel = selectionType === "door" && selectedDoorId === d.id;
                                    return (
                                        <button key={d.id} data-plan-selection={`door:${d.id}`} onClick={() => selectDoor(d.id)}
                                            className={`w-full rounded px-2 py-1 text-left text-[10px] font-mono transition-colors ${isSel ? "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/40" : "text-amber-400/70 hover:bg-accent"}`}>
                                            {wM !== null ? `${wM.toFixed(2)}m wide` : "— wide"}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {windows.length > 0 && (
                            <div className="pt-2">
                                <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-1.5 flex items-center gap-1.5">
                                    <AppWindow className="w-3 h-3 text-[#f472b6]" /> Windows ({windows.length})
                                </p>
                                {windows.map(w => {
                                    const wM = openingWidthM(w);
                                    const isSel = selectionType === "window" && selectedWindowId === w.id;
                                    return (
                                        <button key={w.id} data-plan-selection={`window:${w.id}`} onClick={() => selectWindow(w.id)}
                                            className={`w-full rounded px-2 py-1 text-left text-[10px] font-mono transition-colors ${isSel ? "bg-[#f472b6]/15 text-pink-200 ring-1 ring-[#f472b6]/40" : "text-[#f472b6]/70 hover:bg-accent"}`}>
                                            {wM !== null ? `${wM.toFixed(2)}m wide` : "— wide"}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {calibrated && (
                            <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/8 p-3">
                                <div className="text-[10px] uppercase tracking-widest text-emerald-400 mb-1.5 flex items-center gap-1.5">
                                    <CheckCircle2 className="w-3 h-3" /> Scale Calibrated
                                </div>
                                <div className="text-[11px] font-mono text-muted-foreground space-y-0.5">
                                    <div className="flex justify-between"><span>m/px</span><span className="text-foreground">{scale.toFixed(6)}</span></div>
                                    <div className="flex justify-between"><span>px/m</span><span className="text-foreground">{(1 / scale).toFixed(2)}</span></div>
                                    <div className="flex justify-between"><span>ref</span><span className="text-foreground">{calibLength} m</span></div>
                                </div>
                            </div>
                        )}
                        </div>}
                    </div>

                    <div className="shrink-0 border-t border-border" />

                    {/* Room editor */}
                    {showLegacyEditorSections && selectionType === "room" && selectedRoom && (
                        <div className="shrink-0 p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold" style={{ color: palette.stroke }}>{selectedRoom.name}</span>
                                <div className="flex items-center gap-1">
                                    <button onClick={() => navigate(-1)} disabled={selectedIdx === 0} className="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"><ChevronLeft className="w-3.5 h-3.5" /></button>
                                    <span className="text-[10px] text-muted-foreground font-mono">{selectedIdx + 1}/{rooms.length}</span>
                                    <button onClick={() => navigate(1)} disabled={selectedIdx === rooms.length - 1} className="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"><ChevronRight className="w-3.5 h-3.5" /></button>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                {/* FIX: EditableCell จะแสดง placeholder "N/A" ถ้ายังไม่ calibrate */}
                                <EditableCell room={selectedRoom} field="width"      label="W (m)" suffix="m" />
                                <EditableCell room={selectedRoom} field="height"     label="D (m)" suffix="m" />
                                <EditableCell room={selectedRoom} field="wallHeight" label="H (m)" suffix="m" />
                            </div>
                            {(() => {
                                const area = getRoomAreaM2(selectedRoom);
                                if (area == null) {
                                    return (
                                        <div className="text-[10px] text-muted-foreground/40 font-mono flex justify-between">
                                            <span>Area</span>
                                            <span>— m²</span>
                                        </div>
                                    );
                                }
                                return (
                                    <div className="text-[10px] text-muted-foreground font-mono flex justify-between">
                                        <span>Area</span>
                                        <span className="text-foreground font-medium">{area.toFixed(2)} m²</span>
                                    </div>
                                );
                            })()}
                        </div>
                    )}

                    {/* Wall editor */}
                    {showLegacyEditorSections && selectionType === "wall" && selectedWallId && (() => {
                        const sw = walls.find(w => w.id === selectedWallId);
                        if (!sw) return null;
                        const swIdx = walls.findIndex(w => w.id === selectedWallId);
                        const swThick = getWallThickness(sw), swH = getWallHeight(sw);
                        return (
                            <div className="shrink-0 p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Ruler className="w-3.5 h-3.5 text-amber-400" />
                                        <span className="text-xs font-semibold text-amber-300">Wall {swIdx + 1}</span>
                                        <button onClick={() => onWallUpdate && onWallUpdate(sw.id, "type", sw.type === "exterior" ? "interior" : "exterior")}
                                            className={`text-[9px] px-1.5 py-0.5 rounded font-mono cursor-pointer transition-colors ${sw.type === "exterior" ? "bg-muted text-muted-foreground hover:bg-accent" : "bg-primary/10 text-primary hover:bg-primary/15"}`}>
                                            {sw.type === "exterior" ? "EXT" : "INT"}
                                        </button>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <button onClick={() => { const p = swIdx - 1; if (p >= 0) selectWall(walls[p].id); }} disabled={swIdx === 0} className="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"><ChevronLeft className="w-3.5 h-3.5" /></button>
                                        <span className="text-[10px] text-muted-foreground font-mono">{swIdx + 1}/{walls.length}</span>
                                        <button onClick={() => { const n = swIdx + 1; if (n < walls.length) selectWall(walls[n].id); }} disabled={swIdx === walls.length - 1} className="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"><ChevronRight className="w-3.5 h-3.5" /></button>
                                    </div>
                                </div>
                                {/* FIX: Length แสดงเฉพาะเมื่อ calibrate แล้ว */}
                                <div className="text-[10px] text-muted-foreground font-mono flex justify-between">
                                    <span>Length</span>
                                    <span className={calibrated ? "text-foreground font-medium" : "text-muted-foreground/40"}>
                                        {getWallLength(sw) !== null ? `${getWallLength(sw)!.toFixed(2)} m` : "—"}
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={deleteSelectedWall}
                                    disabled={!onWallDelete}
                                    className="w-full rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    Delete Wall
                                </button>
                                {(["thickness", "wallHeight"] as const).map((field) => {
                                    const label = field === "thickness" ? "Thickness (cm)" : "Height (m)";
                                    const numericValue = field === "thickness"
                                        ? (swThick != null ? +(swThick * 100).toFixed(0) : null)
                                        : (swH != null ? +swH.toFixed(2) : null);
                                    const displayValue = numericValue == null ? "N/A" : String(numericValue);
                                    return (
                                        <div key={field} className="flex-1 min-w-0">
                                            <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
                                            {isWallEditing(sw.id, field) ? (
                                                <div className="flex items-center gap-0.5">
                                                    <Input
                                                        type="number"
                                                        autoFocus
                                                        value={wallEditState?.value ?? ""}
                                                        onChange={(e) => setWallEditState((s) => s ? { ...s, value: e.target.value } : s)}
                                                        onKeyDown={(e) => { if (e.key === "Enter") commitWallEdit(); if (e.key === "Escape") setWallEditState(null); }}
                                                        className="h-7 text-xs font-mono px-2 border-amber-500/60"
                                                    />
                                                    <button onClick={commitWallEdit} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400"><Check className="w-3 h-3" /></button>
                                                    <button onClick={() => setWallEditState(null)} className="p-1 rounded hover:bg-red-500/20 text-red-400"><X className="w-3 h-3" /></button>
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => startWallEdit(sw.id, field, numericValue)}
                                                    className="group flex items-center gap-1 w-full text-left px-1 py-0.5 -mx-1 rounded hover:bg-accent transition-colors">
                                                    <span className="text-sm font-mono font-semibold text-foreground">{displayValue}</span>
                                                    <span className="text-[10px] text-muted-foreground">{field === "thickness" ? "cm" : "m"}</span>
                                                    <Pencil className="w-2.5 h-2.5 opacity-0 group-hover:opacity-50 ml-auto transition-opacity" />
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })()}

                    
                </div>
            </div>
        </div>
    );
};

export default WallReview;
