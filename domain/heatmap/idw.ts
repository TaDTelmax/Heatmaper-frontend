import { contourBreakpointsDb, rssiLegendTicks, rssiToColor } from "./colorScale";
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

type RssiCandidate = {
  point: WeightedRssiPoint;
  pointIndex: number;
  distancePx: number;
  radiusFalloff: number;
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
const DENSE_SURVEY_POINT_COUNT = 120;
const MAX_INFLUENCE_POINTS_DENSE = 24;
const MAX_INFLUENCE_POINTS_MEDIUM = 48;
const MAX_OVERLAY_POINTS = 900;

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


export type FloorplanRfModel = {
  houseMask: Uint8Array | null;
  obstacleMap: ObstacleMap | null;
  compartmentMap: ObstacleMap | null;
  // Per-pixel room-region id (0 = not a distinct room fill — wall line, text,
  // background, or the drawing has no flat per-room colors at all). Many
  // architectural exports fill each room with its own flat pastel color —
  // far more reliable for "which room is this" than detecting wall *lines*
  // (tried and reverted: too much false-positive noise from hatching/text/
  // dimension lines on a busy real-world plan). Null when the floorplan
  // doesn't have distinguishable per-room fills (e.g. a plain B&W drawing).
  roomColorMap: Int32Array | null;
  roomColorCount: number;
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
        : clamp(maxDimension / 65, 13, 22),
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

function normalizeDutSources(aps: RouterPlacement[] | null | undefined, band: WifiBand, settings: RfEngineSettings): RfDutSource[] {
  if (!aps?.length) return [];
  const profile = dutBandProfiles[band];
  return aps.map((ap) => {
    const antennaGainDbi = clamp(ap.antennaGainDbi ?? 3, 0, 12);
    // ap.signalDbm holds the AP's real "Max Signal" spec (e.g. from a
    // TamoGraph AP Info table: -25 dBm on 5GHz, -15 dBm on 2.4GHz) — the
    // strongest RSSI ever observed close to the AP, always negative. Back out
    // the equivalent TX power from the band's reference-loss-at-1m model
    // (rssi@1m = eirp - referenceLoss1mDb) instead of using it directly as a
    // transmit power, since the two are on different scales. The previous
    // `ap.signalDbm > 0` check silently discarded every realistic (negative)
    // Max Signal value and always fell back to a generic 20 dBm default.
    const txPowerDbm =
      ap.signalDbm !== undefined && ap.signalDbm < 0
        ? clamp(ap.signalDbm + profile.referenceLoss1mDb - antennaGainDbi, 0, 30)
        : 20;
    return {
      x: ap.ap_x_px,
      y: ap.ap_y_px,
      txPowerDbm,
      antennaGainDbi,
      antennaPattern: ap.antennaPattern ?? "omni",
      antennaAzimuthDeg: ap.antennaAzimuthDeg ?? 0,
      channel: ap.channel ?? profile.defaultChannel,
      propagationRadiusM: clamp(ap.propagationRadiusM ?? settings.interpolationRadiusM ?? profile.defaultRadiusM, 4, 120),
    };
  });
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

function influencePointLimit(pointCount: number): number {
  if (pointCount > DENSE_SURVEY_POINT_COUNT) return MAX_INFLUENCE_POINTS_DENSE;
  if (pointCount > 64) return MAX_INFLUENCE_POINTS_MEDIUM;
  return pointCount;
}

function recommendedSampleStep(width: number, height: number, pointCount: number): number {
  const maxDimension = Math.max(width, height);
  const baseStep = clamp(Math.round(maxDimension / 980), 3, 6);
  const targetGridCells = pointCount > DENSE_SURVEY_POINT_COUNT ? 26000 : pointCount > 64 ? 62000 : 90000;
  const adaptiveStep = Math.ceil(Math.sqrt(Math.max(width * height, 1) / targetGridCells));
  return clamp(Math.max(baseStep, adaptiveStep), 3, pointCount > DENSE_SURVEY_POINT_COUNT ? 14 : 10);
}

function selectRssiCandidates(
  x: number,
  y: number,
  points: WeightedRssiPoint[],
  radiusPx: number,
  limit: number,
): { candidates: RssiCandidate[]; nearestPoint: WeightedRssiPoint | null; nearestDistancePx: number; exact?: WeightedRssiPoint } {
  const candidates: RssiCandidate[] = [];
  let nearestPoint: WeightedRssiPoint | null = null;
  let nearestDistancePx = Number.POSITIVE_INFINITY;
  let farthestCandidateIndex = -1;
  let farthestCandidateDistance = Number.NEGATIVE_INFINITY;

  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    const distancePx = Math.hypot(x - point.x_px, y - point.y_px);
    if (distancePx <= IDW_ZERO_DISTANCE_EPSILON) {
      return { candidates: [], nearestPoint: point, nearestDistancePx: 0, exact: point };
    }

    if (distancePx < nearestDistancePx) {
      nearestDistancePx = distancePx;
      nearestPoint = point;
    }

    const radiusFalloff = radiusPx > 0 ? 1 - smoothstep(radiusPx * 0.74, radiusPx, distancePx) : 1;
    if (radiusFalloff <= 0.002) continue;

    if (candidates.length < limit) {
      candidates.push({ point, pointIndex, distancePx, radiusFalloff });
      if (distancePx > farthestCandidateDistance) {
        farthestCandidateDistance = distancePx;
        farthestCandidateIndex = candidates.length - 1;
      }
      continue;
    }

    if (distancePx >= farthestCandidateDistance) continue;
    candidates[farthestCandidateIndex] = { point, pointIndex, distancePx, radiusFalloff };
    farthestCandidateIndex = 0;
    farthestCandidateDistance = candidates[0]?.distancePx ?? Number.NEGATIVE_INFINITY;
    for (let candidateIndex = 1; candidateIndex < candidates.length; candidateIndex += 1) {
      if (candidates[candidateIndex].distancePx > farthestCandidateDistance) {
        farthestCandidateDistance = candidates[candidateIndex].distancePx;
        farthestCandidateIndex = candidateIndex;
      }
    }
  }

  return { candidates, nearestPoint, nearestDistancePx };
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
  const signalLift = smoothstep(-84, -52, rssi) * 0.06;
  return clamp(0.66 + confidence * 0.26 + signalLift, 0.62, 0.96);
}

// Matches TamoGraph Site Survey's 11 equal-width contour bands over
// [-80, -20] dBm (see colorScale.ts contourBreakpointsDb) instead of a plain
// uniform 5dB scale, so band edges land on the same dBm values as the
// reference reports. Below/above the legend range there's no further
// subdivision (open-ended "<= -80" / ">= -20" buckets), matching the report.
const CONTOUR_BAND_DB = contourBreakpointsDb[1] - contourBreakpointsDb[0];

function surveyContourRssi(rssi: number): number {
  const first = contourBreakpointsDb[0];
  const last = contourBreakpointsDb[contourBreakpointsDb.length - 1];
  if (rssi <= first) return first;
  if (rssi >= last) return last;
  const lower = first + Math.floor((rssi - first) / CONTOUR_BAND_DB) * CONTOUR_BAND_DB;
  const upper = lower + CONTOUR_BAND_DB;
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
  const { candidates, nearestPoint, nearestDistancePx, exact } = selectRssiCandidates(
    x,
    y,
    points,
    radiusPx,
    influencePointLimit(points.length),
  );
  if (exact) {
    return { rssi: exact.rssi, confidence: 1, nearestDistanceM: 0, wallLossDb: 0, shadowDb: 0 };
  }

  for (const candidate of candidates) {
    const point = candidate.point;
    const distancePx = candidate.distancePx;
    const radiusFalloff = candidate.radiusFalloff;
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

    const residual = dutCalibration?.residuals[candidate.pointIndex];
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
    const preserve = smoothstep(3.5, 12, gradientDb) * 0.78;
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

// Convex hull of a point set via Jarvis march (gift wrapping).
// Returns vertices in CCW order; returns the input array for fewer than 3 points.
function computeConvexHull(
  pts: readonly { x_px: number; y_px: number }[],
): { x_px: number; y_px: number }[] {
  if (pts.length < 3) return [...pts];
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x_px < pts[s].x_px || (pts[i].x_px === pts[s].x_px && pts[i].y_px < pts[s].y_px)) s = i;
  }
  const hull: { x_px: number; y_px: number }[] = [];
  let cur = s;
  do {
    hull.push(pts[cur]);
    let nxt = (cur + 1) % pts.length;
    for (let i = 0; i < pts.length; i++) {
      const cross =
        (pts[nxt].x_px - pts[cur].x_px) * (pts[i].y_px - pts[cur].y_px) -
        (pts[nxt].y_px - pts[cur].y_px) * (pts[i].x_px - pts[cur].x_px);
      const collinearFarther =
        cross === 0 &&
        Math.hypot(pts[i].x_px - pts[cur].x_px, pts[i].y_px - pts[cur].y_px) >
          Math.hypot(pts[nxt].x_px - pts[cur].x_px, pts[nxt].y_px - pts[cur].y_px);
      if (cross < 0 || collinearFarther) nxt = i;
    }
    cur = nxt;
  } while (cur !== s && hull.length <= pts.length + 1);
  return hull;
}

// Binary mask (1 = inside, 0 = outside) for the convex hull of pts expanded
// outward by marginPx. Returns null when fewer than 3 unique positions exist.
function createConvexHullMask(
  width: number,
  height: number,
  pts: readonly { x_px: number; y_px: number }[],
  marginPx: number,
): Uint8Array | null {
  if (pts.length < 3) return null;
  const hull = computeConvexHull(pts);
  if (hull.length < 3) return null;

  // Expand each vertex outward from centroid by marginPx
  const cx = hull.reduce((s, p) => s + p.x_px, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y_px, 0) / hull.length;
  const expanded = hull.map((p) => {
    const dx = p.x_px - cx;
    const dy = p.y_px - cy;
    const d = Math.hypot(dx, dy);
    if (d < 1) return { x_px: p.x_px, y_px: p.y_px };
    const f = 1 + marginPx / d;
    return { x_px: cx + dx * f, y_px: cy + dy * f };
  });

  // Scanline fill for the polygon
  const mask = new Uint8Array(width * height);
  const n = expanded.length;
  for (let y = 0; y < height; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const p1 = expanded[i];
      const p2 = expanded[(i + 1) % n];
      if ((p1.y_px <= y && p2.y_px > y) || (p2.y_px <= y && p1.y_px > y)) {
        xs.push(p1.x_px + ((y - p1.y_px) / (p2.y_px - p1.y_px)) * (p2.x_px - p1.x_px));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.floor(xs[i]));
      const x1 = Math.min(width - 1, Math.ceil(xs[i + 1]));
      for (let x = x0; x <= x1; x++) mask[y * width + x] = 1;
    }
  }
  return mask;
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
  // Auto-detected internal wall/divider lines (compartmentMap, from pixel
  // analysis of the floorplan image — see createFloorplanRfModel) split rooms
  // apart on their own, without requiring any manual wall-drawing. Explicit
  // `walls` (if the user drew any) are layered on top as an extra barrier.
  const barrier = createCompartmentBarrierMask(width, height, compartmentMap, walls, pxPerMeter);
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

// Coverage mask for dense surveys (hundreds of points): the per-point loop in
// createSurveyInfluenceMask is O(points × reach-box-area), which is fine for
// a handful of manually-placed points but explodes for a dense CSV import at
// a wide propagation radius. Instead, bin points onto a coarse grid (cheap:
// O(points)) and dilate that grid by the reach distance (cheap: O(grid
// cells)), then rasterize back to full resolution. Reach is capped small
// (a few meters) so this hugs the actual walked path/rooms — the goal is
// "holes where nothing was measured", not "fill the whole convex hull".
// Fills each color-fill room region entirely once it has a nearby measurement
// — "if there's a point in the bedroom/kitchen, color the whole room" — while
// never bleeding into a neighboring room's region (each is a separate
// connected component by construction in createColorRoomRegions). Pixels
// outside any distinct region (walls, corridors, symbols/text drawn over a
// fill) default to included, so they don't punch thin gaps through an
// otherwise fully-covered room.
function createColorRoomMeasuredMask(
  width: number,
  height: number,
  houseMask: Uint8Array | null | undefined,
  roomColorMap: Int32Array | null | undefined,
  roomColorCount: number,
  points: readonly { x_px: number; y_px: number }[],
): Uint8Array | null {
  if (!roomColorMap || roomColorCount <= 0 || !points.length) return null;

  const measuredRegion = new Uint8Array(roomColorCount + 1);
  for (const point of points) {
    const px = clamp(Math.round(point.x_px), 0, width - 1);
    const py = clamp(Math.round(point.y_px), 0, height - 1);
    const region = roomColorMap[py * width + px];
    if (region > 0) {
      measuredRegion[region] = 1;
      continue;
    }
    // Point landed on a wall/corridor/symbol pixel (region 0) — check its
    // immediate neighborhood for the actual room region it's sitting in.
    for (let dy = -3; dy <= 3 && measuredRegion[region] !== 1; dy += 1) {
      for (let dx = -3; dx <= 3; dx += 1) {
        const x = clamp(px + dx, 0, width - 1);
        const y = clamp(py + dy, 0, height - 1);
        const nearby = roomColorMap[y * width + x];
        if (nearby > 0) measuredRegion[nearby] = 1;
      }
    }
  }
  if (!measuredRegion.some((value) => value === 1)) return null;

  const mask = new Uint8Array(width * height);
  let anyMeasured = false;
  for (let index = 0; index < mask.length; index += 1) {
    if (houseMask && houseMask[index] !== 1) continue;
    const region = roomColorMap[index];
    if (region === 0 || measuredRegion[region] === 1) {
      mask[index] = 1;
      anyMeasured = true;
    }
  }
  return anyMeasured ? mask : null;
}

function createDenseSurveyCoverageMask(
  width: number,
  height: number,
  points: readonly { x_px: number; y_px: number }[],
  reachPx: number,
): Uint8Array | null {
  if (!points.length || reachPx <= 0) return null;

  const cellSize = Math.max(2, Math.round(reachPx / 3));
  const gw = Math.max(1, Math.ceil(width / cellSize));
  const gh = Math.max(1, Math.ceil(height / cellSize));
  const occupied = new Uint8Array(gw * gh);
  for (const point of points) {
    const gx = clamp(Math.floor(point.x_px / cellSize), 0, gw - 1);
    const gy = clamp(Math.floor(point.y_px / cellSize), 0, gh - 1);
    occupied[gy * gw + gx] = 1;
  }

  const reachCells = Math.max(1, Math.ceil(reachPx / cellSize));
  const dilated = new Uint8Array(gw * gh);
  let anyDilated = false;
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      if (occupied[gy * gw + gx] !== 1) continue;
      const x0 = Math.max(0, gx - reachCells);
      const x1 = Math.min(gw - 1, gx + reachCells);
      const y0 = Math.max(0, gy - reachCells);
      const y1 = Math.min(gh - 1, gy + reachCells);
      for (let dy = y0; dy <= y1; dy += 1) {
        for (let dx = x0; dx <= x1; dx += 1) {
          if ((dx - gx) ** 2 + (dy - gy) ** 2 > reachCells * reachCells) continue;
          dilated[dy * gw + dx] = 1;
          anyDilated = true;
        }
      }
    }
  }
  if (!anyDilated) return null;

  const raw = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(gh - 1, Math.floor(y / cellSize));
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(gw - 1, Math.floor(x / cellSize));
      raw[y * width + x] = dilated[gy * gw + gx] ? 255 : 0;
    }
  }

  // The grid rasterization above is inherently blocky (square cells). Blur it
  // so each point's influence reads as a rounded blob instead of a staircase
  // of squares — this also gives a naturally soft edge, matching the feather
  // style used by the other masks in this file.
  const blurRadius = Math.max(2, Math.round(cellSize * 0.9));
  const kernel = gaussianKernel(blurRadius);
  const blurred = blurAxis(blurAxis(raw, width, height, kernel, true), width, height, kernel, false);

  const mask = new Uint8Array(width * height);
  for (let index = 0; index < blurred.length; index += 1) {
    mask[index] = clamp(Math.round(blurred[index]), 0, 255);
  }
  return mask;
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
  const dutSources = normalizeDutSources(options.accessPoints, band, settings);
  const primaryDutSource = dutSources[0] ?? null;
  const dutCalibration = createDutCalibration(primaryDutSource, usable, band, options);
  const denseSurvey = usable.length > DENSE_SURVEY_POINT_COUNT;
  const sampleStep = recommendedSampleStep(width, height, usable.length);
  const maxDutRadiusM = dutSources.reduce((m, d) => Math.max(m, d.propagationRadiusM), 0);
  const propagationRadiusM = Math.max(settings.interpolationRadiusM, maxDutRadiusM);
  const surveyReachPx = Math.min(propagationRadiusM * settings.pxPerMeter, maxDimension * 0.52);
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
  // Prefer color-fill room segmentation over the wall/compartment-based mask
  // when the floorplan has distinguishable per-room colors: it reliably
  // fills a whole measured room without leaking into its neighbor, which the
  // wall-based mask can't do once room-splitting collapses to one big blob
  // (the common case, since reliable automatic wall-line detection isn't
  // available — see idw.ts history/notes on this).
  const colorRoomMask = createColorRoomMeasuredMask(
    width,
    height,
    options.houseMask,
    options.roomColorMap,
    options.roomColorCount ?? 0,
    usable,
  );
  const effectiveMeasuredMask = colorRoomMask ?? measuredMask;
  const signalMask = denseSurvey
    ? createDenseSurveyCoverageMask(
        width,
        height,
        usable,
        // Capped small: a dense survey's own point spacing already traces the
        // walked path/rooms — a wide radius here would defeat the point and
        // fall back to "fill everything", same as no mask at all.
        Math.min(surveyReachPx, maxDimension * 0.05, 5 * settings.pxPerMeter),
      )
    : createSurveyInfluenceMask(
        width,
        height,
        effectiveMeasuredMask ?? options.houseMask,
        dutSources.length ? [...usable, ...dutSources.map((d) => ({ x_px: d.x, y_px: d.y, rssi: -35 }))] : usable,
        options.walls,
        surveyReachPx,
        Math.max(sampleStep * 8, maxDimension * 0.018),
      );

  // Hull mask clips the heatmap to the convex polygon of the measurement points.
  // This ensures no heatmap is shown outside the instrumented area, regardless
  // of the RF radius setting.
  const hullMarginPx = Math.max(sampleStep * 3, 20);
  const hullMask = createConvexHullMask(width, height, usable, hullMarginPx);

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
      if (hullMask && hullMask[maskIndex] !== 1) continue;
      if (effectiveMeasuredMask) {
        if (effectiveMeasuredMask[maskIndex] !== 1) continue;
      } else {
        if (options.houseMask && options.houseMask[maskIndex] !== 1) continue;
        const nearSurvey = denseSurvey || nearestSurveyPointDistancePx(x, y, usable) <= surveyReachPx;
        const nearDut = dutSources.some((d) => Math.hypot(x - d.x, y - d.y) <= Math.min(d.propagationRadiusM * settings.pxPerMeter, maxDimension * 0.58));
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

      const displayRssi = surveyContourRssi(value);
      const [red, green, blue] = rssiToColor(displayRssi);
      const deadZoneLift = value <= settings.deadZoneThresholdRssi ? 0.06 : 0;
      const criticalLift = value <= -82 ? 0.08 : 0;
      const surveyAlpha = clamp(0.74 + coverage * 0.22 + deadZoneLift + criticalLift - shadow[gridIndex] * 0.04, 0, 0.98);

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
  context.filter = `blur(${clamp(sampleStep * 0.55, 1.2, 6).toFixed(1)}px) saturate(1.22) contrast(1.02)`;
  context.drawImage(rawCanvas, 0, 0, width, height);
  context.filter = "none";
  // Each mask below further restricts (intersects, via destination-in
  // compositing) whatever the previous one already allowed — never mutually
  // exclusive. A single-blob measuredMask (room-splitting failed to detect
  // real walls) would otherwise let signalMask's "only near an actual
  // measurement" restriction get silently skipped, undoing the point of
  // having it: any area with no nearby survey/DUT point must stay blank.
  // Feather kept tight (small multiplier) so room/hull boundaries read as a
  // clear map edge — like a wall blocking signal — rather than a soft fade
  // that blends adjacent rooms into one diffuse blob.
  if (effectiveMeasuredMask) {
    applyHouseMask(context, width, height, effectiveMeasuredMask, Math.max(settings.edgeFeatherPx, sampleStep * 1.4));
  } else {
    applyHouseMask(context, width, height, options.houseMask, settings.edgeFeatherPx);
  }
  // signalMask's point-proximity radius is only needed as a safety net for
  // the *undifferentiated* fallback masks (measuredMask's single blob, or no
  // mask at all) — colorRoomMask already fills a whole measured room exactly
  // once it has any point in it, without leaking into unmeasured neighbors,
  // so re-applying a small fixed-radius cut on top of it would re-introduce
  // the same "gap in a room that does have a point" bug colorRoomMask exists
  // to fix (reported directly: a room/corridor with any measurement should
  // be filled to its own far walls, not just a blob around the exact point).
  if (signalMask && !colorRoomMask) {
    applyAlphaMask(context, width, height, signalMask);
  }
  if (hullMask) {
    // Unlike effectiveMeasuredMask (which follows real walls — a crisp edge
    // there reads correctly, "signal stops at the wall"), the hull is a
    // straight-edged polygon connecting the outermost measured points: it
    // has no physical boundary to be crisp *against*, so a tight feather
    // just makes an arbitrary straight line look like a hard, artificial cut
    // instead of the coverage naturally tapering off past the last reading.
    applyHouseMask(context, width, height, hullMask, Math.max(settings.edgeFeatherPx, sampleStep * 4.5));
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

// Segments the floorplan into per-room regions using flat fill color rather
// than wall lines. Many architectural exports color each room a distinct
// pastel (yellow living room, green garage, pink bathroom, ...) — a much
// cleaner signal than edge/line detection, which drowns in hatching, text
// and dimension lines on a real, busy plan (confirmed the hard way this
// session). Pixels near-white (background) or near-black/gray (wall lines,
// text, dimension marks) are excluded from every region; a 4-connected
// flood fill then groups same-quantized-color neighbors into one room each.
// Returns null when fewer than a couple of large-enough regions are found
// (the drawing has no flat per-room colors — e.g. after "Gerar Planta P&B"),
// so callers can fall back to the existing behavior.
// Windowed median over a single interleaved-RGBA channel, used only to
// decide room-fill buckets (see createColorRoomRegions). Many real floor
// plans draw a thin reference grid or material hatch *inside* an otherwise
// flat room fill; at native resolution those lines quantize to a different
// bucket than the fill around them and break the 4-connected flood fill
// into disconnected slivers, so only whichever sliver a measurement point
// happens to land in gets marked "measured" — the rest of the same visual
// room stays blank.
//
// A box blur (tried first) averages the line's color into its neighbors,
// which either isn't enough to cross back into the fill's bucket (thin
// radius) or, widened enough to work, drags an otherwise-legitimate pale
// room fill across the near-white cutoff and blanks the whole room instead.
// A median doesn't have that failure mode: a thin line is a small minority
// in any window that's mostly the surrounding fill, so the median is just
// the fill's own value, completely unaffected by the line — while a real
// boundary between two differently-colored rooms (occupying roughly half
// the window on each side) still resolves to one side's actual color, never
// an invented blend that could accidentally match neither region's bucket.
function medianBlurChannel(data: Uint8ClampedArray, width: number, height: number, channel: number, radius: number): Uint8ClampedArray {
  const result = new Uint8ClampedArray(width * height);
  const windowSide = radius * 2 + 1;
  const buffer = new Uint8ClampedArray(windowSide * windowSide);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sy = clamp(y + dy, 0, height - 1);
        const rowBase = sy * width;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = clamp(x + dx, 0, width - 1);
          buffer[count] = data[(rowBase + sx) * 4 + channel];
          count += 1;
        }
      }
      // Insertion sort: fast enough for a small fixed window (e.g. 25 elements).
      for (let i = 1; i < count; i += 1) {
        const value = buffer[i];
        let j = i - 1;
        while (j >= 0 && buffer[j] > value) {
          buffer[j + 1] = buffer[j];
          j -= 1;
        }
        buffer[j + 1] = value;
      }
      result[y * width + x] = buffer[count >> 1];
    }
  }
  return result;
}

