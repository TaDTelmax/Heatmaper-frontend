import { pointInPolygon } from "./spatial";
import type { HeatmapEngineOptions, ObstacleMap, RoomAnalysis, RoomPolygon, WifiBand } from "@/types/heatmap";
import type { MeasurementPoint } from "@/types/measurement";

type GridContext = {
  values: Float32Array;
  alpha: Float32Array;
  active: Uint8Array;
  gridWidth: number;
  gridHeight: number;
  sampleStep: number;
  width: number;
  height: number;
  pxPerMeter: number;
  obstacleMap?: ObstacleMap | null;
  rooms?: RoomPolygon[];
  measurementPoints?: MeasurementPoint[];
  band?: WifiBand;
  thresholds: Required<Pick<HeatmapEngineOptions, "coverageThresholdRssi" | "weakThresholdRssi" | "deadZoneThresholdRssi">>;
};

type RegionSeed = {
  id: string;
  name: string;
  indices: number[];
};

function round(value: number, digits = 1): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function estimateThroughputMbps(rssi: number): number {
  if (rssi >= -45) return 940;
  if (rssi >= -55) return 720;
  if (rssi >= -65) return 420;
  if (rssi >= -72) return 190;
  if (rssi >= -80) return 55;
  return 8;
}

function estimateLatencyMs(rssi: number, weakPercentage: number, deadPercentage: number): number {
  const signalPenalty = rssi >= -55 ? 0 : Math.abs(rssi + 55) * 0.28;
  const qualityPenalty = weakPercentage * 0.05 + deadPercentage * 0.14;
  return round(Math.min(80, 4.2 + signalPenalty + qualityPenalty), 1);
}

function channelQuality(rssi: number, coveragePercentage: number, deadPercentage: number): number {
  const signalScore = Math.max(0, Math.min(100, ((rssi + 90) / 60) * 100));
  return round(signalScore * 0.46 + coveragePercentage * 0.42 + (100 - deadPercentage) * 0.12);
}

function gridCenter(index: number, gridWidth: number, sampleStep: number, width: number, height: number): { x: number; y: number } {
  const gx = index % gridWidth;
  const gy = Math.floor(index / gridWidth);
  return {
    x: Math.min(width - 1, gx * sampleStep + sampleStep * 0.5),
    y: Math.min(height - 1, gy * sampleStep + sampleStep * 0.5),
  };
}

function isObstacleAt(obstacleMap: ObstacleMap | null | undefined, x: number, y: number): boolean {
  if (!obstacleMap) return false;
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= obstacleMap.width || py >= obstacleMap.height) return false;
  return obstacleMap.data[py * obstacleMap.width + px] === 1;
}

function createExplicitRoomRegions(context: GridContext, rooms: RoomPolygon[]): RegionSeed[] {
  const regions: RegionSeed[] = rooms.map((room, index) => ({
    id: room.id ?? `room-${index + 1}`,
    name: room.name || `Room ${index + 1}`,
    indices: [],
  }));

  for (let index = 0; index < context.active.length; index += 1) {
    if (!context.active[index] || context.alpha[index] <= 0.02) continue;
    const center = gridCenter(index, context.gridWidth, context.sampleStep, context.width, context.height);
    if (isObstacleAt(context.obstacleMap, center.x, center.y)) continue;
    for (let roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
      if (pointInPolygon(center, rooms[roomIndex].polygon)) {
        regions[roomIndex].indices.push(index);
        break;
      }
    }
  }

  return regions.filter((region) => region.indices.length > 0);
}

