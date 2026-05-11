import { distancePx } from "./distance";
import type { FloorplanImage, RouterPlacement, ScaleCalibration } from "@/types/floorplan";
import type { WifiBand } from "@/types/heatmap";
import type { MeasurementPoint, ValidationIssue } from "@/types/measurement";

export const MIN_MEASUREMENT_POINTS = 1;
export const RSSI_MIN = -100;
export const RSSI_MAX = -20;

function issue(severity: ValidationIssue["severity"], message: string, code?: string, point_id?: string): ValidationIssue {
  return { severity, message, code, point_id };
}

export function validateFloorplanFile(file: File): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const validType = ["image/png", "image/jpeg", "image/jpg"].includes(file.type);
  if (!validType) {
    issues.push(issue("error", "Use PNG ou JPG.", "floorplan_type"));
  }
  if (file.size > 12 * 1024 * 1024) {
    issues.push(issue("error", "Arquivo acima de 12 MB.", "floorplan_size"));
  } else if (file.size > 8 * 1024 * 1024) {
    issues.push(issue("warning", "Arquivo grande; a geracao pode demorar.", "floorplan_size_warning"));
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

export function validateRouter(ap: RouterPlacement | null, floorplan: FloorplanImage | null): ValidationIssue[] {
  if (!ap) return [issue("error", "Defina a posicao do AP.", "ap_required")];
  if (!floorplan) return [];
  if (ap.ap_x_px < 0 || ap.ap_y_px < 0 || ap.ap_x_px >= floorplan.width || ap.ap_y_px >= floorplan.height) {
    return [issue("error", "AP fora da planta.", "ap_inside")];
  }
  return [];
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

  for (const point of points) {
    if (!Number.isFinite(point.x_px) || !Number.isFinite(point.y_px)) {
      issues.push(issue("error", "Ponto sem coordenadas x_px/y_px.", "point_coordinates", point.point_id));
      continue;
    }
    if (floorplan && (point.x_px < 0 || point.y_px < 0 || point.x_px >= floorplan.width || point.y_px >= floorplan.height)) {
      issues.push(issue("error", "Ponto fora da planta.", "point_inside", point.point_id));
    }
  }

  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const distance = distancePx(points[left], points[right]);
      if (distance < 8) {
        issues.push(issue("warning", `${points[left].point_id} e ${points[right].point_id} estao duplicados ou muito proximos.`, "point_duplicate"));
      }
    }
  }

  return issues;
}

export function validateRssi(points: MeasurementPoint[], bands: WifiBand[] = ["24ghz", "5ghz"]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const point of points) {
    for (const band of bands) {
      const value = band === "24ghz" ? point.rssi_24ghz : point.rssi_5ghz;
      const label = band === "24ghz" ? "2.4GHz" : "5GHz";
      if (value === null || !Number.isFinite(value)) {
        issues.push(issue("error", `RSSI ${label} ausente.`, "rssi_required", point.point_id));
        continue;
      }
      if (value < RSSI_MIN || value > RSSI_MAX) {
        issues.push(issue("error", `RSSI ${label} fora de -20 a -100 dBm.`, "rssi_range", point.point_id));
      }
    }
    if (point.csv_distance_m !== undefined && point.csv_distance_m !== null && point.distance_m !== null) {
      const delta = Math.abs(point.csv_distance_m - point.distance_m);
      const tolerance = Math.max(1, point.distance_m * 0.25);
      if (delta > tolerance) {
        issues.push(issue("warning", "distance_m do CSV difere da distancia calculada.", "distance_audit", point.point_id));
      }
    }
  }
  return issues;
}

export function validateHeatmapReadiness(
  floorplan: FloorplanImage | null,
  scale: ScaleCalibration,
  ap: RouterPlacement | null,
  points: MeasurementPoint[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!floorplan) issues.push(issue("error", "Planta baixa obrigatoria.", "floorplan_required"));
  issues.push(...validateScale(scale));
  issues.push(...validateRouter(ap, floorplan));
  issues.push(...validateMeasurementPoints(points, floorplan));
  issues.push(...validateRssi(points));
  return issues;
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((item) => item.severity === "error");
}

export function averageRssi(points: MeasurementPoint[], band: WifiBand): number | null {
  const values = points
    .map((point) => (band === "24ghz" ? point.rssi_24ghz : point.rssi_5ghz))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function bestPoint(points: MeasurementPoint[], band: WifiBand): MeasurementPoint | null {
  return points.reduce<MeasurementPoint | null>((best, point) => {
    const value = band === "24ghz" ? point.rssi_24ghz : point.rssi_5ghz;
    const bestValue = best ? (band === "24ghz" ? best.rssi_24ghz : best.rssi_5ghz) : null;
    if (value === null) return best;
    if (bestValue === null || value > bestValue) return point;
    return best;
  }, null);
}

export function worstPoint(points: MeasurementPoint[], band: WifiBand): MeasurementPoint | null {
  return points.reduce<MeasurementPoint | null>((worst, point) => {
    const value = band === "24ghz" ? point.rssi_24ghz : point.rssi_5ghz;
    const worstValue = worst ? (band === "24ghz" ? worst.rssi_24ghz : worst.rssi_5ghz) : null;
    if (value === null) return worst;
    if (worstValue === null || value < worstValue) return point;
    return worst;
  }, null);
}
