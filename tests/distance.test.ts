import assert from "node:assert/strict";
import test from "node:test";
import { distanceMeters, distancePx } from "@/domain/heatmap/distance";

test("pixel distance follows image coordinates", () => {
  assert.equal(distancePx({ x_px: 0, y_px: 0 }, { x_px: 3, y_px: 4 }), 5);
});

test("meter distance divides by px per meter", () => {
  assert.equal(distanceMeters({ x_px: 150, y_px: 0 }, { ap_x_px: 50, ap_y_px: 0 }, 50), 2);
});
