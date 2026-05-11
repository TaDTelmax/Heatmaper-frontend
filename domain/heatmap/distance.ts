import type { Coordinate, RouterPlacement } from "@/types/floorplan";
import type { MeasurementPoint } from "@/types/measurement";

export function distancePx(a: Coordinate, b: Coordinate): number {
  return Math.hypot(a.x_px - b.x_px, a.y_px - b.y_px);
}

export function distanceMeters(point: Coordinate, ap: RouterPlacement, pxPerMeter: number): number {
  if (!Number.isFinite(pxPerMeter) || pxPerMeter <= 0) return 0;
  return distancePx(point, { x_px: ap.ap_x_px, y_px: ap.ap_y_px }) / pxPerMeter;
}

export function withComputedDistances(
  points: MeasurementPoint[],
  ap: RouterPlacement | null,
  pxPerMeter: number,
): MeasurementPoint[] {
  if (!ap || !Number.isFinite(pxPerMeter) || pxPerMeter <= 0) {
    return points.map((point) => ({ ...point, distance_m: null }));
  }

  return points.map((point) => ({
    ...point,
    distance_m: Number(distanceMeters(point, ap, pxPerMeter).toFixed(2)),
  }));
}
