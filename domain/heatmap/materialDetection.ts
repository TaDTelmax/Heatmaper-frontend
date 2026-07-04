import { clamp, sampleLine } from "./spatial";
import type { RfPoint, WallMaterial, WallSegment } from "@/types/heatmap";

type Rgb = [number, number, number];

export type FloorplanMaterialSampler = {
  imageData: ImageData;
  width: number;
  height: number;
  background: Rgb;
};

export type MaterialTraceAnalysis = {
  material: WallMaterial;
  confidence: number;
  coverage: number;
  thicknessPx: number;
};

export type AutoWallDetectionResult = {
  walls: WallSegment[];
  horizontalCount: number;
  verticalCount: number;
  structuralCoverage: number;
};

type AxisCandidate = {
  orientation: "horizontal" | "vertical";
  start: number;
  end: number;
  crossStart: number;
  crossEnd: number;
  score: number;
};

type TraceStats = {
  coverage: number;
  thicknessPx: number;
  averageLuminance: number;
  averageSaturation: number;
  blueRatio: number;
  redOrangeRatio: number;
  yellowBrownRatio: number;
  neutralRatio: number;
  darkNeutralRatio: number;
  gapRatio: number;
};

export async function createFloorplanMaterialSampler(
  floorplanDataUrl: string,
  width: number,
  height: number,
): Promise<FloorplanMaterialSampler | null> {
  const image = await loadImage(floorplanDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return {
    imageData,
    width,
    height,
    background: estimateEdgeBackground(imageData.data, width, height),
  };
}

export function detectWallMaterialFromTrace(
  sampler: FloorplanMaterialSampler | null,
  start: RfPoint,
  end: RfPoint,
  fallback: WallMaterial = "drywall",
): MaterialTraceAnalysis {
  if (!sampler) return { material: fallback, confidence: 0, coverage: 0, thicknessPx: 0 };

  const stats = analyzeTrace(sampler, start, end);
  if (!stats || stats.coverage < 0.12) {
    return {
      material: fallback,
      confidence: 0.16,
      coverage: stats?.coverage ?? 0,
      thicknessPx: stats?.thicknessPx ?? 0,
    };
  }

  const colorConfidence = clamp(stats.coverage + stats.averageSaturation * 0.55, 0.28, 0.95);
  if (stats.blueRatio > 0.34 || (stats.averageSaturation > 0.26 && stats.gapRatio > 0.42 && stats.thicknessPx <= 3.2)) {
    return analysis("glass", colorConfidence, stats);
  }
  if (stats.redOrangeRatio > 0.38) {
    return analysis("brick", colorConfidence, stats);
  }
  if (stats.yellowBrownRatio > 0.34) {
    return analysis("wood", colorConfidence, stats);
  }

  // Neutral (grey/dark) pixel majority — classify by thickness + dark density,
  // which correspond to Brazilian architectural drawing conventions:
  //   very thin → glass or drywall (single-line wall)
  //   medium neutral, low dark density → brick
  //   medium neutral, high dark density → concrete
  //   thick neutral → reinforced concrete
  if (stats.neutralRatio > 0.50) {
    const t = stats.thicknessPx;
    const d = stats.darkNeutralRatio;
    const baseConf = clamp(0.40 + stats.coverage * 0.38, 0.32, 0.80);
    if (t <= 2.5) return analysis("glass", clamp(baseConf - 0.04, 0.28, 0.70), stats);
    if (t <= 5 && d < 0.45) return analysis("drywall", baseConf, stats);
    if (t <= 5) return analysis("brick", baseConf, stats);
    if (t <= 10 && d < 0.55) return analysis("brick", baseConf, stats);
    if (t <= 10) return analysis("concrete", baseConf, stats);
    if (t <= 20) return analysis("concrete", clamp(baseConf + 0.04, 0.36, 0.84), stats);
    return analysis("reinforced_concrete", clamp(baseConf + 0.06, 0.38, 0.86), stats);
  }

  return analysis(fallback, clamp(0.3 + stats.coverage * 0.44, 0.24, 0.82), stats);
}

export function detectWallSegmentsFromFloorplan(
  sampler: FloorplanMaterialSampler | null,
  fallbackMaterial: WallMaterial = "drywall",
): AutoWallDetectionResult {
  if (!sampler) {
    return { walls: [], horizontalCount: 0, verticalCount: 0, structuralCoverage: 0 };
  }

  const scale = clamp(Math.ceil(Math.max(sampler.width, sampler.height) / 2400), 1, 5);
  const scaledWidth = Math.ceil(sampler.width / scale);
  const scaledHeight = Math.ceil(sampler.height / scale);
  const mask = createTraceMask(sampler, scale, scaledWidth, scaledHeight);
  const foregroundPixels = mask.reduce((sum, value) => sum + value, 0);
  const structuralCoverage = foregroundPixels / Math.max(mask.length, 1);

  if (foregroundPixels < Math.max(40, mask.length * 0.00004) || structuralCoverage > 0.46) {
    return { walls: [], horizontalCount: 0, verticalCount: 0, structuralCoverage };
  }

  const integral = createIntegralMask(mask, scaledWidth, scaledHeight);
  const maxScaledDimension = Math.max(scaledWidth, scaledHeight);
  const bandRadius = clamp(Math.round(maxScaledDimension / 360), 2, 5);
  const gapTolerance = clamp(Math.round(maxScaledDimension / 170), 4, 12);
  const minLength = clamp(Math.round(maxScaledDimension * 0.035), 18, 86);
  const maxCrossGap = Math.max(3, bandRadius * 3);

  const horizontal = mergeAxisCandidates(
    extractAxisCandidates(integral, scaledWidth, scaledHeight, "horizontal", bandRadius, gapTolerance, minLength),
    maxCrossGap,
    gapTolerance,
  );
  const vertical = mergeAxisCandidates(
    extractAxisCandidates(integral, scaledWidth, scaledHeight, "vertical", bandRadius, gapTolerance, minLength),
    maxCrossGap,
    gapTolerance,
  );

  const structuralCandidates = selectStructuralWallCandidates(
    consolidateParallelCandidates([...horizontal, ...vertical], Math.max(maxCrossGap * 2, Math.round(maxScaledDimension * 0.014)), gapTolerance),
    scaledWidth,
    scaledHeight,
    minLength,
    bandRadius,
  );
  const wallCandidates = keepMainWallGraphCandidates(
    structuralCandidates,
    scaledWidth,
    scaledHeight,
    Math.max(bandRadius * 5, Math.round(maxScaledDimension * 0.014)),
  )
    .sort((a, b) => candidateLength(b) * b.score - candidateLength(a) * a.score)
    .slice(0, 110);

  const walls = dedupeWallSegments(
    wallCandidates.map((candidate, index) => {
      const wall = axisCandidateToWall(candidate, scale, sampler.width, sampler.height);
      const detected = detectWallMaterialFromTrace(sampler, wall.start, wall.end, fallbackMaterial);
      return {
        id: `auto-wall-${index + 1}`,
        start: wall.start,
        end: wall.end,
        material: detected.material,
      };
    }),
  );

  return {
    walls,
    horizontalCount: walls.filter((wall) => Math.abs(wall.start.y - wall.end.y) < Math.abs(wall.start.x - wall.end.x)).length,
    verticalCount: walls.filter((wall) => Math.abs(wall.start.y - wall.end.y) >= Math.abs(wall.start.x - wall.end.x)).length,
    structuralCoverage: Number(structuralCoverage.toFixed(3)),
  };
}

function analysis(material: WallMaterial, confidence: number, stats: TraceStats): MaterialTraceAnalysis {
  return {
    material,
    confidence: Number(confidence.toFixed(2)),
    coverage: Number(stats.coverage.toFixed(2)),
    thicknessPx: Number(stats.thicknessPx.toFixed(1)),
  };
}

function createTraceMask(
  sampler: FloorplanMaterialSampler,
  scale: number,
  scaledWidth: number,
  scaledHeight: number,
): Uint8Array {
  const mask = new Uint8Array(scaledWidth * scaledHeight);
  const data = sampler.imageData.data;

  for (let y = 0; y < sampler.height; y += 1) {
    const scaledY = Math.floor(y / scale);
    for (let x = 0; x < sampler.width; x += 1) {
      const offset = (y * sampler.width + x) * 4;
      if (data[offset + 3] <= 24) continue;
      const rgb: Rgb = [data[offset], data[offset + 1], data[offset + 2]];
      if (!isTracePixel(rgb, sampler.background)) continue;
      const scaledX = Math.floor(x / scale);
      mask[scaledY * scaledWidth + scaledX] = 1;
    }
  }

  const filtered = new Uint8Array(mask.length);
  for (let y = 0; y < scaledHeight; y += 1) {
    for (let x = 0; x < scaledWidth; x += 1) {
      const index = y * scaledWidth + x;
      if (!mask[index]) continue;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= scaledWidth || ny >= scaledHeight) continue;
          neighbors += mask[ny * scaledWidth + nx];
        }
      }
      if (neighbors >= 1) filtered[index] = 1;
    }
  }
  return filtered;
}

