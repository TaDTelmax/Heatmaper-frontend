import { rssiLegendTicks, rssiToColor } from "./colorScale";
import { defaultInterpolationRadiusM, propagationLossDb } from "./attenuation";
import { analyzeMeasurementPoints, analyzeRoomCoverage } from "./roomAnalysis";
import { clamp, segmentsIntersect, smoothstep } from "./spatial";
import type { RouterPlacement } from "@/types/floorplan";
import type { HeatmapEngineOptions, HeatmapLayer, ObstacleMap, RfEngineSettings, RfPoint, WifiBand } from "@/types/heatmap";
import type { MeasurementPoint } from "@/types/measurement";

export const DEFAULT_IDW_POWER = 2.2;
export const IDW_ZERO_DISTANCE_EPSILON = 1e-9;

type Rgb = [number, number, number];

type WeightedRssiPoint = {
  x_px: number;
  y_px: number;
  rssi: number;
};

type RfDutSource = {
  x: number;
  y: number;
  txPowerDbm: number;
  antennaGainDbi: number;
  antennaPattern: "omni" | "directional";
  antennaAzimuthDeg: number;
  channel: number;
  propagationRadiusM: number;
};

type DutPrediction = {
  rssi: number;
  wallLossDb: number;
  shadowDb: number;
  distanceM: number;
};

type DutCalibration = {
  source: RfDutSource;
  globalOffsetDb: number;
  residuals: (WeightedRssiPoint & { residualDb: number })[];
};

type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type MaskComponent = Bounds & {
  area: number;
  pixels: number[];
};

export function rssiForBand(point: MeasurementPoint, band: WifiBand): number | null {
  if (band === "24ghz") return point.rssi_24ghz;
  if (band === "5ghz") return point.rssi_5ghz;
  return point.rssi_6ghz ?? (point.rssi_5ghz === null ? null : point.rssi_5ghz - 4.5);
}

function usablePointsForBand(points: MeasurementPoint[], band: WifiBand): WeightedRssiPoint[] {
  return points
    .map((point) => {
      const rssi = rssiForBand(point, band);
      return rssi === null ? null : { x_px: point.x_px, y_px: point.y_px, rssi };
    })
    .filter((point): point is WeightedRssiPoint => point !== null);
}

const DEFAULT_COVERAGE_RSSI = -67;
const DEFAULT_WEAK_RSSI = -68;
const DEFAULT_DEAD_RSSI = -75;

type NormalizedHeatmapOptions = HeatmapEngineOptions & {
  settings: RfEngineSettings;
};

type RfInterpolationResult = {
  rssi: number;
  confidence: number;
  nearestDistanceM: number;
  wallLossDb: number;
  shadowDb: number;
};

type MeasuredSignalMask = {
  gridMask: Uint8Array;
  pixelMask: Uint8Array | null;
};

export type FloorplanRfModel = {
  houseMask: Uint8Array | null;
  obstacleMap: ObstacleMap | null;
  compartmentMap: ObstacleMap | null;
  structuralCoverage: number;
};

function normalizeOptions(
  band: WifiBand,
  width: number,
  height: number,
  powerOrOptions: number | HeatmapEngineOptions | undefined,
  legacyHouseMask: Uint8Array | null,
): NormalizedHeatmapOptions {
  const options: HeatmapEngineOptions = typeof powerOrOptions === "number" ? { power: powerOrOptions } : powerOrOptions ?? {};
  const maxDimension = Math.max(width, height);
  const pxPerMeter = Number.isFinite(options.pxPerMeter) && options.pxPerMeter && options.pxPerMeter > 0 ? options.pxPerMeter : 50;
  const settings: RfEngineSettings = {
    power: Number.isFinite(options.power) && options.power && options.power > 0 ? options.power : DEFAULT_IDW_POWER,
    interpolationRadiusM:
      Number.isFinite(options.interpolationRadiusM) && options.interpolationRadiusM && options.interpolationRadiusM > 0
        ? options.interpolationRadiusM
        : defaultInterpolationRadiusM(band),
    gaussianBlurPx:
      Number.isFinite(options.gaussianBlurPx) && options.gaussianBlurPx !== undefined
        ? clamp(options.gaussianBlurPx, 0, Math.max(42, maxDimension * 0.06))
        : clamp(maxDimension / 44, 22, 34),
    pxPerMeter,
    useWallAttenuation: options.useWallAttenuation ?? true,
    coverageThresholdRssi: options.coverageThresholdRssi ?? DEFAULT_COVERAGE_RSSI,
    weakThresholdRssi: options.weakThresholdRssi ?? DEFAULT_WEAK_RSSI,
    deadZoneThresholdRssi: options.deadZoneThresholdRssi ?? DEFAULT_DEAD_RSSI,
    diffusionStrength:
      Number.isFinite(options.diffusionStrength) && options.diffusionStrength !== undefined
        ? clamp(options.diffusionStrength, 0, 1)
        : 0.34,
    edgeFeatherPx:
      Number.isFinite(options.edgeFeatherPx) && options.edgeFeatherPx !== undefined
        ? clamp(options.edgeFeatherPx, 0, 12)
        : clamp(maxDimension / 900, 1.2, 4.5),
  };

  return {
    ...options,
    houseMask: options.houseMask ?? legacyHouseMask ?? null,
    settings,
  };
}

const dutBandProfiles: Record<
  WifiBand,
  { referenceLoss1mDb: number; pathLossExponent: number; defaultChannel: number; defaultRadiusM: number }
> = {
  "24ghz": { referenceLoss1mDb: 52, pathLossExponent: 1.82, defaultChannel: 6, defaultRadiusM: 42 },
  "5ghz": { referenceLoss1mDb: 56, pathLossExponent: 2.12, defaultChannel: 44, defaultRadiusM: 28 },
  "6ghz": { referenceLoss1mDb: 58, pathLossExponent: 2.28, defaultChannel: 5, defaultRadiusM: 22 },
};

function normalizeDutSource(ap: RouterPlacement | null | undefined, band: WifiBand, settings: RfEngineSettings): RfDutSource | null {
  if (!ap) return null;
  const profile = dutBandProfiles[band];
  return {
    x: ap.ap_x_px,
    y: ap.ap_y_px,
    txPowerDbm: clamp(ap.txPower ?? 20, 0, 30),
    antennaGainDbi: clamp(ap.antennaGainDbi ?? 3, 0, 12),
    antennaPattern: ap.antennaPattern ?? "omni",
    antennaAzimuthDeg: ap.antennaAzimuthDeg ?? 0,
    channel: ap.channel ?? profile.defaultChannel,
    propagationRadiusM: clamp(ap.propagationRadiusM ?? settings.interpolationRadiusM ?? profile.defaultRadiusM, 4, 120),
  };
}

function angularDifferenceDeg(a: number, b: number): number {
  const normalized = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return normalized;
}

function antennaPatternLossDb(source: RfDutSource, target: RfPoint): number {
  if (source.antennaPattern !== "directional") return 0;
  const angle = (Math.atan2(target.y - source.y, target.x - source.x) * 180) / Math.PI;
  const delta = angularDifferenceDeg(angle, source.antennaAzimuthDeg);
  return smoothstep(35, 165, delta) * 14;
}

function predictDutRssi(
  target: RfPoint,
  source: RfDutSource,
  band: WifiBand,
  options: NormalizedHeatmapOptions,
): DutPrediction {
  const profile = dutBandProfiles[band];
  const distanceM = Math.hypot(target.x - source.x, target.y - source.y) / Math.max(options.settings.pxPerMeter, 1);
  const logDistanceLoss = profile.referenceLoss1mDb + 10 * profile.pathLossExponent * Math.log10(Math.max(distanceM, 1));
  const loss = propagationLossDb({
    start: { x: source.x, y: source.y },
    end: target,
    band,
    pxPerMeter: options.settings.pxPerMeter,
    walls: options.walls,
    obstacleMap: options.obstacleMap,
    useWallAttenuation: options.settings.useWallAttenuation,
  });
  const radiusPenalty = smoothstep(source.propagationRadiusM * 0.82, source.propagationRadiusM * 1.35, distanceM) * 18;
  const patternPenalty = antennaPatternLossDb(source, target);
  const eirpDbm = source.txPowerDbm + source.antennaGainDbi;
  const rssi = eirpDbm - logDistanceLoss - loss.wallDb - loss.shadowDb + loss.diffractionCreditDb - radiusPenalty - patternPenalty;
  return {
    rssi: clamp(rssi, -96, -24),
    wallLossDb: loss.wallDb,
    shadowDb: loss.shadowDb,
    distanceM,
  };
}

