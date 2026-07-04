import type { Calibration, Coordinate, RouterPlacement } from "@/types/floorplan";
import type { MeasurementPoint } from "@/types/measurement";
import { distanceWorldM, planToWorld } from "@/domain/coordinate/transform";

export function distancePx(a: Coordinate, b: Coordinate): number {
  return Math.hypot(a.x_px - b.x_px, a.y_px - b.y_px);
}

// Build a minimal canonical calibration from a px/m scale (origin at top-left)
// so metric distance is computed by the coordinate engine, never by an inline
// `distancePx / pxPerMeter` at this layer (Constitution Principle I).
function calibrationFromPxPerMeter(pxPerMeter: number): Calibration {
  return {
    mode: "manual",
    pxPerMeter,
    manualPxPerMeter: pxPerMeter,
    knownDistanceM: 0,
    calibrationPoints: [],
    metersPerPixel: 1 / pxPerMeter,
    originPx: { x_px: 0, y_px: 0 },
  };
}

export function distanceMeters(point: Coordinate, ap: RouterPlacement, pxPerMeter: number): number {
  if (!Number.isFinite(pxPerMeter) || pxPerMeter <= 0) return 0;
  const calibration = calibrationFromPxPerMeter(pxPerMeter);
  return distanceWorldM(
    planToWorld(point, calibration),
    planToWorld({ x_px: ap.ap_x_px, y_px: ap.ap_y_px }, calibration),
  );
}

export function withComputedDistances(
  points: MeasurementPoint[],
  aps: RouterPlacement[],
  pxPerMeter: number,
): MeasurementPoint[] {
  if (!aps.length || !Number.isFinite(pxPerMeter) || pxPerMeter <= 0) {
    return points.map((point) => ({ ...point, distance_m: null }));
  }

  return points.map((point) => {
    const minDist = Math.min(...aps.map((ap) => distanceMeters(point, ap, pxPerMeter)));
    return { ...point, distance_m: Number(minDist.toFixed(2)) };
  });
}