function createIntegralMask(mask: Uint8Array, width: number, height: number): Uint32Array {
  const stride = width + 1;
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0;
    for (let x = 1; x <= width; x += 1) {
      rowSum += mask[(y - 1) * width + x - 1];
      integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
    }
  }
  return integral;
}

function extractAxisCandidates(
  integral: Uint32Array,
  width: number,
  height: number,
  orientation: AxisCandidate["orientation"],
  bandRadius: number,
  gapTolerance: number,
  minLength: number,
): AxisCandidate[] {
  const candidates: AxisCandidate[] = [];
  const crossLimit = orientation === "horizontal" ? height : width;
  const inlineLimit = orientation === "horizontal" ? width : height;

  for (let cross = 0; cross < crossLimit; cross += 1) {
    const crossStart = clamp(cross - bandRadius, 0, crossLimit - 1);
    const crossEnd = clamp(cross + bandRadius, 0, crossLimit - 1);
    const bandSize = crossEnd - crossStart + 1;
    let runStart = -1;
    let gap = 0;

    for (let inline = 0; inline < inlineLimit; inline += 1) {
      const hit =
        orientation === "horizontal"
          ? rectSum(integral, width, inline, crossStart, inline + 1, crossEnd + 1) > 0
          : rectSum(integral, width, crossStart, inline, crossEnd + 1, inline + 1) > 0;

      if (hit) {
        if (runStart < 0) runStart = inline;
        gap = 0;
        continue;
      }

      if (runStart >= 0) {
        gap += 1;
        if (gap > gapTolerance) {
          pushAxisCandidate(candidates, integral, width, orientation, runStart, inline - gapTolerance, crossStart, crossEnd, bandSize, minLength);
          runStart = -1;
          gap = 0;
        }
      }
    }

    if (runStart >= 0) {
      pushAxisCandidate(candidates, integral, width, orientation, runStart, inlineLimit, crossStart, crossEnd, bandSize, minLength);
    }
  }

  return candidates;
}

