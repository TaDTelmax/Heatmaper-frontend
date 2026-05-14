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
    return { ...next, pxPerMeter: Number.isFinite(next.manualPxPerMeter) ? next.manualPxPerMeter : 0 };
  }
  if (next.calibrationPoints.length === 2 && next.knownDistanceM > 0) {
    const px = distancePx(next.calibrationPoints[0], next.calibrationPoints[1]);
    return { ...next, pxPerMeter: px / next.knownDistanceM };
  }
  return { ...next, pxPerMeter: 0 };
}

function parseDecimal(value: string): number {
  return Number(value.replace(",", "."));
}

export function StepScaleCalibration({ floorplan, scale, onChange }: StepScaleCalibrationProps) {
  const twoPointDistance =
    scale.calibrationPoints.length === 2 ? distancePx(scale.calibrationPoints[0], scale.calibrationPoints[1]) : null;
  const metersPerPixel = scale.pxPerMeter > 0 ? 1 / scale.pxPerMeter : null;
  const projectedWidthM = scale.pxPerMeter > 0 ? floorplan.width / scale.pxPerMeter : null;
  const projectedHeightM = scale.pxPerMeter > 0 ? floorplan.height / scale.pxPerMeter : null;

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
          <h2>Calibracao da escala real</h2>
          <p>Marque na imagem uma medida conhecida da planta e informe o valor real em metros.</p>
        </div>
      </div>

      <div className="modeGrid">
        <button
          type="button"
          className={scale.mode === "two-point" ? "modeButton active" : "modeButton"}
          onClick={() => update({ ...scale, mode: "two-point" })}
        >
          Medir na planta
        </button>
        <button
          type="button"
          className={scale.mode === "manual" ? "modeButton active" : "modeButton"}
          onClick={() => update({ ...scale, mode: "manual", pxPerMeter: scale.manualPxPerMeter })}
        >
          px/m manual
        </button>
      </div>

      <div className="formGrid two">
        <label className="field" htmlFor="known-distance">
          Medida real da planta (m)
          <input
            id="known-distance"
            inputMode="decimal"
            type="number"
            min="0.1"
            step="0.01"
            value={scale.knownDistanceM}
            onChange={(event) => update({ ...scale, knownDistanceM: parseDecimal(event.target.value), mode: "two-point" })}
          />
          <small style={{ color: "var(--muted)", fontSize: 11 }}>
            Exemplo: clique nas extremidades de uma cota de 3,50 m e informe 3.5
          </small>
        </label>
        <label className="field" htmlFor="manual-scale">
          Escala manual (px/m)
          <input
            id="manual-scale"
            inputMode="decimal"
            type="number"
            min="1"
            step="0.1"
            value={scale.manualPxPerMeter}
            onChange={(event) => update({ ...scale, manualPxPerMeter: parseDecimal(event.target.value), mode: "manual" })}
          />
          <small style={{ color: "var(--muted)", fontSize: 11 }}>
            Use apenas se a relacao px/m ja for conhecida
          </small>
        </label>
      </div>

      <div className="inlineNotice">
        A linha de calibracao usa os pixels originais da imagem enviada. A escala final alimenta distancias, paredes, raio RF e area projetada.
      </div>

      <FloorplanCanvas
        floorplan={floorplan}
        calibrationPoints={scale.calibrationPoints}
        onCanvasClick={scale.mode === "two-point" ? addCalibrationPoint : undefined}
      />

      <div className="factGrid">
        <Fact label="Escala final" value={`${scale.pxPerMeter.toFixed(2)} px/m`} />
        <Fact label="Metro por pixel" value={metersPerPixel === null ? "-" : `${metersPerPixel.toFixed(4)} m/px`} />
        <Fact label="Metodo" value={scale.mode === "manual" ? "Manual" : "Medido na planta"} />
        <Fact label="Linha medida" value={twoPointDistance === null ? "-" : `${twoPointDistance.toFixed(1)} px`} />
        <Fact label="Projecao da imagem" value={projectedWidthM === null ? "-" : `${projectedWidthM.toFixed(2)} x ${projectedHeightM?.toFixed(2)} m`} />
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
