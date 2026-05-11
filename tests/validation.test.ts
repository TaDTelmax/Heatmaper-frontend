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
  const issues = validateRssi([point(1, { rssi_24ghz: -10 })]);
  assert.equal(issues.some((issue) => issue.code === "rssi_range"), true);
});
