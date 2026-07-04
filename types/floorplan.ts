import type { PdfMeasurements } from "@/services/pdfService";
import type { ValidationIssue } from "./measurement";

export type Coordinate = {
  x_px: number;
  y_px: number;
};

// Plan-space pixel position: the stable anchor where an element is placed.
// Rendering/interaction reference and the fixed anchor across re-calibration.
export type PlanAnchor = Coordinate;

// World-space position in meters: the authoritative spatial value for every
// element. All distance/area/coverage math uses this, never raw pixels.
export type WorldCoordinate = {
  x: number;
  y: number;
  unit: "meters";
};

export type FloorplanImage = {
  fileName: string;
  fileSize: number;
  mimeType: string;
  dataUrl: string;
  width: number;
  height: number;
  aspectRatio: number;
  validation: ValidationIssue[];
  enhanced?: boolean;
  pdf?: {
    pageCount: number;
    selectedPage: number;
    detectedScale: number | null;
    textSnippet: string;
    measurements: PdfMeasurements;
  };
};

export type CalibrationMode = "manual" | "two-point" | "known-dimensions";

export type ScaleCalibration = {
  mode: CalibrationMode;
  pxPerMeter: number;
  manualPxPerMeter: number;
  knownDistanceM: number;
  calibrationPoints: Coordinate[];
  knownWidthM?: number;
  knownHeightM?: number;
};

// Canonical, engine-internal calibration: links the derived scale to its input.
// `metersPerPixel` (= 1 / pxPerMeter) is the canonical scale used by the transform;
// `originPx` is the plan-space point mapped to world origin (defaults to plan top-left).
export type Calibration = ScaleCalibration & {
  metersPerPixel: number;
  originPx: PlanAnchor;
};

// Per-floorplan calibration status exposed to the UI and the gate.
// `floorplanKey` identifies the image so replacing it invalidates calibration.
export type CalibrationState =
  | { status: "uncalibrated"; calibration: null; floorplanKey: string }
  | { status: "calibrated"; calibration: Calibration; floorplanKey: string };

export type RouterPlacement = {
  id: string;
  ap_x_px: number;
  ap_y_px: number;
  ssid?: string;
  mac?: string;
  vendor?: string;
  channel?: number;
  signalDbm?: number;
  maxRateMbps?: number;
  encryption?: string;
  // RF model parameters
  antennaGainDbi?: number;
  antennaPattern?: "omni" | "directional";
  antennaAzimuthDeg?: number;
  propagationRadiusM?: number;
  frequency?: "2.4GHz" | "5GHz" | "6GHz" | "dual" | "tri-band";
};
