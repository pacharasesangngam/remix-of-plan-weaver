/**
 * floorplanAI.ts
 * Sends a floor plan image to the Gemini Vision API and returns structured
 * detection results: rooms, walls, doors, and windows.
 *
 * Model priority: gemini-2.0-flash → gemini-1.5-flash → gemini-2.0-flash-lite
 * On 429 (quota) → auto-fallback to mock data so dev can still test the UI.
 */

import type { Room } from "@/types/floorplan";
import type { DetectionResult, DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Models to try in order
const MODELS = [
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-2.0-flash-lite",
];

// ── Prompt ────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert architectural floor plan analyzer.
Analyze the provided floor plan image and return ONLY a valid JSON object (no markdown, no explanation).

The JSON must follow this exact schema:
{
  "summary": "brief description of the floor plan",
  "rooms": [
    {
      "id": "room_1",
      "name": "Living Room",
      "confidence": "high",
      "bbox": { "x": 0.05, "y": 0.10, "w": 0.40, "h": 0.35 },
      "estimatedWidthM": 5.0,
      "estimatedDepthM": 4.0,
      "wallHeightM": 2.8
    }
  ],
  "walls": [
    {
      "id": "w1",
      "x1": 0.05, "y1": 0.10,
      "x2": 0.45, "y2": 0.10,
      "type": "exterior",
      "thicknessRatio": 0.012
    }
  ],
  "doors": [
    { "id": "d1", "bbox": { "x": 0.20, "y": 0.09, "w": 0.04, "h": 0.02 }, "widthM": 0.9 }
  ],
  "windows": [
    { "id": "win1", "bbox": { "x": 0.35, "y": 0.09, "w": 0.06, "h": 0.015 }, "widthM": 1.2 }
  ]
}

WALL DETECTION RULES (critical — read carefully):
1. Trace every visible wall segment as a straight line from its START corner to its END corner.
2. x1,y1,x2,y2 are the CENTERLINE of the wall, normalised 0.0–1.0 relative to image width/height.
3. "type" must be "exterior" for outer boundary walls (thick, dark) and "interior" for internal partition walls (thinner).
4. "thicknessRatio" = pixel thickness of the wall divided by the longer image dimension (width or height). Typical exterior walls are 0.010–0.020, interior walls 0.005–0.012.
5. Do NOT skip short walls or diagonal walls — include every segment.
6. Wall segments should NOT overlap; split at every T-junction or corner.
7. If a wall has a door or window opening, split the wall into segments around the opening.

GENERAL RULES:
- All bbox and wall coordinates are normalised 0.0–1.0 (x=left, y=top, w=width, h=height).
- confidence is "high", "low", or "manual".
- estimatedWidthM and estimatedDepthM are the INTERIOR room dimensions in meters.
- wallHeightM defaults to 2.8 if not labelled.
- Include ALL rooms, ALL walls, ALL doors, and ALL windows visible in the image.
- Return ONLY the JSON object, nothing else.`;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fileToBase64(file: File): Promise<{ base64: string; mimeType: string }> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            const [header, base64] = result.split(",");
            const mimeType = header.replace("data:", "").replace(";base64", "");
            resolve({ base64, mimeType });
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function objectUrlToBase64(url: string): Promise<{ base64: string; mimeType: string }> {
    const blob = await fetch(url).then((r) => r.blob());
    return fileToBase64(new File([blob], "floorplan", { type: blob.type }));
}

// ── Mock fallback (used when quota exceeded) ──────────────────────────────────
// Coordinates mapped from the Thai floor plan image:
//   ซักล้าง | ครัว (top)
//   นอน3 | อาหาร | ห้องน้ำ (middle)
//   รับแขก | โถงโล่ง | นอน2 (lower-middle)
//   เฉลียง | นอน1 (bottom)
const MOCK_RESULT: DetectionResult = {
    summary: "แปลนบ้านไทย — ซักล้าง, ครัว, นอน1-3, ห้องน้ำ, รับแขก, โถงโล่ง, เฉลียง (API quota exceeded)",
    rooms: [
        // ═══ ROOMS — measured from Thai floor plan image (portrait ~820×980) ═══
        // Image floor plan content spans: x 0.05-0.93, y 0.02-0.95
        //
        // ซักล้าง: left=5%, right=40%, top=2%, bottom=19%
        {
            id: "r1", name: "ซักล้าง", confidence: "high", width: 4.0, height: 2.0, wallHeight: 2.8,
            bbox: { x: 0.05, y: 0.02, w: 0.35, h: 0.17 }
        } as Room & { bbox: object },
        // ครัว: left=47%, right=93%, top=2%, bottom=29%
        {
            id: "r2", name: "ครัว", confidence: "high", width: 5.5, height: 3.3, wallHeight: 2.8,
            bbox: { x: 0.47, y: 0.02, w: 0.46, h: 0.27 }
        } as Room & { bbox: object },
        // นอน 3: left=5%, right=36%, top=19%, bottom=47%
        {
            id: "r3", name: "นอน 3", confidence: "high", width: 3.5, height: 3.3, wallHeight: 2.8,
            bbox: { x: 0.05, y: 0.19, w: 0.31, h: 0.28 }
        } as Room & { bbox: object },
        // อาหาร: left=36%, right=57%, top=19%, bottom=47%
        {
            id: "r4", name: "อาหาร", confidence: "high", width: 2.5, height: 3.3, wallHeight: 2.8,
            bbox: { x: 0.36, y: 0.19, w: 0.21, h: 0.28 }
        } as Room & { bbox: object },
        // ห้องน้ำ: left=57%, right=93%, top=29%, bottom=47%
        {
            id: "r5", name: "ห้องน้ำ", confidence: "high", width: 4.0, height: 2.0, wallHeight: 2.8,
            bbox: { x: 0.57, y: 0.29, w: 0.36, h: 0.18 }
        } as Room & { bbox: object },
        // รับแขก: left=5%, right=36%, top=47%, bottom=72%
        {
            id: "r6", name: "รับแขก", confidence: "high", width: 3.5, height: 2.8, wallHeight: 2.8,
            bbox: { x: 0.05, y: 0.47, w: 0.31, h: 0.25 }
        } as Room & { bbox: object },
        // โถงโล่ง: left=36%, right=57%, top=47%, bottom=73%
        {
            id: "r7", name: "โถงโล่ง", confidence: "high", width: 2.5, height: 2.8, wallHeight: 2.8,
            bbox: { x: 0.36, y: 0.47, w: 0.21, h: 0.26 }
        } as Room & { bbox: object },
        // นอน 2: left=57%, right=93%, top=47%, bottom=73%
        {
            id: "r8", name: "นอน 2", confidence: "high", width: 4.0, height: 2.8, wallHeight: 2.8,
            bbox: { x: 0.57, y: 0.47, w: 0.36, h: 0.26 }
        } as Room & { bbox: object },
        // เฉลียง: left=34%, right=57%, top=73%, bottom=95%
        {
            id: "r9", name: "เฉลียง", confidence: "high", width: 2.5, height: 2.3, wallHeight: 2.8,
            bbox: { x: 0.34, y: 0.73, w: 0.23, h: 0.22 }
        } as Room & { bbox: object },
        // นอน 1: left=57%, right=93%, top=73%, bottom=95%
        {
            id: "r10", name: "นอน 1", confidence: "high", width: 4.0, height: 2.3, wallHeight: 2.8,
            bbox: { x: 0.57, y: 0.73, w: 0.36, h: 0.22 }
        } as Room & { bbox: object },
    ] as Room[],
    walls: [
        // ── Exterior walls — follow the floor plan boundary ──
        // Top: ซักล้าง portion (left of stair notch)
        { id: "w1", x1: 0.05, y1: 0.02, x2: 0.40, y2: 0.02, type: "exterior", thickness: 0.25, thicknessRatio: 0.013 },
        // Top: ครัว portion (right of stair notch)
        { id: "w2", x1: 0.47, y1: 0.02, x2: 0.93, y2: 0.02, type: "exterior", thickness: 0.25, thicknessRatio: 0.013 },
        // Right wall
        { id: "w3", x1: 0.93, y1: 0.02, x2: 0.93, y2: 0.95, type: "exterior", thickness: 0.25, thicknessRatio: 0.013 },
        // Bottom: นอน 1 + เฉลียง portion  
        { id: "w4", x1: 0.34, y1: 0.95, x2: 0.93, y2: 0.95, type: "exterior", thickness: 0.25, thicknessRatio: 0.013 },
        // Left of เฉลียง (step down)
        { id: "w5", x1: 0.34, y1: 0.73, x2: 0.34, y2: 0.95, type: "exterior", thickness: 0.25, thicknessRatio: 0.013 },
        // Left wall (ซักล้าง down to รับแขก)
        { id: "w6", x1: 0.05, y1: 0.02, x2: 0.05, y2: 0.72, type: "exterior", thickness: 0.25, thicknessRatio: 0.013 },
        // Bottom of รับแขก (left section ends)
        { id: "w7", x1: 0.05, y1: 0.72, x2: 0.20, y2: 0.72, type: "exterior", thickness: 0.25, thicknessRatio: 0.013 },

        // ── Interior walls ──
        // Vertical: ซักล้าง right edge / stair (x=0.40, top portion only)
        { id: "w8", x1: 0.40, y1: 0.02, x2: 0.40, y2: 0.19, type: "interior", thickness: 0.15, thicknessRatio: 0.008 },
        // Vertical: left section | center (x=0.36, from นอน3 down)
        { id: "w9", x1: 0.36, y1: 0.19, x2: 0.36, y2: 0.73, type: "interior", thickness: 0.15, thicknessRatio: 0.008 },
        // Vertical: center | right (x=0.57, full height)
        { id: "w10", x1: 0.57, y1: 0.02, x2: 0.57, y2: 0.95, type: "interior", thickness: 0.15, thicknessRatio: 0.008 },
        // Horizontal: ซักล้าง|นอน3 & อาหาร top (y=0.19)
        { id: "w11", x1: 0.05, y1: 0.19, x2: 0.57, y2: 0.19, type: "interior", thickness: 0.15, thicknessRatio: 0.008 },
        // Horizontal: ครัว|ห้องน้ำ (y=0.29)
        { id: "w12", x1: 0.57, y1: 0.29, x2: 0.93, y2: 0.29, type: "interior", thickness: 0.15, thicknessRatio: 0.008 },
        // Horizontal: นอน3|รับแขก & อาหาร|โถงโล่ง (y=0.47)
        { id: "w13", x1: 0.05, y1: 0.47, x2: 0.57, y2: 0.47, type: "interior", thickness: 0.15, thicknessRatio: 0.008 },
        // Horizontal: ห้องน้ำ|นอน2 (y=0.47)
        { id: "w14", x1: 0.57, y1: 0.47, x2: 0.93, y2: 0.47, type: "interior", thickness: 0.15, thicknessRatio: 0.008 },
        // Horizontal: โถงโล่ง|เฉลียง & นอน2|นอน1 (y=0.73)
        { id: "w15", x1: 0.36, y1: 0.73, x2: 0.93, y2: 0.73, type: "interior", thickness: 0.15, thicknessRatio: 0.008 },
    ],
    doors: [
        // นอน 3 door (arc visible)
        { id: "d1", bbox: { x: 0.20, y: 0.44, w: 0.04, h: 0.035 }, widthM: 0.9 },
        // รับแขก door
        { id: "d2", bbox: { x: 0.20, y: 0.67, w: 0.04, h: 0.035 }, widthM: 0.9 },
        // ห้องน้ำ door
        { id: "d3", bbox: { x: 0.57, y: 0.38, w: 0.04, h: 0.035 }, widthM: 0.9 },
        // นอน 2 door (lower)
        { id: "d4", bbox: { x: 0.57, y: 0.66, w: 0.04, h: 0.035 }, widthM: 0.9 },
        // นอน 1 door
        { id: "d5", bbox: { x: 0.57, y: 0.76, w: 0.04, h: 0.035 }, widthM: 0.9 },
        // เฉลียง entrance (top)
        { id: "d6", bbox: { x: 0.38, y: 0.71, w: 0.04, h: 0.03 }, widthM: 0.9 },
        // เฉลียง entrance (bottom-left arc)
        { id: "d7", bbox: { x: 0.37, y: 0.90, w: 0.04, h: 0.035 }, widthM: 0.9 },
    ],
    windows: [
        // Left wall windows (hatched marks = fixed windows)
        { id: "win1", bbox: { x: 0.05, y: 0.23, w: 0.012, h: 0.07 }, widthM: 1.0 },
        { id: "win2", bbox: { x: 0.05, y: 0.32, w: 0.012, h: 0.07 }, widthM: 1.0 },
        { id: "win3", bbox: { x: 0.05, y: 0.50, w: 0.012, h: 0.06 }, widthM: 1.0 },
        // Top wall windows (ซักล้าง top windows shown as hatches)
        { id: "win4", bbox: { x: 0.10, y: 0.04, w: 0.08, h: 0.010 }, widthM: 1.2 },
        { id: "win5", bbox: { x: 0.22, y: 0.04, w: 0.08, h: 0.010 }, widthM: 1.2 },
        // Right wall windows (นอน 2, นอน 1)
        { id: "win6", bbox: { x: 0.96, y: 0.49, w: 0.012, h: 0.07 }, widthM: 1.0 },
        { id: "win7", bbox: { x: 0.96, y: 0.59, w: 0.012, h: 0.07 }, widthM: 1.0 },
        { id: "win8", bbox: { x: 0.96, y: 0.76, w: 0.012, h: 0.07 }, widthM: 1.0 },
        { id: "win9", bbox: { x: 0.96, y: 0.85, w: 0.012, h: 0.07 }, widthM: 1.0 },
        // ครัว top windows
        { id: "win10", bbox: { x: 0.60, y: 0.04, w: 0.10, h: 0.010 }, widthM: 1.4 },
        { id: "win11", bbox: { x: 0.78, y: 0.04, w: 0.10, h: 0.010 }, widthM: 1.4 },
    ],
};

// ── Try one model ─────────────────────────────────────────────────────────────
async function tryModel(
    model: string,
    base64: string,
    mimeType: string,
): Promise<{ result: DetectionResult } | { status: number }> {
    const url = `${BASE}/${model}:generateContent?key=${API_KEY}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{
                parts: [
                    { text: SYSTEM_PROMPT },
                    { inlineData: { mimeType, data: base64 } },
                ],
            }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        }),
    });

    if (!res.ok) return { status: res.status };

    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const clean = text.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim();

    try {
        const parsed = JSON.parse(clean);
        const rooms: Room[] = (parsed.rooms ?? []).map((r: { id: string; name: string; confidence: "high" | "low" | "manual"; bbox: { x: number; y: number; w: number; h: number }; estimatedWidthM: number; estimatedDepthM: number; wallHeightM?: number }) => ({
            id: r.id, name: r.name, confidence: r.confidence ?? "high",
            width: r.estimatedWidthM ?? 3, height: r.estimatedDepthM ?? 3,
            wallHeight: r.wallHeightM ?? 2.8, bbox: r.bbox,
        } as Room & { bbox: object }));

        const walls: DetectedWallSegment[] = (parsed.walls ?? []).map((w: { id: string; x1: number; y1: number; x2: number; y2: number; type: "exterior" | "interior"; thicknessRatio?: number }) => {
            // Convert thicknessRatio (relative to image) → meters using PLAN_SIZE=20
            const thicknessM = w.thicknessRatio != null
                ? Math.max(0.05, Math.min(0.5, w.thicknessRatio * 20))
                : (w.type === "exterior" ? 0.25 : 0.15);
            return {
                id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
                type: w.type ?? "interior",
                thickness: thicknessM,
                thicknessRatio: w.thicknessRatio,
            };
        });
        const doors: DetectedDoor[] = (parsed.doors ?? []).map((d: { id: string; bbox: { x: number; y: number; w: number; h: number }; widthM: number }) => ({
            id: d.id, bbox: d.bbox, widthM: d.widthM ?? 0.9,
        }));
        const windows: DetectedWindow[] = (parsed.windows ?? []).map((w: { id: string; bbox: { x: number; y: number; w: number; h: number }; widthM: number }) => ({
            id: w.id, bbox: w.bbox, widthM: w.widthM ?? 1.2,
        }));

        return { result: { rooms, walls, doors, windows, summary: parsed.summary } };
    } catch {
        return { status: -1 }; // parse error
    }
}

