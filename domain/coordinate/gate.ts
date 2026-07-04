import type { Calibration, CalibrationState } from "@/types/floorplan";

// Thrown by any engine operation that needs a real scale when the plan is not
// calibrated. The machine-readable code lets the UI render a single, typed,
// actionable "calibration required" message (Constitution Principle I).
export class CalibrationError extends Error {
  readonly code = "calibration_required" as const;

  constructor(message = "Calibracao obrigatoria antes de qualquer saida espacial.") {
    super(message);
    this.name = "CalibrationError";
  }
}

// Non-throwing predicate for UI gating.
export function isCalibrated(state: CalibrationState): boolean {
  return state.status === "calibrated";
}

// Choke point for all spatial output: returns the active calibration or throws.
export function requireCalibrated(state: CalibrationState): Calibration {
  if (state.status !== "calibrated") {
    throw new CalibrationError();
  }
  return state.calibration;
}
