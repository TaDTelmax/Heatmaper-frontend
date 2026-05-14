"use client";

import { Loader2, MapPin, MousePointer2, ScanSearch, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { withComputedDistances } from "@/domain/heatmap/distance";
import { validateMeasurementPoints } from "@/domain/heatmap/validation";
import { detectMeasurementPoints } from "@/services/imageDetection";
import type { Coordinate, FloorplanImage, RouterPlacement } from "@/types/floorplan";
import type { MeasurementPoint } from "@/types/measurement";
import { FloorplanCanvas } from "./FloorplanCanvas";
import { IssueList } from "./StepUploadFloorplan";

type StepMeasurementPointsProps = {
  floorFile: File | null;
  floorplan: FloorplanImage;
  points: MeasurementPoint[];
  ap: RouterPlacement | null;
  pxPerMeter: number;
  onChange: (points: MeasurementPoint[]) => void;
};

function nowIso(): string {
  return new Date().toISOString();
}

function renumber(points: MeasurementPoint[]): MeasurementPoint[] {
  return points.map((point, index) => ({ ...point, point_id: `P${index + 1}` }));
}

function nextManualPointId(points: MeasurementPoint[]): string {
  const highest = points.reduce((max, point) => {
    const numeric = point.point_id.match(/^P(\d+)$/i);
    return numeric ? Math.max(max, Number(numeric[1])) : max;
  }, 0);
  return `P${highest + 1}`;
}

function createManualPoint(pointId: string, coordinate: Coordinate): MeasurementPoint {
  return {
    point_id: pointId,
    x_px: coordinate.x_px,
    y_px: coordinate.y_px,
    rssi_24ghz: null,
    rssi_5ghz: null,
    rssi_6ghz: null,
    distance_m: null,
    timestamp: nowIso(),
    source: "manual",
  };
}

export function StepMeasurementPoints({
  floorFile,
  floorplan,
  points,
  ap,
  pxPerMeter,
  onChange,
}: StepMeasurementPointsProps) {
  const [selectedPointId, setSelectedPointId] = useState<string | null>(points[0]?.point_id ?? null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const selectedPoint = useMemo(
    () => points.find((point) => point.point_id === selectedPointId) ?? points[0] ?? null,
    [points, selectedPointId],
  );

  function commit(next: MeasurementPoint[]) {
    onChange(withComputedDistances(next, ap, pxPerMeter));
  }

  function addPoint(coordinate: Coordinate) {
    const next = [...points, createManualPoint(nextManualPointId(points), coordinate)];
    setSelectedPointId(next[next.length - 1].point_id);
    commit(next);
  }

  function updatePoint(pointId: string, coordinate: Coordinate) {
    commit(points.map((point) => (point.point_id === pointId ? { ...point, ...coordinate } : point)));
  }

  function updateSelected(field: "x_px" | "y_px" | "point_id", value: string) {
    if (!selectedPoint) return;
    commit(
      points.map((point) => {
        if (point.point_id !== selectedPoint.point_id) return point;
        if (field === "point_id") return { ...point, point_id: value || point.point_id };
        return { ...point, [field]: Number(value) };
      }),
    );
    if (field === "point_id") setSelectedPointId(value);
  }

  function removeSelected() {
    if (!selectedPoint) return;
    const next = points.filter((point) => point.point_id !== selectedPoint.point_id);
    setSelectedPointId(next[0]?.point_id ?? null);
    commit(next);
  }

  async function runDetection() {
    if (!floorFile) return;
    setIsDetecting(true);
    setDetail(null);
    try {
      const result = await detectMeasurementPoints(floorFile);
      const next = withComputedDistances(renumber(result.points), ap, pxPerMeter);
      commit(next);
      setSelectedPointId(next[0]?.point_id ?? null);
      setDetail(`${result.detail} ${next.length} ponto(s).`);
    } catch (error) {
      setDetail(error instanceof Error ? error.message : "Nao foi possivel detectar pontos.");
    } finally {
      setIsDetecting(false);
    }
  }

  return (
    <section className="stepPanel">
      <div className="stepHeader">
        <span className="stepIcon"><MapPin size={18} /></span>
        <div>
          <h2>Pontos de medicao</h2>
          <p>Detecte, importe pelo CSV ou marque manualmente na planta.</p>
        </div>
      </div>

      <div className="toolbar">
        <button className="secondaryButton" type="button" disabled={!floorFile || isDetecting} onClick={runDetection}>
          {isDetecting ? <Loader2 className="spin" size={16} /> : <ScanSearch size={16} />}
          Detectar
        </button>
        <span className="toolHint"><MousePointer2 size={15} /> {points.length} ponto(s)</span>
      </div>

      {detail && <div className="inlineNotice">{detail}</div>}

      <FloorplanCanvas
        floorplan={floorplan}
        points={points}
        ap={ap}
        selectedPointId={selectedPointId}
        onCanvasClick={addPoint}
        onPointDrag={updatePoint}
        onPointSelect={setSelectedPointId}
      />

      <div className="pointEditor">
        <div className="pointList" aria-label="Lista de pontos">
          {points.map((point) => (
            <button
              key={point.point_id}
              type="button"
              className={selectedPoint?.point_id === point.point_id ? "active" : ""}
              onClick={() => setSelectedPointId(point.point_id)}
            >
              {point.point_id}
            </button>
          ))}
        </div>

        {selectedPoint && (
          <div className="formGrid three compact">
            <label className="field">
              ID
              <input value={selectedPoint.point_id} onChange={(event) => updateSelected("point_id", event.target.value)} />
            </label>
            <label className="field">
              x_px
              <input type="number" value={selectedPoint.x_px} onChange={(event) => updateSelected("x_px", event.target.value)} />
            </label>
            <label className="field">
              y_px
              <input type="number" value={selectedPoint.y_px} onChange={(event) => updateSelected("y_px", event.target.value)} />
            </label>
            <button className="secondaryButton dangerText" type="button" onClick={removeSelected}>
              <Trash2 size={16} />
              Remover
            </button>
          </div>
        )}
      </div>

      <IssueList issues={validateMeasurementPoints(points, floorplan, { requireAtLeastOne: false })} />
    </section>
  );
}
