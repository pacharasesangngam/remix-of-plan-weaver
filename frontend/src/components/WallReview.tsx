import { useState, useRef, useEffect, useCallback } from "react";
import {
    CheckCircle2, AlertCircle, Pencil, Check, X,
    ArrowRight, Zap, ChevronLeft, ChevronRight,
    DoorOpen, AppWindow, Layers, Eye, EyeOff, Ruler,
    Crosshair, RotateCcw, Building2, ZoomIn, ZoomOut, Maximize,
} from "lucide-react";
import type { Room, DimensionUnit } from "@/types/floorplan";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import { UNITS } from "@/types/floorplan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
interface WallReviewProps {
    rooms: Room[];
    unit: DimensionUnit;
    imageUrl: string | null;
    backgroundImageUrl?: string | null;
    walls?: DetectedWallSegment[];
    doors?: DetectedDoor[];
    windows?: DetectedWindow[];
    scale: number; 
    onScaleChange: (s: number) => void;
    onPlanSizeChange?: (pw: number, ph: number) => void;
    onPpmChange?: (ppm: number) => void;  
    onRoomUpdate: (id: string, field: keyof Room, value: number | string) => void;
    onWallUpdate?: (id: string, field: keyof DetectedWallSegment, value: number | string) => void;
    onWallAdd?: (wall: DetectedWallSegment) => void;
    onWallDelete?: (id: string) => void;
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

type SelectionType = "room" | "wall" | "door" | "window";
type OverlayLayer  = "rooms" | "walls" | "doors" | "windows" | "image";
// idle → placing (dropping points) → ready (both down, enter real dist) → applied
type CalibPhase    = "idle" | "placing" | "ready" | "applied";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const ROOM_PALETTE = [
    { stroke: "#60a5fa", fill: "rgba(96,165,250,0.10)", text: "#93c5fd" },
    { stroke: "#34d399", fill: "rgba(52,211,153,0.10)", text: "#6ee7b7" },
    { stroke: "#f472b6", fill: "rgba(244,114,182,0.10)", text: "#f9a8d4" },
    { stroke: "#fb923c", fill: "rgba(251,146,60,0.10)",  text: "#fdba74" },
    { stroke: "#a78bfa", fill: "rgba(167,139,250,0.10)", text: "#c4b5fd" },
];

const CONF_STYLE: Record<Room["confidence"], { stroke: string; label: string; labelBg: string }> = {
    high:   { stroke: "#34d399", label: "High",   labelBg: "rgba(52,211,153,0.85)"  },
    low:    { stroke: "#fbbf24", label: "Low",    labelBg: "rgba(251,191,36,0.85)"  },
    manual: { stroke: "#94a3b8", label: "Manual", labelBg: "rgba(148,163,184,0.85)" },
};

// Hit radius (normalised coords) — ใหญ่พอที่จะจับจุดได้ง่าย โดยเฉพาะ touch screen
const DRAG_HIT = 0.045;
const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

// ─────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────
const WallReview = ({
    rooms, unit, imageUrl,
    backgroundImageUrl,
    walls = [], doors = [], windows = [],
    scale, onScaleChange, onPlanSizeChange,
    onPpmChange, onRoomUpdate, onWallUpdate, onWallAdd, onWallDelete, onGenerate,
    wallHeightMeter = 2.8, onWallHeightChange,
}: WallReviewProps) => {

    const [editState,      setEditState]      = useState<EditState | null>(null);
    const [wallEditState,  setWallEditState]  = useState<WallEditState | null>(null);
    const [selectedId,     setSelectedId]     = useState<string | null>(rooms[0]?.id ?? null);
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

    // Calibration — restore "applied" state when returning from 3D view
    const [calibPhase,  setCalibPhase]  = useState<CalibPhase>(() => scale > 0 ? "applied" : "idle");
    const [calibPts,    setCalibPts]    = useState<CalibPoint[]>([]);
    const [calibLength, setCalibLength] = useState("");
    const [mousePos,    setMousePos]    = useState<CalibPoint | null>(null);
    const [wallDrawMode, setWallDrawMode] = useState(false);
    const [wallDraftStart, setWallDraftStart] = useState<CalibPoint | null>(null);
    const [wallDraftMouse, setWallDraftMouse] = useState<CalibPoint | null>(null);

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
    const fittedImageRef = useRef<string | null>(null);
    const isAtFitRef = useRef(true);
    const selectionInitializedRef = useRef(false);
    const [isPanning, setIsPanning] = useState(false);
    const currentUnit = UNITS.find((u) => u.value === unit) ?? UNITS[0];

    useEffect(() => {
        const selectedObjectId = selectionType === "room" ? selectedId
            : selectionType === "wall" ? selectedWallId
            : selectionType === "door" ? selectedDoorId
            : selectedWindowId;
        const sidebar = sidebarScrollRef.current;
        if (!sidebar || !selectedObjectId) return;
        const item = sidebar.querySelector<HTMLElement>(`[data-plan-selection="${selectionType}:${selectedObjectId}"]`);
        if (!item) return;
        const sidebarRect = sidebar.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        const delta = itemRect.top < sidebarRect.top
            ? itemRect.top - sidebarRect.top
            : itemRect.bottom > sidebarRect.bottom
                ? itemRect.bottom - sidebarRect.bottom
                : 0;
        if (delta) sidebar.scrollBy({ top: delta, behavior: "smooth" });
    }, [selectedDoorId, selectedId, selectedWallId, selectedWindowId, selectionType]);

    // ── scale ใช้งานได้จริงเมื่อ calibrate แล้วเท่านั้น ──────
    const calibrated = calibPhase === "applied" && scale > 0;

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

    useEffect(() => {
        if (!selectionInitializedRef.current && rooms.length > 0) {
            setSelectedId(rooms[0].id);
            selectionInitializedRef.current = true;
        }
    }, [rooms]);

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
        if (wallDrawMode) return wallDraftStart ? "crosshair" : "cell";
        if (!mousePos) return "crosshair";
        if (isDragging) return "grabbing";
        if (nearestPointIdx(mousePos, calibPts, DRAG_HIT) !== -1) return "grab";
        return "crosshair";
    })();

    const stopWallDraw = () => {
        setWallDrawMode(false);
        setWallDraftStart(null);
        setWallDraftMouse(null);
    };

    const startWallDraw = () => {
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
    };

    const undoLastManualWall = () => {
        if (!onWallDelete) return;
        let wallId = manualWallHistoryRef.current.pop();
        while (wallId && !walls.some(wall => wall.id === wallId)) wallId = manualWallHistoryRef.current.pop();
        if (wallId) onWallDelete(wallId);
    };

    const createManualWall = (start: CalibPoint, end: CalibPoint) => {
        const pxLen = pixelDist(start, end);
        if (pxLen < 6 || !onWallAdd) return false;
        const endpointDistance = (a: CalibPoint, b: CalibPoint) => Math.hypot(a.x - b.x, a.y - b.y);
        const duplicate = walls.some(wall =>
            (endpointDistance(start, { x: wall.x1, y: wall.y1 }) < 0.02 && endpointDistance(end, { x: wall.x2, y: wall.y2 }) < 0.02) ||
            (endpointDistance(start, { x: wall.x2, y: wall.y2 }) < 0.02 && endpointDistance(end, { x: wall.x1, y: wall.y1 }) < 0.02)
        );
        if (duplicate) return false;
        const id = `manual-wall-${Date.now()}`;

        onWallAdd({
            id,
            x1: start.x,
            y1: start.y,
            x2: end.x,
            y2: end.y,
            type: "interior",
            thickness: 0.15,
            wallHeight: wallHeightMeter,
        });
        manualWallHistoryRef.current.push(id);
        selectWall(id);
        return true;
    };

    const onWallDrawPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const pt = evToNorm(e);
        if (!pt) return;

        if (!wallDraftStart) {
            setWallDraftStart(pt);
            setWallDraftMouse(pt);
            return;
        }

        const created = createManualWall(wallDraftStart, pt);
        setWallDraftStart(null);
        setWallDraftMouse(null);
        if (created) stopWallDraw();
    }, [wallDraftStart, onWallAdd, imgSize]);

    const onWallDrawPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const pt = evToNorm(e);
        if (pt) setWallDraftMouse(pt);
    }, []);

    const onWallDrawPointerLeave = useCallback(() => {
        setWallDraftMouse(null);
    }, []);

    // ── Calibration pointer handlers ─────────────────────────
    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const pt = evToNorm(e);
        if (!pt) return;

        // ① Grab priority — ถ้าใกล้จุดไหนพอ → drag ทันที ไม่ place ใหม่
        const idx = nearestPointIdx(pt, calibPts, DRAG_HIT);
        if (idx !== -1) {
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
    }, [calibPts, nearestPointIdx]);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const pt = evToNorm(e);
        if (!pt) return;
        setMousePos(pt);

        if (draggingIdx.current !== null) {
            e.preventDefault();
            setCalibPts(prev => {
                const next = [...prev];
                next[draggingIdx.current!] = pt;
                return next;
            });
        }
    }, []);

    const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
        draggingIdx.current = null;
        setIsDragging(false);
    }, []);

    const onPointerLeave = useCallback(() => {
        setMousePos(null);
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
        if (viewZoom <= 1 || inPointerMode || target.closest("button, input")) return;
        panStartRef.current = { x: e.clientX, y: e.clientY, panX: viewPan.x, panY: viewPan.y, captured: false };
        isAtFitRef.current = false;
        // ยังไม่ capture ตรงนี้ — รอดูก่อนว่าเป็น drag จริงหรือแค่ click
    }, [inPointerMode, viewPan, viewZoom]);

    const onPanPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
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

        const screenScale = real / px
        const screenPpm = px / real  

        onScaleChange(screenScale)
        onPlanSizeChange?.(imgSize.w * screenScale, imgSize.h * screenScale)
        onPpmChange?.(screenPpm)

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
        onPlanSizeChange?.(0, 0);
    };

    const startCalibration = () => {
        stopWallDraw();
        setCalibPhase("placing");
        setCalibPts([]);
        setCalibLength("");
        setMousePos(null);
    };

    const recalibrate = () => {
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

    // ── Layer toggle ─────────────────────────────────────────
    const toggleLayer = (layer: OverlayLayer) =>
        setLayers(prev => { const s = new Set(prev); s.has(layer) ? s.delete(layer) : s.add(layer); return s; });

    // ── Room editing ─────────────────────────────────────────
    // FIX: ถ้า calibrate แล้ว แสดงค่าจาก bbox × imgSize × scale แทน normalized width/height
    const getDisplay = (room: Room, field: "width" | "height" | "wallHeight") => {
        if (field === "wallHeight") return +(room.wallHeight ?? wallHeightMeter).toFixed(2);
        const bbox = roomBBox(room);
        if (calibrated && bbox) {
            const px = field === "width"
                ? bbox.w * imgSize.w * scale
                : bbox.h * imgSize.h * scale;
            return +px.toFixed(2);
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
    const getWallLength = (w: DetectedWallSegment) => {
        const dx = (w.x2 - w.x1) * imgSize.w;
        const dy = (w.y2 - w.y1) * imgSize.h;
        const px = Math.sqrt(dx * dx + dy * dy);
        if (calibrated) return px * scale;
        // ก่อน calibrate — คืน pixel distance หารด้วย 40 เป็น approximation
        return px / 40;
    };

    const getWallThickness = (w: DetectedWallSegment): number | null =>
        typeof w.thickness === "number" ? w.thickness : null;
    const getWallHeight = (w: DetectedWallSegment): number | null =>
        typeof w.wallHeight === "number" ? w.wallHeight : wallHeightMeter;
    const getWallThicknessLabel = (w: DetectedWallSegment) =>
        getWallThickness(w) !== null
            ? `${(getWallThickness(w)! * 100).toFixed(0)}cm`
            : w.thicknessRatio != null
                ? `r ${(w.thicknessRatio).toFixed(3)}`
                : "N/A";

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
    };
    const selectRoom = (id: string) => {
        setSelectedId(id); setSelectionType("room"); setSelectedWallId(null); setSelectedDoorId(null); setSelectedWindowId(null);
    };
    const selectWall = (id: string) => {
        setSelectedWallId(id); setSelectionType("wall"); setSelectedId(null); setSelectedDoorId(null); setSelectedWindowId(null);
    };
    const selectDoor = (id: string) => {
        setSelectedDoorId(id); setSelectionType("door"); setSelectedId(null); setSelectedWallId(null); setSelectedWindowId(null);
    };
    const selectWindow = (id: string) => {
        setSelectedWindowId(id); setSelectionType("window"); setSelectedId(null); setSelectedWallId(null); setSelectedDoorId(null);
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
    const selectedRoom = rooms.find(r => r.id === selectedId);
    const selectedIdx  = rooms.findIndex(r => r.id === selectedId);
    const palette      = selectedIdx >= 0 ? ROOM_PALETTE[selectedIdx % ROOM_PALETTE.length] : ROOM_PALETTE[0];
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

    const getRoomAreaM2 = (room: Room): number | null => {
        if (typeof room.areaSqm === "number" && room.areaSqm > 0) return room.areaSqm;
        if (room.width > 1 || room.height > 1) return room.width * room.height;
        const polygon = room.polygon && room.polygon.length >= 3
            ? room.polygon
            : room.wallPolygon && room.wallPolygon.length >= 3
                ? room.wallPolygon
                : null;
        if (!calibrated || !polygon) return null;
        return polygonArea(polygon, imgSize.w * scale, imgSize.h * scale);
    };

    // FIX: คืน null เมื่อยังไม่ calibrate เพื่อให้ panel ขวา block ตัวเลขเมตร
    const bboxToM = (normDim: number, axis: "w" | "h"): number | null =>
        calibrated ? normDim * (axis === "w" ? imgSize.w : imgSize.h) * scale : null;

    // ── ค่า label บน SVG overlay ────────────────────────────
    // ถ้ายังไม่ calibrate แสดง "N/A" แทนตัวเลขเมตร
    const dimLabel = (normDim: number, axis: "w" | "h"): string => {
        const m = bboxToM(normDim, axis);
        return m !== null ? `${m.toFixed(2)}m` : "N/A";
    };

    // ── ค่า door/window width เป็นเมตร ──────────────────────
    // widthPx เป็น pixel จาก bbox ของ YOLO → ต้องคูณ scale เพื่อให้เป็นเมตร
    const doorWidthM   = (d: DetectedDoor):   number | null => calibrated && d.widthPx ? d.widthPx * scale : null;
    const windowWidthM = (w: DetectedWindow): number | null => calibrated && w.widthPx ? w.widthPx * scale : (w.widthM ?? null);
    const polygonPath = (points?: { x: number; y: number }[] | null): string | null => {
        if (!points || points.length < 3) return null;
        return points.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ") + " Z";
    };

    // Resolve selection from plan-space coordinates so direct selection remains
    // reliable for thin detected lines and at every viewport zoom/pan level.
    const onPlanClick = (e: React.MouseEvent<SVGSVGElement>) => {
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

        const door = layers.has("doors") && doors.find(item => inRect(item.bbox, 0.012));
        if (door) return selectDoor(door.id);
        const windowItem = layers.has("windows") && windows.find(item => inRect(item.bbox, 0.012));
        if (windowItem) return selectWindow(windowItem.id);
        const wall = layers.has("walls") && walls.find(item => distanceToSegmentPx(item) <= 12);
        if (wall) return selectWall(wall.id);
        const room = layers.has("rooms") && rooms.find(item => {
            const polygon = item.wallPolygon ?? item.polygon;
            return polygon && polygon.length >= 3 ? inPolygon(polygon) : (() => {
                const bbox = roomBBox(item);
                return bbox ? inRect(bbox) : false;
            })();
        });
        if (room) return selectRoom(room.id);
        clearSelection();
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
            <div className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between gap-3 bg-card/30 flex-wrap">
                <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                    <div>
                        <span className="text-sm font-semibold text-foreground">Wall &amp; Room Review</span>
                        <span className="ml-2 text-[11px] text-muted-foreground">
                            {rooms.length} rooms · {walls.length} walls · {doors.length} doors · {windows.length} windows
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-3 flex-wrap">

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
                                    <Crosshair className="w-3.5 h-3.5" />
                                    {scale.toFixed(5)} m/px
                                </button>
                                <button onClick={resetCalibration} title="รีเซ็ต"
                                    className="p-1 rounded hover:bg-slate-100 text-muted-foreground/70 hover:text-foreground transition-colors">
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
                                <span className="text-[10px] text-muted-foreground shrink-0">m</span>
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
                    <div className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 border border-border bg-card/80"
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
                    <div className={`flex items-center gap-2 rounded-lg px-3 py-1.5 border transition-all duration-200 ${
                        wallDrawMode ? "border-blue-500/60 bg-blue-500/10" : "border-border bg-card/80"
                    }`}>
                        {!wallDrawMode ? (
                            <button onClick={startWallDraw}
                                className="flex items-center gap-1.5 text-[11px] font-medium text-blue-300 hover:text-blue-200 transition-colors">
                                <Pencil className="w-3.5 h-3.5" />
                                Draw Wall
                            </button>
                        ) : (
                            <>
                                <Pencil className="w-3.5 h-3.5 text-blue-400 animate-pulse shrink-0" />
                                <span className="text-[11px] text-blue-300 font-medium whitespace-nowrap">
                                    {wallDraftStart ? "Click end point" : "Click start point"}
                                </span>
                                <button onClick={stopWallDraw} className="p-1 rounded hover:bg-slate-100 text-muted-foreground">
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </>
                        )}
                        <button
                            onClick={undoLastManualWall}
                            disabled={!onWallDelete || manualWallHistoryRef.current.length === 0}
                            title="Undo last manual wall"
                            className="p-1 rounded text-muted-foreground/70 hover:bg-slate-100 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                            <RotateCcw className="w-3 h-3" />
                        </button>
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
                            { id: "windows", label: "Windows", color: "#06b6d4" },
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
                                    style={{ pointerEvents: inPointerMode ? "none" : "all" }}
                                    onClickCapture={onPlanClick}>

                                    <g transform="scale(100)">

                                    {/* WALLS */}
                                    {layers.has("walls") && walls.map(wall => {
                                        const isSel = selectedWallId === wall.id;
                                        const sw = wall.thicknessRatio != null
                                            ? Math.max(0.002, Math.min(wall.thicknessRatio * 0.35, 0.012))
                                            : wall.type === "exterior" ? 0.006 : 0.003;                                        const isManual = wall.id.startsWith("manual-wall-");
                                        const col = isSel ? "#fbbf24" : isManual ? "#38bdf8" : wall.type === "exterior" ? "#1a1a1a" : "#2563eb";
                                        const mx = (wall.x1 + wall.x2) / 2, my = (wall.y1 + wall.y2) / 2;

                                        // ขยาย endpoint ออก sw/2 ในแกนที่เป็นแนวของเส้น
                                        // เพื่อให้มุมผนังเชื่อมกันแม้ preserveAspectRatio="none" ทำให้ linecap ไม่สมมาตร
                                        const isHoriz = Math.abs(wall.y2 - wall.y1) < 0.005;
                                        const isVert  = Math.abs(wall.x2 - wall.x1) < 0.005;
                                        const half = sw / 2;
                                        const ex1 = isHoriz ? wall.x1 - half : wall.x1;
                                        const ex2 = isHoriz ? wall.x2 + half : wall.x2;
                                        const ey1 = isVert  ? wall.y1 - half : wall.y1;
                                        const ey2 = isVert  ? wall.y2 + half : wall.y2;

                                        return (
                                            <g key={wall.id} style={{ cursor: "pointer", pointerEvents: "all" }}>
                                                <line x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2} stroke="transparent" strokeWidth={sw + 0.025} pointerEvents="stroke" />
                                                {isSel && <line x1={ex1} y1={ey1} x2={ex2} y2={ey2} stroke="#fbbf24" strokeWidth={sw + 0.008} strokeLinecap="butt" opacity={0.45} />}
                                                <line x1={ex1} y1={ey1} x2={ex2} y2={ey2} stroke={col} strokeWidth={isSel ? sw + 0.002 : sw} strokeLinecap="butt" opacity={isSel ? 1 : 0.85} />
                                                {isSel && (
                                                    <g style={{ pointerEvents: "none" }}>
                                                        <rect x={mx - 0.075} y={my - 0.045} width={0.15} height={0.032} rx={0.005} fill="rgba(251,191,36,0.95)" />
                                                        <text x={mx} y={my - 0.018} textAnchor="middle" fontSize={0.02} fontWeight="700" fill="#000" fontFamily="monospace">
                                                            {calibrated
                                                                ? `${getWallLength(wall).toFixed(2)}m · ${getWallThicknessLabel(wall)}`
                                                                : `— · ${getWallThicknessLabel(wall)}`}
                                                        </text>
                                                    </g>
                                                )}
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

                                    {/* ROOMS */}
                                    {layers.has("rooms") && rooms.map((room, idx) => {
                                        const bbox = roomBBox(room);
                                        const polygon = room.wallPolygon ?? room.polygon ?? null;
                                        if (!bbox && (!polygon || polygon.length < 3)) return null;
                                        const cs = CONF_STYLE[room.confidence] ?? CONF_STYLE.manual;
                                        const pal = ROOM_PALETTE[idx % ROOM_PALETTE.length];
                                        const isSel = selectedId === room.id;
                                        const points = polygon && polygon.length >= 3
                                            ? polygon.map((p) => `${p.x},${p.y}`).join(" ")
                                            : `${bbox.x},${bbox.y} ${bbox.x + bbox.w},${bbox.y} ${bbox.x + bbox.w},${bbox.y + bbox.h} ${bbox.x},${bbox.y + bbox.h}`;
                                        const cx = room.center?.x ?? (bbox.x + bbox.w / 2);
                                        const cy = room.center?.y ?? (bbox.y + bbox.h / 2);
                                        const { x: rx0, y: ry0, w: rw, h: rh } = bbox;
                                        const badgeW = Math.max(0, Math.min(rw - 0.008, (room.name ?? "").length * 0.009 + 0.015));
                                        // FIX: ใช้ dimLabel ที่ block ก่อน calibrate
                                        const wL = dimLabel(rw, "w");
                                        const hL = dimLabel(rh, "h");
                                        return (
                                            <g key={room.id} style={{ cursor: "pointer", pointerEvents: "all" }}>                                               <polygon points={points} fill={isSel ? pal.fill : `${cs.stroke}18`} />
                                                <polygon points={points} fill="none" stroke={isSel ? pal.stroke : cs.stroke}
                                                    strokeWidth={isSel ? 0.004 : 0.002} strokeDasharray={isSel ? "none" : "0.01 0.005"} opacity={isSel ? 1 : 0.6} />
                                                {isSel && <circle cx={cx} cy={cy} r={0.008} fill={pal.stroke} opacity={0.85} />}
                                                {badgeW > 0.01 && <>
                                                    <rect x={cx - badgeW / 2} y={cy - 0.02} width={badgeW} height={0.025} rx={0.005} fill={isSel ? pal.stroke : cs.labelBg} opacity={0.92} />
                                                    <text x={cx - badgeW / 2 + 0.006} y={cy - 0.003} fontSize={0.016} fontWeight="600" fill="#000" fontFamily="sans-serif">{room.name}</text>
                                                </>}
                                                <text x={cx} y={cy + 0.032} textAnchor="middle" fontSize={0.014} fill={isSel ? pal.text : cs.stroke} fontFamily="monospace" opacity={isSel ? 1 : 0.7}>{wL}</text>
                                                <text x={cx + (bbox.w / 2 + 0.008)} y={cy + 0.007} textAnchor="start" fontSize={0.014} fill={isSel ? pal.text : cs.stroke} fontFamily="monospace" opacity={isSel ? 1 : 0.7}>{hL}</text>
                                            </g>
                                        );
                                    })}

                                    {/* DOORS */}
                                    {layers.has("doors") && doors.map(door => {
                                        const { x: dx, y: dy, w: dw, h: dh0 } = door.bbox;
                                        const dh = Math.max(dh0, 0.012); 
                                        const cx = dx + dw / 2, cy = dy + dh / 2;
                                        const wM = doorWidthM(door);
                                        const visualRadius = dw;
                                        const doorPath = polygonPath(door.polygon) ?? `M ${cx} ${cy} L ${cx + visualRadius} ${cy} A ${visualRadius} ${visualRadius} 0 0 0 ${cx} ${cy - visualRadius} Z`;

                                        const isSel = selectionType === "door" && selectedDoorId === door.id;
                                        return (
                                            <g key={door.id} style={{ cursor: "pointer", pointerEvents: "all" }}>                                               <rect x={dx - 0.012} y={dy - 0.012} width={dw + 0.024} height={dh + 0.024} fill="transparent" />
                                                {isSel && <rect x={dx - 0.008} y={dy - 0.008} width={dw + 0.016} height={dh + 0.016} fill="none" stroke="#fef3c7" strokeWidth={0.004} rx={0.003} />}
                                                <path 
                                                    d={doorPath} 
                                                    fill="rgba(245,158,11,0.25)" // เพิ่มความเข้ม
                                                    stroke="#f59e0b" 
                                                    strokeWidth={0.004} // เพิ่มความหนาเส้น
                                                    opacity={0.9} 
                                                />
                                                {/* ... ส่วน Text ... */}
                                            </g>
                                        );
                                    })}

                                    {/* WINDOWS */}
                                    {layers.has("windows") && windows.map(win => {
                                        const { x: wx, y: wy, w: ww, h: wh0 } = win.bbox;
                                        const wh = Math.max(wh0, 0.008);
                                        const isSel = selectionType === "window" && selectedWindowId === win.id;
                                        // FIX: ใช้ windowWidthM helper ที่ block ก่อน calibrate
                                        const wM = windowWidthM(win);
                                        return (
                                            <g key={win.id} style={{ cursor: "pointer", pointerEvents: "all" }}>                                                {isSel && <rect x={wx - 0.008} y={wy - 0.008} width={ww + 0.016} height={wh + 0.016} fill="none" stroke="#cffafe" strokeWidth={0.004} rx={0.003} />}
                                                <rect x={wx} y={wy} width={ww} height={wh} fill="rgba(6,182,212,0.12)" stroke="#06b6d4" strokeWidth={0.003} rx={0.002} opacity={0.85} />
                                                <line x1={wx + ww * 0.33} y1={wy} x2={wx + ww * 0.33} y2={wy + wh} stroke="#06b6d4" strokeWidth={0.002} opacity={0.6} />
                                                <line x1={wx + ww * 0.67} y1={wy} x2={wx + ww * 0.67} y2={wy + wh} stroke="#06b6d4" strokeWidth={0.002} opacity={0.6} />
                                                <text x={wx + ww / 2} y={wy + wh + 0.018} textAnchor="middle" fontSize={0.013} fill="#06b6d4" fontFamily="monospace" opacity={0.9}>
                                                    W {wM !== null ? `${wM.toFixed(2)}m` : "N/A"}
                                                </text>
                                            </g>
                                        );
                                    })}

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
                                                const isHovered = mousePos && normDist(mousePos, pt) < DRAG_HIT;
                                                const isThisDragging = isDragging && draggingIdx.current === i;
                                                const showRing = isHovered || isThisDragging;
                                                return (
                                                    <g key={i} style={{ pointerEvents: "none" }}>
                                                        <circle cx={pt.x} cy={pt.y} r={0.022}
                                                            fill={isThisDragging ? "rgba(251,191,36,0.25)" : "rgba(251,191,36,0.15)"}
                                                            stroke="#fbbf24"
                                                            strokeWidth={isThisDragging ? 0.003 : 0.002}
                                                            opacity={showRing ? 1 : 0}
                                                            style={{ transition: "opacity 0.08s" }}
                                                        />
                                                        <circle cx={pt.x} cy={pt.y} r={0.007} fill="#fbbf24" />
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
                                    </g>
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
                <div className="w-[280px] shrink-0 border-l border-border flex flex-col bg-card/30 overflow-hidden">
                    <div ref={sidebarScrollRef} className="flex-1 overflow-y-auto p-3 space-y-1.5">
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-2 flex items-center gap-1.5">
                            <Layers className="w-3 h-3" /> Rooms
                        </p>

                        {/* FIX: Banner แจ้ง calibrate ก่อนถ้ายังไม่ทำ */}
                        {!calibrated && (
                            <div className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 flex items-center gap-2">
                                <Crosshair className="w-3 h-3 text-amber-400 shrink-0" />
                                <span className="text-[10px] text-amber-400/80">Calibrate scale ก่อนเพื่อดูขนาดเป็นเมตร</span>
                            </div>
                        )}

                        {rooms.map((room, idx) => {
                            const cs = CONF_STYLE[room.confidence] ?? CONF_STYLE.manual;
                            const pal = ROOM_PALETTE[idx % ROOM_PALETTE.length];
                            const isSel = selectedId === room.id && selectionType === "room";
                            const Icon = room.confidence === "high" ? CheckCircle2 : AlertCircle;
                            const bbox = roomBBox(room);
                            // FIX: block ตัวเลขเมตรจนกว่าจะ calibrate
                            const realW = bbox ? bboxToM(bbox.w, "w") : null;
                            const realH = bbox ? bboxToM(bbox.h, "h") : null;
                            return (
                                <button key={room.id} data-plan-selection={`room:${room.id}`} onClick={() => selectRoom(room.id)}
                                    className={`w-full text-left rounded-lg px-3 py-2.5 border transition-all duration-200 ${isSel ? "shadow-sm" : "border-border/70 hover:border-border hover:bg-accent/60"}`}
                                    style={isSel ? { borderColor: `${pal.stroke}60`, background: pal.fill } : {}}>
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: pal.stroke }} />
                                            <span className="text-xs font-medium text-foreground truncate">{room.name}</span>
                                        </div>
                                        <Icon className="w-3 h-3 shrink-0" style={{ color: cs.stroke }} />
                                    </div>
                                    <div className="mt-1 text-[10px] font-mono text-muted-foreground">
                                        {realW !== null
                                            ? <span className="text-emerald-400">{realW.toFixed(2)} × {realH?.toFixed(2)} m</span>
                                            : <span className="text-muted-foreground/40">— × — m</span>
                                        }
                                    </div>
                                </button>
                            );
                        })}

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
                                                <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${isExt ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}>{isExt ? "EXT" : "INT"}</span>
                                            </div>
                                            <div className="mt-1 text-[10px] font-mono text-muted-foreground flex gap-3">
                                                {/* FIX: แสดง — ก่อน calibrate */}
                                                <span>L: {calibrated ? `${getWallLength(wall).toFixed(1)}m` : "N/A"}</span>
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
                                    const wM = doorWidthM(d);
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
                                    <AppWindow className="w-3 h-3 text-cyan-400" /> Windows ({windows.length})
                                </p>
                                {windows.map(w => {
                                    const wM = windowWidthM(w);
                                    const isSel = selectionType === "window" && selectedWindowId === w.id;
                                    return (
                                        <button key={w.id} data-plan-selection={`window:${w.id}`} onClick={() => selectWindow(w.id)}
                                            className={`w-full rounded px-2 py-1 text-left text-[10px] font-mono transition-colors ${isSel ? "bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-500/40" : "text-cyan-400/70 hover:bg-accent"}`}>
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
                    </div>

                    <div className="shrink-0 border-t border-border" />

                    {/* Room editor */}
                    {selectionType === "room" && selectedRoom && (
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
                    {selectionType === "wall" && selectedWallId && (() => {
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
                                        {calibrated ? `${getWallLength(sw).toFixed(2)} m` : "N/A"}
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

                    {/* BOTTOM HINT */}
                    <div className="shrink-0 px-5 py-1.5 border-t border-border bg-card/20 flex items-center justify-between text-[10px] text-muted-foreground/50">
                        <div className="flex items-center gap-1.5">
                            <Pencil className="w-3 h-3" />
                            คลิกห้อง/กำแพงเพื่อเลือก · คลิกตัวเลขเพื่อแก้ไข · Enter บันทึก · Esc ยกเลิก
                        </div>
                        {calibrated && (
                            <div className="flex items-center gap-1.5 text-emerald-500/60">
                                <Crosshair className="w-3 h-3" />
                                Scale: {scale.toFixed(5)} m/px
                            </div>
                        )}
                        {inCalibMode && (
                            <div className="flex items-center gap-1.5 text-amber-400/60 animate-pulse">
                                <Crosshair className="w-3 h-3" />
                                Calibration mode active — ลาก P1/P2 เพื่อปรับ
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default WallReview;
