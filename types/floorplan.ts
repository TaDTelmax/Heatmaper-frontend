import type { ValidationIssue } from "./measurement";

export type Coordinate = {
  x_px: number;
  y_px: number;
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
};

export type CalibrationMode = "manual" | "two-point";

export type ScaleCalibration = {
  mode: CalibrationMode;
  pxPerMeter: number;
  manualPxPerMeter: number;
  knownDistanceM: number;
  calibrationPoints: Coordinate[];
};

export type RouterPlacement = {
  ap_x_px: number;
  ap_y_px: number;
  frequency?: "2.4GHz" | "5GHz" | "6GHz" | "dual" | "tri-band";
  txPower?: number;
  antennaGainDbi?: number;
  antennaPattern?: "omni" | "directional";
  antennaAzimuthDeg?: number;
  channel?: number;
  propagationRadiusM?: number;
};
