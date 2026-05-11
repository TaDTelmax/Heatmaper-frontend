import type { FloorplanImage, RouterPlacement, ScaleCalibration } from "./floorplan";
import type { MeasurementPoint } from "./measurement";

export type WifiBand = "24ghz" | "5ghz";

export type HeatmapLayer = {
  band: WifiBand;
  dataUrl: string;
  width: number;
  height: number;
  minRssi: number;
  maxRssi: number;
  avgRssi: number;
};

export type HeatmapResult = {
  heatmap24: HeatmapLayer;
  heatmap5: HeatmapLayer;
  overlay24: string;
  overlay5: string;
  chart24: string;
  chart5: string;
  floorWithPoints: string;
  generatedAt: string;
  power: number;
  opacity: number;
};

export type HeatmapProject = {
  version: 1;
  floorplan: Omit<FloorplanImage, "dataUrl"> & { dataUrl?: string };
  scale: ScaleCalibration;
  ap: RouterPlacement | null;
  points: MeasurementPoint[];
  heatmap?: {
    generatedAt: string;
    power: number;
    opacity: number;
  };
};

export const bandLabels: Record<WifiBand, string> = {
  "24ghz": "2.4 GHz",
  "5ghz": "5 GHz",
};
