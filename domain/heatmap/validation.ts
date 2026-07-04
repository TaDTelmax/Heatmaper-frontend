import { distancePx } from "./distance";
import type { FloorplanImage, RouterPlacement, ScaleCalibration } from "@/types/floorplan";
import type { WifiBand } from "@/types/heatmap";
import type { MeasurementPoint, ValidationIssue } from "@/types/measurement";

export const MIN_MEASUREMENT_POINTS = 1;
export const RSSI_MIN = -100;
export const RSSI_MAX = -10;
export const REQUIRED_RSSI_BANDS: WifiBand[] = ["24ghz", "5ghz"];
const DUPLICATE_SCAN_LIMIT = 1200;
const MAX_DUPLICATE_WARNINGS = 40;
const MAX_POINT_COORDINATE_ISSUES = 160;
const MAX_RSSI_POINT_ISSUES = 160;

function issue(severity: ValidationIssue["severity"], message: string, code?: string, point_id?: string): ValidationIssue {
  return { severity, message, code, point_id };
}

function bandLabel(band: WifiBand): string {
  if (band === "24ghz") return "2.4GHz";
  if (band === "5ghz") return "5GHz";
  return "6GHz";
}

function rssiForBand(point: MeasurementPoint, band: WifiBand, allowDerived6GHz: boolean): number | null {
  if (band === "24ghz") return point.rssi_24ghz;
  if (band === "5ghz") return point.rssi_5ghz;
  if (point.rssi_6ghz !== null && point.rssi_6ghz !== undefined) return point.rssi_6ghz;
  return allowDerived6GHz && point.rssi_5ghz !== null ? point.rssi_5ghz - 4.5 : null;
}

function pushIssue(issues: ValidationIssue[], next: ValidationIssue, maxIssues: number): boolean {
  if (issues.length >= maxIssues) return false;
  issues.push(next);
  return true;
}

export function validateFloorplanFile(file: File): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const validType = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "application/pdf"].includes(file.type);
  if (!validType) {
    issues.push(issue("error", "Use PNG, JPG, SVG ou PDF.", "floorplan_type"));
  }
  const isPdf = file.type === "application/pdf";
  const maxSize = isPdf ? 50 * 1024 * 1024 : 12 * 1024 * 1024;
  const warnSize = isPdf ? 30 * 1024 * 1024 : 8 * 1024 * 1024;
  if (file.size > maxSize) {
    issues.push(issue("error", `Arquivo acima de ${isPdf ? "50" : "12"} MB.`, "floorplan_size"));
  } else if (file.size > warnSize) {
    issues.push(issue("warning", "Arquivo grande; a renderizacao pode demorar.", "floorplan_size_warning"));
  }
  return issues;
}

export function validateFloorplanImage(asset: FloorplanImage): ValidationIssue[] {
  const issues = [...asset.validation];
  if (asset.width < 600 || asset.height < 400) {
    issues.push(issue("warning", "Resolucao baixa para uma planta detalhada.", "floorplan_resolution"));
  }
  if (asset.width > 3600 || asset.height > 3600) {
    issues.push(issue("warning", "Resolucao alta; o heatmap sera mais pesado.", "floorplan_resolution_large"));
  }
  if (asset.aspectRatio < 0.35 || asset.aspectRatio > 3.2) {
    issues.push(issue("warning", "Proporcao incomum para planta baixa.", "floorplan_ratio"));
  }
  return issues;
}

// A plan is calibrated once it has a valid real-world scale (px/m > 0).
export function isScaleCalibrated(scale: ScaleCalibration): boolean {
  return Number.isFinite(scale.pxPerMeter) && scale.pxPerMeter > 0;
}