function createDutCalibration(
  source: RfDutSource | null,
  points: WeightedRssiPoint[],
  band: WifiBand,
  options: NormalizedHeatmapOptions,
): DutCalibration | null {
  if (!source || !points.length) return null;
  const residuals = points.map((point) => {
    const prediction = predictDutRssi({ x: point.x_px, y: point.y_px }, source, band, options);
    return {
      ...point,
      residualDb: clamp(point.rssi - prediction.rssi, -32, 32),
    };
  });
  const globalOffsetDb = residuals.reduce((sum, point) => sum + point.residualDb, 0) / residuals.length;
  return {
    source,
    globalOffsetDb: clamp(globalOffsetDb, -28, 28),
    residuals,
  };
}

export function idwWeight(distancePx: number, power = DEFAULT_IDW_POWER, alphaPx = 0): number {
  if (distancePx <= IDW_ZERO_DISTANCE_EPSILON) return Number.POSITIVE_INFINITY;
  return 1 / (distancePx + Math.max(alphaPx, 0)) ** power;
}

function idwInterpolateUsable(
  x: number,
  y: number,
  points: WeightedRssiPoint[],
  power = DEFAULT_IDW_POWER,
): number {
  let weightedSum = 0;
  let weightSum = 0;
  for (const point of points) {
    const distance = Math.hypot(x - point.x_px, y - point.y_px);
    if (distance <= IDW_ZERO_DISTANCE_EPSILON) return point.rssi;
    const weight = idwWeight(distance, power);
    weightedSum += weight * point.rssi;
    weightSum += weight;
  }

  if (weightSum === 0) {
    throw new Error("A soma dos pesos IDW foi zero.");
  }
  return weightedSum / weightSum;
}

export function idwInterpolate(
  x: number,
  y: number,
  points: MeasurementPoint[],
  band: WifiBand,
  power = DEFAULT_IDW_POWER,
): number {
  const usable = usablePointsForBand(points, band);
  if (!usable.length) {
    throw new Error("IDW requer ao menos um ponto com RSSI.");
  }
  return idwInterpolateUsable(x, y, usable, power);
}

function alphaForRssi(rssi: number, confidence: number): number {
  const baseCoverage = 0.52 + smoothstep(-88, -62, rssi) * 0.12;
  return clamp(baseCoverage + confidence * 0.34, 0.42, 0.96);
}

function surveyContourRssi(rssi: number): number {
  const bandSizeDb = 5;
  const lower = Math.floor(rssi / bandSizeDb) * bandSizeDb;
  const upper = lower + bandSizeDb;
  const eased = smoothstep(lower + 0.65, upper - 0.65, rssi);
  return lower + (upper - lower) * eased;
}

function rfInterpolateUsable(
  x: number,
  y: number,
  points: WeightedRssiPoint[],
  band: WifiBand,
  options: NormalizedHeatmapOptions,
  dutCalibration: DutCalibration | null = null,
): RfInterpolationResult {
  const settings = options.settings;
  const radiusPx = settings.interpolationRadiusM * settings.pxPerMeter;
  const target = { x, y };
  const dutPrediction = dutCalibration ? predictDutRssi(target, dutCalibration.source, band, options) : null;
  let weightedSum = 0;
  let weightSum = 0;
  let weightedResidual = 0;
  let residualWeightSum = 0;
  let weightedWallLoss = 0;
  let weightedShadowLoss = 0;
  let maxFalloff = 0;
  let nearestPoint: WeightedRssiPoint | null = null;
  let nearestDistancePx = Number.POSITIVE_INFINITY;

  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    const distancePx = Math.hypot(x - point.x_px, y - point.y_px);
    if (distancePx <= IDW_ZERO_DISTANCE_EPSILON) {
      return { rssi: point.rssi, confidence: 1, nearestDistanceM: 0, wallLossDb: 0, shadowDb: 0 };
    }

    if (distancePx < nearestDistancePx) {
      nearestDistancePx = distancePx;
      nearestPoint = point;
    }

    const radiusFalloff = radiusPx > 0 ? 1 - smoothstep(radiusPx * 0.74, radiusPx, distancePx) : 1;
    if (radiusFalloff <= 0.002) continue;

    const source = { x: point.x_px, y: point.y_px };
    const loss = propagationLossDb({
      start: source,
      end: target,
      band,
      pxPerMeter: settings.pxPerMeter,
      walls: options.walls,
      obstacleMap: options.obstacleMap,
      useWallAttenuation: settings.useWallAttenuation,
    });
    const effectiveDistancePx = distancePx + loss.wallDb * settings.pxPerMeter * 0.09;
    const adaptivePower = clamp(settings.power + smoothstep(radiusPx * 0.2, radiusPx, effectiveDistancePx) * 0.36, 1.35, 4.4);
    const weight = idwWeight(Math.max(effectiveDistancePx, 0.1), adaptivePower, settings.pxPerMeter * 0.16) * radiusFalloff;
    const adjustedRssi = point.rssi - loss.totalDb * 0.34 - loss.wallDb * 0.42;
    weightedSum += adjustedRssi * weight;
    weightedWallLoss += loss.wallDb * weight;
    weightedShadowLoss += loss.shadowDb * weight;
    weightSum += weight;
    maxFalloff = Math.max(maxFalloff, radiusFalloff);

    const residual = dutCalibration?.residuals[pointIndex];
    if (dutPrediction && residual) {
      const residualWeight = idwWeight(Math.max(effectiveDistancePx, 0.1), Math.max(settings.power, 2.2), settings.pxPerMeter * 0.1) * radiusFalloff;
      weightedResidual += residual.residualDb * residualWeight;
      residualWeightSum += residualWeight;
    }
  }

  if (weightSum > 0) {
    const measurementRssi = weightedSum / weightSum;
    const calibratedDutRssi =
      dutPrediction && dutCalibration
        ? dutPrediction.rssi + (residualWeightSum > 0 ? weightedResidual / residualWeightSum : dutCalibration.globalOffsetDb)
        : null;
    const dutBlend =
      calibratedDutRssi === null
        ? 0
        : clamp(
            0.26 +
              smoothstep(radiusPx * 0.16, radiusPx * 0.96, nearestDistancePx) * 0.38 +
              smoothstep(6, 28, dutPrediction?.wallLossDb ?? 0) * 0.14,
            0.18,
            0.72,
          );
    const rssi = calibratedDutRssi === null ? measurementRssi : measurementRssi * (1 - dutBlend) + calibratedDutRssi * dutBlend;
    return {
      rssi: clamp(rssi, -96, -24),
      confidence: clamp(0.18 + maxFalloff * 0.82, 0, 1),
      nearestDistanceM: nearestDistancePx / settings.pxPerMeter,
      wallLossDb: Math.max(weightedWallLoss / weightSum, dutPrediction?.wallLossDb ?? 0),
      shadowDb: Math.max(weightedShadowLoss / weightSum, dutPrediction?.shadowDb ?? 0),
    };
  }

  if (!nearestPoint) {
    throw new Error("IDW requer ao menos um ponto com RSSI.");
  }

  if (dutPrediction && dutCalibration) {
    return {
      rssi: clamp(dutPrediction.rssi + dutCalibration.globalOffsetDb, -96, -24),
      confidence: clamp(0.12 + (1 - smoothstep(dutCalibration.source.propagationRadiusM * 0.9, dutCalibration.source.propagationRadiusM * 1.35, dutPrediction.distanceM)) * 0.34, 0.08, 0.46),
      nearestDistanceM: nearestDistancePx / settings.pxPerMeter,
      wallLossDb: dutPrediction.wallLossDb,
      shadowDb: dutPrediction.shadowDb,
    };
  }

  const source = { x: nearestPoint.x_px, y: nearestPoint.y_px };
  const loss = propagationLossDb({
    start: source,
    end: target,
    band,
    pxPerMeter: settings.pxPerMeter,
    walls: options.walls,
    obstacleMap: options.obstacleMap,
    useWallAttenuation: settings.useWallAttenuation,
  });
  const outOfRangeFade = radiusPx > 0 ? 1 - smoothstep(radiusPx, radiusPx * 1.45, nearestDistancePx) : 1;
  return {
    rssi: nearestPoint.rssi - loss.totalDb * 0.42 - loss.wallDb * 0.28,
    confidence: clamp(outOfRangeFade * 0.22, 0, 0.22),
    nearestDistanceM: nearestDistancePx / settings.pxPerMeter,
    wallLossDb: loss.wallDb,
    shadowDb: loss.shadowDb,
  };
}