function pushAxisCandidate(
  candidates: AxisCandidate[],
  integral: Uint32Array,
  width: number,
  orientation: AxisCandidate["orientation"],
  start: number,
  endExclusive: number,
  crossStart: number,
  crossEnd: number,
  bandSize: number,
  minLength: number,
): void {
  const end = endExclusive - 1;
  const length = end - start + 1;
  if (length < minLength) return;

  const pixels =
    orientation === "horizontal"
      ? rectSum(integral, width, start, crossStart, end + 1, crossEnd + 1)
      : rectSum(integral, width, crossStart, start, crossEnd + 1, end + 1);
  const density = pixels / Math.max(length * bandSize, 1);
  if (density < 0.06 || density > 0.92) return;

  candidates.push({
    orientation,
    start,
    end,
    crossStart,
    crossEnd,
    score: density,
  });
}

function rectSum(
  integral: Uint32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const stride = width + 1;
  return integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
}

function mergeAxisCandidates(candidates: AxisCandidate[], maxCrossGap: number, maxInlineGap: number): AxisCandidate[] {
  const merged: AxisCandidate[] = [];
  const sorted = [...candidates].sort((a, b) => {
    if (a.orientation !== b.orientation) return a.orientation.localeCompare(b.orientation);
    const crossDelta = axisCenter(a) - axisCenter(b);
    if (Math.abs(crossDelta) > maxCrossGap) return crossDelta;
    return a.start - b.start;
  });

  for (const candidate of sorted) {
    const match = merged.find((current) => {
      if (current.orientation !== candidate.orientation) return false;
      if (Math.abs(axisCenter(current) - axisCenter(candidate)) > maxCrossGap) return false;
      return Math.min(current.end, candidate.end) - Math.max(current.start, candidate.start) >= -maxInlineGap;
    });

    if (!match) {
      merged.push({ ...candidate });
      continue;
    }

    match.start = Math.min(match.start, candidate.start);
    match.end = Math.max(match.end, candidate.end);
    match.crossStart = Math.min(match.crossStart, candidate.crossStart);
    match.crossEnd = Math.max(match.crossEnd, candidate.crossEnd);
    match.score = Math.max(match.score, candidate.score);
  }

  return merged;
}

