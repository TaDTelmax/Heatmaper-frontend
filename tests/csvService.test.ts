import assert from "node:assert/strict";
import test from "node:test";
import { parseMeasurementCsv, prepareCsvRowsForFloorplan } from "../services/csvService.ts";

test("csv parser accepts ZTE RSSI survey exports", () => {
  const csv = [
    "Timestamp,X(Lat),Y(Lon),Signal,Noise,Ch,MAC,SSID",
    "2026-01-14T13:07:31,13.1120391,10.5510940,-26,-92,36,20:3A:EB:DF:62:3D,CLARO_DF623C-5G",
    "2026-01-14T13:07:31,13.1120391,10.5169480,-79,-85,6,6E:02:B8:A0:A3:2C,Clarowifi_1024-IoT",
    "2026-01-14T13:07:31,13.1120391,10.5169480,-15,-89,6,20:3A:EB:DF:62:3C,CLARO_DF623C",
  ].join("\n");

  const result = parseMeasurementCsv(csv);

  assert.deepEqual(result.errors, []);
  assert.equal(result.hasCoordinates, true);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], {
    point_id: "P1",
    x_px: 13.1120391,
    y_px: 10.551094,
    coordinate_kind: "survey",
    rssi_24ghz: null,
    rssi_5ghz: -26,
    rssi_6ghz: null,
    distance_m: null,
    timestamp: "2026-01-14T13:07:31",
  });
  assert.equal(result.rows[1].point_id, "P2");
  assert.equal(result.rows[1].x_px, 13.1120391);
  assert.equal(result.rows[1].y_px, 10.516948);
  assert.equal(result.rows[1].coordinate_kind, "survey");
  assert.equal(result.rows[1].rssi_24ghz, -15);
  assert.equal(result.rows[1].rssi_5ghz, null);
});

test("csv survey rows are normalized and consolidated for the floorplan (uncalibrated fallback)", () => {
  const result = parseMeasurementCsv([
    "Timestamp,X(Lat),Y(Lon),Signal,Ch,SSID",
    "2026-01-14T13:07:31,13.1120391,10.5510940,-70,6,IoT",
    "2026-01-14T13:07:31,13.1120391,10.5510940,-15,6,CLARO",
    "2026-01-14T13:07:32,13.0000000,10.0000000,-30,36,CLARO-5G",
  ].join("\n"));

  const { rows, issues } = prepareCsvRowsForFloorplan(result.rows, { width: 1000, height: 500 }, 0);

  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.coordinate_kind === "pixel"), true);
  assert.equal(rows.some((row) => row.rssi_24ghz === -15), true);
  assert.equal(rows.some((row) => row.rssi_5ghz === -30), true);
  assert.equal(rows.every((row) => (row.x_px ?? -1) >= 0 && (row.x_px ?? 1001) < 1000), true);
  assert.equal(rows.every((row) => (row.y_px ?? -1) >= 0 && (row.y_px ?? 501) < 500), true);
  assert.equal(issues.some((item) => item.code === "csv_survey_uncalibrated"), true);
});

test("calibrated survey import maps meters to pixels isotropically, preserving true aspect ratio", () => {
  // Synthetic dataset shaped like the real ZTE CSV: X in ~0..24m, Y in ~0..18m
  // (aspect ratio ~1.33), plus a corrupted sentinel row (~3.66e7) that must
  // be excluded from both the reference bounding box and the output.
  const lines = ["Timestamp,X(Lat),Y(Lon),Signal,Ch,SSID"];
  const points: Array<[number, number]> = [];
  for (let index = 0; index < 40; index += 1) {
    const x = (index / 39) * 24; // 0..24
    const y = (index / 39) * 18; // 0..18
    points.push([x, y]);
    lines.push(`2026-01-14T13:07:${String(31 + (index % 28)).padStart(2, "0")},${x.toFixed(6)},${y.toFixed(6)},-50,6,CLARO`);
  }
  // Corrupted sentinel row (GPS-lock-failure style outlier), must be dropped.
  lines.push("2026-01-14T13:08:00,36600000.123456,36600000.123456,-50,6,CLARO");

  const result = parseMeasurementCsv(lines.join("\n"));
  assert.equal(result.rows.length, 41);

  const pxPerMeter = 20; // e.g. a 26.57m x 20.64m house calibrated at 20 px/m
  const { rows, issues } = prepareCsvRowsForFloorplan(result.rows, { width: 560, height: 420 }, pxPerMeter);

  // The sentinel row must not survive as a wild outlier.
  const finiteRows = rows.filter((row) => row.x_px !== null && row.x_px !== undefined && row.y_px !== null && row.y_px !== undefined);
  for (const row of finiteRows) {
    assert.ok((row.x_px as number) < 1000, `sentinel x_px leaked through: ${row.x_px}`);
    assert.ok((row.y_px as number) < 1000, `sentinel y_px leaked through: ${row.y_px}`);
  }

  // True footprint aspect ratio (24/18 = 1.333) must be preserved, i.e. the
  // pixel bounding box must NOT be independently stretched to the canvas
  // aspect ratio (560/420 = 1.333 as well here, so pick apart via spread math
  // instead): the pixel spread should equal meters spread * pxPerMeter.
  const xs = finiteRows.map((row) => row.x_px as number);
  const ys = finiteRows.map((row) => row.y_px as number);
  const xSpreadPx = Math.max(...xs) - Math.min(...xs);
  const ySpreadPx = Math.max(...ys) - Math.min(...ys);
  const expectedXSpreadPx = 24 * pxPerMeter;
  const expectedYSpreadPx = 18 * pxPerMeter;
  assert.ok(Math.abs(xSpreadPx - expectedXSpreadPx) < 5, `x spread ${xSpreadPx} != expected ${expectedXSpreadPx}`);
  assert.ok(Math.abs(ySpreadPx - expectedYSpreadPx) < 5, `y spread ${ySpreadPx} != expected ${expectedYSpreadPx}`);

  assert.equal(issues.some((item) => item.code === "csv_survey_uncalibrated"), false);
});

test("out-of-bounds warning fires when the metrically-placed survey footprint does not fit the plan", () => {
  const lines = ["Timestamp,X(Lat),Y(Lon),Signal,Ch,SSID"];
  for (let index = 0; index < 20; index += 1) {
    const x = (index / 19) * 24;
    const y = (index / 19) * 18;
    lines.push(`2026-01-14T13:07:${String(31 + (index % 28)).padStart(2, "0")},${x.toFixed(6)},${y.toFixed(6)},-50,6,CLARO`);
  }
  const result = parseMeasurementCsv(lines.join("\n"));

  // A tiny floorplan (in px) combined with a large pxPerMeter forces most of
  // the metrically-placed footprint to fall outside the canvas.
  const { issues } = prepareCsvRowsForFloorplan(result.rows, { width: 100, height: 100 }, 20);

  assert.equal(issues.some((item) => item.code === "csv_survey_out_of_bounds"), true);
});
