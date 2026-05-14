import { buildMeasurementsCsv } from "./csvService";
import type { FloorplanImage, RouterPlacement, ScaleCalibration } from "@/types/floorplan";
import type { HeatmapProject, HeatmapResult, RoomPolygon, WallSegment } from "@/types/heatmap";
import type { MeasurementPoint } from "@/types/measurement";

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
}

export function downloadTextFile(text: string, filename: string, type = "text/plain;charset=utf-8"): void {
  const blob = new Blob([text], { type });
  downloadBlob(blob, filename);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

export function buildProjectJson(
  floorplan: FloorplanImage,
  scale: ScaleCalibration,
  ap: RouterPlacement | null,
  points: MeasurementPoint[],
  result: HeatmapResult | null,
  walls: WallSegment[] = [],
  rooms: RoomPolygon[] = [],
): string {
  const project: HeatmapProject = {
    version: 1,
    floorplan: {
      fileName: floorplan.fileName,
      fileSize: floorplan.fileSize,
      mimeType: floorplan.mimeType,
      width: floorplan.width,
      height: floorplan.height,
      aspectRatio: floorplan.aspectRatio,
      validation: floorplan.validation,
    },
    scale,
    ap,
    points,
    walls,
    rooms,
    heatmap: result
      ? {
        generatedAt: result.generatedAt,
        power: result.power,
        interpolationRadiusM: result.interpolationRadiusM,
        gaussianBlurPx: result.gaussianBlurPx,
        useWallAttenuation: result.useWallAttenuation,
        opacity: result.opacity,
      }
      : undefined,
  };
  return JSON.stringify(project, null, 2);
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function createSimplePdfReport(params: {
  floorplan: FloorplanImage;
  scale: ScaleCalibration;
  ap: RouterPlacement | null;
  points: MeasurementPoint[];
  generatedAt: string;
}): Blob {
  const lines = [
    "WiFi Heatmaper - Relatorio",
    `Gerado em: ${params.generatedAt}`,
    `Planta: ${params.floorplan.fileName} (${params.floorplan.width}x${params.floorplan.height}px)`,
    `Escala: ${params.scale.pxPerMeter.toFixed(2)} px/m`,
    `AP: ${params.ap ? `${params.ap.ap_x_px.toFixed(1)}, ${params.ap.ap_y_px.toFixed(1)} px` : "nao definido"}`,
    `Pontos: ${params.points.length}`,
    "",
    "point_id | x_px | y_px | rssi_24ghz | rssi_5ghz | rssi_6ghz | distance_m",
    ...params.points.map((point) =>
      [
        point.point_id,
        point.x_px.toFixed(1),
        point.y_px.toFixed(1),
        point.rssi_24ghz ?? "",
        point.rssi_5ghz ?? "",
        point.rssi_6ghz ?? "",
        point.distance_m?.toFixed(2) ?? "",
      ].join(" | "),
    ),
  ];

  const contentLines = lines.slice(0, 42);
  const stream = [
    "BT",
    "/F1 13 Tf",
    "50 790 Td",
    ...contentLines.flatMap((line, index) => {
      const command = `(${escapePdfText(line)}) Tj`;
      return index === 0 ? [command] : ["0 -18 Td", command];
    }),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

export function exportCsv(points: MeasurementPoint[]): string {
  return buildMeasurementsCsv(points);
}