function consolidateParallelCandidates(candidates: AxisCandidate[], maxCrossGap: number, maxInlineGap: number): AxisCandidate[] {
  const merged: AxisCandidate[] = [];
  const sorted = [...candidates]
    .filter((candidate) => axisCandidateLooksStructural(candidate, 1))
    .sort((a, b) => {
      if (a.orientation !== b.orientation) return a.orientation.localeCompare(b.orientation);
      const crossDelta = axisCenter(a) - axisCenter(b);
      if (Math.abs(crossDelta) > maxCrossGap) return crossDelta;
      return a.start - b.start;
    });

  for (const candidate of sorted) {
    const match = merged.find((current) => {
      if (current.orientation !== candidate.orientation) return false;
      if (Math.abs(axisCenter(current) - axisCenter(candidate)) > maxCrossGap) return false;
      return axisOverlapRatio(current, candidate) > 0.48 || Math.min(current.end, candidate.end) - Math.max(current.start, candidate.start) >= -maxInlineGap;
    });

    if (!match) {
      merged.push({ ...candidate });
      continue;
    }

    match.start = Math.min(match.start, candidate.start);
    match.end = Math.max(match.end, candidate.end);
    match.crossStart = Math.min(match.crossStart, candidate.crossStart);
    match.crossEnd = Math.max(match.crossEnd, candidate.crossEnd);
    match.score = Math.max(match.score, candidate.score);
  }

  return merged;
}

function selectStructuralWallCandidates(
  candidates: AxisCandidate[],
  width: number,
  height: number,
  minLength: number,
  bandRadius: number,
): AxisCandidate[] {
  const maxDimension = Math.max(width, height);
  const frameTolerance = Math.max(8, Math.round(maxDimension * 0.018));
  const junctionTolerance = Math.max(bandRadius * 4, Math.round(maxDimension * 0.012));
  const parallelTolerance = Math.max(bandRadius * 5, Math.round(maxDimension * 0.018));

  return candidates.filter((candidate) => {
    if (!axisCandidateLooksStructural(candidate, minLength)) return false;

    const length = candidateLength(candidate);
    const junctions = candidates.filter((other) => candidate !== other && candidatesIntersect(candidate, other, junctionTolerance)).length;
    const frameContact = candidateTouchesFrame(candidate, width, height, frameTolerance);
    const parallelNeighbors = candidates.filter((other) => {
      if (candidate === other || candidate.orientation !== other.orientation) return false;
      return Math.abs(axisCenter(candidate) - axisCenter(other)) <= parallelTolerance && axisOverlapRatio(candidate, other) > 0.54;
    }).length;

    const boundaryWall = frameContact && length >= maxDimension * 0.16;
    const connectedWall = length >= maxDimension * 0.09 && junctions >= 1;
    const roomDivider = length >= minLength * 2.1 && junctions >= 2;
    const repeatedFurnitureStripe = parallelNeighbors >= 2 && length < maxDimension * 0.28 && !frameContact;

    return (boundaryWall || connectedWall || roomDivider) && !repeatedFurnitureStripe;
  });
}