// Hard calibration gate: blocks spatial output and names calibration as the
// required next step (Constitution Principle I; FR-005 / SC-003).
export function validateCalibrationGate(scale: ScaleCalibration): ValidationIssue[] {
  if (!isScaleCalibrated(scale)) {
    return [
      issue(
        "error",
        "Calibracao obrigatoria: defina a escala real (metros) antes de gerar saidas espaciais.",
        "calibration_required",
      ),
    ];
  }
  return [];
}

export function validateScale(scale: ScaleCalibration): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Number.isFinite(scale.pxPerMeter) || scale.pxPerMeter <= 0) {
    issues.push(issue("error", "Informe uma escala valida em px/m.", "scale_required"));
  }
  if (scale.pxPerMeter < 5 || scale.pxPerMeter > 1000) {
    issues.push(issue("warning", "Escala fora do intervalo usual de plantas.", "scale_range"));
  }
  if (scale.mode === "two-point" && scale.calibrationPoints.length !== 2) {
    issues.push(issue("error", "A calibracao por parede precisa de dois pontos.", "scale_two_points"));
  }
  return issues;
}

export function validateRouter(aps: RouterPlacement[], floorplan: FloorplanImage | null): ValidationIssue[] {
  if (!aps.length) return [issue("error", "Defina a posicao de pelo menos um AP.", "ap_required")];
  if (!floorplan) return [];
  const issues: ValidationIssue[] = [];
  for (const ap of aps) {
    if (ap.ap_x_px < 0 || ap.ap_y_px < 0 || ap.ap_x_px >= floorplan.width || ap.ap_y_px >= floorplan.height) {
      issues.push(issue("error", `AP "${ap.ssid ?? ap.id}" fora da planta.`, "ap_inside"));
    }
  }
  return issues;
}

export function validateMeasurementPoints(
  points: MeasurementPoint[],
  floorplan: FloorplanImage | null,
  options: { requireAtLeastOne?: boolean } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const requireAtLeastOne = options.requireAtLeastOne ?? true;
  if (requireAtLeastOne && points.length < MIN_MEASUREMENT_POINTS) {
    issues.push(issue("error", "Importe ou marque ao menos um ponto de medicao.", "points_count"));
  }

  let omittedCoordinateIssues = 0;
  for (const point of points) {
    if (!Number.isFinite(point.x_px) || !Number.isFinite(point.y_px)) {
      if (!pushIssue(issues, issue("error", "Ponto sem coordenadas x_px/y_px.", "point_coordinates", point.point_id), MAX_POINT_COORDINATE_ISSUES)) {
        omittedCoordinateIssues += 1;
      }
      continue;
    }
    if (floorplan && (point.x_px < 0 || point.y_px < 0 || point.x_px >= floorplan.width || point.y_px >= floorplan.height)) {
      if (!pushIssue(issues, issue("error", "Ponto fora da planta.", "point_inside", point.point_id), MAX_POINT_COORDINATE_ISSUES)) {
        omittedCoordinateIssues += 1;
      }
    }
  }
  if (omittedCoordinateIssues > 0) {
    issues.push(issue("warning", `${omittedCoordinateIssues} inconsistencias adicionais de coordenadas foram omitidas.`, "point_issues_truncated"));
  }

  if (points.length > DUPLICATE_SCAN_LIMIT) return issues;

  let duplicateWarnings = 0;
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      if (points[left].source === "csv" || points[right].source === "csv") continue;
      const distance = distancePx(points[left], points[right]);
      if (distance < 8) {
        duplicateWarnings += 1;
        if (duplicateWarnings <= MAX_DUPLICATE_WARNINGS) {
          issues.push(issue("warning", `${points[left].point_id} e ${points[right].point_id} estao duplicados ou muito proximos.`, "point_duplicate"));
        }
      }
    }
  }
  if (duplicateWarnings > MAX_DUPLICATE_WARNINGS) {
    issues.push(issue("warning", `${duplicateWarnings - MAX_DUPLICATE_WARNINGS} avisos adicionais de pontos muito proximos foram omitidos.`, "point_duplicate_truncated"));
  }

  return issues;
}