function gaussianKernel(radius: number): Float32Array {
  const size = radius * 2 + 1;
  const sigma = Math.max(radius / 2.5, 0.72);
  const kernel = new Float32Array(size);
  let sum = 0;
  for (let index = 0; index < size; index += 1) {
    const offset = index - radius;
    const value = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[index] = value;
    sum += value;
  }
  for (let index = 0; index < kernel.length; index += 1) {
    kernel[index] /= sum;
  }
  return kernel;
}

function blurAxis(input: Float32Array, width: number, height: number, kernel: Float32Array, horizontal: boolean): Float32Array {
  const radius = Math.floor(kernel.length / 2);
  const output = new Float32Array(input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sampleX = horizontal ? clamp(x + k, 0, width - 1) : x;
        const sampleY = horizontal ? y : clamp(y + k, 0, height - 1);
        value += input[sampleY * width + sampleX] * kernel[k + radius];
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

function blurWeightedFieldPass(
  values: Float32Array,
  alpha: Float32Array,
  active: Uint8Array,
  width: number,
  height: number,
  radius: number,
): void {
  const numerator = new Float32Array(values.length);
  const denominator = new Float32Array(values.length);
  const originalValues = new Float32Array(values);
  for (let index = 0; index < values.length; index += 1) {
    if (!active[index]) continue;
    const weight = Math.max(alpha[index], 0.001);
    numerator[index] = values[index] * weight;
    denominator[index] = weight;
  }

  const kernel = gaussianKernel(radius);
  const blurredNumerator = blurAxis(blurAxis(numerator, width, height, kernel, true), width, height, kernel, false);
  const blurredDenominator = blurAxis(blurAxis(denominator, width, height, kernel, true), width, height, kernel, false);

  for (let index = 0; index < values.length; index += 1) {
    if (!active[index] || blurredDenominator[index] <= 0.0001) continue;
    const gx = index % width;
    const gy = Math.floor(index / width);
    const left = originalValues[gy * width + clamp(gx - 1, 0, width - 1)];
    const right = originalValues[gy * width + clamp(gx + 1, 0, width - 1)];
    const up = originalValues[clamp(gy - 1, 0, height - 1) * width + gx];
    const down = originalValues[clamp(gy + 1, 0, height - 1) * width + gx];
    const gradientDb = Math.hypot(right - left, down - up);
    const preserve = smoothstep(5.5, 16, gradientDb) * 0.42;
    values[index] = originalValues[index] * preserve + (blurredNumerator[index] / blurredDenominator[index]) * (1 - preserve);
    alpha[index] = clamp(blurredDenominator[index], 0, 1);
  }
}

function blurWeightedField(
  values: Float32Array,
  alpha: Float32Array,
  active: Uint8Array,
  width: number,
  height: number,
  radius: number,
): void {
  if (radius <= 0) return;
  blurWeightedFieldPass(values, alpha, active, width, height, radius);
  if (radius > 2) blurWeightedFieldPass(values, alpha, active, width, height, Math.max(1, Math.round(radius * 0.46)));
}

function obstacleAtGridCenter(obstacleMap: ObstacleMap | null | undefined, x: number, y: number): boolean {
  if (!obstacleMap) return false;
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= obstacleMap.width || py >= obstacleMap.height) return false;
  return obstacleMap.data[py * obstacleMap.width + px] === 1;
}

function inwardMaskAlpha(houseMask: Uint8Array, width: number, height: number, index: number, radius: number): number {
  if (houseMask[index] !== 1) return 0;
  if (radius <= 0) return 255;
  const px = index % width;
  const py = Math.floor(index / width);
  let total = 0;
  let inside = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = px + dx;
      const y = py + dy;
      total += 1;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (houseMask[y * width + x] === 1) inside += 1;
    }
  }
  return Math.round(255 * smoothstep(0.44, 0.92, inside / Math.max(total, 1)));
}

function applyHouseMask(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  houseMask: Uint8Array | null | undefined,
  edgeFeatherPx = 2,
): void {
  if (!houseMask) return;
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext("2d");
  if (!maskContext) return;
  const maskImage = maskContext.createImageData(width, height);
  const featherRadius = Math.round(edgeFeatherPx);
  for (let index = 0; index < houseMask.length; index += 1) {
    const offset = index * 4;
    maskImage.data[offset] = 255;
    maskImage.data[offset + 1] = 255;
    maskImage.data[offset + 2] = 255;
    maskImage.data[offset + 3] = inwardMaskAlpha(houseMask, width, height, index, featherRadius);
  }
  maskContext.putImageData(maskImage, 0, 0);
  context.save();
  context.globalCompositeOperation = "destination-in";
  context.drawImage(maskCanvas, 0, 0);
  context.restore();
}

function markBarrierDisk(mask: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number): void {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      mask[y * width + x] = 1;
    }
  }
}

function markBarrierLine(
  mask: Uint8Array,
  width: number,
  height: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
  radius: number,
): void {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const steps = Math.max(1, Math.ceil(length));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = Math.round(start.x + (end.x - start.x) * t);
    const y = Math.round(start.y + (end.y - start.y) * t);
    markBarrierDisk(mask, width, height, x, y, radius);
  }
}

function createCompartmentBarrierMask(
  width: number,
  height: number,
  compartmentMap: ObstacleMap | null | undefined,
  walls: NormalizedHeatmapOptions["walls"],
  pxPerMeter: number,
): Uint8Array | null {
  const hasExplicitWalls = Boolean(walls?.length);
  if (!compartmentMap && !hasExplicitWalls) return null;

  const barrier = new Uint8Array(width * height);
  let hasBarrier = false;

  if (compartmentMap?.width === width && compartmentMap.height === height) {
    for (let index = 0; index < compartmentMap.data.length; index += 1) {
      if (compartmentMap.data[index] !== 1) continue;
      barrier[index] = 1;
      hasBarrier = true;
    }
  }

  for (const wall of walls ?? []) {
    const thicknessPx = Math.max(3, Math.round(((wall.thicknessM ?? 0.12) * Math.max(pxPerMeter, 1)) / 2));
    const radius = clamp(thicknessPx, 2, 10);
    markBarrierLine(barrier, width, height, wall.start, wall.end, radius);
    hasBarrier = true;
  }

  return hasBarrier ? barrier : null;
}

function nearestSurveyPointDistancePx(x: number, y: number, points: WeightedRssiPoint[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const point of points) {
    nearest = Math.min(nearest, Math.hypot(x - point.x_px, y - point.y_px));
  }
  return nearest;
}

function nearestValidIndex(valid: Uint8Array, width: number, height: number, x: number, y: number): number {
  const px = clamp(Math.round(x), 0, width - 1);
  const py = clamp(Math.round(y), 0, height - 1);
  const direct = py * width + px;
  if (valid[direct] === 1) return direct;

  const maxRadius = Math.max(4, Math.round(Math.max(width, height) * 0.012));
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const sx = px + dx;
        const sy = py + dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const index = sy * width + sx;
        if (valid[index] !== 1) continue;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
    }
    if (bestIndex !== -1) return bestIndex;
  }

  return -1;
}

