import { useLayoutEffect, useRef, useState } from "react";

/** Fit the background to the rendered SVG text, including names wider than the room. */
export function RoomNameBadge({ name, x, y, fill }: { name: string; x: number; y: number; fill: string }) {
  const text = useRef<SVGTextElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    setWidth(text.current?.getComputedTextLength?.() || name.length * 0.011);
  }, [name]);
  return <g data-room-name-badge>
    <rect x={x - width / 2 - 0.006} y={y - 0.02} width={width + 0.012} height={0.025}
      rx={0.005} fill={fill} opacity={0.92} />
    <text ref={text} x={x} y={y - 0.003} textAnchor="middle" fontSize={0.016} fontWeight="600"
      fill="#000" fontFamily="sans-serif">{name}</text>
  </g>;
}
