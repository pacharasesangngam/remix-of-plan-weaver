import type { CSSProperties } from "react";
import { Check } from "lucide-react";

export interface MaterialSwatch {
  id: string;
  name: string;
  detail?: string;
  style: CSSProperties;
}

/** Schematic previews using the same catalog colors as the model, not product photos. */
export default function MaterialSwatches({ label, options, value, onChange }: {
  label: string;
  options: MaterialSwatch[];
  value?: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="space-y-2">
      <p className="text-sm font-medium text-foreground">{label}</p>
      <div className="grid grid-cols-2 gap-2">
        {options.map(option => (
          <button key={option.id} type="button" aria-pressed={value === option.id}
            onClick={() => onChange(option.id)} title={option.detail ?? option.name}
            className={`min-w-0 overflow-hidden rounded-xl border p-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${value === option.id ? "border-primary bg-primary/10" : "border-border bg-background hover:border-primary/60"}`}>
            <span className="relative block h-12 rounded-lg border border-black/10" style={option.style}>
              {value === option.id && <span className="absolute right-1 top-1 rounded-full bg-primary p-1 text-primary-foreground"><Check className="h-3 w-3" /></span>}
            </span>
            <span className="mt-1.5 block text-xs font-medium leading-4 text-foreground">{option.name}</span>
            {option.detail && <span className="mt-0.5 block break-words text-[11px] leading-4 text-muted-foreground">{option.detail}</span>}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">ตัวอย่างสีและลายโดยประมาณ</p>
    </div>
  );
}
