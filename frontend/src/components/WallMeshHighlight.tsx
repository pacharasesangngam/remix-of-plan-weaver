import type { BufferGeometry } from "three";

/** Uses wall-local finished geometry; the scene retains ownership of that geometry. */
export default function WallMeshHighlight({ geometry, color, outlineOnly = false, showOutline = true }: {
  geometry: BufferGeometry;
  color: string;
  outlineOnly?: boolean;
  showOutline?: boolean;
}) {
  return <>
    {!outlineOnly && <mesh renderOrder={20} raycast={() => null}>
      {/* Primitives are borrowed, so unmounting a highlight cannot dispose the wall. */}
      <primitive object={geometry} attach="geometry" />
      <meshBasicMaterial color={color} transparent opacity={0.24} depthWrite={false}
        polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
    </mesh>}
    {showOutline && <lineSegments renderOrder={21} raycast={() => null}>
      <edgesGeometry args={[geometry]} />
      <lineBasicMaterial color={color} transparent opacity={1} depthWrite={false} />
    </lineSegments>}
  </>;
}
