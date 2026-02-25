import { useState, useRef, useEffect } from "react";
import {
    CheckCircle2, AlertCircle, Pencil, Check, X,
    ArrowRight, Zap, ChevronLeft, ChevronRight,
    DoorOpen, AppWindow, Layers, Image, ImageOff,
    Eye, EyeOff, Ruler,
} from "lucide-react";
import type { Room, DimensionUnit } from "@/types/floorplan";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";
import { UNITS } from "@/types/floorplan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface WallReviewProps {
    rooms: Room[];
    unit: DimensionUnit;
    imageUrl: string | null;
    walls?: DetectedWallSegment[];
    doors?: DetectedDoor[];
    windows?: DetectedWindow[];
    onRoomUpdate: (id: string, field: keyof Room, value: number | string) => void;
    onWallUpdate?: (id: string, field: keyof DetectedWallSegment, value: number | string) => void;
    onGenerate: () => void;
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

type SelectionType = "room" | "wall";

type OverlayLayer = "rooms" | "walls" | "doors" | "windows" | "image";

// Palette for room overlays
const ROOM_PALETTE = [
    { stroke: "#60a5fa", fill: "rgba(96,165,250,0.10)", text: "#93c5fd" },
    { stroke: "#34d399", fill: "rgba(52,211,153,0.10)", text: "#6ee7b7" },
    { stroke: "#f472b6", fill: "rgba(244,114,182,0.10)", text: "#f9a8d4" },
    { stroke: "#fb923c", fill: "rgba(251,146,60,0.10)", text: "#fdba74" },
    { stroke: "#a78bfa", fill: "rgba(167,139,250,0.10)", text: "#c4b5fd" },
];

const CONF_STYLE: Record<Room["confidence"], { stroke: string; label: string; labelBg: string }> = {
    high: { stroke: "#34d399", label: "High", labelBg: "rgba(52,211,153,0.85)" },
    low: { stroke: "#fbbf24", label: "Low", labelBg: "rgba(251,191,36,0.85)" },
    manual: { stroke: "#94a3b8", label: "Manual", labelBg: "rgba(148,163,184,0.85)" },
};