function keepMainWallGraphCandidates(
  candidates: AxisCandidate[],
  width: number,
  height: number,
  tolerance: number,
): AxisCandidate[] {
  if (!candidates.length) return [];

  const visited = new Uint8Array(candidates.length);
  const components: { indices: number[]; totalLength: number; frameTouches: number; junctions: number }[] = [];

  for (let seed = 0; seed < candidates.length; seed += 1) {
    if (visited[seed]) continue;
    const queue = [seed];
    const indices: number[] = [];
    visited[seed] = 1;

    for (let head = 0; head < queue.length; head += 1) {
      const currentIndex = queue[head];
      indices.push(currentIndex);
      const current = candidates[currentIndex];

      for (let nextIndex = 0; nextIndex < candidates.length; nextIndex += 1) {
        if (visited[nextIndex] || nextIndex === currentIndex) continue;
        const next = candidates[nextIndex];
        if (!candidatesIntersect(current, next, tolerance) && !candidateEndpointsNear(current, next, tolerance * 1.5)) continue;
        visited[nextIndex] = 1;
        queue.push(nextIndex);
      }
    }

    let totalLength = 0;
    let frameTouches = 0;
    let junctions = 0;
    for (const index of indices) {
      const candidate = candidates[index];
      totalLength += candidateLength(candidate);
      if (candidateTouchesFrame(candidate, width, height, Math.max(8, Math.round(Math.max(width, height) * 0.018)))) {
        frameTouches += 1;
      }
      junctions += candidates.filter((other) => other !== candidate && candidatesIntersect(candidate, other, tolerance)).length;
    }
    components.push({ indices, totalLength, frameTouches, junctions });
  }

  const maxDimension = Math.max(width, height);
  const keep = components.filter((component) => {
    if (component.indices.length === 1) {
      const candidate = candidates[component.indices[0]];
      return component.frameTouches > 0 && candidateLength(candidate) >= maxDimension * 0.28;
    }
    return component.totalLength >= maxDimension * 0.26 && (component.frameTouches > 0 || component.junctions >= 2);
  });

  if (!keep.length) {
    const largest = components.sort((a, b) => b.totalLength - a.totalLength)[0];
    return largest?.totalLength >= maxDimension * 0.26 ? largest.indices.map((index) => candidates[index]) : [];
  }

  return keep.flatMap((component) => component.indices.map((index) => candidates[index]));
}

function axisCandidateLooksStructural(candidate: AxisCandidate, minLength: number): boolean {
  const length = candidateLength(candidate);
  const thickness = candidate.crossEnd - candidate.crossStart + 1;
  const aspect = length / Math.max(thickness, 1);
  return length >= minLength && aspect >= 4.8 && thickness <= Math.max(18, length * 0.2);
}

function axisCandidateToWall(candidate: AxisCandidate, scale: number, width: number, height: number): Pick<WallSegment, "start" | "end"> {
  const center = (candidate.crossStart + candidate.crossEnd + 1) * scale * 0.5;
  const start = candidate.start * scale;
  const end = (candidate.end + 1) * scale - 1;

  if (candidate.orientation === "horizontal") {
    const y = roundCoordinate(clamp(center, 0, height - 1));
    return {
      start: { x: roundCoordinate(clamp(start, 0, width - 1)), y },
      end: { x: roundCoordinate(clamp(end, 0, width - 1)), y },
    };
  }

  const x = roundCoordinate(clamp(center, 0, width - 1));
  return {
    start: { x, y: roundCoordinate(clamp(start, 0, height - 1)) },
    end: { x, y: roundCoordinate(clamp(end, 0, height - 1)) },
  };
}

function dedupeWallSegments(walls: WallSegment[]): WallSegment[] {
  const accepted: WallSegment[] = [];
  for (const wall of walls) {
    const duplicate = accepted.some((current) => {
      const sameOrientation =
        Math.abs(current.start.y - current.end.y) < Math.abs(current.start.x - current.end.x) ===
        (Math.abs(wall.start.y - wall.end.y) < Math.abs(wall.start.x - wall.end.x));
      if (!sameOrientation) return false;
      const currentCenter = wallCenter(current);
      const wallCenterPoint = wallCenter(wall);
      const crossDistance = Math.hypot(currentCenter.x - wallCenterPoint.x, currentCenter.y - wallCenterPoint.y);
      const currentLength = Math.hypot(current.end.x - current.start.x, current.end.y - current.start.y);
      const wallLength = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
      return crossDistance < 4 && Math.abs(currentLength - wallLength) < 8;
    });
    if (!duplicate) accepted.push(wall);
  }
  return accepted;
}

