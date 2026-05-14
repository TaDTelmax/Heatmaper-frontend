import { clamp, sampleLine } from "./spatial";
import type { RfPoint, WallMaterial } from "@/types/heatmap";

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
  if (stats.blueRatio > 0.18 || (stats.gapRatio > 0.36 && stats.thicknessPx <= 3.2)) {
    return analysis("glass", colorConfidence, stats);
  }
  if (stats.redOrangeRatio > 0.24) {
    return analysis("brick", colorConfidence, stats);
  }
  if (stats.yellowBrownRatio > 0.2) {
    return analysis("wood", colorConfidence, stats);
  }

  const thicknessConfidence = clamp(0.28 + stats.coverage * 0.44 + stats.thicknessPx / 16, 0.24, 0.9);
  if (stats.darkNeutralRatio > 0.66 && stats.thicknessPx >= 11) {
    return analysis("metal", thicknessConfidence, stats);
  }
  if (stats.thicknessPx >= 8.4 || (stats.darkNeutralRatio > 0.42 && stats.thicknessPx >= 6.6)) {
    return analysis("reinforced_concrete", thicknessConfidence, stats);
  }
  if (stats.thicknessPx >= 4.6 || (stats.neutralRatio > 0.54 && stats.averageLuminance < 0.48)) {
    return analysis("concrete", thicknessConfidence, stats);
  }

  return analysis("drywall", clamp(0.3 + stats.coverage * 0.44, 0.24, 0.82), stats);
}

function analysis(material: WallMaterial, confidence: number, stats: TraceStats): MaterialTraceAnalysis {
  return {
    material,
    confidence: Number(confidence.toFixed(2)),
    coverage: Number(stats.coverage.toFixed(2)),
    thicknessPx: Number(stats.thicknessPx.toFixed(1)),
  };
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
