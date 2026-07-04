// Coordinate Engine: the authoritative px<->meters transform and metric
// distance/area queries, gated behind mandatory calibration.
// See specs/001-coordinate-engine for the contract.

export {
  MIN_REFERENCE_SEPARATION_PX,
  MIN_DISTINCT_SEPARATION_PX,
  planToWorld,
  worldToPlan,
  separationPx,
  distanceWorldM,
  polygonAreaM2,
} from "./transform.ts";

export { CalibrationError, isCalibrated, requireCalibrated } from "./gate.ts";

export {
  deriveCalibration,
  calibrate,
  recalibrate,
} from "./calibration.ts";
export type {
  CalibrationInput,
  TwoPointInput,
  ManualInput,
  DeriveCalibrationResult,
} from "./calibration.ts";

export {
  toWorld,
  toPlan,
  distanceM,
  areaM2,
  recomputeWorld,
} from "./coordinateEngine.ts";