function createColorRoomRegions(
  imageData: ImageData,
  width: number,
  height: number,
  houseMask: Uint8Array | null,
): { map: Int32Array; count: number } | null {
  const data = imageData.data;
  const QUANT = 20; // bucket width per channel — absorbs anti-aliasing noise
  const NEAR_WHITE = 232;
  const NEAR_DARK = 70;
  const MIN_CHROMA = 10; // below this, treat as grayscale (wall/background), not a room fill
  const HATCH_BLUR_RADIUS = 2;

  const blurredR = medianBlurChannel(data, width, height, 0, HATCH_BLUR_RADIUS);
  const blurredG = medianBlurChannel(data, width, height, 1, HATCH_BLUR_RADIUS);
  const blurredB = medianBlurChannel(data, width, height, 2, HATCH_BLUR_RADIUS);

  const bucket = new Int32Array(width * height).fill(-1); // -1 = not a candidate room-fill pixel
  for (let index = 0; index < width * height; index += 1) {
    if (houseMask && houseMask[index] !== 1) continue;
    const offset = index * 4;
    if (data[offset + 3] <= 24) continue;
    const r = blurredR[index];
    const g = blurredG[index];
    const b = blurredB[index];
    if (r >= NEAR_WHITE && g >= NEAR_WHITE && b >= NEAR_WHITE) continue;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    if (maxC <= NEAR_DARK) continue;
    if (maxC - minC < MIN_CHROMA) continue;
    const qr = Math.round(r / QUANT);
    const qg = Math.round(g / QUANT);
    const qb = Math.round(b / QUANT);
    bucket[index] = (qr << 16) | (qg << 8) | qb;
  }

  const map = new Int32Array(width * height);
  const visited = new Uint8Array(width * height);
  const minArea = Math.max(120, Math.round(width * height * 0.0012));
  let regionCount = 0;
  const queue: number[] = [];

  for (let seed = 0; seed < bucket.length; seed += 1) {
    if (bucket[seed] < 0 || visited[seed]) continue;
    const seedBucket = bucket[seed];
    queue.length = 0;
    queue.push(seed);
    visited[seed] = 1;
    const pixels: number[] = [];

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      pixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      if (x > 0 && bucket[index - 1] === seedBucket && !visited[index - 1]) { visited[index - 1] = 1; queue.push(index - 1); }
      if (x < width - 1 && bucket[index + 1] === seedBucket && !visited[index + 1]) { visited[index + 1] = 1; queue.push(index + 1); }
      if (y > 0 && bucket[index - width] === seedBucket && !visited[index - width]) { visited[index - width] = 1; queue.push(index - width); }
      if (y < height - 1 && bucket[index + width] === seedBucket && !visited[index + width]) { visited[index + width] = 1; queue.push(index + width); }
    }

    if (pixels.length < minArea) continue;
    regionCount += 1;
    for (const index of pixels) map[index] = regionCount;
  }

  if (regionCount > 0) fillEnclosedRoomHoles(map, houseMask, width, height);

  return regionCount > 0 ? { map, count: regionCount } : null;
}

