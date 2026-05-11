import assert from "node:assert/strict";
import test from "node:test";
import { idwInterpolate, idwWeight } from "@/domain/heatmap/idw";
import type { MeasurementPoint } from "@/types/measurement";

const basePoint: Omit<MeasurementPoint, "point_id" | "x_px" | "y_px" | "rssi_24ghz" | "rssi_5ghz"> = {
  distance_m: null,
  timestamp: "2026-05-04T00:00:00.000Z",
  source: "manual",
};

test("idw weight follows inverse distance power", () => {
  assert.equal(idwWeight(0, 2), Number.POSITIVE_INFINITY);
  assert.equal(idwWeight(2, 2), 0.25);
});

test("idw returns the measured value at the measured pixel", () => {
  const points: MeasurementPoint[] = [
    { ...basePoint, point_id: "P1", x_px: 10, y_px: 10, rssi_24ghz: -35, rssi_5ghz: -40 },
    { ...basePoint, point_id: "P2", x_px: 30, y_px: 10, rssi_24ghz: -80, rssi_5ghz: -82 },
  ];
  assert.equal(idwInterpolate(10, 10, points, "24ghz"), -35);
});

test("idw interpolates equal distance points by average RSSI", () => {
  const points: MeasurementPoint[] = [
    { ...basePoint, point_id: "P1", x_px: 0, y_px: 0, rssi_24ghz: -40, rssi_5ghz: -50 },
    { ...basePoint, point_id: "P2", x_px: 10, y_px: 0, rssi_24ghz: -80, rssi_5ghz: -70 },
  ];
  assert.equal(idwInterpolate(5, 0, points, "24ghz"), -60);
});

test("idw interpolates asymmetric distances with sum rssi over distance power", () => {
  const points: MeasurementPoint[] = [
    { ...basePoint, point_id: "P1", x_px: 0, y_px: 0, rssi_24ghz: -40, rssi_5ghz: -50 },
    { ...basePoint, point_id: "P2", x_px: 20, y_px: 0, rssi_24ghz: -80, rssi_5ghz: -70 },
  ];
  assert.equal(idwInterpolate(5, 0, points, "24ghz", 2), -44);
});