export function validateRssi(points: MeasurementPoint[], bands: WifiBand[] = ["24ghz", "5ghz"]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bandCounts = new Map<WifiBand, number>(bands.map((band) => [band, 0]));
  let omittedPointIssues = 0;

  for (const point of points) {
    let hasAnyBand = false;
    for (const band of bands) {
      const value = rssiForBand(point, band, false);
      const label = bandLabel(band);
      if (value === null || !Number.isFinite(value)) {
        continue;
      }
      hasAnyBand = true;
      bandCounts.set(band, (bandCounts.get(band) ?? 0) + 1);
      if (value < RSSI_MIN || value > RSSI_MAX) {
        if (!pushIssue(issues, issue("error", `RSSI ${label} fora de -10 a -100 dBm.`, "rssi_range", point.point_id), MAX_RSSI_POINT_ISSUES)) {
          omittedPointIssues += 1;
        }
      }
    }
    if (!hasAnyBand) {
      if (!pushIssue(issues, issue("error", "RSSI ausente nas bandas requeridas.", "rssi_required", point.point_id), MAX_RSSI_POINT_ISSUES)) {
        omittedPointIssues += 1;
      }
    }
    if (point.csv_distance_m !== undefined && point.csv_distance_m !== null && point.distance_m !== null) {
      const delta = Math.abs(point.csv_distance_m - point.distance_m);
      const tolerance = Math.max(1, point.distance_m * 0.25);
      if (delta > tolerance) {
        if (!pushIssue(issues, issue("warning", "distance_m do CSV difere da distancia calculada.", "distance_audit", point.point_id), MAX_RSSI_POINT_ISSUES)) {
          omittedPointIssues += 1;
        }
      }
    }
  }

  for (const band of bands) {
    if ((bandCounts.get(band) ?? 0) === 0) {
      issues.push(issue("error", `Nenhum RSSI ${bandLabel(band)} informado.`, "rssi_band_required"));
    }
  }
  if (omittedPointIssues > 0) {
    issues.push(issue("warning", `${omittedPointIssues} inconsistencias adicionais de RSSI foram omitidas.`, "rssi_issues_truncated"));
  }
  return issues;
}

export function validateHeatmapReadiness(
  floorplan: FloorplanImage | null,
  scale: ScaleCalibration,
  aps: RouterPlacement[],
  points: MeasurementPoint[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!floorplan) issues.push(issue("error", "Planta baixa obrigatoria.", "floorplan_required"));
  issues.push(...validateCalibrationGate(scale));
  issues.push(...validateScale(scale));
  issues.push(...validateRouter(aps, floorplan));
  issues.push(...validateMeasurementPoints(points, floorplan));
  issues.push(...validateRssi(points, REQUIRED_RSSI_BANDS));
  return issues;
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((item) => item.severity === "error");
}

export function averageRssi(points: MeasurementPoint[], band: WifiBand): number | null {
  const values = points
    .map((point) => rssiForBand(point, band, band === "6ghz"))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function bestPoint(points: MeasurementPoint[], band: WifiBand): MeasurementPoint | null {
  return points.reduce<MeasurementPoint | null>((best, point) => {
    const value = rssiForBand(point, band, band === "6ghz");
    const bestValue = best ? rssiForBand(best, band, band === "6ghz") : null;
    if (value === null) return best;
    if (bestValue === null || value > bestValue) return point;
    return best;
  }, null);
}

export function worstPoint(points: MeasurementPoint[], band: WifiBand): MeasurementPoint | null {
  return points.reduce<MeasurementPoint | null>((worst, point) => {
    const value = rssiForBand(point, band, band === "6ghz");
    const worstValue = worst ? rssiForBand(worst, band, band === "6ghz") : null;
    if (value === null) return worst;
    if (worstValue === null || value < worstValue) return point;
    return worst;
  }, null);
}
