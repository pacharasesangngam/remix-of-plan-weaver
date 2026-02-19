import { useState, useRef, useEffect } from "react";
import {
    CheckCircle2, AlertCircle, Pencil, Check, X,
    ArrowRight, Zap, ChevronLeft, ChevronRight,
    DoorOpen, AppWindow, Layers,
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
    onGenerate: () => void;
}

interface EditState {
    roomId: string;
    field: "width" | "height" | "wallHeight";
    value: string;
}

type OverlayLayer = "rooms" | "walls" | "doors" | "windows";

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
    onRoomUpdate, onGenerate,
}: WallReviewProps) => {
    const [editState, setEditState] = useState<EditState | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(rooms[0]?.id ?? null);
    const [imgSize, setImgSize] = useState({ w: 1, h: 1 });
    const [layers, setLayers] = useState<Set<OverlayLayer>>(
        new Set(["rooms", "walls", "doors", "windows"])
    );
    const imgRef = useRef<HTMLImageElement>(null);

    const currentUnit = UNITS.find((u) => u.value === unit) ?? UNITS[0];

    // Track rendered image size for SVG overlay
    useEffect(() => {
        const measure = () => {
            if (imgRef.current) {
                setImgSize({ w: imgRef.current.clientWidth, h: imgRef.current.clientHeight });
            }
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
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
                    <div className="hidden lg:flex items-center gap-1 bg-black/20 rounded-lg p-1 border border-white/[0.06]">
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
                                {label}
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
                            <div className="relative inline-flex max-w-full max-h-full">
                                <img
                                    ref={imgRef}
                                    src={imageUrl}
                                    alt="Floor plan"
                                    className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
                                    style={{ filter: "brightness(0.75) contrast(1.1)" }}
                                    onLoad={() => {
                                        if (imgRef.current) {
                                            setImgSize({ w: imgRef.current.clientWidth, h: imgRef.current.clientHeight });
                                        }
                                    }}
                                />

                                {/* SVG overlay */}
                                <svg
                                    className="absolute inset-0 pointer-events-none"
                                    width={imgSize.w}
                                    height={imgSize.h}
                                    viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                                >
                                    {/* ── WALLS ── */}
                                    {layers.has("walls") && walls.map((wall) => (
                                        <line
                                            key={wall.id}
                                            x1={bx(wall.x1)} y1={by(wall.y1)}
                                            x2={bx(wall.x2)} y2={by(wall.y2)}
                                            stroke={wall.type === "exterior" ? "#e2e8f0" : "#94a3b8"}
                                            strokeWidth={wall.type === "exterior" ? 2.5 : 1.5}
                                            strokeLinecap="round"
                                            opacity={0.7}
                                        />
                                    ))}

                                    {/* ── ROOMS ── */}
                                    {layers.has("rooms") && rooms.map((room, idx) => {
                                        const bbox = roomBBox(room);
                                        if (!bbox) return null;
                                        const cs = CONF_STYLE[room.confidence];
                                        const pal = ROOM_PALETTE[idx % ROOM_PALETTE.length];
                                        const px = bx(bbox.x), py = by(bbox.y);
                                        const pw = bx(bbox.w), ph = by(bbox.h);
                                        const isSelected = selectedId === room.id;

                                        return (
                                            <g key={room.id}>
                                                <rect x={px} y={py} width={pw} height={ph}
                                                    fill={isSelected ? pal.fill : `${cs.stroke}18`} rx={4} />
                                                <rect x={px} y={py} width={pw} height={ph}
                                                    fill="none"
                                                    stroke={isSelected ? pal.stroke : cs.stroke}
                                                    strokeWidth={isSelected ? 2.5 : 1.5}
                                                    strokeDasharray={isSelected ? "none" : "6 3"}
                                                    rx={4} opacity={isSelected ? 1 : 0.55} />

                                                {/* Corner ticks for selected */}
                                                {isSelected && [
                                                    [[px, py + 10], [px, py], [px + 10, py]],
                                                    [[px + pw - 10, py], [px + pw, py], [px + pw, py + 10]],
                                                    [[px, py + ph - 10], [px, py + ph], [px + 10, py + ph]],
                                                    [[px + pw - 10, py + ph], [px + pw, py + ph], [px + pw, py + ph - 10]],
                                                ].map((pts, i) => (
                                                    <polyline key={i}
                                                        points={pts.map(([x, y]) => `${x},${y}`).join(" ")}
                                                        fill="none" stroke={pal.stroke} strokeWidth={3} strokeLinecap="round" />
                                                ))}

                                                {/* Room name badge */}
                                                <rect x={px + 4} y={py + 4}
                                                    width={Math.min(pw - 8, room.name.length * 6.5 + 10)} height={18}
                                                    rx={4} fill={isSelected ? pal.stroke : cs.labelBg} opacity={0.92} />
                                                <text x={px + 9} y={py + 17} fontSize={10} fontWeight="600"
                                                    fill="#000" fontFamily="sans-serif">
                                                    {room.name}
                                                </text>

                                                {/* Dimension labels */}
                                                <text x={px + pw / 2} y={py + ph + 15} textAnchor="middle"
                                                    fontSize={10} fill={isSelected ? pal.text : cs.stroke}
                                                    fontFamily="monospace" opacity={isSelected ? 1 : 0.7}>
                                                    {+(room.width / currentUnit.toMeter).toFixed(1)}{unit}
                                                </text>
                                                <text x={px + pw + 5} y={py + ph / 2 + 4} textAnchor="start"
                                                    fontSize={10} fill={isSelected ? pal.text : cs.stroke}
                                                    fontFamily="monospace" opacity={isSelected ? 1 : 0.7}>
                                                    {+(room.height / currentUnit.toMeter).toFixed(1)}{unit}
                                                </text>
                                            </g>
                                        );
                                    })}

                                    {/* ── DOORS ── */}
                                    {layers.has("doors") && doors.map((door) => {
                                        const px = bx(door.bbox.x), py = by(door.bbox.y);
                                        const pw = bx(door.bbox.w), ph = Math.max(by(door.bbox.h), 12);
                                        const cx = px + pw / 2, cy = py + ph / 2;
                                        const r = Math.max(pw, ph) * 0.9;
                                        return (
                                            <g key={door.id}>
                                                {/* Door swing arc */}
                                                <path
                                                    d={`M ${cx} ${cy} L ${cx + pw / 2} ${cy} A ${pw / 2} ${pw / 2} 0 0 0 ${cx} ${cy - pw / 2} Z`}
                                                    fill="rgba(245,158,11,0.15)"
                                                    stroke="#f59e0b"
                                                    strokeWidth={1.5}
                                                    opacity={0.85}
                                                />
                                                {/* Door width label */}
                                                <text x={cx} y={cy + ph / 2 + 13} textAnchor="middle"
                                                    fontSize={9} fill="#f59e0b" fontFamily="monospace" opacity={0.9}>
                                                    D {door.widthM}m
                                                </text>
                                            </g>
                                        );
                                    })}

                                    {/* ── WINDOWS ── */}
                                    {layers.has("windows") && windows.map((win) => {
                                        const px = bx(win.bbox.x), py = by(win.bbox.y);
                                        const pw = bx(win.bbox.w), ph = Math.max(by(win.bbox.h), 6);
                                        return (
                                            <g key={win.id}>
                                                {/* Window — three parallel lines */}
                                                <rect x={px} y={py} width={pw} height={ph}
                                                    fill="rgba(6,182,212,0.12)" stroke="#06b6d4" strokeWidth={1.5} rx={1} opacity={0.85} />
                                                <line x1={px + pw * 0.33} y1={py} x2={px + pw * 0.33} y2={py + ph}
                                                    stroke="#06b6d4" strokeWidth={1} opacity={0.6} />
                                                <line x1={px + pw * 0.67} y1={py} x2={px + pw * 0.67} y2={py + ph}
                                                    stroke="#06b6d4" strokeWidth={1} opacity={0.6} />
                                                {/* Window width label */}
                                                <text x={px + pw / 2} y={py + ph + 13} textAnchor="middle"
                                                    fontSize={9} fill="#06b6d4" fontFamily="monospace" opacity={0.9}>
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
                    <div className="absolute bottom-4 left-4 flex items-center gap-3 bg-black/50 border border-white/10 backdrop-blur-md rounded-lg px-3 py-2 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-slate-400 rounded inline-block" />Walls</span>
                        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border-2 border-blue-400 inline-block" />Rooms</span>
                        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border-2 border-amber-400 inline-block" />Doors</span>
                        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border-2 border-cyan-400 inline-block" />Windows</span>
                    </div>
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
                            const isSelected = selectedId === room.id;
                            const Icon = room.confidence === "high" ? CheckCircle2 : AlertCircle;
                            return (
                                <button
                                    key={room.id}
                                    onClick={() => setSelectedId(room.id)}
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
                    {selectedRoom && (
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
                </div>
            </div>

            {/* Bottom hint */}
            <div className="shrink-0 px-5 py-1.5 border-t border-border bg-card/20 flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <Pencil className="w-3 h-3" />
                คลิกที่ห้องใน list เพื่อ highlight · คลิกตัวเลขเพื่อแก้ · Enter บันทึก · Esc ยกเลิก
            </div>
        </div>
    );
};

export default WallReview;
