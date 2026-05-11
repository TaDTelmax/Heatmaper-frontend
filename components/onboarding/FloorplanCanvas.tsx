"use client";

import type { PointerEvent } from "react";
import { useRef, useState } from "react";
import type { Coordinate, FloorplanImage, RouterPlacement } from "@/types/floorplan";
import type { MeasurementPoint } from "@/types/measurement";

type FloorplanCanvasProps = {
  floorplan: FloorplanImage;
  points?: MeasurementPoint[];
  ap?: RouterPlacement | null;
  calibrationPoints?: Coordinate[];
  selectedPointId?: string | null;
  onCanvasClick?: (coordinate: Coordinate) => void;
  onPointDrag?: (pointId: string, coordinate: Coordinate) => void;
  onPointSelect?: (pointId: string) => void;
  className?: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function FloorplanCanvas({
  floorplan,
  points = [],
  ap,
  calibrationPoints = [],
  selectedPointId,
  onCanvasClick,
  onPointDrag,
  onPointSelect,
  className,
}: FloorplanCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draggingPointId, setDraggingPointId] = useState<string | null>(null);

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
            <circle cx={point.x_px} cy={point.y_px} r="12" />
            <text x={point.x_px} y={point.y_px + 4}>{index + 1}</text>
          </g>
        ))}

        {ap && (
          <g className="apMarker" transform={`translate(${ap.ap_x_px} ${ap.ap_y_px})`}>
            <rect className="apBody" x="-13" y="2" width="26" height="9" rx="1.8" />
            <line className="apSlot" x1="-10" y1="7" x2="5" y2="7" />
            <line className="apLed" x1="7.5" y1="5.2" x2="11" y2="5.2" />
            <line className="apLed" x1="7.5" y1="8.8" x2="11" y2="8.8" />
            <line className="apAntenna" x1="0" y1="2" x2="0" y2="-6" />
            <circle className="apNode" cy="-7" r="2.2" />
            <path className="apSignal inner" d="M-7 -12A12 12 0 0 1 7 -12" />
            <path className="apSignal outer" d="M-12 -17A20 20 0 0 1 12 -17" />
          </g>
        )}

        {points.map((point) => (
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
            <circle r="13" />
            <text y="5">{point.point_id.replace(/^P/i, "")}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
