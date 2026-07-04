import type { PlanAnchor, WorldCoordinate } from "@/types/floorplan";

// The kind of positioned entity on the plan. All kinds share the same
// positioning contract so the coordinate engine can treat them uniformly.
export type SpatialElementKind =
  | "measurement"
  | "router"
  | "mesh"
  | "obstacle"
  | "robot";

// Shared positioning shape for every spatial element.
// `anchor` is the stable plan-space pixel position (rendering + re-calibration anchor).
// `world` is the authoritative metric position; null while the plan is uncalibrated.
export type SpatialElement = {
  anchor: PlanAnchor;
  world: WorldCoordinate | null;
  kind: SpatialElementKind;
};
