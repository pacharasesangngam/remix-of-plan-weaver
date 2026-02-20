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
    { "id": "w1", "x1": 0.05, "y1": 0.10, "x2": 0.45, "y2": 0.10, "type": "exterior" }
  ],
  "doors": [
    { "id": "d1", "bbox": { "x": 0.20, "y": 0.09, "w": 0.04, "h": 0.02 }, "widthM": 0.9 }
  ],
  "windows": [
    { "id": "win1", "bbox": { "x": 0.35, "y": 0.09, "w": 0.06, "h": 0.015 }, "widthM": 1.2 }
  ]
}

Rules:
- bbox coordinates are normalised 0.0–1.0 relative to IMAGE dimensions (x=left, y=top, w=width, h=height)
- wall segments (x1,y1,x2,y2) are also normalised 0.0–1.0
- confidence is "high", "low", or "manual"
- estimatedWidthM and estimatedDepthM are in meters
- wallHeightM defaults to 2.8 if not shown
- Include ALL rooms, major walls, doors, and windows visible
- Return ONLY the JSON object, nothing else`;

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
const MOCK_RESULT: DetectionResult = {
    summary: "Demo data (API quota exceeded)",
    rooms: [
        { id: "r1", name: "Bedroom 1", confidence: "high", width: 3.5, height: 3.0, wallHeight: 2.8, bbox: { x: 0.05, y: 0.05, w: 0.25, h: 0.40 } } as Room & { bbox: object },
        { id: "r2", name: "Bedroom 2", confidence: "high", width: 4.0, height: 3.2, wallHeight: 2.8, bbox: { x: 0.32, y: 0.05, w: 0.28, h: 0.40 } } as Room & { bbox: object },
        { id: "r3", name: "Living Room", confidence: "high", width: 5.5, height: 4.0, wallHeight: 2.8, bbox: { x: 0.05, y: 0.50, w: 0.35, h: 0.45 } } as Room & { bbox: object },
        { id: "r4", name: "Kitchen", confidence: "low", width: 3.0, height: 2.8, wallHeight: 2.8, bbox: { x: 0.62, y: 0.05, w: 0.33, h: 0.38 } } as Room & { bbox: object },
        { id: "r5", name: "Bathroom", confidence: "manual", width: 2.0, height: 2.5, wallHeight: 2.8, bbox: { x: 0.62, y: 0.50, w: 0.20, h: 0.30 } } as Room & { bbox: object },
    ] as Room[],
    walls: [
        { id: "w1", x1: 0.05, y1: 0.05, x2: 0.95, y2: 0.05, type: "exterior" },
        { id: "w2", x1: 0.05, y1: 0.05, x2: 0.05, y2: 0.95, type: "exterior" },
        { id: "w3", x1: 0.95, y1: 0.05, x2: 0.95, y2: 0.95, type: "exterior" },
        { id: "w4", x1: 0.05, y1: 0.95, x2: 0.95, y2: 0.95, type: "exterior" },
        { id: "w5", x1: 0.30, y1: 0.05, x2: 0.30, y2: 0.50, type: "interior" },
        { id: "w6", x1: 0.60, y1: 0.05, x2: 0.60, y2: 0.95, type: "interior" },
        { id: "w7", x1: 0.05, y1: 0.50, x2: 0.60, y2: 0.50, type: "interior" },
    ],
    doors: [
        { id: "d1", bbox: { x: 0.14, y: 0.04, w: 0.06, h: 0.03 }, widthM: 0.9 },
        { id: "d2", bbox: { x: 0.40, y: 0.04, w: 0.06, h: 0.03 }, widthM: 0.9 },
        { id: "d3", bbox: { x: 0.18, y: 0.49, w: 0.06, h: 0.03 }, widthM: 0.9 },
    ],
    windows: [
        { id: "w1", bbox: { x: 0.07, y: 0.20, w: 0.06, h: 0.02 }, widthM: 1.2 },
        { id: "w2", bbox: { x: 0.67, y: 0.20, w: 0.06, h: 0.02 }, widthM: 1.2 },
        { id: "w3", bbox: { x: 0.30, y: 0.94, w: 0.08, h: 0.02 }, widthM: 1.5 },
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

        const walls: DetectedWallSegment[] = (parsed.walls ?? []).map((w: { id: string; x1: number; y1: number; x2: number; y2: number; type: "exterior" | "interior" }) => ({
            id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, type: w.type ?? "interior",
        }));
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
