import type { Calibration, CalibrationState, PlanAnchor } from "@/types/floorplan";
import type { ValidationIssue } from "@/types/measurement";
import {
  MIN_DISTINCT_SEPARATION_PX,
  MIN_REFERENCE_SEPARATION_PX,
  separationPx,
} from "./transform.ts";

const DEFAULT_ORIGIN: PlanAnchor = { x_px: 0, y_px: 0 };

// Usual range for floorplan scales; outside this we warn (retained behavior).
const PX_PER_METER_MIN = 5;
const PX_PER_METER_MAX = 1000;

export type TwoPointInput = {
  mode: "two-point";
  points: [PlanAnchor, PlanAnchor];
  knownDistanceM: number;
  originPx?: PlanAnchor;
};

export type ManualInput = {
  mode: "manual";
  pxPerMeter: number;
  originPx?: PlanAnchor;
};

export type CalibrationInput = TwoPointInput | ManualInput;

export type DeriveCalibrationResult = {
  calibration: Calibration | null;
  issues: ValidationIssue[];
};

function issue(
  severity: ValidationIssue["severity"],
  message: string,
  code: string,
): ValidationIssue {
  return { severity, message, code };
}

function hasBlocking(issues: ValidationIssue[]): boolean {
  return issues.some((item) => item.severity === "error");
}

function buildCalibration(
  mode: "manual" | "two-point",
  pxPerMeter: number,
  knownDistanceM: number,
  calibrationPoints: PlanAnchor[],
  originPx: PlanAnchor,
  manualPxPerMeter: number,
): Calibration {
  return {
    mode,
    pxPerMeter,
    manualPxPerMeter,
    knownDistanceM,
    calibrationPoints,
    metersPerPixel: 1 / pxPerMeter,
    originPx,
  };
}

function rangeWarnings(pxPerMeter: number): ValidationIssue[] {
  if (pxPerMeter < PX_PER_METER_MIN || pxPerMeter > PX_PER_METER_MAX) {
    return [issue("warning", "Escala fora do intervalo usual de plantas.", "scale_range")];
  }
  return [];
}

// Derive a canonical Calibration from two-point or manual input.
// Returns blocking issues (no calibration) for invalid input, or a calibration
// plus any warnings. Never throws.
export function deriveCalibration(input: CalibrationInput): DeriveCalibrationResult {
  const issues: ValidationIssue[] = [];
  const origin = input.originPx ?? DEFAULT_ORIGIN;

  if (input.mode === "manual") {
    if (!Number.isFinite(input.pxPerMeter) || input.pxPerMeter <= 0) {
      issues.push(issue("error", "Informe uma escala valida em px/m.", "scale_required"));
      return { calibration: null, issues };
    }
    issues.push(...rangeWarnings(input.pxPerMeter));
    return {
      calibration: buildCalibration(
        "manual",
        input.pxPerMeter,
        0,
        [],
        origin,
        input.pxPerMeter,
      ),
      issues,
    };
  }

  // two-point
  if (!Number.isFinite(input.knownDistanceM) || input.knownDistanceM <= 0) {
    issues.push(issue("error", "Informe uma distancia real positiva em metros.", "scale_required"));
  }
  const [a, b] = input.points;
  const sep = separationPx(a, b);
  if (sep <= MIN_DISTINCT_SEPARATION_PX) {
    issues.push(issue("error", "A calibracao por parede precisa de dois pontos distintos.", "scale_two_points"));
  } else if (sep < MIN_REFERENCE_SEPARATION_PX) {
    issues.push(
      issue(
        "warning",
        "Os pontos de referencia estao muito proximos; a escala pode ser imprecisa.",
        "scale_separation",
      ),
    );
  }

  if (hasBlocking(issues)) {
    return { calibration: null, issues };
  }

  const pxPerMeter = sep / input.knownDistanceM;
  issues.push(...rangeWarnings(pxPerMeter));
  return {
    calibration: buildCalibration(
      "two-point",
      pxPerMeter,
      input.knownDistanceM,
      [a, b],
      origin,
      pxPerMeter,
    ),
    issues,
  };
}

// Build a calibrated state from input for a given floorplan identity.
// On blocking issues, returns an uncalibrated state plus the issues.
export function calibrate(
  floorplanKey: string,
  input: CalibrationInput,
): { state: CalibrationState; issues: ValidationIssue[] } {
  const { calibration, issues } = deriveCalibration(input);
  if (!calibration) {
    return { state: { status: "uncalibrated", calibration: null, floorplanKey }, issues };
  }
  return { state: { status: "calibrated", calibration, floorplanKey }, issues };
}

// Re-calibrate an existing plan with new input. Element anchors are untouched by
// this function; callers recompute element world coordinates via the engine's
// recomputeWorld using the returned state (FR-013).
export function recalibrate(
  previous: CalibrationState,
  input: CalibrationInput,
): { state: CalibrationState; issues: ValidationIssue[] } {
  return calibrate(previous.floorplanKey, input);
}
