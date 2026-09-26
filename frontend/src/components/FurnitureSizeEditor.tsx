import { useEffect, useState } from "react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { furnitureHalfSize, type FurnitureItem } from "@/types/furniture";

export default function FurnitureSizeEditor({ item, planW, planH, onApply }: { item: FurnitureItem; planW: number; planH: number; onApply: (size: Pick<FurnitureItem, "width" | "depth" | "height">) => void }) {
  const [draft, setDraft] = useState({ width: String(item.width), depth: String(item.depth), height: String(item.height) });
  useEffect(() => setDraft({ width: String(item.width), depth: String(item.depth), height: String(item.height) }), [item.id, item.width, item.depth, item.height]);
  const size = { width: Number(draft.width), depth: Number(draft.depth), height: Number(draft.height) };
  const half = furnitureHalfSize({ ...item, ...size }, planW, planH);
  const valid = Object.values(size).every(n => Number.isFinite(n) && n >= 0.2 && n <= 20) && half.x <= 0.5 && half.y <= 0.5;
  return <div className="space-y-2">
    <p className="text-xs text-muted-foreground">ขนาดจริง กว้าง × ลึก × สูง · หน่วยเมตร (1 m = 100 cm)</p>
    {([['width', 'ความกว้าง'], ['depth', 'ความลึก'], ['height', 'ความสูง']] as const).map(([key, label]) => <label key={key} className="grid grid-cols-[1fr_100px] items-center gap-2 text-sm">{label} (m)<Input type="number" min="0.2" max="20" step="0.01" value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} /></label>)}
    {!valid && <p role="alert" className="text-xs text-destructive">ระบุขนาด 0.20–20 เมตร และต้องไม่เกินพื้นที่วาด</p>}
    <Button variant="outline" className="w-full" disabled={!valid} onClick={() => onApply(size)}>ใช้ขนาดนี้</Button>
    <p className="text-xs text-muted-foreground">ค่าเริ่มต้นเป็นขนาดตัวอย่าง ปรับตามขนาดสินค้าหรือขนาดที่วัดได้</p>
  </div>;
}
