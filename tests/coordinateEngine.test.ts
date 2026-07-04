import assert from "node:assert/strict";
import test from "node:test";
import type { CalibrationState } from "@/types/floorplan";
import type { SpatialElement } from "@/types/spatialElement";
import { CalibrationError, isCalibrated, requireCalibrated } from "../domain/coordinate/gate.ts";
import {
  areaM2,
  distanceM,
  recomputeWorld,
  toPlan,
  toWorld,
} from "../domain/coordinate/coordinateEngine.ts";

const uncalibrated: CalibrationState = {
  status: "uncalibrated",
  calibration: null,
  floorplanKey: "plan-key",
};

// 50 px/m, origin top-left.
const calibrated: CalibrationState = {
  status: "calibrated",
  floorplanKey: "plan-key",
  calibration: {
    mode: "two-point",
    pxPerMeter: 50,
    manualPxPerMeter: 50,
    knownDistanceM: 4,
    calibrationPoints: [],
    metersPerPixel: 0.02,
    originPx: { x_px: 0, y_px: 0 },
  },
};

test("isCalibrated reflects state", () => {
  assert.equal(isCalibrated(uncalibrated), false);
  assert.equal(isCalibrated(calibrated), true);
});

test("requireCalibrated throws a typed CalibrationError when uncalibrated (FR-005)", () => {
  assert.throws(
    () => requireCalibrated(uncalibrated),
    (err: unknown) => err instanceof CalibrationError && err.code === "calibration_required",
  );
  assert.equal(requireCalibrated(calibrated).pxPerMeter, 50);
});

test("every spatial query is gated on an uncalibrated plan (SC-003)", () => {
  const anchor = { x_px: 100, y_px: 100 };
  assert.throws(() => toWorld(anchor, uncalibrated), CalibrationError);
  assert.throws(() => toPlan({ x: 1, y: 1, unit: "meters" }, uncalibrated), CalibrationError);
  assert.throws(() => distanceM(anchor, { x_px: 200, y_px: 100 }, uncalibrated), CalibrationError);
  assert.throws(() => areaM2([anchor, { x_px: 200, y_px: 100 }, { x_px: 200, y_px: 200 }], uncalibrated), CalibrationError);
});

test("toWorld yields authoritative meters when calibrated", () => {
  const world = toWorld({ x_px: 150, y_px: 300 }, calibrated);
  assert.deepEqual(world, { x: 3, y: 6, unit: "meters" });
});

test("distanceM matches the scaled meters within 2% (SC-002)", () => {
  // 250px apart at 50 px/m = 5m.
  const meters = distanceM({ x_px: 0, y_px: 0 }, { x_px: 150, y_px: 200 }, calibrated);
  assert.ok(Math.abs(meters - 5) / 5 < 0.02);
});

test("distanceM accepts world coordinates directly", () => {
  const meters = distanceM(
    { x: 0, y: 0, unit: "meters" },
    { x: 3, y: 4, unit: "meters" },
    calibrated,
  );
  assert.equal(meters, 5);
});

test("areaM2 computes a real-world rectangle area", () => {
  // 100px x 250px at 50 px/m = 2m x 5m = 10 m^2.
  const area = areaM2(
    [
      { x_px: 0, y_px: 0 },
      { x_px: 100, y_px: 0 },
      { x_px: 100, y_px: 250 },
      { x_px: 0, y_px: 250 },
    ],
    calibrated,
  );
  assert.ok(Math.abs(area - 10) < 1e-9);
});

test("recomputeWorld nulls world when uncalibrated and fills it when calibrated", () => {
  const elements: SpatialElement[] = [
    { anchor: { x_px: 100, y_px: 100 }, world: { x: 9, y: 9, unit: "meters" }, kind: "mesh" },
  ];
  assert.equal(recomputeWorld(elements, uncalibrated)[0].world, null);
  assert.deepEqual(recomputeWorld(elements, calibrated)[0].world, { x: 2, y: 2, unit: "meters" });
});