// Absorbs small pockets of unclassified pixels (icon/symbol boxes, text
// labels — anything with a near-white or low-chroma background, so it never
// got a color bucket at all) into whichever single room region fully
// encloses them. A room-color region already lets unclassified pixels
// through unconditionally (see createColorRoomMeasuredMask), but leaving them
// unabsorbed still means those exact icon-shaped pixels render as blank
// holes over the heatmap when the underlying grid sample lands right on one
// (the base floorplan behind shows through as a near-white patch instead of
// the surrounding room's color). Holes that touch the image/house-mask
// border, or border more than one distinct region, are left alone — either
// they're not really "enclosed", or they straddle a real room boundary and
// absorbing them would incorrectly merge two different rooms.
function fillEnclosedRoomHoles(map: Int32Array, houseMask: Uint8Array | null | undefined, width: number, height: number): void {
  const HOLE_MAX_AREA = Math.max(2000, Math.round(width * height * 0.004));
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];

  for (let seed = 0; seed < map.length; seed += 1) {
    if (map[seed] !== 0 || visited[seed] || (houseMask && houseMask[seed] !== 1)) continue;
    stack.length = 0;
    stack.push(seed);
    visited[seed] = 1;
    const holePixels: number[] = [];
    const borderRegions = new Set<number>();
    let touchesOutside = false;

    while (stack.length) {
      const index = stack.pop() as number;
      holePixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) touchesOutside = true;

      const neighbors = [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1];
      for (let n = 0; n < neighbors.length; n += 1) {
        const next = neighbors[n];
        if (next < 0) { touchesOutside = true; continue; }
        if (houseMask && houseMask[next] !== 1) { touchesOutside = true; continue; }
        if (map[next] !== 0) { borderRegions.add(map[next]); continue; }
        if (!visited[next]) { visited[next] = 1; stack.push(next); }
      }
      if (holePixels.length > HOLE_MAX_AREA) break;
    }

    if (touchesOutside || holePixels.length > HOLE_MAX_AREA || borderRegions.size !== 1) continue;
    const [onlyRegion] = borderRegions;
    for (const index of holePixels) map[index] = onlyRegion;
  }
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
  if (!context) return { houseMask: null, obstacleMap: null, compartmentMap: null, roomColorMap: null, roomColorCount: 0, structuralCoverage: 0 };
  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const houseMask = createHouseMaskFromPixels(imageData, width, height);
  const obstacleData = createObstacleMaskFromPixels(imageData, width, height, houseMask);
  const dividerData = createCompartmentDividerMaskFromPixels(imageData, width, height, houseMask);
  const colorRegions = createColorRoomRegions(imageData, width, height, houseMask);
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
    roomColorMap: colorRegions?.map ?? null,
    roomColorCount: colorRegions?.count ?? 0,
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