function createMeasuredCompartmentMask(
  width: number,
  height: number,
  houseMask: Uint8Array | null | undefined,
  compartmentMap: ObstacleMap | null | undefined,
  walls: NormalizedHeatmapOptions["walls"],
  pxPerMeter: number,
  points: WeightedRssiPoint[],
): Uint8Array | null {
  const barrier = createCompartmentBarrierMask(width, height, null, walls, pxPerMeter);
  void compartmentMap;
  if (!houseMask && !barrier) return null;

  const valid = new Uint8Array(width * height);
  let validPixels = 0;
  for (let index = 0; index < valid.length; index += 1) {
    if (houseMask && houseMask[index] !== 1) continue;
    if (barrier && barrier[index] === 1) continue;
    valid[index] = 1;
    validPixels += 1;
  }
  if (!validPixels) return houseMask ?? null;

  const pointSeeds = new Uint8Array(valid.length);
  let seedCount = 0;
  for (const point of points) {
    const seedIndex = nearestValidIndex(valid, width, height, point.x_px, point.y_px);
    if (seedIndex === -1 || pointSeeds[seedIndex] === 1) continue;
    pointSeeds[seedIndex] = 1;
    seedCount += 1;
  }
  if (!seedCount) return null;

  const components = connectedMaskComponents(valid, width, height, false);
  const measured = new Uint8Array(width * height);
  let measuredPixels = 0;

  for (const component of components) {
    const hasMeasurement = component.pixels.some((pixel) => pointSeeds[pixel] === 1);
    if (!hasMeasurement) continue;
    for (const pixel of component.pixels) {
      measured[pixel] = 1;
      measuredPixels += 1;
    }
  }

  if (measuredPixels <= 0) return null;

  // Dividers split rooms, but only unmeasured room areas should disappear.
  if (barrier) {
    for (let index = 0; index < barrier.length; index += 1) {
      if (barrier[index] !== 1) continue;
      if (houseMask && houseMask[index] !== 1) continue;
      measured[index] = 1;
    }
  }

  return measured;
}

function createSurveyInfluenceMask(
  width: number,
  height: number,
  baseMask: Uint8Array | null | undefined,
  points: WeightedRssiPoint[],
  walls: NormalizedHeatmapOptions["walls"],
  maxReachPx: number,
  featherPx: number,
): Uint8Array | null {
  if (!points.length || maxReachPx <= 0) return null;
  const mask = new Uint8Array(width * height);
  const solidReach = Math.max(1, maxReachPx - Math.max(featherPx, 1));
  let activePixels = 0;

  for (const point of points) {
    const minX = clamp(Math.floor(point.x_px - maxReachPx), 0, width - 1);
    const maxX = clamp(Math.ceil(point.x_px + maxReachPx), 0, width - 1);
    const minY = clamp(Math.floor(point.y_px - maxReachPx), 0, height - 1);
    const maxY = clamp(Math.ceil(point.y_px + maxReachPx), 0, height - 1);
    const wallCheckStep = Math.max(3, Math.round(Math.max(width, height) / 360));
    const wallBlockCache = new Map<number, boolean>();

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const index = y * width + x;
        if (baseMask && baseMask[index] !== 1) continue;
        const distance = Math.hypot(x - point.x_px, y - point.y_px);
        if (distance > maxReachPx) continue;
        if (walls?.length && cellLineCrossesWall(point, x, y, walls, wallCheckStep, wallBlockCache)) continue;
        const alpha = Math.round(255 * (1 - smoothstep(solidReach, maxReachPx, distance)));
        if (alpha > mask[index]) {
          if (mask[index] === 0) activePixels += 1;
          mask[index] = alpha;
        }
      }
    }
  }

  return activePixels > 0 ? mask : null;
}

function cellLineCrossesWall(
  point: WeightedRssiPoint,
  x: number,
  y: number,
  walls: NormalizedHeatmapOptions["walls"],
  step: number,
  cache: Map<number, boolean>,
): boolean {
  const cellX = Math.floor(x / step);
  const cellY = Math.floor(y / step);
  const key = cellY * 100000 + cellX;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const target = {
    x: cellX * step + step * 0.5,
    y: cellY * step + step * 0.5,
  };
  const blocked = lineCrossesWall({ x: point.x_px, y: point.y_px }, target, walls);
  cache.set(key, blocked);
  return blocked;
}

function lineCrossesWall(start: { x: number; y: number }, end: { x: number; y: number }, walls: NormalizedHeatmapOptions["walls"]): boolean {
  if (!walls?.length) return false;
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);

  for (const wall of walls) {
    const wallMinX = Math.min(wall.start.x, wall.end.x) - 2;
    const wallMaxX = Math.max(wall.start.x, wall.end.x) + 2;
    const wallMinY = Math.min(wall.start.y, wall.end.y) - 2;
    const wallMaxY = Math.max(wall.start.y, wall.end.y) + 2;
    if (wallMaxX < minX || wallMinX > maxX || wallMaxY < minY || wallMinY > maxY) continue;
    if (segmentsIntersect(start, end, wall.start, wall.end)) return true;
  }

  return false;
}

function applyAlphaMask(context: CanvasRenderingContext2D, width: number, height: number, alphaMask: Uint8Array | null | undefined): void {
  if (!alphaMask) return;
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext("2d");
  if (!maskContext) return;
  const imageData = maskContext.createImageData(width, height);
  for (let index = 0; index < alphaMask.length; index += 1) {
    const offset = index * 4;
    imageData.data[offset] = 255;
    imageData.data[offset + 1] = 255;
    imageData.data[offset + 2] = 255;
    imageData.data[offset + 3] = alphaMask[index];
  }
  maskContext.putImageData(imageData, 0, 0);
  context.save();
  context.globalCompositeOperation = "destination-in";
  context.drawImage(maskCanvas, 0, 0);
  context.restore();
}

function gridCellHasBarrier(
  barrier: Uint8Array | null,
  width: number,
  height: number,
  gridX: number,
  gridY: number,
  sampleStep: number,
): boolean {
  if (!barrier) return false;
  const startX = Math.max(0, Math.floor(gridX * sampleStep));
  const startY = Math.max(0, Math.floor(gridY * sampleStep));
  const endX = Math.min(width - 1, Math.ceil((gridX + 1) * sampleStep));
  const endY = Math.min(height - 1, Math.ceil((gridY + 1) * sampleStep));
  const xStep = Math.max(1, Math.floor((endX - startX + 1) / 3));
  const yStep = Math.max(1, Math.floor((endY - startY + 1) / 3));
  for (let y = startY; y <= endY; y += yStep) {
    for (let x = startX; x <= endX; x += xStep) {
      if (barrier[y * width + x] === 1) return true;
    }
  }
  return false;
}

function nearestPassableGridIndex(passable: Uint8Array, gridWidth: number, gridHeight: number, x: number, y: number, sampleStep: number): number {
  const gx = clamp(Math.round(x / sampleStep), 0, gridWidth - 1);
  const gy = clamp(Math.round(y / sampleStep), 0, gridHeight - 1);
  const direct = gy * gridWidth + gx;
  if (passable[direct] === 1) return direct;

  const maxRadius = Math.max(2, Math.round(Math.max(gridWidth, gridHeight) * 0.018));
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const sx = gx + dx;
        const sy = gy + dy;
        if (sx < 0 || sy < 0 || sx >= gridWidth || sy >= gridHeight) continue;
        const index = sy * gridWidth + sx;
        if (passable[index] !== 1) continue;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    }
    if (best !== -1) return best;
  }

  return -1;
}

type HeapNode = {
  index: number;
  distance: number;
};

function heapPush(heap: HeapNode[], node: HeapNode): void {
  heap.push(node);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent].distance <= node.distance) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = node;
}

function heapPop(heap: HeapNode[]): HeapNode | null {
  if (!heap.length) return null;
  const root = heap[0];
  const last = heap.pop();
  if (!last || !heap.length) return root;

  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    const child = right < heap.length && heap[right].distance < heap[left].distance ? right : left;
    if (heap[child].distance >= last.distance) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return root;
}

function rasterizeGridMaskToPixelMask(
  gridMask: Uint8Array,
  gridWidth: number,
  gridHeight: number,
  sampleStep: number,
  width: number,
  height: number,
  baseMask: Uint8Array | null | undefined,
  barrier: Uint8Array | null,
): Uint8Array | null {
  const pixelMask = new Uint8Array(width * height);
  let pixels = 0;

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      if (gridMask[gy * gridWidth + gx] !== 1) continue;
      const startX = Math.max(0, Math.floor(gx * sampleStep));
      const startY = Math.max(0, Math.floor(gy * sampleStep));
      const endX = Math.min(width - 1, Math.ceil((gx + 1) * sampleStep));
      const endY = Math.min(height - 1, Math.ceil((gy + 1) * sampleStep));
      for (let y = startY; y <= endY; y += 1) {
        for (let x = startX; x <= endX; x += 1) {
          const index = y * width + x;
          if (baseMask && baseMask[index] !== 1) continue;
          if (barrier && barrier[index] === 1) continue;
          if (pixelMask[index] !== 1) {
            pixelMask[index] = 1;
            pixels += 1;
          }
        }
      }
    }
  }

  return pixels > 0 ? pixelMask : null;
}

