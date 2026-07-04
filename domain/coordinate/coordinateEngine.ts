import type { CalibrationState, PlanAnchor, WorldCoordinate } from "@/types/floorplan";
import type { SpatialElement } from "@/types/spatialElement";
import { requireCalibrated } from "./gate.ts";
import {
  distanceWorldM,
  planToWorld,
  polygonAreaM2,
  worldToPlan,
} from "./transform.ts";

// The single authoritative interface for plan<->world conversion and all metric
// distance/area queries. Every method that returns spatial output is gated:
// it throws CalibrationError when the plan is uncalibrated (Constitution
// Principle I; FR-005). No consumer computes metric distance from pixels.

function toWorldCoordinate(
  point: PlanAnchor | WorldCoordinate,
  state: CalibrationState,
): WorldCoordinate {
  if ("unit" in point) return point;
  const calibration = requireCalibrated(state);
  return planToWorld(point, calibration);
}

// Convert a plan-space anchor to its authoritative world coordinate (meters).
export function toWorld(anchor: PlanAnchor, state: CalibrationState): WorldCoordinate {
  const calibration = requireCalibrated(state);
  return planToWorld(anchor, calibration);
}

// Inverse: place an authoritative world coordinate back onto the plan.
export function toPlan(world: WorldCoordinate, state: CalibrationState): PlanAnchor {
  const calibration = requireCalibrated(state);
  return worldToPlan(world, calibration);
}

// Real distance in meters between two points (anchors or world coordinates).
// Always computed from world coordinates, never raw pixels (FR-011).
export function distanceM(
  a: PlanAnchor | WorldCoordinate,
  b: PlanAnchor | WorldCoordinate,
  state: CalibrationState,
): number {
  const worldA = toWorldCoordinate(a, state);
  const worldB = toWorldCoordinate(b, state);
  return distanceWorldM(worldA, worldB);
}

// Real area in square meters of a polygon (anchors or world coordinates).
export function areaM2(
  polygon: (PlanAnchor | WorldCoordinate)[],
  state: CalibrationState,
): number {
  requireCalibrated(state);
  const world = polygon.map((point) => toWorldCoordinate(point, state));
  return polygonAreaM2(world);
}

// Recompute each element's authoritative world coordinate from its fixed anchor
// under the current calibration. Anchors are never mutated; on an uncalibrated
// state every element's world is set to null (FR-012, FR-013).
export function recomputeWorld(
  elements: SpatialElement[],
  state: CalibrationState,
): SpatialElement[] {
  if (state.status !== "calibrated") {
    return elements.map((element) => ({ ...element, world: null }));
  }
  return elements.map((element) => ({
    ...element,
    world: planToWorld(element.anchor, state.calibration),
  }));
}
