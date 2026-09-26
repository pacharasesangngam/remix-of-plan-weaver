import { Component, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import { FurnitureMeshes } from "./FurnitureVisual";
import type { FurnitureItem } from "@/types/furniture";

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="p-3 text-xs">ไม่สามารถเปิดตัวอย่าง 3D บนอุปกรณ์นี้ได้</p> : this.props.children; }
}

export default function FurnitureModelPreview({ item }: { item: FurnitureItem }) {
  const [open, setOpen] = useState(false);
  return <details className="rounded-lg border bg-muted/30" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer p-3 text-sm font-medium">ดูตัวอย่างโมเดล 3D</summary>
    {open && <PreviewBoundary><div className="h-52" aria-label="ตัวอย่างโมเดลเฟอร์นิเจอร์ 3D">
      <Canvas frameloop="demand" dpr={[1, 1.5]} camera={{ position: [4, 3, 5], fov: 40 }} fallback={<p>อุปกรณ์นี้ไม่รองรับ WebGL</p>}>
        <ambientLight intensity={1.2} />
        <directionalLight position={[3, 5, 4]} intensity={2} />
        <directionalLight position={[-3, 2, -3]} intensity={0.8} />
        <Bounds fit clip observe margin={1.5}>
          <FurnitureMeshes items={[{ ...item, x: 0.5, y: 0.5 }]} planW={10} planH={10} />
        </Bounds>
        <OrbitControls makeDefault enablePan={false} minPolarAngle={0.1} maxPolarAngle={Math.PI / 2} />
      </Canvas>
    </div><p className="px-3 pb-3 text-xs text-muted-foreground">ลากเพื่อหมุน · ลูกกลิ้งเพื่อซูม</p></PreviewBoundary>}
  </details>;
}
