"use client";

import type { PointerEvent } from "react";
import { useRef, useState } from "react";
import type { Coordinate, FloorplanImage, RouterPlacement } from "@/types/floorplan";
import type { MeasurementPoint } from "@/types/measurement";

type FloorplanCanvasProps = {
  floorplan: FloorplanImage;
  points?: MeasurementPoint[];
  aps?: RouterPlacement[];
  calibrationPoints?: Coordinate[];
  selectedPointId?: string | null;
  selectedApId?: string | null;
  onCanvasClick?: (coordinate: Coordinate) => void;
  onPointDrag?: (pointId: string, coordinate: Coordinate) => void;
  onPointSelect?: (pointId: string) => void;
  onApSelect?: (id: string) => void;
  className?: string;
};

const MAX_RENDERED_POINTS = 900;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sampledPoints(points: MeasurementPoint[], limit: number, selectedPointId?: string | null): MeasurementPoint[] {
  if (points.length <= limit) return points;
  const sampled: MeasurementPoint[] = [];
  const used = new Set<string>();
  const step = (points.length - 1) / Math.max(limit - 1, 1);

  for (let index = 0; index < limit; index += 1) {
    const point = points[Math.round(index * step)];
    if (!point || used.has(point.point_id)) continue;
    sampled.push(point);
    used.add(point.point_id);
  }

  const selected = selectedPointId ? points.find((point) => point.point_id === selectedPointId) : null;
  if (selected && !used.has(selected.point_id)) {
    sampled[sampled.length - 1] = selected;
  }

  return sampled;
}

// Marker radius in image-pixel units. The displayed canvas width is roughly
// constant regardless of the source floorplan's resolution (CSS-driven, not
// intrinsic), so the radius must scale with the image's own pixel size to
// keep the marker's on-screen size consistent. A fixed px clamp (the previous
// approach) made markers nearly invisible on high-resolution crops (e.g. a
// ~5000px-wide vector-exported PDF render at 250 DPI).
function markerRadiusForFloorplan(floorplan: FloorplanImage): number {
  const size = Math.max(floorplan.width, floorplan.height);
  return Math.round(clamp(size * 0.0075, 6, 42) * 10) / 10;
}

export function FloorplanCanvas({
  floorplan,
  points = [],
  aps = [],
  calibrationPoints = [],
  selectedPointId,
  selectedApId,
  onCanvasClick,
  onPointDrag,
  onPointSelect,
  onApSelect,
  className,
}: FloorplanCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draggingPointId, setDraggingPointId] = useState<string | null>(null);
  const renderedPoints = sampledPoints(points, MAX_RENDERED_POINTS, selectedPointId);
  const markerRadius = markerRadiusForFloorplan(floorplan);
  const markerTextSize = Math.max(7, markerRadius * 1.08);
  const markerTextY = markerRadius * 0.36;
  const calibrationRadius = markerRadius + 1.2;
  const apScale = markerRadius / 8.4;

  function coordinateFromClient(clientX: number, clientY: number): Coordinate {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x_px: 0, y_px: 0 };
    const x = ((clientX - rect.left) / rect.width) * floorplan.width;
    const y = ((clientY - rect.top) / rect.height) * floorplan.height;
    return {
      x_px: Math.round(clamp(x, 0, floorplan.width - 1) * 100) / 100,
      y_px: Math.round(clamp(y, 0, floorplan.height - 1) * 100) / 100,
    };
  }

  function handleCanvasClick(event: PointerEvent<SVGSVGElement>) {
    if (!onCanvasClick || event.defaultPrevented || event.target !== event.currentTarget) return;
    onCanvasClick(coordinateFromClient(event.clientX, event.clientY));
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!draggingPointId || !onPointDrag) return;
    onPointDrag(draggingPointId, coordinateFromClient(event.clientX, event.clientY));
  }

  function stopDragging() {
    setDraggingPointId(null);
  }

  return (
    <div
      className={`floorplanCanvas ${className ?? ""}`}
      style={{ aspectRatio: `${floorplan.width} / ${floorplan.height}` }}
    >
      <img src={floorplan.dataUrl} alt="Planta baixa" draggable={false} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${floorplan.width} ${floorplan.height}`}
        preserveAspectRatio="none"
        onClick={handleCanvasClick}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        aria-label="Overlay de coordenadas da planta"
      >
        {calibrationPoints.length === 2 && (
          <line
            x1={calibrationPoints[0].x_px}
            y1={calibrationPoints[0].y_px}
            x2={calibrationPoints[1].x_px}
            y2={calibrationPoints[1].y_px}
            className="calibrationLine"
          />
        )}

        {calibrationPoints.map((point, index) => (
          <g key={`cal-${index}`} className="calibrationPoint">
            <circle cx={point.x_px} cy={point.y_px} r={calibrationRadius} />
            <text x={point.x_px} y={point.y_px + markerTextY} style={{ fontSize: markerTextSize }}>{index + 1}</text>
          </g>
        ))}

        {aps.map((ap, index) => (
          <g
            key={ap.id}
            className={`apMarker ${selectedApId === ap.id ? "selected" : ""}`}
            transform={`translate(${ap.ap_x_px} ${ap.ap_y_px}) scale(${apScale})`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onApSelect?.(ap.id);
            }}
          >
            <rect className="apBody" x="-13" y="2" width="26" height="9" rx="1.8" />
            <line className="apSlot" x1="-10" y1="7" x2="5" y2="7" />
            <line className="apLed" x1="7.5" y1="5.2" x2="11" y2="5.2" />
            <line className="apLed" x1="7.5" y1="8.8" x2="11" y2="8.8" />
            <line className="apAntenna" x1="0" y1="2" x2="0" y2="-6" />
            <circle className="apNode" cy="-7" r="2.2" />
            <path className="apSignal inner" d="M-7 -12A12 12 0 0 1 7 -12" />
            <path className="apSignal outer" d="M-12 -17A20 20 0 0 1 12 -17" />
            <text x="0" y="-10" style={{ fontSize: markerTextSize * 0.85, textAnchor: "middle" }}>{index + 1}</text>
          </g>
        ))}

        {renderedPoints.map((point) => (
          <g
            key={point.point_id}
            className={`measurementMarker ${selectedPointId === point.point_id ? "selected" : ""}`}
            transform={`translate(${point.x_px} ${point.y_px})`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPointSelect?.(point.point_id);
            }}
            onPointerDown={(event) => {
              if (!onPointDrag) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDraggingPointId(point.point_id);
              onPointSelect?.(point.point_id);
            }}
          >
            <circle r={markerRadius} />
            <text y={markerTextY} style={{ fontSize: markerTextSize }}>{point.point_id.replace(/^P/i, "")}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
