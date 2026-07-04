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
  aps: RouterPlacement[],
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
    aps,
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

export function exportCsv(points: MeasurementPoint[]): string {
  return buildMeasurementsCsv(points);
}