function drawFloorplanBase(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
): void {
  context.save();
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.globalAlpha = 0.52;
  context.filter = "grayscale(1) contrast(0.78) brightness(1.22)";
  context.drawImage(image, 0, 0, width, height);
  context.restore();
}

function canvasMarkerScale(width: number, height: number): number {
  return clamp(Math.max(width, height) / 1400, 0.52, 0.78);
}

export async function renderFloorWithPoints(
  floorplanDataUrl: string,
  width: number,
  height: number,
  points: MeasurementPoint[],
  aps: RouterPlacement[],
): Promise<string> {
  const floor = await loadImage(floorplanDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas indisponivel para desenhar pontos.");
  drawFloorplanBase(context, floor, width, height);
  drawPointOverlay(context, points, aps);
  return canvas.toDataURL("image/png");
}

export async function composeOverlay(
  floorplanDataUrl: string,
  heatmapDataUrl: string,
  width: number,
  height: number,
  _points: MeasurementPoint[],
  aps: RouterPlacement[],
  opacity: number,
): Promise<string> {
  const [floor, heatmap] = await Promise.all([loadImage(floorplanDataUrl), loadImage(heatmapDataUrl)]);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas indisponivel para montar overlay.");

  drawFloorplanBase(context, floor, width, height);
  context.globalAlpha = clamp(Math.max(opacity, 0.84), 0.74, 0.96);
  context.drawImage(heatmap, 0, 0, width, height);
  context.globalAlpha = 1;
  const scale = canvasMarkerScale(width, height);
  for (const ap of aps) drawRouterIcon(context, ap.ap_x_px, ap.ap_y_px, scale);
  return canvas.toDataURL("image/png");
}

export async function composeHeatmapChart(
  overlayDataUrl: string,
  width: number,
  height: number,
  title: string,
): Promise<string> {
  const overlay = await loadImage(overlayDataUrl);
  const scale = Math.max(1, Math.min(2.4, width / 720));
  const sidePad = Math.round(26 * scale);
  const top = Math.round(42 * scale);
  const legendGap = Math.round(10 * scale);
  const legendHeight = Math.round(22 * scale);
  const bottom = Math.round(10 * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width + sidePad * 2;
  canvas.height = top + height + legendGap + legendHeight + bottom;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas indisponivel para montar grafico do heatmap.");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111111";
  context.font = `italic ${Math.round(18 * scale)}px Georgia, "Times New Roman", serif`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(title, sidePad, Math.round(top * 0.46));
  context.drawImage(overlay, sidePad, top, width, height);

  const legendX = sidePad;
  const legendY = top + height + legendGap;
  const legendW = Math.max(1, width);
  const segmentW = legendW / rssiLegendTicks.length;
  rssiLegendTicks.forEach((tick, index) => {
    const x = legendX + segmentW * index;
    const w = index === rssiLegendTicks.length - 1 ? legendX + legendW - x : Math.ceil(segmentW);
    context.fillStyle = tick.color;
    context.fillRect(x, legendY, w, legendHeight);
  });
  context.strokeStyle = "rgba(17, 24, 39, 0.12)";
  context.lineWidth = Math.max(1, Math.round(scale));
  context.strokeRect(legendX, legendY, legendW, legendHeight);

  context.font = `700 ${Math.max(6, Math.round(7.5 * scale))}px Arial, sans-serif`;
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
  aps: RouterPlacement[],
): void {
  const markerScale = canvasMarkerScale(context.canvas.width, context.canvas.height);
  for (const ap of aps) drawRouterIcon(context, ap.ap_x_px, ap.ap_y_px, markerScale);

  const renderedPoints = sampledOverlayPoints(points, MAX_OVERLAY_POINTS);
  const radius = 9 * markerScale;
  const fontSize = Math.max(6, 9 * markerScale);
  for (const point of renderedPoints) {
    context.save();
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#0f766e";
    context.lineWidth = Math.max(1.4, 2.6 * markerScale);
    context.beginPath();
    context.arc(point.x_px, point.y_px, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "#0f766e";
    context.font = `bold ${fontSize}px Segoe UI, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(point.point_id.replace(/^P/i, ""), point.x_px, point.y_px);
    context.restore();
  }
}

function sampledOverlayPoints(points: MeasurementPoint[], limit: number): MeasurementPoint[] {
  if (points.length <= limit) return points;
  const sampled: MeasurementPoint[] = [];
  const used = new Set<string>();
  const step = (points.length - 1) / Math.max(limit - 1, 1);

  for (let index = 0; index < limit; index += 1) {
    const point = points[Math.round(index * step)];
    if (!point || used.has(point.point_id)) continue;
    sampled.push(point);
    used.add(point.point_id);
  }

  return sampled;
}

function drawRouterIcon(context: CanvasRenderingContext2D, x: number, y: number, scale = 1): void {
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  context.lineCap = "round";
  context.lineJoin = "round";

  context.shadowColor = "rgba(15, 23, 42, 0.22)";
  context.shadowBlur = 3;
  context.shadowOffsetY = 1;
  context.fillStyle = "rgba(242, 203, 57, 0.9)";
  context.strokeStyle = "rgba(255, 255, 255, 0.92)";
  context.lineWidth = 2.4;
  context.beginPath();
  context.arc(0, 0, 10.5, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.shadowColor = "transparent";

  context.fillStyle = "rgba(255, 255, 255, 0.82)";
  context.beginPath();
  context.arc(0, 0, 6, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#0891b2";
  context.beginPath();
  context.arc(0, 0, 2.4, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = "#0891b2";
  context.lineWidth = 1.35;
  context.beginPath();
  context.arc(0, 0, 5, Math.PI * 1.16, Math.PI * 1.84);
  context.stroke();
  context.beginPath();
  context.arc(0, 0, 7.4, Math.PI * 1.14, Math.PI * 1.86);
  context.stroke();

  context.restore();
}