function createMeasuredSignalMask(params: {
  width: number;
  height: number;
  gridWidth: number;
  gridHeight: number;
  sampleStep: number;
  houseMask: Uint8Array | null | undefined;
  compartmentMap: ObstacleMap | null | undefined;
  walls: NormalizedHeatmapOptions["walls"];
  pxPerMeter: number;
  points: WeightedRssiPoint[];
  maxReachPx: number;
}): MeasuredSignalMask | null {
  const barrier = createCompartmentBarrierMask(params.width, params.height, params.compartmentMap, params.walls, params.pxPerMeter);
  const measuredCompartmentMask = createMeasuredCompartmentMask(
    params.width,
    params.height,
    params.houseMask,
    params.compartmentMap,
    params.walls,
    params.pxPerMeter,
    params.points,
  );
  const baseMask = measuredCompartmentMask ?? params.houseMask ?? null;
  const passable = new Uint8Array(params.gridWidth * params.gridHeight);
  let passableCount = 0;

  for (let gy = 0; gy < params.gridHeight; gy += 1) {
    for (let gx = 0; gx < params.gridWidth; gx += 1) {
      const x = Math.min(params.width - 1, Math.floor(gx * params.sampleStep + params.sampleStep * 0.5));
      const y = Math.min(params.height - 1, Math.floor(gy * params.sampleStep + params.sampleStep * 0.5));
      const pixelIndex = y * params.width + x;
      if (baseMask && baseMask[pixelIndex] !== 1) continue;
      if (gridCellHasBarrier(barrier, params.width, params.height, gx, gy, params.sampleStep)) continue;
      passable[gy * params.gridWidth + gx] = 1;
      passableCount += 1;
    }
  }

  if (!passableCount) return null;

  const distances = new Float32Array(passable.length);
  distances.fill(Number.POSITIVE_INFINITY);
  const heap: HeapNode[] = [];
  let seedCount = 0;

  for (const point of params.points) {
    const seed = nearestPassableGridIndex(passable, params.gridWidth, params.gridHeight, point.x_px, point.y_px, params.sampleStep);
    if (seed === -1 || distances[seed] === 0) continue;
    distances[seed] = 0;
    heapPush(heap, { index: seed, distance: 0 });
    seedCount += 1;
  }

  if (!seedCount) return null;

  const neighbors = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
  ] as const;

  while (heap.length) {
    const current = heapPop(heap);
    if (!current || current.distance !== distances[current.index]) continue;
    if (current.distance > params.maxReachPx) continue;
    const gx = current.index % params.gridWidth;
    const gy = Math.floor(current.index / params.gridWidth);

    for (const [dx, dy, costFactor] of neighbors) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= params.gridWidth || ny >= params.gridHeight) continue;
      const next = ny * params.gridWidth + nx;
      if (passable[next] !== 1) continue;
      const nextDistance = current.distance + params.sampleStep * costFactor;
      if (nextDistance > params.maxReachPx || nextDistance >= distances[next]) continue;
      distances[next] = nextDistance;
      heapPush(heap, { index: next, distance: nextDistance });
    }
  }

  const gridMask = new Uint8Array(passable.length);
  let activeCount = 0;
  for (let index = 0; index < distances.length; index += 1) {
    if (distances[index] <= params.maxReachPx) {
      gridMask[index] = 1;
      activeCount += 1;
    }
  }

  if (!activeCount) return null;
  return {
    gridMask,
    pixelMask: rasterizeGridMaskToPixelMask(
      gridMask,
      params.gridWidth,
      params.gridHeight,
      params.sampleStep,
      params.width,
      params.height,
      baseMask,
      barrier,
    ),
  };
}

export function createHeatmapLayer(
  width: number,
  height: number,
  points: MeasurementPoint[],
  band: WifiBand,
  powerOrOptions: number | HeatmapEngineOptions = DEFAULT_IDW_POWER,
  houseMask: Uint8Array | null = null,
): HeatmapLayer {
  const usable = usablePointsForBand(points, band);
  if (!usable.length) {
    throw new Error("IDW requer ao menos um ponto com RSSI.");
  }

  const maxDimension = Math.max(width, height);
  const options = normalizeOptions(band, width, height, powerOrOptions, houseMask);
  const settings = options.settings;
  const dutSource = normalizeDutSource(options.accessPoint, band, settings);
  const dutCalibration = createDutCalibration(dutSource, usable, band, options);
  const sampleStep = clamp(Math.round(maxDimension / 980), 3, 6);
  const propagationRadiusM = Math.max(settings.interpolationRadiusM, dutSource?.propagationRadiusM ?? 0);
  const surveyReachPx = Math.min(propagationRadiusM * settings.pxPerMeter, maxDimension * 0.52);
  const dutReachPx = dutSource ? Math.min(dutSource.propagationRadiusM * settings.pxPerMeter, maxDimension * 0.58) : 0;
  const gridWidth = Math.ceil(width / sampleStep);
  const gridHeight = Math.ceil(height / sampleStep);
  const gridSize = gridWidth * gridHeight;
  const values = new Float32Array(gridSize);
  const alpha = new Float32Array(gridSize);
  const shadow = new Float32Array(gridSize);
  const active = new Uint8Array(gridSize);
  const measuredMask = createMeasuredCompartmentMask(
    width,
    height,
    options.houseMask,
    options.compartmentMap,
    options.walls,
    settings.pxPerMeter,
    usable,
  );
  const signalMask = createSurveyInfluenceMask(
    width,
    height,
    measuredMask ?? options.houseMask,
    dutSource ? [...usable, { x_px: dutSource.x, y_px: dutSource.y, rssi: -35 }] : usable,
    options.walls,
    surveyReachPx,
    Math.max(sampleStep * 8, maxDimension * 0.018),
  );

  let minRssi = Number.POSITIVE_INFINITY;
  let maxRssi = Number.NEGATIVE_INFINITY;
  let total = 0;
  let count = 0;
  let covered = 0;
  let dead = 0;

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = Math.min(width - 1, gx * sampleStep + sampleStep * 0.5);
      const y = Math.min(height - 1, gy * sampleStep + sampleStep * 0.5);
      const maskIndex = Math.floor(y) * width + Math.floor(x);
      const gridIndex = gy * gridWidth + gx;
      if (measuredMask) {
        if (measuredMask[maskIndex] !== 1) continue;
      } else {
        if (options.houseMask && options.houseMask[maskIndex] !== 1) continue;
        const nearSurvey = nearestSurveyPointDistancePx(x, y, usable) <= surveyReachPx;
        const nearDut = dutSource ? Math.hypot(x - dutSource.x, y - dutSource.y) <= dutReachPx : false;
        if (!nearSurvey && !nearDut) continue;
      }

      const interpolated = rfInterpolateUsable(x, y, usable, band, options, dutCalibration);
      const obstaclePenalty = obstacleAtGridCenter(options.obstacleMap, x, y) ? 0.84 : 1;
      const shadowPenalty = clamp(interpolated.wallLossDb * 0.012 + interpolated.shadowDb * 0.03, 0, 0.3);
      values[gridIndex] = interpolated.rssi;
      alpha[gridIndex] = alphaForRssi(interpolated.rssi, interpolated.confidence) * obstaclePenalty * (1 - shadowPenalty * 0.36);
      shadow[gridIndex] = shadowPenalty;
      active[gridIndex] = 1;
    }
  }

  const blurRadius = Math.round(settings.gaussianBlurPx / sampleStep);
  blurWeightedField(values, alpha, active, gridWidth, gridHeight, blurRadius);

  for (let index = 0; index < values.length; index += 1) {
    if (!active[index] || alpha[index] <= 0.025) continue;
    const value = values[index];
    minRssi = Math.min(minRssi, value);
    maxRssi = Math.max(maxRssi, value);
    total += value;
    count += 1;
    if (value >= settings.coverageThresholdRssi) covered += 1;
    if (value <= settings.deadZoneThresholdRssi) dead += 1;
  }

  const rawCanvas = document.createElement("canvas");
  rawCanvas.width = gridWidth;
  rawCanvas.height = gridHeight;
  const rawContext = rawCanvas.getContext("2d");
  if (!rawContext) throw new Error("Canvas indisponivel para gerar heatmap.");

  const imageData = rawContext.createImageData(gridWidth, gridHeight);
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const gridIndex = gy * gridWidth + gx;
      const offset = gridIndex * 4;
      if (!active[gridIndex]) continue;

      const value = values[gridIndex];
      const coverage = alpha[gridIndex];
      if (coverage <= 0.025) continue;

      const displayRssi = value <= -85 ? value : surveyContourRssi(value);
      const [red, green, blue] = rssiToColor(displayRssi);
      const deadZoneLift = value <= settings.deadZoneThresholdRssi ? 0.08 : 0;
      const criticalLift = value <= -85 ? 0.12 : 0;
      const surveyAlpha = clamp(0.54 + coverage * 0.42 + deadZoneLift + criticalLift - shadow[gridIndex] * 0.06, 0, 0.98);

      imageData.data[offset] = red;
      imageData.data[offset + 1] = green;
      imageData.data[offset + 2] = blue;
      imageData.data[offset + 3] = Math.round(surveyAlpha * 255);
    }
  }

  rawContext.putImageData(imageData, 0, 0);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas indisponivel para gerar heatmap.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.filter = `blur(${clamp(sampleStep * 0.62, 1.2, 4.2).toFixed(1)}px) saturate(1.16) contrast(1.06)`;
  context.drawImage(rawCanvas, 0, 0, width, height);
  context.filter = "none";
  if (measuredMask) {
    applyHouseMask(context, width, height, measuredMask, Math.max(settings.edgeFeatherPx, sampleStep * 3));
  } else if (signalMask) {
    applyAlphaMask(context, width, height, signalMask);
  } else {
    applyHouseMask(context, width, height, options.houseMask, settings.edgeFeatherPx);
  }

  const analysisContext = {
    values,
    alpha,
    active,
    gridWidth,
    gridHeight,
    sampleStep,
    width,
    height,
    pxPerMeter: settings.pxPerMeter,
    obstacleMap: settings.useWallAttenuation ? options.obstacleMap : null,
    rooms: options.rooms,
    measurementPoints: points,
    band,
    thresholds: {
      coverageThresholdRssi: settings.coverageThresholdRssi,
      weakThresholdRssi: settings.weakThresholdRssi,
      deadZoneThresholdRssi: settings.deadZoneThresholdRssi,
    },
  };
  const roomAnalysis = analyzeRoomCoverage(analysisContext);
  const pointAnalysis = analyzeMeasurementPoints(analysisContext);

  return {
    band,
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
    gridWidth,
    gridHeight,
    sampleStep,
    minRssi: count ? Number(minRssi.toFixed(1)) : 0,
    maxRssi: count ? Number(maxRssi.toFixed(1)) : 0,
    avgRssi: Number((total / Math.max(count, 1)).toFixed(1)),
    coveragePercentage: Number(((covered / Math.max(count, 1)) * 100).toFixed(1)),
    deadZonePercentage: Number(((dead / Math.max(count, 1)) * 100).toFixed(1)),
    roomAnalysis,
    pointAnalysis,
    settings,
  };
}

