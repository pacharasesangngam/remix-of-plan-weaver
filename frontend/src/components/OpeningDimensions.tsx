import { Input } from "./ui/input";
import { editOpening, openingGeometry, type Opening, type OpeningKind } from "@/lib/openingModel";
import type { DetectedWallSegment, DetectedDoor, DetectedWindow } from "@/types/detection";

/** Both editors issue the same geometry edit commands. Only width requires plan calibration. */
export default function OpeningDimensions({ opening, kind, walls, doors, windows, pw, ph, wallHeight, calibrated, onEdit }: {
  opening: Opening; kind: OpeningKind; walls: DetectedWallSegment[]; doors: DetectedDoor[]; windows: DetectedWindow[];
  pw: number; ph: number; wallHeight: number; calibrated: boolean;
  onEdit: (field: keyof Opening, value: Opening[keyof Opening]) => void;
}) {
  const geometry = openingGeometry(opening, kind, walls, pw, ph, wallHeight);
  if (!geometry) return null;
  const fields: ("width" | "height" | "sill")[] = kind === "door" ? ["width", "height"] : ["width", "height", "sill"];
  return <div className="grid grid-cols-2 gap-2">
    {fields.map(field => {
      const measured = field !== "width" || calibrated;
      return <label key={field} className="text-xs text-muted-foreground">
        {field === "sill" ? "Sill Height" : field === "width" ? "Width" : "Height"} (m)
        <Input key={`${opening.id}:${field}:${geometry[field]}:${measured}`} aria-label={`Opening ${field} (m)`}
          type="number" step="0.01" min={field === "sill" ? 0 : 0.01} disabled={!measured}
          defaultValue={measured ? geometry[field].toFixed(2) : ""} placeholder={"\u2014"}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
          onBlur={event => {
            if (!measured || event.target.value === "") return;
            const updated = editOpening(opening, kind, { mode: field, value: Number(event.target.value) }, walls, doors, windows, pw, ph, wallHeight);
            if (!updated) return;
            const property = field === "width" ? "wallSpan" : field === "height" ? "heightM" : "sillHeightM";
            onEdit(property, updated[property]);
          }} />
      </label>;
    })}
  </div>;
}