// ── Main export ───────────────────────────────────────────────────────────────
export type DetectFloorPlanResult = DetectionResult & { usedMock?: boolean; usedModel?: string };

export async function detectFloorPlan(
    imageUrlOrFile: string | File,
): Promise<DetectFloorPlanResult> {
    if (!API_KEY) throw new Error("NO_API_KEY");

    const { base64, mimeType } =
        typeof imageUrlOrFile === "string"
            ? await objectUrlToBase64(imageUrlOrFile)
            : await fileToBase64(imageUrlOrFile);

    let lastStatus = 0;

    // Try each model in order
    for (const model of MODELS) {
        const attempt = await tryModel(model, base64, mimeType);
        if ("result" in attempt) {
            return { ...attempt.result, usedModel: model };
        }
        lastStatus = attempt.status;
        // Only retry on 404 (model not found). Stop on 429/400/403.
        if (attempt.status !== 404) break;
    }

    // 429 quota → use mock data + flag it
    if (lastStatus === 429) {
        console.warn("[floorplanAI] Quota exceeded — using mock data");
        return { ...MOCK_RESULT, usedMock: true };
    }

    // 403 forbidden (leaked/invalid key) → use mock data + flag it
    if (lastStatus === 403) {
        console.warn("[floorplanAI] API key invalid or blocked (403) — using mock data");
        return { ...MOCK_RESULT, usedMock: true };
    }

    throw new Error(`API_ERROR_${lastStatus}`);
}
