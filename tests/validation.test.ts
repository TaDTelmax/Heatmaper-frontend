import assert from "node:assert/strict";
import test from "node:test";
import { validateMeasurementPoints, validateRssi } from "@/domain/heatmap/validation";
import type { FloorplanImage } from "@/types/floorplan";
import type { MeasurementPoint } from "@/types/measurement";

const floorplan: FloorplanImage = {
  fileName: "planta.png",
  fileSize: 1200,
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,",
  width: 100,
  height: 100,
  aspectRatio: 1,
  validation: [],
};

function point(index: number, patch: Partial<MeasurementPoint> = {}): MeasurementPoint {
  return {
    point_id: `P${index}`,
    x_px: index * 5,
    y_px: index * 5,
    rssi_24ghz: -50,
    rssi_5ghz: -55,
    distance_m: null,
    timestamp: "2026-05-04T00:00:00.000Z",
    source: "manual",
    ...patch,
  };
}

test("measurement validation requires at least one point", () => {
  const issues = validateMeasurementPoints([], floorplan);
  assert.equal(issues.some((issue) => issue.code === "points_count"), true);
});

test("measurement validation catches points outside image", () => {
  const points = Array.from({ length: 3 }, (_, index) => point(index + 1));
  points[2] = point(3, { x_px: 150 });
  const issues = validateMeasurementPoints(points, floorplan);
  assert.equal(issues.some((issue) => issue.code === "point_inside"), true);
});

test("rssi validation rejects values outside expected dBm range", () => {
  const issues = validateRssi([point(1, { rssi_24ghz: -5 })]);
  assert.equal(issues.some((issue) => issue.code === "rssi_range"), true);
});

test("rssi validation accepts sparse survey rows when required bands exist", () => {
  const issues = validateRssi([
    point(1, { rssi_24ghz: -45, rssi_5ghz: null }),
    point(2, { rssi_24ghz: null, rssi_5ghz: -50 }),
  ]);
  assert.equal(issues.some((issue) => issue.code === "rssi_required"), false);
  assert.equal(issues.some((issue) => issue.code === "rssi_band_required"), false);
});

test("measurement validation ignores duplicate scan for large imports", () => {
  const points = Array.from({ length: 1500 }, (_, index) => point(index + 1, { x_px: 10, y_px: 10 }));
  const issues = validateMeasurementPoints(points, floorplan);
  assert.equal(issues.some((issue) => issue.code === "point_duplicate_skipped"), false);
  assert.equal(issues.some((issue) => issue.code === "point_duplicate"), false);
});

test("measurement validation ignores csv duplicate markers", () => {
  const points = [
    point(1, { x_px: 10, y_px: 10, source: "csv" }),
    point(2, { x_px: 10, y_px: 10, source: "csv" }),
  ];
  const issues = validateMeasurementPoints(points, floorplan);
  assert.equal(issues.some((issue) => issue.code === "point_duplicate"), false);
});
