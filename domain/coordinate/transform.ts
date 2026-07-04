import type { Calibration, PlanAnchor, WorldCoordinate } from "@/types/floorplan";

// Below this on-plan separation (pixels) between two calibration points, a 1px
// selection error produces an unreliable scale, so we warn (see calibration.ts).
export const MIN_REFERENCE_SEPARATION_PX = 40;

// Coincident-point guard for two-point calibration: separation at or below this
// is treated as the same point and rejected.
export const MIN_DISTINCT_SEPARATION_PX = 1e-6;

// Pure, deterministic affine transform between plan space (pixels) and world
// space (meters). Isotropic scale (metersPerPixel) plus an origin offset; no
// rotation/shear (floorplan images are axis-aligned). All functions are total
// and side-effect free.

export function planToWorld(anchor: PlanAnchor, calibration: Calibration): WorldCoordinate {
  const { metersPerPixel, originPx } = calibration;
  return {
    x: (anchor.x_px - originPx.x_px) * metersPerPixel,
    y: (anchor.y_px - originPx.y_px) * metersPerPixel,
    unit: "meters",
  };
}

export function worldToPlan(world: WorldCoordinate, calibration: Calibration): PlanAnchor {
  const { metersPerPixel, originPx } = calibration;
  return {
    x_px: world.x / metersPerPixel + originPx.x_px,
    y_px: world.y / metersPerPixel + originPx.y_px,
  };
}

// Euclidean separation in pixels between two plan-space anchors.
export function separationPx(a: PlanAnchor, b: PlanAnchor): number {
  return Math.hypot(a.x_px - b.x_px, a.y_px - b.y_px);
}

// Euclidean distance in meters between two world coordinates.
export function distanceWorldM(a: WorldCoordinate, b: WorldCoordinate): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Shoelace area in square meters of a world-space polygon.
export function polygonAreaM2(points: WorldCoordinate[]): number {
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}
