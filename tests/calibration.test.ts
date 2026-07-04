import assert from "node:assert/strict";
import test from "node:test";
import type { CalibrationState } from "@/types/floorplan";
import type { SpatialElement } from "@/types/spatialElement";
import {
  calibrate,
  deriveCalibration,
  recalibrate,
} from "../domain/coordinate/calibration.ts";
import { recomputeWorld, distanceM } from "../domain/coordinate/coordinateEngine.ts";

function hasCode(issues: { code?: string }[], code: string): boolean {
  return issues.some((i) => i.code === code);
}

test("two-point: 4m wall over 200px derives pxPerMeter 50", () => {
  const { calibration, issues } = deriveCalibration({
    mode: "two-point",
    points: [{ x_px: 100, y_px: 100 }, { x_px: 300, y_px: 100 }],
    knownDistanceM: 4,
  });
  assert.ok(calibration);
  assert.equal(calibration?.pxPerMeter, 50);
  assert.equal(calibration?.metersPerPixel, 0.02);
  assert.equal(issues.length, 0);
});

test("manual: pxPerMeter is taken directly", () => {
  const { calibration } = deriveCalibration({ mode: "manual", pxPerMeter: 80 });
  assert.equal(calibration?.pxPerMeter, 80);
  assert.equal(calibration?.metersPerPixel, 1 / 80);
});

test("rejects non-positive known distance (FR-006)", () => {
  const { calibration, issues } = deriveCalibration({
    mode: "two-point",
    points: [{ x_px: 0, y_px: 0 }, { x_px: 200, y_px: 0 }],
    knownDistanceM: 0,
  });
  assert.equal(calibration, null);
  assert.ok(hasCode(issues, "scale_required"));
});

test("rejects coincident reference points (FR-007)", () => {
  const { calibration, issues } = deriveCalibration({
    mode: "two-point",
    points: [{ x_px: 120, y_px: 120 }, { x_px: 120, y_px: 120 }],
    knownDistanceM: 4,
  });
  assert.equal(calibration, null);
  assert.ok(hasCode(issues, "scale_two_points"));
});

test("warns but still calibrates when points are closer than 40px (FR-008)", () => {
  const { calibration, issues } = deriveCalibration({
    mode: "two-point",
    points: [{ x_px: 0, y_px: 0 }, { x_px: 20, y_px: 0 }],
    knownDistanceM: 1,
  });
  assert.ok(calibration);
  assert.ok(hasCode(issues, "scale_separation"));
});

test("re-calibration keeps element anchors fixed and rescales world coords (FR-013)", () => {
  const elements: SpatialElement[] = [
    { anchor: { x_px: 200, y_px: 0 }, world: null, kind: "router" },
    { anchor: { x_px: 400, y_px: 0 }, world: null, kind: "measurement" },
  ];

  // First calibration: 50 px/m -> 200px between elements = 4m.
  const first = calibrate("plan-key", {
    mode: "two-point",
    points: [{ x_px: 0, y_px: 0 }, { x_px: 200, y_px: 0 }],
    knownDistanceM: 4,
  }).state as CalibrationState;
  const placed = recomputeWorld(elements, first);
  assert.ok(Math.abs(distanceM(placed[0].anchor, placed[1].anchor, first) - 4) < 1e-9);

  // Re-calibrate: same 200px reference is now 2m -> 100 px/m. Same 200px gap = 2m.
  const second = recalibrate(first, {
    mode: "two-point",
    points: [{ x_px: 0, y_px: 0 }, { x_px: 200, y_px: 0 }],
    knownDistanceM: 2,
  }).state as CalibrationState;
  const rescaled = recomputeWorld(placed, second);

  // Anchors unchanged.
  assert.deepEqual(rescaled[0].anchor, elements[0].anchor);
  assert.deepEqual(rescaled[1].anchor, elements[1].anchor);
  // World distance halved.
  assert.ok(Math.abs(distanceM(rescaled[0].anchor, rescaled[1].anchor, second) - 2) < 1e-9);
});

test("reimport reproduces world coordinates exactly from anchors + calibration (FR-015/SC-005)", () => {
  const state = calibrate("plan-key", {
    mode: "two-point",
    points: [{ x_px: 10, y_px: 10 }, { x_px: 210, y_px: 10 }],
    knownDistanceM: 4,
  }).state as CalibrationState;
  const elements: SpatialElement[] = [
    { anchor: { x_px: 123.45, y_px: 678.9 }, world: null, kind: "robot" },
  ];

  // Simulate export -> reimport: serialize anchors + calibration, re-derive world.
  const serialized = JSON.stringify({ state, anchors: elements.map((e) => e.anchor) });
  const parsed = JSON.parse(serialized) as { state: CalibrationState; anchors: typeof elements[number]["anchor"][] };
  const restored = recomputeWorld(
    parsed.anchors.map((anchor) => ({ anchor, world: null, kind: "robot" as const })),
    parsed.state,
  );
  const original = recomputeWorld(elements, state);
  assert.deepEqual(restored[0].world, original[0].world);
});