function colorDistance(a: Rgb, b: Rgb): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function estimateEdgeBackground(data: Uint8ClampedArray, width: number, height: number): Rgb {
  const samples: Rgb[] = [];
  const pushPixel = (x: number, y: number): void => {
    const offset = (y * width + x) * 4;
    samples.push([data[offset], data[offset + 1], data[offset + 2]]);
  };

  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 80))) {
    pushPixel(x, 0);
    pushPixel(x, height - 1);
  }
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 80))) {
    pushPixel(0, y);
    pushPixel(width - 1, y);
  }

  const sum = samples.reduce<Rgb>(
    (acc, rgb) => [acc[0] + rgb[0], acc[1] + rgb[1], acc[2] + rgb[2]],
    [0, 0, 0],
  );
  return [sum[0] / samples.length, sum[1] / samples.length, sum[2] / samples.length];
}

function componentLooksLikeAnnotation(component: MaskComponent, width: number, height: number): boolean {
  const boxW = component.maxX - component.minX + 1;
  const boxH = component.maxY - component.minY + 1;
  const aspect = boxW / Math.max(1, boxH);
  const density = component.area / Math.max(1, boxW * boxH);
  const maxDimension = Math.max(width, height);
  const longAxis = Math.max(boxW, boxH);
  const shortAxis = Math.min(boxW, boxH);
  const longThin = aspect > 12 || aspect < 1 / 12;
  const dimensionLikeLine = longAxis > maxDimension * 0.08 && shortAxis <= Math.max(10, maxDimension * 0.012);
  const smallTextStroke = component.area < Math.max(120, width * height * 0.00008) && longAxis <= maxDimension * 0.12;
  const tiny = component.area < Math.max(36, width * height * 0.00004);
  return tiny || smallTextStroke || dimensionLikeLine || (longThin && density < 0.72);
}

function componentCenter(component: MaskComponent): { x: number; y: number } {
  return {
    x: (component.minX + component.maxX) / 2,
    y: (component.minY + component.maxY) / 2,
  };
}

function pointInsideBounds(point: { x: number; y: number }, bounds: Bounds): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}

function buildStructuralFootprintMask(components: MaskComponent[], width: number, height: number): Uint8Array {
  const footprint = new Uint8Array(width * height);
  if (!components.length) return footprint;

  const rowMin = new Int32Array(height);
  const rowMax = new Int32Array(height);
  const colMin = new Int32Array(width);
  const colMax = new Int32Array(width);
  rowMin.fill(width);
  rowMax.fill(-1);
  colMin.fill(height);
  colMax.fill(-1);

  for (const component of components) {
    for (const index of component.pixels) {
      const x = index % width;
      const y = Math.floor(index / width);
      rowMin[y] = Math.min(rowMin[y], x);
      rowMax[y] = Math.max(rowMax[y], x);
      colMin[x] = Math.min(colMin[x], y);
      colMax[x] = Math.max(colMax[x], y);
    }
  }

  const smoothSpans = (mins: Int32Array, maxs: Int32Array, emptyMin: number, maxGap: number): void => {
    let previous = -1;
    for (let index = 0; index < maxs.length; index += 1) {
      if (maxs[index] < 0) continue;
      if (previous >= 0) {
        const gap = index - previous;
        if (gap > 1 && gap <= maxGap) {
          for (let fill = previous + 1; fill < index; fill += 1) {
            const t = (fill - previous) / gap;
            mins[fill] = Math.round(mins[previous] + (mins[index] - mins[previous]) * t);
            maxs[fill] = Math.round(maxs[previous] + (maxs[index] - maxs[previous]) * t);
          }
        }
      }
      previous = index;
    }

    for (let index = 0; index < maxs.length; index += 1) {
      if (maxs[index] < 0) mins[index] = emptyMin;
    }
  };

  const maxGap = Math.max(6, Math.round(Math.max(width, height) * 0.012));
  smoothSpans(rowMin, rowMax, width, maxGap);
  smoothSpans(colMin, colMax, height, maxGap);

  const pad = Math.max(1, Math.round(Math.max(width, height) / 900));
  for (let y = 0; y < height; y += 1) {
    if (rowMax[y] < 0) continue;
    const minX = Math.max(0, rowMin[y] - pad);
    const maxX = Math.min(width - 1, rowMax[y] + pad);
    for (let x = minX; x <= maxX; x += 1) {
      if (colMax[x] < 0) continue;
      if (y < colMin[x] - pad || y > colMax[x] + pad) continue;
      footprint[y * width + x] = 1;
    }
  }

  return footprint;
}

function createEnclosedAreaMaskFromBarrier(barrier: Uint8Array, width: number, height: number): Uint8Array | null {
  const exterior = new Uint8Array(width * height);
  const queue: number[] = [];
  const enqueue = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (barrier[index] || exterior[index]) return;
    exterior[index] = 1;
    queue.push(index);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head];
    const x = index % width;
    const y = Math.floor(index / width);
    for (const [dx, dy] of neighbors) {
      enqueue(x + dx, y + dy);
    }
  }

  const enclosed = new Uint8Array(width * height);
  for (let index = 0; index < enclosed.length; index += 1) {
    if (!exterior[index]) enclosed[index] = 1;
  }

  const components = connectedMaskComponents(enclosed, width, height, false);
  const mask = new Uint8Array(width * height);
  const minArea = Math.max(160, Math.round(width * height * 0.0022));
  let keptPixels = 0;
  for (const component of components) {
    if (component.area < minArea) continue;
    for (const pixel of component.pixels) {
      mask[pixel] = 1;
      keptPixels += 1;
    }
  }

  const ratio = keptPixels / Math.max(width * height, 1);
  if (keptPixels < minArea || ratio < 0.035 || ratio > 0.86) return null;
  return mask;
}