function wallCenter(wall: WallSegment): RfPoint {
  return {
    x: (wall.start.x + wall.end.x) / 2,
    y: (wall.start.y + wall.end.y) / 2,
  };
}

function candidateLength(candidate: AxisCandidate): number {
  return candidate.end - candidate.start + 1;
}

function axisOverlapRatio(a: AxisCandidate, b: AxisCandidate): number {
  if (a.orientation !== b.orientation) return 0;
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start) + 1;
  if (overlap <= 0) return 0;
  return overlap / Math.max(1, Math.min(candidateLength(a), candidateLength(b)));
}

function axisCenter(candidate: AxisCandidate): number {
  return (candidate.crossStart + candidate.crossEnd) / 2;
}

function candidatesIntersect(a: AxisCandidate, b: AxisCandidate, tolerance: number): boolean {
  if (a.orientation === b.orientation) return false;
  const horizontal = a.orientation === "horizontal" ? a : b;
  const vertical = a.orientation === "vertical" ? a : b;
  const horizontalY = axisCenter(horizontal);
  const verticalX = axisCenter(vertical);
  return (
    verticalX >= horizontal.start - tolerance &&
    verticalX <= horizontal.end + tolerance &&
    horizontalY >= vertical.start - tolerance &&
    horizontalY <= vertical.end + tolerance
  );
}

function candidateEndpointsNear(a: AxisCandidate, b: AxisCandidate, tolerance: number): boolean {
  const endpointsA = candidateEndpoints(a);
  const endpointsB = candidateEndpoints(b);
  return endpointsA.some((pointA) =>
    endpointsB.some((pointB) => Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y) <= tolerance),
  );
}

function candidateEndpoints(candidate: AxisCandidate): RfPoint[] {
  const cross = axisCenter(candidate);
  if (candidate.orientation === "horizontal") {
    return [
      { x: candidate.start, y: cross },
      { x: candidate.end, y: cross },
    ];
  }
  return [
    { x: cross, y: candidate.start },
    { x: cross, y: candidate.end },
  ];
}

function candidateTouchesFrame(candidate: AxisCandidate, width: number, height: number, tolerance: number): boolean {
  const cross = axisCenter(candidate);
  if (candidate.orientation === "horizontal") {
    return cross <= tolerance || cross >= height - tolerance || candidate.start <= tolerance || candidate.end >= width - tolerance;
  }
  return cross <= tolerance || cross >= width - tolerance || candidate.start <= tolerance || candidate.end >= height - tolerance;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 10) / 10;
}