const WallReview = ({
    rooms, unit, imageUrl,
    walls = [], doors = [], windows = [],
    onRoomUpdate, onWallUpdate, onGenerate,
}: WallReviewProps) => {
    const [editState, setEditState] = useState<EditState | null>(null);
    const [wallEditState, setWallEditState] = useState<WallEditState | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(rooms[0]?.id ?? null);
    const [selectionType, setSelectionType] = useState<SelectionType>("room");
    const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
    const [imgSize, setImgSize] = useState({ w: 1, h: 1 });
    const [layers, setLayers] = useState<Set<OverlayLayer>>(
        new Set(["rooms", "walls", "doors", "windows", "image"])
    );
    const imgRef = useRef<HTMLImageElement>(null);

    const currentUnit = UNITS.find((u) => u.value === unit) ?? UNITS[0];

    // Track rendered image size via ResizeObserver (correct for any window size)
    useEffect(() => {
        const el = imgRef.current;
        if (!el) return;
        const measure = () => {
            setImgSize({ w: el.clientWidth, h: el.clientHeight });
        };
        // Measure immediately after load
        if (el.complete) measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [imageUrl]);

    const toggleLayer = (layer: OverlayLayer) =>
        setLayers((prev) => {
            const s = new Set(prev);
            s.has(layer) ? s.delete(layer) : s.add(layer);
            return s;
        });

    /* ── editing helpers ── */
    const getDisplay = (room: Room, field: "width" | "height" | "wallHeight") => {
        if (field === "wallHeight") return +(room.wallHeight ?? 2.8).toFixed(2);
        const raw = field === "width" ? room.width : room.height;
        return +(raw / currentUnit.toMeter).toFixed(2);
    };

    const startEdit = (roomId: string, field: EditState["field"], val: number) =>
        setEditState({ roomId, field, value: String(val) });

    const commitEdit = () => {
        if (!editState) return;
        const v = parseFloat(editState.value);
        if (!isNaN(v) && v > 0) {
            if (editState.field === "wallHeight") {
                onRoomUpdate(editState.roomId, "wallHeight", v);
            } else {
                onRoomUpdate(editState.roomId, editState.field, v * currentUnit.toMeter);
            }
        }
        setEditState(null);
    };

    const isEditing = (roomId: string, field: EditState["field"]) =>
        editState?.roomId === roomId && editState?.field === field;

    /* ── wall editing helpers ── */
    const getWallLength = (wall: DetectedWallSegment) => {
        const dx = (wall.x2 - wall.x1) * 20; // PLAN_SIZE = 20
        const dz = (wall.y2 - wall.y1) * 20;
        return Math.sqrt(dx * dx + dz * dz);
    };

    const getWallThickness = (wall: DetectedWallSegment) =>
        wall.thickness ?? (wall.type === "exterior" ? 0.25 : 0.15);

    const getWallHeight = (wall: DetectedWallSegment) =>
        wall.wallHeight ?? 2.8;

    const startWallEdit = (wallId: string, field: WallEditState["field"], val: number) =>
        setWallEditState({ wallId, field, value: String(val) });

    const commitWallEdit = () => {
        if (!wallEditState || !onWallUpdate) return;
        const v = parseFloat(wallEditState.value);
        if (!isNaN(v) && v > 0) {
            if (wallEditState.field === "thickness") {
                onWallUpdate(wallEditState.wallId, "thickness", v / 100); // cm → m
            } else {
                onWallUpdate(wallEditState.wallId, "wallHeight", v);
            }
        }
        setWallEditState(null);
    };

    const isWallEditing = (wallId: string, field: WallEditState["field"]) =>
        wallEditState?.wallId === wallId && wallEditState?.field === field;

    const selectRoom = (id: string) => {
        setSelectedId(id);
        setSelectionType("room");
        setSelectedWallId(null);
    };

    const selectWall = (id: string) => {
        setSelectedWallId(id);
        setSelectionType("wall");
        setSelectedId(null);
    };

    /* ── sub-components ── */
    const EditableCell = ({
        room, field, label, suffix,
    }: { room: Room; field: EditState["field"]; label: string; suffix: string }) => {
        const val = getDisplay(room, field);
        const editing = isEditing(room.id, field);
        return (
            <div className="flex-1 min-w-0">
                <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
                {editing ? (
                    <div className="flex items-center gap-0.5">
                        <Input
                            type="number"
                            autoFocus
                            value={editState!.value}
                            onChange={(e) => setEditState((s) => s ? { ...s, value: e.target.value } : s)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditState(null); }}
                            className="h-7 text-xs font-mono px-2 border-primary/60"
                        />
                        <button onClick={commitEdit} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400 shrink-0">
                            <Check className="w-3 h-3" />
                        </button>
                        <button onClick={() => setEditState(null)} className="p-1 rounded hover:bg-red-500/20 text-red-400 shrink-0">
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                ) : (
                    <button
                        onClick={() => startEdit(room.id, field, val)}
                        className="group flex items-center gap-1 w-full text-left px-1 py-0.5 -mx-1 rounded hover:bg-white/5 transition-colors"
                    >
                        <span className="text-sm font-mono font-semibold text-foreground">{val}</span>
                        <span className="text-[10px] text-muted-foreground">{suffix}</span>
                        <Pencil className="w-2.5 h-2.5 text-muted-foreground/0 group-hover:text-muted-foreground/50 ml-auto shrink-0 transition-colors" />
                    </button>
                )}
            </div>
        );
    };

    const selectedRoom = rooms.find((r) => r.id === selectedId);
    const selectedIdx = rooms.findIndex((r) => r.id === selectedId);
    const palette = ROOM_PALETTE[selectedIdx % ROOM_PALETTE.length];

    const navigate = (dir: -1 | 1) => {
        const next = selectedIdx + dir;
        if (next >= 0 && next < rooms.length) setSelectedId(rooms[next].id);
    };

    /* ── bbox → pixel helpers ── */
    // imgSize tracks the true rendered px size of the <img> element (updated by ResizeObserver)
    const bx = (v: number) => v * imgSize.w;
    const by = (v: number) => v * imgSize.h;

    /* ── Room bbox: stored in room as bbox field if from AI ── */
    const roomBBox = (room: Room): { x: number; y: number; w: number; h: number } | null => {
        const r = room as Room & { bbox?: { x: number; y: number; w: number; h: number } };
        return r.bbox ?? null;
    };

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* ── Top action bar ── */}
            <div className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between gap-3 bg-card/30">
                <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                    <div>
                        <span className="text-sm font-semibold text-foreground">Wall &amp; Room Review</span>
                        <span className="ml-2 text-[11px] text-muted-foreground">
                            {rooms.length} rooms · {walls.length} walls · {doors.length} doors · {windows.length} windows
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    {/* Layer toggles */}
                    <div className="flex items-center gap-1 bg-black/20 rounded-lg p-1 border border-white/[0.06]">
                        {/* Image toggle */}
                        <button
                            onClick={() => toggleLayer("image")}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all duration-150 border ${layers.has("image")
                                ? "bg-white/10 text-foreground border-white/10"
                                : "text-muted-foreground/40 hover:text-muted-foreground border-transparent"
                                }`}
                            title={layers.has("image") ? "ซ่อนรูปแปลนบ้าน" : "แสดงรูปแปลนบ้าน"}
                        >
                            {layers.has("image")
                                ? <Eye className="w-3 h-3 text-emerald-400" />
                                : <EyeOff className="w-3 h-3" />}
                            <span className="hidden sm:inline">Image</span>
                        </button>
                        <div className="w-px h-4 bg-white/10 mx-0.5" />
                        {([
                            { id: "rooms", label: "Rooms", color: "#60a5fa" },
                            { id: "walls", label: "Walls", color: "#94a3b8" },
                            { id: "doors", label: "Doors", color: "#f59e0b" },
                            { id: "windows", label: "Windows", color: "#06b6d4" },
                        ] as { id: OverlayLayer; label: string; color: string }[]).map(({ id, label, color }) => (
                            <button
                                key={id}
                                onClick={() => toggleLayer(id)}
                                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all duration-150 ${layers.has(id) ? "bg-white/10 text-foreground" : "text-muted-foreground/40 hover:text-muted-foreground"
                                    }`}
                            >
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: layers.has(id) ? color : "#374151" }} />
                                <span className="hidden sm:inline">{label}</span>
                            </button>
                        ))}
                    </div>

                    <Button
                        onClick={onGenerate}
                        className="gap-2 h-9 px-4 text-xs font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-[0_0_16px_rgba(59,130,246,0.35)] hover:shadow-[0_0_24px_rgba(59,130,246,0.5)] transition-all"
                    >
                        <Zap className="w-3.5 h-3.5" />
                        Generate 3D
                        <ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                </div>
            </div>

            {/* ── Main split view ── */}
            <div className="flex-1 flex min-h-0">

                {/* LEFT — floor plan image with SVG overlay */}
                <div className="flex-1 relative bg-black/20 flex items-center justify-center overflow-hidden">
                    {imageUrl ? (
                        <div className="relative w-full h-full flex items-center justify-center p-4">
                            {/* inline-block shrinks to exactly the rendered image size */}
                            <div className="relative inline-block" style={{ lineHeight: 0 }}>
                                <img
                                    ref={imgRef}
                                    src={imageUrl}
                                    alt="Floor plan"
                                    className="block max-w-full max-h-[calc(100vh-160px)] rounded-lg shadow-2xl transition-opacity duration-300"
                                    style={{
                                        filter: "brightness(0.92) contrast(1.05)",
                                        opacity: layers.has("image") ? 1 : 0,
                                    }}
                                    onLoad={() => {
                                        if (imgRef.current) {
                                            setImgSize({ w: imgRef.current.clientWidth, h: imgRef.current.clientHeight });
                                        }
                                    }}
                                />

                                {/* SVG overlay — viewBox 0 0 1 1 so all wall/room coords (0-1) map directly.
                                    preserveAspectRatio=none + inset-0 makes it stretch exactly over <img>. */}
                                <svg
                                    className="absolute inset-0 pointer-events-none"
                                    width="100%"
                                    height="100%"
                                    viewBox="0 0 1 1"
                                    preserveAspectRatio="none"
                                >
                                    {/* ── WALLS ── */}
                                    {layers.has("walls") && walls.map((wall) => {
                                        const isWallSelected = selectedWallId === wall.id;
                                        // Coords are already 0-1 normalised — use directly
                                        const wx1 = wall.x1, wy1 = wall.y1;
                                        const wx2 = wall.x2, wy2 = wall.y2;
                                        const wmx = (wx1 + wx2) / 2, wmy = (wy1 + wy2) / 2;
                                        const wLen = getWallLength(wall);
                                        const wThick = getWallThickness(wall);

                                        // strokeWidth in normalised units. thicknessRatio is already image-relative (0-1).
                                        const strokeNorm = wall.thicknessRatio != null
                                            ? Math.max(0.004, wall.thicknessRatio)
                                            : wall.type === "exterior" ? 0.013 : 0.007;

                                        const wallColor = isWallSelected
                                            ? "#fbbf24"
                                            : wall.type === "exterior"
                                                ? "#1a1a1a"
                                                : "#3a3a3a";

                                        return (
                                            <g
                                                key={wall.id}
                                                style={{ cursor: "pointer", pointerEvents: "all" }}
                                                onClick={(e) => { e.stopPropagation(); selectWall(wall.id); }}
                                            >
                                                {/* Transparent hit area */}
                                                <line
                                                    x1={wx1} y1={wy1} x2={wx2} y2={wy2}
                                                    stroke="transparent"
                                                    strokeWidth={strokeNorm + 0.025}
                                                    pointerEvents="stroke"
                                                />
                                                {/* Amber glow when selected */}
                                                {isWallSelected && (
                                                    <line
                                                        x1={wx1} y1={wy1} x2={wx2} y2={wy2}
                                                        stroke="#fbbf24"
                                                        strokeWidth={strokeNorm + 0.008}
                                                        strokeLinecap="square"
                                                        opacity={0.45}
                                                    />
                                                )}
                                                {/* Thick wall line */}
                                                <line
                                                    x1={wx1} y1={wy1} x2={wx2} y2={wy2}
                                                    stroke={wallColor}
                                                    strokeWidth={isWallSelected ? strokeNorm + 0.002 : strokeNorm}
                                                    strokeLinecap="square"
                                                    opacity={isWallSelected ? 1 : 0.85}
                                                />
                                                {/* Dimension label */}
                                                {isWallSelected && (
                                                    <g style={{ pointerEvents: "none" }}>
                                                        <rect
                                                            x={wmx - 0.065} y={wmy - 0.045}
                                                            width={0.13} height={0.032}
                                                            rx={0.005}
                                                            fill="rgba(251,191,36,0.95)"
                                                        />
                                                        <text
                                                            x={wmx} y={wmy - 0.018}
                                                            textAnchor="middle"
                                                            fontSize={0.02}
                                                            fontWeight="700"
                                                            fill="#000"
                                                            fontFamily="monospace"
                                                        >
                                                            {wLen.toFixed(1)}m · {(wThick * 100).toFixed(0)}cm
                                                        </text>
                                                    </g>
                                                )}
                                            </g>
                                        );
                                    })}

                                    {/* ── ROOMS ── */}
                                    {layers.has("rooms") && rooms.map((room, idx) => {
                                        const bbox = roomBBox(room);
                                        if (!bbox) return null;
                                        const cs = CONF_STYLE[room.confidence];
                                        const pal = ROOM_PALETTE[idx % ROOM_PALETTE.length];
                                        // Use normalised coords directly
                                        const rx0 = bbox.x, ry0 = bbox.y;
                                        const rw = bbox.w, rh = bbox.h;
                                        const isSelected = selectedId === room.id;
                                        const nameLen = room.name.length;
                                        const badgeW = Math.max(0, Math.min(rw - 0.008, nameLen * 0.009 + 0.015));

                                        return (
                                            <g key={room.id}>
                                                <rect x={rx0} y={ry0} width={rw} height={rh}
                                                    fill={isSelected ? pal.fill : `${cs.stroke}18`} rx={0.004} />
                                                <rect x={rx0} y={ry0} width={rw} height={rh}
                                                    fill="none"
                                                    stroke={isSelected ? pal.stroke : cs.stroke}
                                                    strokeWidth={isSelected ? 0.004 : 0.002}
                                                    strokeDasharray={isSelected ? "none" : "0.01 0.005"}
                                                    rx={0.004} opacity={isSelected ? 1 : 0.6} />

                                                {/* Corner ticks */}
                                                {isSelected && [
                                                    [[rx0, ry0 + 0.015], [rx0, ry0], [rx0 + 0.015, ry0]],
                                                    [[rx0 + rw - 0.015, ry0], [rx0 + rw, ry0], [rx0 + rw, ry0 + 0.015]],
                                                    [[rx0, ry0 + rh - 0.015], [rx0, ry0 + rh], [rx0 + 0.015, ry0 + rh]],
                                                    [[rx0 + rw - 0.015, ry0 + rh], [rx0 + rw, ry0 + rh], [rx0 + rw, ry0 + rh - 0.015]],
                                                ].map((pts, i) => (
                                                    <polyline key={i}
                                                        points={pts.map(([x, y]) => `${x},${y}`).join(" ")}
                                                        fill="none" stroke={pal.stroke} strokeWidth={0.005} strokeLinecap="round" />
                                                ))}

                                                {/* Room name badge — only if fits */}
                                                {badgeW > 0.01 && (
                                                    <>
                                                        <rect x={rx0 + 0.006} y={ry0 + 0.006}
                                                            width={badgeW} height={0.025}
                                                            rx={0.005} fill={isSelected ? pal.stroke : cs.labelBg} opacity={0.92} />
                                                        <text x={rx0 + 0.012} y={ry0 + 0.023}
                                                            fontSize={0.016} fontWeight="600"
                                                            fill="#000" fontFamily="sans-serif">
                                                            {room.name}
                                                        </text>
                                                    </>
                                                )}

                                                {/* Dimension labels */}
                                                <text x={rx0 + rw / 2} y={ry0 + rh + 0.022} textAnchor="middle"
                                                    fontSize={0.014} fill={isSelected ? pal.text : cs.stroke}
                                                    fontFamily="monospace" opacity={isSelected ? 1 : 0.7}>
                                                    {+(room.width / currentUnit.toMeter).toFixed(1)}{unit}
                                                </text>
                                                <text x={rx0 + rw + 0.008} y={ry0 + rh / 2 + 0.007} textAnchor="start"
                                                    fontSize={0.014} fill={isSelected ? pal.text : cs.stroke}
                                                    fontFamily="monospace" opacity={isSelected ? 1 : 0.7}>
                                                    {+(room.height / currentUnit.toMeter).toFixed(1)}{unit}
                                                </text>
                                            </g>
                                        );
                                    })}

                                    {/* ── DOORS ── */}
                                    {layers.has("doors") && doors.map((door) => {
                                        const dx = door.bbox.x, dy = door.bbox.y;
                                        const dw = door.bbox.w, dh = Math.max(door.bbox.h, 0.012);
                                        const cx = dx + dw / 2, cy = dy + dh / 2;
                                        return (
                                            <g key={door.id}>
                                                <path
                                                    d={`M ${cx} ${cy} L ${cx + dw / 2} ${cy} A ${dw / 2} ${dw / 2} 0 0 0 ${cx} ${cy - dw / 2} Z`}
                                                    fill="rgba(245,158,11,0.15)"
                                                    stroke="#f59e0b"
                                                    strokeWidth={0.003}
                                                    opacity={0.85}
                                                />
                                                <text x={cx} y={cy + dh / 2 + 0.018} textAnchor="middle"
                                                    fontSize={0.013} fill="#f59e0b" fontFamily="monospace" opacity={0.9}>
                                                    D {door.widthM}m
                                                </text>
                                            </g>
                                        );
                                    })}

                                    {/* ── WINDOWS ── */}
                                    {layers.has("windows") && windows.map((win) => {
                                        const wx = win.bbox.x, wy = win.bbox.y;
                                        const ww = win.bbox.w, wh = Math.max(win.bbox.h, 0.008);
                                        return (
                                            <g key={win.id}>
                                                <rect x={wx} y={wy} width={ww} height={wh}
                                                    fill="rgba(6,182,212,0.12)" stroke="#06b6d4" strokeWidth={0.003} rx={0.002} opacity={0.85} />
                                                <line x1={wx + ww * 0.33} y1={wy} x2={wx + ww * 0.33} y2={wy + wh}
                                                    stroke="#06b6d4" strokeWidth={0.002} opacity={0.6} />
                                                <line x1={wx + ww * 0.67} y1={wy} x2={wx + ww * 0.67} y2={wy + wh}
                                                    stroke="#06b6d4" strokeWidth={0.002} opacity={0.6} />
                                                <text x={wx + ww / 2} y={wy + wh + 0.018} textAnchor="middle"
                                                    fontSize={0.013} fill="#06b6d4" fontFamily="monospace" opacity={0.9}>
                                                    W {win.widthM}m
                                                </text>
                                            </g>
                                        );
                                    })}
                                </svg>
                            </div>
                        </div>
                    ) : (
                        <span className="text-xs text-muted-foreground">No image</span>
                    )}

                    {/* Legend */}
                    {/* <div className="absolute bottom-4 left-4 flex items-center gap-3 bg-black/50 border border-white/10 backdrop-blur-md rounded-lg px-3 py-2 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-slate-400 rounded inline-block" />Walls</span>
                        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border-2 border-blue-400 inline-block" />Rooms</span>
                        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border-2 border-amber-400 inline-block" />Doors</span>
                        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border-2 border-cyan-400 inline-block" />Windows</span>
                    </div> */}
                </div>

                {/* RIGHT — room list + selected room editor */}
                <div className="w-[280px] shrink-0 border-l border-border flex flex-col bg-card/30 overflow-hidden">
                    <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-2 flex items-center gap-1.5">
                            <Layers className="w-3 h-3" /> Rooms
                        </p>
                        {rooms.map((room, idx) => {
                            const cs = CONF_STYLE[room.confidence];
                            const pal = ROOM_PALETTE[idx % ROOM_PALETTE.length];
                            const isSelected = selectedId === room.id && selectionType === "room";
                            const Icon = room.confidence === "high" ? CheckCircle2 : AlertCircle;
                            return (
                                <button
                                    key={room.id}
                                    onClick={() => selectRoom(room.id)}
                                    className={`w-full text-left rounded-lg px-3 py-2.5 border transition-all duration-200 ${isSelected ? "border-white/20 shadow-sm" : "border-border/50 hover:border-border hover:bg-white/4"
                                        }`}
                                    style={isSelected ? { borderColor: `${pal.stroke}60`, background: pal.fill } : {}}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: pal.stroke }} />
                                            <span className="text-xs font-medium text-foreground truncate">{room.name}</span>
                                        </div>
                                        <Icon className="w-3 h-3 shrink-0" style={{ color: cs.stroke }} />
                                    </div>
                                    <div className="mt-1 text-[10px] font-mono text-muted-foreground">
                                        {+(room.width / currentUnit.toMeter).toFixed(1)} × {+(room.height / currentUnit.toMeter).toFixed(1)} {unit}
                                    </div>
                                </button>
                            );
                        })}

                        {/* Walls list */}
                        {walls.length > 0 && (
                            <div className="pt-3">
                                <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-2 flex items-center gap-1.5">
                                    <Ruler className="w-3 h-3" /> Walls ({walls.length})
                                </p>
                                {walls.map((wall, idx) => {
                                    const isWallSel = selectedWallId === wall.id && selectionType === "wall";
                                    const wLen = getWallLength(wall);
                                    const wThick = getWallThickness(wall);
                                    const wH = getWallHeight(wall);
                                    const isExt = wall.type === "exterior";
                                    return (
                                        <button
                                            key={wall.id}
                                            onClick={() => selectWall(wall.id)}
                                            className={`w-full text-left rounded-lg px-3 py-2 border transition-all duration-200 mb-1 ${isWallSel
                                                ? "border-amber-500/40 bg-amber-500/10 shadow-sm"
                                                : "border-border/50 hover:border-border hover:bg-white/4"
                                                }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <span className={`w-2 h-0.5 rounded shrink-0 ${isExt ? "bg-slate-300" : "bg-slate-500"}`} />
                                                    <span className="text-[11px] font-medium text-foreground">
                                                        Wall {idx + 1}
                                                    </span>
                                                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${isExt ? "bg-slate-500/20 text-slate-300" : "bg-slate-600/20 text-slate-400"
                                                        }`}>
                                                        {isExt ? "EXT" : "INT"}
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="mt-1 text-[10px] font-mono text-muted-foreground flex gap-3">
                                                <span>L: {wLen.toFixed(1)}m</span>
                                                <span>T: {(wThick * 100).toFixed(0)}cm</span>
                                                <span>H: {wH.toFixed(1)}m</span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {/* Doors summary */}
                        {doors.length > 0 && (
                            <div className="pt-2">
                                <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-1.5 flex items-center gap-1.5">
                                    <DoorOpen className="w-3 h-3 text-amber-400" /> Doors ({doors.length})
                                </p>
                                {doors.map((d) => (
                                    <div key={d.id} className="text-[10px] font-mono text-amber-400/70 px-1">
                                        {d.widthM}m wide
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Windows summary */}
                        {windows.length > 0 && (
                            <div className="pt-2">
                                <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-1.5 flex items-center gap-1.5">
                                    <AppWindow className="w-3 h-3 text-cyan-400" /> Windows ({windows.length})
                                </p>
                                {windows.map((w) => (
                                    <div key={w.id} className="text-[10px] font-mono text-cyan-400/70 px-1">
                                        {w.widthM}m wide
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Divider */}
                    <div className="shrink-0 border-t border-border" />

                    {/* Selected room editor */}
                    {selectionType === "room" && selectedRoom && (
                        <div className="shrink-0 p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold" style={{ color: palette.stroke }}>
                                    {selectedRoom.name}
                                </span>
                                <div className="flex items-center gap-1">
                                    <button onClick={() => navigate(-1)} disabled={selectedIdx === 0}
                                        className="p-1 rounded hover:bg-white/8 text-muted-foreground disabled:opacity-30 transition-colors">
                                        <ChevronLeft className="w-3.5 h-3.5" />
                                    </button>
                                    <span className="text-[10px] text-muted-foreground font-mono">
                                        {selectedIdx + 1}/{rooms.length}
                                    </span>
                                    <button onClick={() => navigate(1)} disabled={selectedIdx === rooms.length - 1}
                                        className="p-1 rounded hover:bg-white/8 text-muted-foreground disabled:opacity-30 transition-colors">
                                        <ChevronRight className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <EditableCell room={selectedRoom} field="width" label={`W (${unit})`} suffix={unit} />
                                <EditableCell room={selectedRoom} field="height" label={`D (${unit})`} suffix={unit} />
                                <EditableCell room={selectedRoom} field="wallHeight" label="H (m)" suffix="m" />
                            </div>
                            <div className="text-[10px] text-muted-foreground font-mono flex justify-between">
                                <span>Area</span>
                                <span className="text-foreground font-medium">
                                    {(selectedRoom.width * selectedRoom.height).toFixed(2)} m²
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Selected wall editor */}
                    {selectionType === "wall" && selectedWallId && (() => {
                        const sw = walls.find((w) => w.id === selectedWallId);
                        if (!sw) return null;
                        const swIdx = walls.findIndex((w) => w.id === selectedWallId);
                        const swLen = getWallLength(sw);
                        const swThick = getWallThickness(sw);
                        const swH = getWallHeight(sw);

                        return (
                            <div className="shrink-0 p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Ruler className="w-3.5 h-3.5 text-amber-400" />
                                        <span className="text-xs font-semibold text-amber-300">
                                            Wall {swIdx + 1}
                                        </span>
                                        <button
                                            onClick={() => {
                                                if (onWallUpdate) {
                                                    onWallUpdate(sw.id, "type", sw.type === "exterior" ? "interior" : "exterior");
                                                }
                                            }}
                                            className={`text-[9px] px-1.5 py-0.5 rounded font-mono cursor-pointer transition-colors ${sw.type === "exterior"
                                                ? "bg-slate-500/20 text-slate-300 hover:bg-slate-500/30"
                                                : "bg-slate-600/20 text-slate-400 hover:bg-slate-600/30"
                                                }`}
                                            title="คลิกเพื่อสลับ EXT/INT"
                                        >
                                            {sw.type === "exterior" ? "EXT" : "INT"}
                                        </button>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => {
                                                const prev = swIdx - 1;
                                                if (prev >= 0) selectWall(walls[prev].id);
                                            }}
                                            disabled={swIdx === 0}
                                            className="p-1 rounded hover:bg-white/8 text-muted-foreground disabled:opacity-30 transition-colors"
                                        >
                                            <ChevronLeft className="w-3.5 h-3.5" />
                                        </button>
                                        <span className="text-[10px] text-muted-foreground font-mono">
                                            {swIdx + 1}/{walls.length}
                                        </span>
                                        <button
                                            onClick={() => {
                                                const next = swIdx + 1;
                                                if (next < walls.length) selectWall(walls[next].id);
                                            }}
                                            disabled={swIdx === walls.length - 1}
                                            className="p-1 rounded hover:bg-white/8 text-muted-foreground disabled:opacity-30 transition-colors"
                                        >
                                            <ChevronRight className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>

                                {/* Read-only length */}
                                <div className="text-[10px] text-muted-foreground font-mono flex justify-between">
                                    <span>Length</span>
                                    <span className="text-foreground font-medium">{swLen.toFixed(2)} m</span>
                                </div>

                                {/* Editable thickness */}
                                <div>
                                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Thickness (cm)</div>
                                    {isWallEditing(sw.id, "thickness") ? (
                                        <div className="flex items-center gap-0.5">
                                            <Input
                                                type="number"
                                                autoFocus
                                                value={wallEditState!.value}
                                                onChange={(e) => setWallEditState((s) => s ? { ...s, value: e.target.value } : s)}
                                                onKeyDown={(e) => { if (e.key === "Enter") commitWallEdit(); if (e.key === "Escape") setWallEditState(null); }}
                                                className="h-7 text-xs font-mono px-2 border-amber-500/60"
                                            />
                                            <button onClick={commitWallEdit} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400 shrink-0">
                                                <Check className="w-3 h-3" />
                                            </button>
                                            <button onClick={() => setWallEditState(null)} className="p-1 rounded hover:bg-red-500/20 text-red-400 shrink-0">
                                                <X className="w-3 h-3" />
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => startWallEdit(sw.id, "thickness", +(swThick * 100).toFixed(0))}
                                            className="group flex items-center gap-1 w-full text-left px-1 py-0.5 -mx-1 rounded hover:bg-white/5 transition-colors"
                                        >
                                            <span className="text-sm font-mono font-semibold text-foreground">{(swThick * 100).toFixed(0)}</span>
                                            <span className="text-[10px] text-muted-foreground">cm</span>
                                            <Pencil className="w-2.5 h-2.5 text-muted-foreground/0 group-hover:text-muted-foreground/50 ml-auto shrink-0 transition-colors" />
                                        </button>
                                    )}
                                </div>

                                {/* Editable wall height */}
                                <div>
                                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Height (m)</div>
                                    {isWallEditing(sw.id, "wallHeight") ? (
                                        <div className="flex items-center gap-0.5">
                                            <Input
                                                type="number"
                                                autoFocus
                                                value={wallEditState!.value}
                                                onChange={(e) => setWallEditState((s) => s ? { ...s, value: e.target.value } : s)}
                                                onKeyDown={(e) => { if (e.key === "Enter") commitWallEdit(); if (e.key === "Escape") setWallEditState(null); }}
                                                className="h-7 text-xs font-mono px-2 border-amber-500/60"
                                            />
                                            <button onClick={commitWallEdit} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400 shrink-0">
                                                <Check className="w-3 h-3" />
                                            </button>
                                            <button onClick={() => setWallEditState(null)} className="p-1 rounded hover:bg-red-500/20 text-red-400 shrink-0">
                                                <X className="w-3 h-3" />
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => startWallEdit(sw.id, "wallHeight", +swH.toFixed(2))}
                                            className="group flex items-center gap-1 w-full text-left px-1 py-0.5 -mx-1 rounded hover:bg-white/5 transition-colors"
                                        >
                                            <span className="text-sm font-mono font-semibold text-foreground">{swH.toFixed(2)}</span>
                                            <span className="text-[10px] text-muted-foreground">m</span>
                                            <Pencil className="w-2.5 h-2.5 text-muted-foreground/0 group-hover:text-muted-foreground/50 ml-auto shrink-0 transition-colors" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })()}
                </div>
            </div>

            {/* Bottom hint */}
            <div className="shrink-0 px-5 py-1.5 border-t border-border bg-card/20 flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <Pencil className="w-3 h-3" />
                คลิกห้อง/กำแพงเพื่อเลือก · คลิกตัวเลขเพื่อแก้ไข · Enter บันทึก · Esc ยกเลิก
            </div>
        </div>
    );
};

export default WallReview;
