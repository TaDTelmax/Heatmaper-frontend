"use client";

import { Ruler, RotateCcw } from "lucide-react";
import { distancePx } from "@/domain/heatmap/distance";
import { validateScale } from "@/domain/heatmap/validation";
import type { Coordinate, FloorplanImage, ScaleCalibration } from "@/types/floorplan";
import { FloorplanCanvas } from "./FloorplanCanvas";
import { Fact, IssueList } from "./StepUploadFloorplan";

type StepScaleCalibrationProps = {
  floorplan: FloorplanImage;
  scale: ScaleCalibration;
  onChange: (scale: ScaleCalibration) => void;
};

function calculateScale(next: ScaleCalibration): ScaleCalibration {
  if (next.mode === "manual") {
    return { ...next, pxPerMeter: next.manualPxPerMeter };
  }
  if (next.calibrationPoints.length === 2 && next.knownDistanceM > 0) {
    const px = distancePx(next.calibrationPoints[0], next.calibrationPoints[1]);
    return { ...next, pxPerMeter: px / next.knownDistanceM };
  }
  return next;
}

export function StepScaleCalibration({ floorplan, scale, onChange }: StepScaleCalibrationProps) {
  const twoPointDistance =
    scale.calibrationPoints.length === 2 ? distancePx(scale.calibrationPoints[0], scale.calibrationPoints[1]) : null;

  function update(next: ScaleCalibration) {
    onChange(calculateScale(next));
  }

  function addCalibrationPoint(point: Coordinate) {
    if (scale.mode !== "two-point") return;
    const points = scale.calibrationPoints.length >= 2 ? [point] : [...scale.calibrationPoints, point];
    update({ ...scale, calibrationPoints: points });
  }

  return (
    <section className="stepPanel">
      <div className="stepHeader">
        <span className="stepIcon"><Ruler size={18} /></span>
        <div>
          <h2>Calibracao da escala</h2>
          <p>Informe px/m ou use dois pontos de uma medida conhecida.</p>
        </div>
      </div>

      <div className="modeGrid">
        <button
          type="button"
          className={scale.mode === "manual" ? "modeButton active" : "modeButton"}
          onClick={() => update({ ...scale, mode: "manual", pxPerMeter: scale.manualPxPerMeter })}
        >
          Manual
        </button>
        <button
          type="button"
          className={scale.mode === "two-point" ? "modeButton active" : "modeButton"}
          onClick={() => update({ ...scale, mode: "two-point" })}
        >
          Dois pontos
        </button>
      </div>

      <div className="formGrid two">
        <label className="field" htmlFor="manual-scale">
          1 metro em px
          <input
            id="manual-scale"
            inputMode="decimal"
            type="number"
            min="1"
            step="0.1"
            value={scale.manualPxPerMeter}
            onChange={(event) => update({ ...scale, manualPxPerMeter: Number(event.target.value), mode: "manual" })}
          />
        </label>
        <label className="field" htmlFor="known-distance">
          Medida conhecida (m)
          <input
            id="known-distance"
            inputMode="decimal"
            type="number"
            min="0.1"
            step="0.1"
            value={scale.knownDistanceM}
            onChange={(event) => update({ ...scale, knownDistanceM: Number(event.target.value), mode: "two-point" })}
          />
        </label>
      </div>

      <FloorplanCanvas
        floorplan={floorplan}
        calibrationPoints={scale.calibrationPoints}
        onCanvasClick={scale.mode === "two-point" ? addCalibrationPoint : undefined}
      />

      <div className="factGrid">
        <Fact label="Escala final" value={`${scale.pxPerMeter.toFixed(2)} px/m`} />
        <Fact label="Metodo" value={scale.mode === "manual" ? "Manual" : "Dois pontos"} />
        <Fact label="Linha medida" value={twoPointDistance === null ? "-" : `${twoPointDistance.toFixed(1)} px`} />
      </div>

      {scale.calibrationPoints.length > 0 && (
        <button
          className="secondaryButton"
          type="button"
          onClick={() => update({ ...scale, calibrationPoints: [] })}
        >
          <RotateCcw size={16} />
          Refazer pontos
        </button>
      )}

      <IssueList issues={validateScale(scale)} />
    </section>
  );
}