function createHouseMaskFromPixels(imageData: ImageData, width: number, height: number): Uint8Array | null {
  const data = imageData.data;
  const edgeBackground = estimateEdgeBackground(data, width, height);
  const foreground = new Uint8Array(width * height);
  const foregroundPixels: number[] = [];
  const foregroundThreshold = 42;

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const rgb: Rgb = [data[offset], data[offset + 1], data[offset + 2]];
    if (data[offset + 3] <= 24 || colorDistance(rgb, edgeBackground) <= foregroundThreshold) continue;
    foreground[index] = 1;
    foregroundPixels.push(index);
  }

  if (!foregroundPixels.length) return null;

  const barrier = new Uint8Array(width * height);
  const dilation = Math.max(2, Math.round(Math.max(width, height) / 450));
  for (const index of foregroundPixels) {
    const px = index % width;
    const py = Math.floor(index / width);
    for (let dy = -dilation; dy <= dilation; dy += 1) {
      for (let dx = -dilation; dx <= dilation; dx += 1) {
        if (dx * dx + dy * dy > dilation * dilation) continue;
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        barrier[y * width + x] = 1;
      }
    }
  }

  const components: MaskComponent[] = [];
  const visited = new Uint8Array(width * height);
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  for (let seed = 0; seed < barrier.length; seed += 1) {
    if (!barrier[seed] || visited[seed]) continue;
    const component: MaskComponent = { pixels: [], area: 0, minX: width, minY: height, maxX: 0, maxY: 0 };
    const queue = [seed];
    visited[seed] = 1;

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      const x = index % width;
      const y = Math.floor(index / width);
      component.pixels.push(index);
      component.area += 1;
      component.minX = Math.min(component.minX, x);
      component.minY = Math.min(component.minY, y);
      component.maxX = Math.max(component.maxX, x);
      component.maxY = Math.max(component.maxY, y);

      for (const [dx, dy] of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!barrier[next] || visited[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    components.push(component);
  }

  components.sort((a, b) => b.area - a.area);
  const structuralCandidates = components.filter((component) => !componentLooksLikeAnnotation(component, width, height));
  const mainComponent = structuralCandidates[0] ?? components[0];
  if (!mainComponent) return null;

  const mainPad = Math.round(Math.max(width, height) * 0.01);
  const mainBox: Bounds = {
    minX: Math.max(0, mainComponent.minX - mainPad),
    minY: Math.max(0, mainComponent.minY - mainPad),
    maxX: Math.min(width - 1, mainComponent.maxX + mainPad),
    maxY: Math.min(height - 1, mainComponent.maxY + mainPad),
  };

  const maskCandidates = structuralCandidates.length ? structuralCandidates : [mainComponent];
  const structuralComponents = maskCandidates.filter((component) => {
    if (component === mainComponent) return true;
    const center = componentCenter(component);
    return component.area >= mainComponent.area * 0.018 && pointInsideBounds(center, mainBox);
  });

  const enclosedMask = createEnclosedAreaMaskFromBarrier(barrier, width, height);
  if (enclosedMask) return enclosedMask;

  const mask = buildStructuralFootprintMask(structuralComponents, width, height);
  return mask.some((value) => value === 1) ? mask : null;
}

function luminance(red: number, green: number, blue: number): number {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

function dilateBinaryMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const output = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const px = index % width;
    const py = Math.floor(index / width);
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        output[y * width + x] = 1;
      }
    }
  }
  return output;
}

function connectedMaskComponents(mask: Uint8Array, width: number, height: number, diagonal = false): MaskComponent[] {
  const components: MaskComponent[] = [];
  const visited = new Uint8Array(width * height);
  const neighbors = diagonal
    ? ([
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
      ] as const)
    : ([
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const);

  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    const component: MaskComponent = { pixels: [], area: 0, minX: width, minY: height, maxX: 0, maxY: 0 };
    const queue = [seed];
    visited[seed] = 1;

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      const x = index % width;
      const y = Math.floor(index / width);
      component.pixels.push(index);
      component.area += 1;
      component.minX = Math.min(component.minX, x);
      component.minY = Math.min(component.minY, y);
      component.maxX = Math.max(component.maxX, x);
      component.maxY = Math.max(component.maxY, y);

      for (const [dx, dy] of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!mask[next] || visited[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    components.push(component);
  }

  return components;
}

function createObstacleMaskFromPixels(
  imageData: ImageData,
  width: number,
  height: number,
  houseMask: Uint8Array | null,
): Uint8Array | null {
  const data = imageData.data;
  const edgeBackground = estimateEdgeBackground(data, width, height);
  const raw = new Uint8Array(width * height);
  const maxDimension = Math.max(width, height);

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    if (houseMask && houseMask[index] !== 1) continue;
    if (data[offset + 3] <= 24) continue;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const contrast = colorDistance([red, green, blue], edgeBackground);
    const darkLine = luminance(red, green, blue) < 0.76;
    if (contrast > 46 || darkLine) {
      raw[index] = 1;
    }
  }

  const components = connectedMaskComponents(raw, width, height, true);
  const structural = new Uint8Array(width * height);
  const minArea = Math.max(28, Math.round(width * height * 0.000006));
  const minLongAxis = Math.max(34, Math.round(maxDimension * 0.028));

  for (const component of components) {
    const boxW = component.maxX - component.minX + 1;
    const boxH = component.maxY - component.minY + 1;
    const longAxis = Math.max(boxW, boxH);
    const shortAxis = Math.min(boxW, boxH);
    const density = component.area / Math.max(1, boxW * boxH);
    const compactMarker = longAxis < Math.max(38, maxDimension * 0.026) && density > 0.28;
    const likelyText = component.area < Math.max(90, width * height * 0.000018) && shortAxis < 12;
    const dimensionLikeLine = longAxis > maxDimension * 0.08 && shortAxis <= Math.max(10, maxDimension * 0.012);
    const structuralLine = longAxis >= minLongAxis && component.area >= minArea && !dimensionLikeLine;
    const structuralBlock = component.area >= Math.max(220, width * height * 0.00008) && density > 0.04;

    if ((structuralLine || structuralBlock) && !compactMarker && !likelyText) {
      for (const pixel of component.pixels) {
        structural[pixel] = 1;
      }
    }
  }

  const dilation = Math.max(1, Math.round(maxDimension / 1100));
  const obstacle = dilateBinaryMask(structural, width, height, dilation);
  if (houseMask) {
    for (let index = 0; index < obstacle.length; index += 1) {
      if (houseMask[index] !== 1) obstacle[index] = 0;
    }
  }
  const obstaclePixels = obstacle.reduce((sum, value) => sum + value, 0);
  const ratio = obstaclePixels / Math.max(width * height, 1);
  if (obstaclePixels < Math.max(48, width * height * 0.00003) || ratio > 0.42) return null;
  return obstacle;
}

function createCompartmentDividerMaskFromPixels(
  imageData: ImageData,
  width: number,
  height: number,
  houseMask: Uint8Array | null,
): Uint8Array | null {
  const data = imageData.data;
  const edgeBackground = estimateEdgeBackground(data, width, height);
  const raw = new Uint8Array(width * height);
  const maxDimension = Math.max(width, height);

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    if (houseMask && houseMask[index] !== 1) continue;
    if (data[offset + 3] <= 24) continue;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const contrast = colorDistance([red, green, blue], edgeBackground);
    const darkLine = luminance(red, green, blue) < 0.72;
    if (contrast > 54 || darkLine) {
      raw[index] = 1;
    }
  }

  const components = connectedMaskComponents(raw, width, height, true);
  const divider = new Uint8Array(width * height);
  const minLongAxis = Math.max(72, Math.round(maxDimension * 0.075));
  const minArea = Math.max(42, Math.round(width * height * 0.00001));

  for (const component of components) {
    const boxW = component.maxX - component.minX + 1;
    const boxH = component.maxY - component.minY + 1;
    const longAxis = Math.max(boxW, boxH);
    const shortAxis = Math.min(boxW, boxH);
    const aspect = longAxis / Math.max(shortAxis, 1);
    const density = component.area / Math.max(1, boxW * boxH);
    const compactFurniture = longAxis < Math.max(110, maxDimension * 0.13) && shortAxis > Math.max(14, maxDimension * 0.018);
    const likelySymbol = density > 0.32 && longAxis < Math.max(140, maxDimension * 0.16);
    const dimensionLikeLine = longAxis > maxDimension * 0.08 && shortAxis <= Math.max(8, maxDimension * 0.01) && density < 0.2;
    const wallLikeLine = longAxis >= minLongAxis && component.area >= minArea && aspect >= 3.2 && shortAxis <= Math.max(36, maxDimension * 0.036);
    const wallLikeNetwork =
      longAxis >= Math.max(120, maxDimension * 0.12) &&
      component.area >= minArea * 2 &&
      density >= 0.015 &&
      density <= 0.28 &&
      !compactFurniture;

    if ((wallLikeLine || wallLikeNetwork) && !likelySymbol && !dimensionLikeLine) {
      for (const pixel of component.pixels) {
        divider[pixel] = 1;
      }
    }
  }

  const dilation = Math.max(1, Math.round(maxDimension / 950));
  const dividerMask = dilateBinaryMask(divider, width, height, dilation);
  if (houseMask) {
    for (let index = 0; index < dividerMask.length; index += 1) {
      if (houseMask[index] !== 1) dividerMask[index] = 0;
    }
  }

  const dividerPixels = dividerMask.reduce((sum, value) => sum + value, 0);
  const ratio = dividerPixels / Math.max(width * height, 1);
  if (dividerPixels < Math.max(80, width * height * 0.00004) || ratio > 0.24) return null;
  return dividerMask;
}

