import assert from "node:assert/strict";
import test from "node:test";
import type { Calibration } from "@/types/floorplan";
import {
  distanceWorldM,
  planToWorld,
  polygonAreaM2,
  separationPx,
  worldToPlan,
} from "../domain/coordinate/transform.ts";

// pxPerMeter 50 => metersPerPixel 0.02, origin at top-left.
const calibration: Calibration = {
  mode: "two-point",
  pxPerMeter: 50,
  manualPxPerMeter: 50,
  knownDistanceM: 4,
  calibrationPoints: [],
  metersPerPixel: 0.02,
  originPx: { x_px: 0, y_px: 0 },
};

test("planToWorld scales pixels to meters from the origin", () => {
  const world = planToWorld({ x_px: 100, y_px: 250 }, calibration);
  assert.equal(world.unit, "meters");
  assert.equal(world.x, 2);
  assert.equal(world.y, 5);
});

test("planToWorld respects a non-zero origin", () => {
  const shifted: Calibration = { ...calibration, originPx: { x_px: 50, y_px: 50 } };
  const world = planToWorld({ x_px: 100, y_px: 50 }, shifted);
  assert.equal(world.x, 1);
  assert.equal(world.y, 0);
});

test("worldToPlan is the inverse of planToWorld within 1e-6 px", () => {
  const anchor = { x_px: 137.4, y_px: 902.1 };
  const roundTrip = worldToPlan(planToWorld(anchor, calibration), calibration);
  assert.ok(Math.abs(roundTrip.x_px - anchor.x_px) < 1e-6);
  assert.ok(Math.abs(roundTrip.y_px - anchor.y_px) < 1e-6);
});

test("separationPx is Euclidean", () => {
  assert.equal(separationPx({ x_px: 0, y_px: 0 }, { x_px: 30, y_px: 40 }), 50);
});

test("distanceWorldM is Euclidean in meters", () => {
  const a = planToWorld({ x_px: 0, y_px: 0 }, calibration);
  const b = planToWorld({ x_px: 300, y_px: 400 }, calibration); // 500px / 50 = 10m
  assert.ok(Math.abs(distanceWorldM(a, b) - 10) < 1e-9);
});

test("polygonAreaM2 computes a 2m x 5m rectangle as 10 m^2", () => {
  const corners = [
    planToWorld({ x_px: 0, y_px: 0 }, calibration),
    planToWorld({ x_px: 100, y_px: 0 }, calibration),
    planToWorld({ x_px: 100, y_px: 250 }, calibration),
    planToWorld({ x_px: 0, y_px: 250 }, calibration),
  ];
  assert.ok(Math.abs(polygonAreaM2(corners) - 10) < 1e-9);
});
