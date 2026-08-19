import { createCanvas, Image, ImageData } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";

globalThis.document = {
  createElement(tag) {
    if (tag === "canvas") return createCanvas(300, 150);
    throw new Error(`unsupported tag ${tag}`);
  },
};
globalThis.Image = Image;
globalThis.ImageData = ImageData;

const FRONTEND = "/workspaces/Heatmaper/frontend";
const REF = "/workspaces/Heatmaper/reference";

const { parseMeasurementCsv, prepareCsvRowsForFloorplan } = await import(`${FRONTEND}/services/csvService.ts`);
const { createHeatmapLayer, composeOverlay, composeHeatmapChart, createFloorplanRfModel } = await import(`${FRONTEND}/domain/heatmap/idw.ts`);

const PX_PER_METER = 197 / 4;

async function loadImageAsync(srcBuffer) {
  const img = new Image();
  img.src = srcBuffer;
  await img.decode();
  return img;
}

const floorplanBuf = readFileSync(`${REF}/loop_floorplan_small.png`);
const floorplanImg = await loadImageAsync(floorplanBuf);
const width = floorplanImg.width;
const height = floorplanImg.height;
const floorplanDataUrl = `data:image/png;base64,${floorplanBuf.toString("base64")}`;
const rfModel = await createFloorplanRfModel(floorplanDataUrl, width, height);
console.log("roomColorCount:", rfModel.roomColorCount);

const csvText = readFileSync(`${REF}/ZTE ZXHN Z1320.csv`, "utf-8");
const parsed = parseMeasurementCsv(csvText);
const { rows: placedRows } = prepareCsvRowsForFloorplan(parsed.rows, { width, height }, PX_PER_METER);
const rotatedRows = placedRows.map((r) => ({
  ...r,
  x_px: r.x_px != null ? width - r.x_px : r.x_px,
  y_px: r.y_px != null ? height - r.y_px : r.y_px,
}));

function toMeasurementPoints(rows, band) {
  const field = band === "24ghz" ? "rssi_24ghz" : "rssi_5ghz";
  return rows
    .filter((r) => r.x_px != null && r.y_px != null && r[field] != null)
    .map((r, i) => ({
      point_id: r.point_id || `P${i}`,
      x_px: r.x_px,
      y_px: r.y_px,
      rssi_24ghz: r.rssi_24ghz ?? null,
      rssi_5ghz: r.rssi_5ghz ?? null,
      rssi_6ghz: null,
      distance_m: r.distance_m ?? null,
      timestamp: r.timestamp ?? "",
      source: "csv",
    }));
}

const bandTitles = {
  "5ghz": "Signal Level (zte 802.11ax (5 GHz) - 20:3A:EB:DF:62:3D)",
  "24ghz": "Signal Level (zte 802.11ax (2.4 GHz) - 20:3A:EB:DF:62:3C)",
};

for (const band of ["5ghz", "24ghz"]) {
  const points = toMeasurementPoints(rotatedRows, band);
  const layer = createHeatmapLayer(width, height, points, band, {
    pxPerMeter: PX_PER_METER,
    houseMask: rfModel.houseMask,
    obstacleMap: rfModel.obstacleMap,
    compartmentMap: rfModel.compartmentMap,
    roomColorMap: rfModel.roomColorMap,
    roomColorCount: rfModel.roomColorCount,
  });
  console.log(band, "coverage:", layer.coveragePercentage, "dead:", layer.deadZonePercentage);

  const overlay = await composeOverlay(floorplanDataUrl, layer.dataUrl, width, height, points, [], 0.88);
  const chart = await composeHeatmapChart(overlay, width, height, bandTitles[band]);
  writeFileSync(`${REF}/loop_${band}.png`, Buffer.from(chart.split(",")[1], "base64"));
  console.log("wrote", `loop_${band}.png`);
}
