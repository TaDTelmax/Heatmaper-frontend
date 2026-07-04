"use client";

import { Ruler, RotateCcw, Scissors } from "lucide-react";
import { distancePx } from "@/domain/heatmap/distance";
import { deriveCalibration } from "@/domain/coordinate/calibration";
import { validateScale } from "@/domain/heatmap/validation";
import type { AspectCorrectionInfo } from "@/services/pdfService";
import type { Coordinate, FloorplanImage, ScaleCalibration } from "@/types/floorplan";
import type { ValidationIssue } from "@/types/measurement";
import { FloorplanCanvas } from "./FloorplanCanvas";
import { Fact, IssueList } from "./StepUploadFloorplan";

// Mismatch above which the raw auto-crop vs. the informed real-world
// dimensions is flagged for manual review, even though padding already
// corrected the metric scale itself (the crop region may still be wrong).
const ASPECT_MISMATCH_WARNING_THRESHOLD = 0.10; // 10%

type StepScaleCalibrationProps = {
  floorplan: FloorplanImage;
  scale: ScaleCalibration;
  onChange: (scale: ScaleCalibration) => void;
  onCropFloorplan?: () => Promise<void>;
  isCropping?: boolean;
  cropError?: string | null;
  cropAspectInfo?: AspectCorrectionInfo | null;
};

function pxPerMeterFromDimensions(widthPx: number, heightPx: number, knownWidthM: number | undefined, knownHeightM: number | undefined): number {
  const fromWidth = (knownWidthM && knownWidthM > 0) ? widthPx / knownWidthM : null;
  const fromHeight = (knownHeightM && knownHeightM > 0) ? heightPx / knownHeightM : null;
  if (fromWidth !== null && fromHeight !== null) return (fromWidth + fromHeight) / 2;
  if (fromWidth !== null) return fromWidth;
  if (fromHeight !== null) return fromHeight;
  return 0;
}

// Compute the derived px/m via the coordinate engine so the scale that feeds the
// whole platform comes from a single authoritative source (Constitution Principle I).
function calculateScale(next: ScaleCalibration, floorplan: FloorplanImage): { scale: ScaleCalibration; issues: ValidationIssue[] } {
  if (next.mode === "known-dimensions") {
    const pxPerMeter = pxPerMeterFromDimensions(floorplan.width, floorplan.height, next.knownWidthM, next.knownHeightM);
    const issues: ValidationIssue[] = pxPerMeter <= 0
      ? [{ severity: "error", message: "Informe ao menos uma dimensao real positiva.", code: "scale_required" }]
      : [];
    return { scale: { ...next, pxPerMeter }, issues };
  }
  if (next.mode === "manual") {
    const { calibration, issues } = deriveCalibration({
      mode: "manual",
      pxPerMeter: Number.isFinite(next.manualPxPerMeter) ? next.manualPxPerMeter : 0,
    });
    return { scale: { ...next, pxPerMeter: calibration?.pxPerMeter ?? 0 }, issues };
  }
  if (next.calibrationPoints.length === 2) {
    const { calibration, issues } = deriveCalibration({
      mode: "two-point",
      points: [next.calibrationPoints[0], next.calibrationPoints[1]],
      knownDistanceM: next.knownDistanceM,
    });
    return { scale: { ...next, pxPerMeter: calibration?.pxPerMeter ?? 0 }, issues };
  }
  return { scale: { ...next, pxPerMeter: 0 }, issues: [] };
}

function parseDecimal(value: string): number {
  return Number(value.replace(",", "."));
}