export async function createHouseMaskFromFloorplan(
  floorplanDataUrl: string,
  width: number,
  height: number,
): Promise<Uint8Array | null> {
  const image = await loadImage(floorplanDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  return createHouseMaskFromPixels(context.getImageData(0, 0, width, height), width, height);
}

export async function createFloorplanRfModel(
  floorplanDataUrl: string,
  width: number,
  height: number,
): Promise<FloorplanRfModel> {
  const image = await loadImage(floorplanDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return { houseMask: null, obstacleMap: null, compartmentMap: null, structuralCoverage: 0 };
  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const houseMask = createHouseMaskFromPixels(imageData, width, height);
  const obstacleData = createObstacleMaskFromPixels(imageData, width, height, houseMask);
  const dividerData = createCompartmentDividerMaskFromPixels(imageData, width, height, houseMask);
  const structuralCoverage = obstacleData
    ? Number(((obstacleData.reduce((sum, value) => sum + value, 0) / Math.max(width * height, 1)) * 100).toFixed(2))
    : 0;

  return {
    houseMask,
    obstacleMap: obstacleData
      ? {
          width,
          height,
          data: obstacleData,
          material: "drywall",
        }
      : null,
    compartmentMap: dividerData
      ? {
          width,
          height,
          data: dividerData,
          material: "drywall",
        }
      : null,
    structuralCoverage,
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Nao foi possivel carregar a imagem."));
    image.src = src;
  });
}

export async function renderFloorWithPoints(
  floorplanDataUrl: string,
  width: number,
  height: number,
  points: MeasurementPoint[],
  ap: RouterPlacement | null,
): Promise<string> {
  const [floor] = await Promise.all([loadImage(floorplanDataUrl)]);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas indisponivel para desenhar pontos.");
  context.drawImage(floor, 0, 0, width, height);
  drawPointOverlay(context, points, ap);
  return canvas.toDataURL("image/png");
}

export async function composeOverlay(
  floorplanDataUrl: string,
  heatmapDataUrl: string,
  width: number,
  height: number,
  points: MeasurementPoint[],
  ap: RouterPlacement | null,
  opacity: number,
): Promise<string> {
  const [floor, heatmap] = await Promise.all([loadImage(floorplanDataUrl), loadImage(heatmapDataUrl)]);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas indisponivel para montar overlay.");

  context.drawImage(floor, 0, 0, width, height);
  context.globalAlpha = opacity;
  context.drawImage(heatmap, 0, 0, width, height);
  context.globalAlpha = 1;
  drawPointOverlay(context, points, ap);
  return canvas.toDataURL("image/png");
}

export async function composeHeatmapChart(
  overlayDataUrl: string,
  width: number,
  height: number,
  title: string,
): Promise<string> {
  const overlay = await loadImage(overlayDataUrl);
  const scale = Math.max(1, Math.min(2.6, width / 620));
  const top = Math.round(42 * scale);
  const legendGap = Math.round(14 * scale);
  const legendHeight = Math.round(22 * scale);
  const labelSpace = Math.round(8 * scale);
  const bottom = Math.round(10 * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = top + height + legendGap + legendHeight + labelSpace + bottom;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas indisponivel para montar grafico do heatmap.");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111827";
  context.font = `${Math.round(18 * scale)}px Segoe UI, Arial, sans-serif`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(title, Math.round(16 * scale), Math.round(top * 0.48));
  context.drawImage(overlay, 0, top, width, height);

  const legendX = Math.round(16 * scale);
  const legendY = top + height + legendGap;
  const legendW = Math.max(1, width - legendX * 2);
  const segmentW = legendW / rssiLegendTicks.length;
  rssiLegendTicks.forEach((tick, index) => {
    const x = legendX + segmentW * index;
    const w = index === rssiLegendTicks.length - 1 ? legendX + legendW - x : Math.ceil(segmentW);
    context.fillStyle = tick.color;
    context.fillRect(x, legendY, w, legendHeight);
  });
  context.strokeStyle = "rgba(17, 24, 39, 0.16)";
  context.lineWidth = Math.max(1, Math.round(scale));
  context.strokeRect(legendX, legendY, legendW, legendHeight);

  context.font = `700 ${Math.max(7, Math.round(8 * scale))}px Segoe UI, Arial, sans-serif`;
  context.textBaseline = "middle";
  rssiLegendTicks.forEach((tick, index) => {
    const x = legendX + segmentW * index + segmentW / 2;
    context.fillStyle = tick.textColor;
    context.textAlign = "center";
    context.fillText(tick.label, x, legendY + legendHeight / 2);
  });

  return canvas.toDataURL("image/png");
}

function drawPointOverlay(
  context: CanvasRenderingContext2D,
  points: MeasurementPoint[],
  ap: RouterPlacement | null,
): void {
  if (ap) {
    drawRouterIcon(context, ap.ap_x_px, ap.ap_y_px);
  }

  for (const point of points) {
    context.save();
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#0f766e";
    context.lineWidth = 4;
    context.beginPath();
    context.arc(point.x_px, point.y_px, 12, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "#0f766e";
    context.font = "bold 14px Segoe UI, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(point.point_id.replace(/^P/i, ""), point.x_px, point.y_px);
    context.restore();
  }
}

function drawRouterIcon(context: CanvasRenderingContext2D, x: number, y: number, scale = 1): void {
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  context.lineCap = "round";
  context.lineJoin = "round";

  context.shadowColor = "rgba(15, 23, 42, .24)";
  context.shadowBlur = 3;
  context.shadowOffsetY = 1;
  context.fillStyle = "#5f7484";
  context.strokeStyle = "#3f5362";
  context.lineWidth = 1.6;
  context.beginPath();
  context.roundRect(-13, 2, 26, 9, 1.8);
  context.fill();
  context.stroke();
  context.shadowColor = "transparent";

  context.strokeStyle = "#f8fafc";
  context.lineWidth = 1.8;
  context.beginPath();
  context.moveTo(-10, 7);
  context.lineTo(5, 7);
  context.stroke();

  context.strokeStyle = "#52d1bd";
  context.beginPath();
  context.moveTo(7.5, 5.2);
  context.lineTo(11, 5.2);
  context.moveTo(7.5, 8.8);
  context.lineTo(11, 8.8);
  context.stroke();

  context.strokeStyle = "#5f7484";
  context.lineWidth = 1.6;
  context.beginPath();
  context.moveTo(0, 2);
  context.lineTo(0, -6);
  context.stroke();

  context.fillStyle = "#f8fafc";
  context.beginPath();
  context.arc(0, -7, 2.2, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.lineWidth = 2.4;
  context.strokeStyle = "#52d1bd";
  context.beginPath();
  context.arc(0, -6, 8, Math.PI * 1.18, Math.PI * 1.82);
  context.stroke();

  context.strokeStyle = "#5f7484";
  context.beginPath();
  context.arc(0, -6, 13.5, Math.PI * 1.18, Math.PI * 1.82);
  context.stroke();

  context.restore();
}
