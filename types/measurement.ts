export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  severity: ValidationSeverity;
  message: string;
  code?: string;
  point_id?: string;
};

export type PointSource = "manual" | "detected" | "csv";

export type MeasurementPoint = {
  point_id: string;
  x_px: number;
  y_px: number;
  rssi_24ghz: number | null;
  rssi_5ghz: number | null;
  rssi_6ghz?: number | null;
  distance_m: number | null;
  timestamp: string;
  source: PointSource;
  csv_distance_m?: number | null;
};

export type CsvMeasurementRow = {
  point_id: string;
  x_px?: number | null;
  y_px?: number | null;
  coordinate_kind?: "pixel" | "survey" | null;
  rssi_24ghz?: number | null;
  rssi_5ghz?: number | null;
  rssi_6ghz?: number | null;
  distance_m?: number | null;
  timestamp?: string | null;
};