export function StepScaleCalibration({ floorplan, scale, onChange, onCropFloorplan, isCropping = false, cropError, cropAspectInfo = null }: StepScaleCalibrationProps) {
  const twoPointDistance =
    scale.calibrationPoints.length === 2 ? distancePx(scale.calibrationPoints[0], scale.calibrationPoints[1]) : null;
  const metersPerPixel = scale.pxPerMeter > 0 ? 1 / scale.pxPerMeter : null;
  const projectedWidthM = scale.pxPerMeter > 0 ? floorplan.width / scale.pxPerMeter : null;
  const projectedHeightM = scale.pxPerMeter > 0 ? floorplan.height / scale.pxPerMeter : null;
  const isCalibrated = scale.pxPerMeter > 0;
  const engineIssues = calculateScale(scale, floorplan).issues;
  const aspectMismatchPct = cropAspectInfo ? cropAspectInfo.mismatchRatio * 100 : null;
  const aspectIssues: ValidationIssue[] =
    cropAspectInfo && cropAspectInfo.mismatchRatio > ASPECT_MISMATCH_WARNING_THRESHOLD
      ? [
          {
            severity: "warning",
            message: `O recorte automatico ficou com proporcao ${cropAspectInfo.rawAspectRatio.toFixed(2)}:1, ${aspectMismatchPct?.toFixed(0)}% diferente da proporcao real informada (${cropAspectInfo.targetAspectRatio.toFixed(2)}:1). A escala foi corrigida com preenchimento branco, mas revise se o recorte pegou a area certa da planta.`,
            code: "crop_aspect_mismatch",
          },
        ]
      : [];

  function update(next: ScaleCalibration) {
    onChange(calculateScale(next, floorplan).scale);
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
        <button
          type="button"
          className={scale.mode === "known-dimensions" ? "modeButton active" : "modeButton"}
          onClick={() => update({ ...scale, mode: "known-dimensions" })}
        >
          Dimensoes reais
        </button>
      </div>

      {scale.mode === "known-dimensions" ? (
        <>
          <div className="formGrid two">
            <label className="field" htmlFor="known-width">
              Largura real (m)
              <input
                id="known-width"
                inputMode="decimal"
                type="number"
                min="0.1"
                step="0.01"
                value={scale.knownWidthM ?? ""}
                onChange={(event) => update({ ...scale, knownWidthM: parseDecimal(event.target.value), mode: "known-dimensions" })}
              />
              <small style={{ color: "var(--muted)", fontSize: 11 }}>
                Largura total do ambiente em metros
              </small>
            </label>
            <label className="field" htmlFor="known-height">
              Altura real (m)
              <input
                id="known-height"
                inputMode="decimal"
                type="number"
                min="0.1"
                step="0.01"
                value={scale.knownHeightM ?? ""}
                onChange={(event) => update({ ...scale, knownHeightM: parseDecimal(event.target.value), mode: "known-dimensions" })}
              />
              <small style={{ color: "var(--muted)", fontSize: 11 }}>
                Profundidade total do ambiente em metros
              </small>
            </label>
          </div>
          {onCropFloorplan && (
            <button
              className="primaryButton"
              type="button"
              disabled={isCropping || !((scale.knownWidthM ?? 0) > 0 || (scale.knownHeightM ?? 0) > 0)}
              onClick={onCropFloorplan}
            >
              <Scissors size={15} />
              {isCropping ? "Recortando…" : "Recortar planta ao desenho"}
            </button>
          )}
        </>
      ) : (
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
      )}

      <div className="inlineNotice">
        A linha de calibracao usa os pixels originais da imagem enviada. A escala final alimenta distancias, paredes, raio RF e area projetada.
      </div>

      <FloorplanCanvas
        floorplan={floorplan}
        calibrationPoints={scale.calibrationPoints}
        onCanvasClick={scale.mode === "two-point" ? addCalibrationPoint : undefined}
      />

      <div className="factGrid">
        <Fact label="Status" value={isCalibrated ? "Calibrado" : "Nao calibrado"} />
        <Fact label="Escala final" value={`${scale.pxPerMeter.toFixed(2)} px/m`} />
        <Fact label="Metro por pixel" value={metersPerPixel === null ? "-" : `${metersPerPixel.toFixed(4)} m/px`} />
        <Fact label="Metodo" value={scale.mode === "manual" ? "Manual" : scale.mode === "known-dimensions" ? "Dimensoes reais" : "Medido na planta"} />
        <Fact label="Linha medida" value={twoPointDistance === null ? "-" : `${twoPointDistance.toFixed(1)} px`} />
        <Fact label="Projecao da imagem" value={projectedWidthM === null ? "-" : `${projectedWidthM.toFixed(2)} x ${projectedHeightM?.toFixed(2)} m`} />
        {cropAspectInfo && (
          <>
            <Fact
              label="Proporcao do recorte vs. real"
              value={`${cropAspectInfo.rawAspectRatio.toFixed(3)}:1 vs ${cropAspectInfo.targetAspectRatio.toFixed(3)}:1 (${aspectMismatchPct?.toFixed(1)}% dif.)`}
            />
            <Fact
              label="Correcao automatica de proporcao"
              value={cropAspectInfo.applied ? "Aplicada (preenchimento branco)" : "Nao necessaria"}
            />
          </>
        )}
      </div>

      {!isCalibrated && (
        <div className="inlineNotice">
          A planta ainda nao esta calibrada. Defina a escala real (metros) antes de gerar qualquer saida espacial.
        </div>
      )}

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

      <IssueList issues={[
        ...engineIssues,
        ...validateScale(scale),
        ...aspectIssues,
        ...(cropError ? [{ severity: "error" as const, message: cropError, code: "crop_error" }] : []),
      ]} />
    </section>
  );
}