function createAutoRoomRegions(context: GridContext): RegionSeed[] {
  const passable = new Uint8Array(context.active.length);
  for (let index = 0; index < context.active.length; index += 1) {
    if (!context.active[index] || context.alpha[index] <= 0.03) continue;
    const center = gridCenter(index, context.gridWidth, context.sampleStep, context.width, context.height);
    if (isObstacleAt(context.obstacleMap, center.x, center.y)) continue;
    passable[index] = 1;
  }

  const visited = new Uint8Array(passable.length);
  const regions: RegionSeed[] = [];
  const minSamples = Math.max(18, Math.round(passable.length * 0.0015));
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  for (let seed = 0; seed < passable.length; seed += 1) {
    if (!passable[seed] || visited[seed]) continue;
    const queue = [seed];
    const indices: number[] = [];
    visited[seed] = 1;

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      indices.push(index);
      const gx = index % context.gridWidth;
      const gy = Math.floor(index / context.gridWidth);

      for (const [dx, dy] of neighbors) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= context.gridWidth || ny >= context.gridHeight) continue;
        const next = ny * context.gridWidth + nx;
        if (!passable[next] || visited[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (indices.length >= minSamples) {
      regions.push({ id: `auto-room-${regions.length + 1}`, name: `Room ${regions.length + 1}`, indices });
    }
  }

  regions.sort((a, b) => b.indices.length - a.indices.length);
  return regions.slice(0, 18).map((region, index) => ({ ...region, name: regions.length === 1 ? "Floor Area" : `Room ${index + 1}` }));
}

function analyzeRegion(region: RegionSeed, context: GridContext): RoomAnalysis | null {
  if (!region.indices.length) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let sumX = 0;
  let sumY = 0;
  let total = 0;
  let worst = Number.POSITIVE_INFINITY;
  let best = Number.NEGATIVE_INFINITY;
  let covered = 0;
  let weak = 0;
  let dead = 0;
  let excellent = 0;
  let good = 0;
  let acceptable = 0;
  let weakQuality = 0;
  let deadQuality = 0;

  for (const index of region.indices) {
    const value = context.values[index];
    const center = gridCenter(index, context.gridWidth, context.sampleStep, context.width, context.height);
    minX = Math.min(minX, center.x);
    minY = Math.min(minY, center.y);
    maxX = Math.max(maxX, center.x);
    maxY = Math.max(maxY, center.y);
    sumX += center.x;
    sumY += center.y;
    total += value;
    worst = Math.min(worst, value);
    best = Math.max(best, value);

    if (value >= context.thresholds.coverageThresholdRssi) covered += 1;
    if (value < context.thresholds.weakThresholdRssi) weak += 1;
    if (value <= context.thresholds.deadZoneThresholdRssi) dead += 1;
    if (value >= -50) excellent += 1;
    else if (value >= context.thresholds.coverageThresholdRssi) good += 1;
    else if (value >= context.thresholds.weakThresholdRssi) acceptable += 1;
    else if (value > context.thresholds.deadZoneThresholdRssi) weakQuality += 1;
    else deadQuality += 1;
  }

  const count = region.indices.length;
  const areaPx = count * context.sampleStep * context.sampleStep;
  const areaM2 = context.pxPerMeter > 0 ? areaPx / (context.pxPerMeter * context.pxPerMeter) : null;
  const toPercent = (value: number) => round((value / Math.max(count, 1)) * 100);
  const coveragePercentage = toPercent(covered);
  const weakCoveragePercentage = toPercent(weak);
  const deadZonePercentage = toPercent(dead);
  const avgRssi = round(total / count);
  const channelScore = channelQuality(avgRssi, coveragePercentage, deadZonePercentage);

  return {
    id: region.id,
    name: region.name,
    areaPx: Math.round(areaPx),
    areaM2: areaM2 === null ? null : round(areaM2, 2),
    sampleCount: count,
    avgRssi,
    worstRssi: round(worst),
    bestRssi: round(best),
    coveragePercentage,
    weakCoveragePercentage,
    deadZonePercentage,
    roamingQuality: round(Math.min(100, coveragePercentage * 0.72 + channelScore * 0.28)),
    estimatedThroughputMbps: estimateThroughputMbps(avgRssi),
    estimatedLatencyMs: estimateLatencyMs(avgRssi, weakCoveragePercentage, deadZonePercentage),
    channelQuality: channelScore,
    centroid: {
      x: round(sumX / count),
      y: round(sumY / count),
    },
    bounds: {
      minX: round(minX),
      minY: round(minY),
      maxX: round(maxX),
      maxY: round(maxY),
    },
    quality: {
      excellent: toPercent(excellent),
      good: toPercent(good),
      acceptable: toPercent(acceptable),
      weak: toPercent(weakQuality),
      dead: toPercent(deadQuality),
    },
  };
}

function pointRssi(point: MeasurementPoint, band: WifiBand): number | null {
  if (band === "24ghz") return point.rssi_24ghz;
  if (band === "5ghz") return point.rssi_5ghz;
  return point.rssi_6ghz ?? (point.rssi_5ghz === null ? null : point.rssi_5ghz - 4.5);
}

function qualityForValue(
  rssi: number,
  thresholds: GridContext["thresholds"],
): RoomAnalysis["quality"] {
  return {
    excellent: rssi >= -50 ? 100 : 0,
    good: rssi < -50 && rssi >= thresholds.coverageThresholdRssi ? 100 : 0,
    acceptable: rssi < thresholds.coverageThresholdRssi && rssi >= thresholds.weakThresholdRssi ? 100 : 0,
    weak: rssi < thresholds.weakThresholdRssi && rssi > thresholds.deadZoneThresholdRssi ? 100 : 0,
    dead: rssi <= thresholds.deadZoneThresholdRssi ? 100 : 0,
  };
}

export function analyzeMeasurementPoints(context: GridContext): RoomAnalysis[] {
  if (!context.measurementPoints?.length || !context.band) return [];

  return context.measurementPoints
    .map((point): RoomAnalysis | null => {
      const rssi = pointRssi(point, context.band as WifiBand);
      if (rssi === null || !Number.isFinite(rssi)) return null;
      const coverage = rssi >= context.thresholds.coverageThresholdRssi ? 100 : 0;
      const weak = rssi < context.thresholds.weakThresholdRssi ? 100 : 0;
      const dead = rssi <= context.thresholds.deadZoneThresholdRssi ? 100 : 0;
      const channelScore = channelQuality(rssi, coverage, dead);

      return {
        id: point.point_id,
        name: point.point_id,
        areaPx: 0,
        areaM2: null,
        sampleCount: 1,
        avgRssi: round(rssi),
        worstRssi: round(rssi),
        bestRssi: round(rssi),
        coveragePercentage: coverage,
        weakCoveragePercentage: weak,
        deadZonePercentage: dead,
        roamingQuality: round(Math.min(100, coverage * 0.72 + channelScore * 0.28)),
        estimatedThroughputMbps: estimateThroughputMbps(rssi),
        estimatedLatencyMs: estimateLatencyMs(rssi, weak, dead),
        channelQuality: channelScore,
        centroid: {
          x: round(point.x_px),
          y: round(point.y_px),
        },
        bounds: {
          minX: round(point.x_px),
          minY: round(point.y_px),
          maxX: round(point.x_px),
          maxY: round(point.y_px),
        },
        quality: qualityForValue(rssi, context.thresholds),
      };
    })
    .filter((analysis): analysis is RoomAnalysis => analysis !== null);
}

export function analyzeRoomCoverage(context: GridContext): RoomAnalysis[] {
  const regions =
    context.rooms && context.rooms.length ? createExplicitRoomRegions(context, context.rooms) : createAutoRoomRegions(context);
  return regions
    .map((region) => analyzeRegion(region, context))
    .filter((analysis): analysis is RoomAnalysis => analysis !== null)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
