import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewDimensions } from "./ReviewDimensions";
import { RoomNameBadge } from "./RoomNameBadge";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps horizontal and vertical room labels centered on their span at different zoom sizes", () => {
  const dimensions = [
    { id: "horizontal", wallId: "wall", boundary: true, length: 7.75, start: { x: 0.1, y: 0.2 }, end: { x: 0.8, y: 0.2 } },
    { id: "vertical", wallId: "side", boundary: true, length: 3, start: { x: 0.8, y: 0.2 }, end: { x: 0.8, y: 0.6 } },
  ];
  const overlay = (width: number, height: number) => <svg><ReviewDimensions dimensions={dimensions} width={width} height={height} /></svg>;
  const view = render(overlay(1000, 500));
  const labels = () => view.container.querySelectorAll('[data-dimension-label]');
  expect(labels()[0]).toHaveAttribute("transform", "translate(0.45 0.2) scale(0.001 0.002)");
  expect(labels()[1]).toHaveAttribute("transform", "translate(0.8 0.4) scale(0.001 0.002)");
  expect(labels()[0].querySelector("text")).toHaveTextContent(/^7.75$/);
  expect(view.container.querySelector("rect")).toBeNull();
  view.rerender(overlay(2000, 1000));
  expect(labels()[0]).toHaveAttribute("transform", "translate(0.45 0.2) scale(0.0005 0.001)");
  expect(labels()[1]).toHaveAttribute("transform", "translate(0.8 0.4) scale(0.0005 0.001)");
});

it("fits the room-name background to the full measured text and updates after rename", () => {
  const original = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getComputedTextLength");
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", { configurable: true, value: function () {
    return this.textContent === "Room 9" ? 0.075 : 0.18;
  } });
  try {
    const view = render(<svg><RoomNameBadge name="Room 9" x={0.5} y={0.5} fill="violet" /></svg>);
    expect(Number(view.container.querySelector("rect")!.getAttribute("width"))).toBeCloseTo(0.087);
    expect(view.container.querySelector("text")).toHaveAttribute("text-anchor", "middle");
    view.rerender(<svg><RoomNameBadge name="Living Room 9" x={0.5} y={0.5} fill="violet" /></svg>);
    expect(Number(view.container.querySelector("rect")!.getAttribute("width"))).toBeCloseTo(0.192);
  } finally {
    if (original) Object.defineProperty(SVGElement.prototype, "getComputedTextLength", original);
    else Reflect.deleteProperty(SVGElement.prototype, "getComputedTextLength");
  }
});