function analyzeTrace(sampler: FloorplanMaterialSampler, start: RfPoint, end: RfPoint): TraceStats | null {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length < 8) return null;

  const samples = sampleLine(start, end, clamp(Math.round(Math.max(sampler.width, sampler.height) / 650), 2, 5));
  const dx = (end.x - start.x) / length;
  const dy = (end.y - start.y) / length;
  const normalX = -dy;
  const normalY = dx;
  const radius = clamp(Math.round(Math.max(sampler.width, sampler.height) / 240), 5, 13);

  let tracedRows = 0;
  let previousHadTrace = false;
  let traceRuns = 0;
  let foregroundPixels = 0;
  let totalPixels = 0;
  let thicknessTotal = 0;
  let luminanceTotal = 0;
  let saturationTotal = 0;
  let bluePixels = 0;
  let redOrangePixels = 0;
  let yellowBrownPixels = 0;
  let neutralPixels = 0;
  let darkNeutralPixels = 0;

  for (const sample of samples) {
    let rowForeground = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const x = Math.round(sample.x + normalX * offset);
      const y = Math.round(sample.y + normalY * offset);
      const pixel = readPixel(sampler, x, y);
      totalPixels += 1;
      if (!pixel || !isTracePixel(pixel, sampler.background)) continue;

      rowForeground += 1;
      foregroundPixels += 1;

      const lum = luminance(pixel[0], pixel[1], pixel[2]);
      const sat = saturation(pixel[0], pixel[1], pixel[2]);
      const hue = hueDegrees(pixel[0], pixel[1], pixel[2]);
      luminanceTotal += lum;
      saturationTotal += sat;

      if (sat >= 0.18 && hue >= 175 && hue <= 230) bluePixels += 1;
      if (sat >= 0.16 && (hue <= 24 || hue >= 350)) redOrangePixels += 1;
      if (sat >= 0.16 && hue > 24 && hue <= 58) yellowBrownPixels += 1;
      if (sat < 0.18) neutralPixels += 1;
      if (sat < 0.2 && lum < 0.34) darkNeutralPixels += 1;
    }

    if (rowForeground > 0) {
      tracedRows += 1;
      thicknessTotal += rowForeground;
      if (!previousHadTrace) traceRuns += 1;
      previousHadTrace = true;
    } else {
      previousHadTrace = false;
    }
  }

  if (!foregroundPixels || !totalPixels) return null;
  const coverage = tracedRows / samples.length;
  return {
    coverage,
    thicknessPx: thicknessTotal / Math.max(tracedRows, 1),
    averageLuminance: luminanceTotal / foregroundPixels,
    averageSaturation: saturationTotal / foregroundPixels,
    blueRatio: bluePixels / foregroundPixels,
    redOrangeRatio: redOrangePixels / foregroundPixels,
    yellowBrownRatio: yellowBrownPixels / foregroundPixels,
    neutralRatio: neutralPixels / foregroundPixels,
    darkNeutralRatio: darkNeutralPixels / foregroundPixels,
    gapRatio: clamp((traceRuns - 1) / Math.max(samples.length - 1, 1), 0, 1),
  };
}

function readPixel(sampler: FloorplanMaterialSampler, x: number, y: number): Rgb | null {
  if (x < 0 || y < 0 || x >= sampler.width || y >= sampler.height) return null;
  const offset = (y * sampler.width + x) * 4;
  if (sampler.imageData.data[offset + 3] <= 24) return null;
  return [
    sampler.imageData.data[offset],
    sampler.imageData.data[offset + 1],
    sampler.imageData.data[offset + 2],
  ];
}

function isTracePixel(rgb: Rgb, background: Rgb): boolean {
  const contrast = colorDistance(rgb, background);
  const lum = luminance(rgb[0], rgb[1], rgb[2]);
  const sat = saturation(rgb[0], rgb[1], rgb[2]);
  return contrast > 42 || lum < 0.74 || (sat > 0.24 && contrast > 30);
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
    if (data[offset + 3] <= 24) return;
    samples.push([data[offset], data[offset + 1], data[offset + 2]]);
  };

  const xStep = Math.max(1, Math.floor(width / 80));
  const yStep = Math.max(1, Math.floor(height / 80));
  for (let x = 0; x < width; x += xStep) {
    pushPixel(x, 0);
    pushPixel(x, height - 1);
  }
  for (let y = 0; y < height; y += yStep) {
    pushPixel(0, y);
    pushPixel(width - 1, y);
  }

  if (!samples.length) return [255, 255, 255];
  const sum = samples.reduce<Rgb>(
    (acc, rgb) => [acc[0] + rgb[0], acc[1] + rgb[1], acc[2] + rgb[2]],
    [0, 0, 0],
  );
  return [sum[0] / samples.length, sum[1] / samples.length, sum[2] / samples.length];
}

function luminance(red: number, green: number, blue: number): number {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

function saturation(red: number, green: number, blue: number): number {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  return max <= 0 ? 0 : (max - min) / max;
}

function hueDegrees(red: number, green: number, blue: number): number {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta <= Number.EPSILON) return 0;

  let hue = 0;
  if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  return hue < 0 ? hue + 360 : hue;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Nao foi possivel carregar a planta."));
    image.src = src;
  });
}
