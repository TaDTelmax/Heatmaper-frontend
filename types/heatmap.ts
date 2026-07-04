import type { FloorplanImage, RouterPlacement, ScaleCalibration } from "./floorplan";
import type { MeasurementPoint } from "./measurement";

export type WifiBand = "24ghz" | "5ghz" | "6ghz";

export type RfPoint = {
  x: number;
  y: number;
};

export type WallMaterial = "drywall" | "glass" | "wood" | "brick" | "concrete" | "reinforced_concrete" | "stone" | "metal";

export type WallSegment = {
  id?: string;
  start: RfPoint;
  end: RfPoint;
  material: WallMaterial;
  thicknessM?: number;
};

export type RoomPolygon = {
  id?: string;
  name: string;
  polygon: RfPoint[];
};

export type ObstacleMap = {
  width: number;
  height: number;
  data: Uint8Array;
  material: WallMaterial;
};

export type RfEngineSettings = {
  power: number;
  interpolationRadiusM: number;
  gaussianBlurPx: number;
  pxPerMeter: number;
  useWallAttenuation: boolean;
  coverageThresholdRssi: number;
  weakThresholdRssi: number;
  deadZoneThresholdRssi: number;
  diffusionStrength: number;
  edgeFeatherPx: number;
};

export type HeatmapEngineOptions = Partial<RfEngineSettings> & {
  accessPoints?: RouterPlacement[];
  houseMask?: Uint8Array | null;
  obstacleMap?: ObstacleMap | null;
  compartmentMap?: ObstacleMap | null;
  roomColorMap?: Int32Array | null;
  roomColorCount?: number;
  walls?: WallSegment[];
  rooms?: RoomPolygon[];
};

export type RssiQualityBreakdown = {
  excellent: number;
  good: number;
  acceptable: number;
  weak: number;
  dead: number;
};

export type RoomAnalysis = {
  id: string;
  name: string;
  areaPx: number;
  areaM2: number | null;
  sampleCount: number;
  avgRssi: number;
  worstRssi: number;
  bestRssi: number;
  coveragePercentage: number;
  weakCoveragePercentage: number;
  deadZonePercentage: number;
  roamingQuality: number;
  estimatedThroughputMbps: number;
  estimatedLatencyMs: number;
  channelQuality: number;
  centroid: RfPoint;
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  quality: RssiQualityBreakdown;
};

export type HeatmapLayer = {
  band: WifiBand;
  dataUrl: string;
  width: number;
  height: number;
  gridWidth: number;
  gridHeight: number;
  sampleStep: number;
  minRssi: number;
  maxRssi: number;
  avgRssi: number;
  coveragePercentage: number;
  deadZonePercentage: number;
  roomAnalysis: RoomAnalysis[];
  pointAnalysis: RoomAnalysis[];
  settings: RfEngineSettings;
};

export type HeatmapResult = {
  heatmap24: HeatmapLayer;
  heatmap5: HeatmapLayer;
  heatmap6: HeatmapLayer;
  overlay24: string;
  overlay5: string;
  overlay6: string;
  chart24: string;
  chart5: string;
  chart6: string;
  floorWithPoints: string;
  generatedAt: string;
  power: number;
  interpolationRadiusM: number;
  gaussianBlurPx: number;
  useWallAttenuation: boolean;
  opacity: number;
};

export type HeatmapProject = {
  version: 1;
  floorplan: Omit<FloorplanImage, "dataUrl"> & { dataUrl?: string };
  scale: ScaleCalibration;
  aps: RouterPlacement[];
  points: MeasurementPoint[];
  walls?: WallSegment[];
  rooms?: RoomPolygon[];
  heatmap?: {
    generatedAt: string;
    power: number;
    interpolationRadiusM?: number;
    gaussianBlurPx?: number;
    useWallAttenuation?: boolean;
    opacity: number;
  };
};

export const bandLabels: Record<WifiBand, string> = {
  "24ghz": "2.4 GHz",
  "5ghz": "5 GHz",
  "6ghz": "6 GHz",
};
