import { rssiLegendTicks, rssiToColor } from "./colorScale";
import type { RouterPlacement } from "@/types/floorplan";
import type { HeatmapLayer, WifiBand } from "@/types/heatmap";
import type { MeasurementPoint } from "@/types/measurement";

export const DEFAULT_IDW_POWER = 2.2;
export const IDW_ZERO_DISTANCE_EPSILON = 1e-9;

type Rgb = [number, number, number];

type WeightedRssiPoint = {
  x_px: number;
  y_px: number;
  rssi: number;
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
  return band === "24ghz" ? point.rssi_24ghz : point.rssi_5ghz;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, Number.EPSILON), 0, 1);
  return t * t * (3 - 2 * t);
}

function rssiStrength(rssi: number): number {
  return clamp((rssi + 80) / 60, 0, 1);
}

function usablePointsForBand(points: MeasurementPoint[], band: WifiBand): WeightedRssiPoint[] {
  return points
    .map((point) => {
      const rssi = rssiForBand(point, band);
      return rssi === null ? null : { x_px: point.x_px, y_px: point.y_px, rssi };
    })
    .filter((point): point is WeightedRssiPoint => point !== null);
}

export function idwWeight(distancePx: number, power = DEFAULT_IDW_POWER): number {
  if (distancePx <= IDW_ZERO_DISTANCE_EPSILON) return Number.POSITIVE_INFINITY;
  return 1 / distancePx ** power;
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

function estimatePointSpacing(points: WeightedRssiPoint[], maxDimension: number): number {
  if (points.length < 2) return maxDimension * 0.32;

  const nearestDistances = points.map((point, index) => {
    let nearest = Number.POSITIVE_INFINITY;
    for (let otherIndex = 0; otherIndex < points.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = points[otherIndex];
      nearest = Math.min(nearest, Math.hypot(point.x_px - other.x_px, point.y_px - other.y_px));
    }
    return nearest;
  });

  nearestDistances.sort((a, b) => a - b);
  return nearestDistances[Math.floor(nearestDistances.length / 2)] || maxDimension * 0.32;
}

function reachRadiusPx(point: WeightedRssiPoint, maxDimension: number, pointSpacing: number): number {
  const strength = rssiStrength(point.rssi);
  const spacingReach = pointSpacing * (0.75 + strength * 0.62);
  const signalReach = maxDimension * (0.08 + Math.pow(strength, 0.85) * 0.28);
  return clamp(Math.max(spacingReach, signalReach), maxDimension * 0.08, maxDimension * 0.48);
}

function pointReachCoverage(x: number, y: number, points: WeightedRssiPoint[], maxDimension: number, pointSpacing: number): number {
  let coverage = 0;

  for (const point of points) {
    const radius = reachRadiusPx(point, maxDimension, pointSpacing);
    const distance = Math.hypot(x - point.x_px, y - point.y_px);
    if (distance >= radius) continue;

    const centerToEdge = 1 - distance / radius;
    const falloff = smoothstep(0, 1, centerToEdge);
    coverage = Math.max(coverage, falloff * (0.72 + rssiStrength(point.rssi) * 0.28));
  }

  return clamp(coverage, 0, 1);
}

export function createHeatmapLayer(
  width: number,
  height: number,
  points: MeasurementPoint[],
  band: WifiBand,
  power = DEFAULT_IDW_POWER,
  houseMask: Uint8Array | null = null,
): HeatmapLayer {
  const usable = usablePointsForBand(points, band);
  if (!usable.length) {
    throw new Error("IDW requer ao menos um ponto com RSSI.");
  }

  const maxDimension = Math.max(width, height);
  const sampleStep = clamp(Math.round(maxDimension / 520), 1, 3);
  const gridWidth = Math.ceil(width / sampleStep);
  const gridHeight = Math.ceil(height / sampleStep);
  const gridSize = gridWidth * gridHeight;
  const values = new Float32Array(gridSize);
  const coverages = new Float32Array(gridSize);
  const active = new Uint8Array(gridSize);
  const pointSpacing = estimatePointSpacing(usable, maxDimension);

  let minRssi = Number.POSITIVE_INFINITY;
  let maxRssi = Number.NEGATIVE_INFINITY;
  let total = 0;
  let count = 0;

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = Math.min(width - 1, gx * sampleStep + sampleStep * 0.5);
      const y = Math.min(height - 1, gy * sampleStep + sampleStep * 0.5);
      const maskIndex = Math.floor(y) * width + Math.floor(x);
      const gridIndex = gy * gridWidth + gx;
      if (houseMask && houseMask[maskIndex] !== 1) continue;

      const value = idwInterpolateUsable(x, y, usable, power);
      const coverage = pointReachCoverage(x, y, usable, maxDimension, pointSpacing);
      values[gridIndex] = value;
      coverages[gridIndex] = coverage;
      active[gridIndex] = 1;
      minRssi = Math.min(minRssi, value);
      maxRssi = Math.max(maxRssi, value);
      total += value;
      count += 1;
    }
  }

  const rawCanvas = document.createElement("canvas");
  rawCanvas.width = gridWidth;
  rawCanvas.height = gridHeight;
  const rawContext = rawCanvas.getContext("2d");
  if (!rawContext) throw new Error("Canvas indisponivel para gerar heatmap.");

  const imageData = rawContext.createImageData(gridWidth, gridHeight);
  const valueAt = (gx: number, gy: number, fallback: number): number => {
    const x = clamp(gx, 0, gridWidth - 1);
    const y = clamp(gy, 0, gridHeight - 1);
    const index = y * gridWidth + x;
    return active[index] ? values[index] : fallback;
  };

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const gridIndex = gy * gridWidth + gx;
      const offset = gridIndex * 4;
      if (!active[gridIndex]) continue;

      const value = values[gridIndex];
      const coverage = coverages[gridIndex];
      if (coverage <= 0.025) continue;

      const left = valueAt(gx - 1, gy, value);
      const right = valueAt(gx + 1, gy, value);
      const up = valueAt(gx, gy - 1, value);
      const down = valueAt(gx, gy + 1, value);
      const slopeX = (right - left) / 60;
      const slopeY = (down - up) / 60;
      const heightStrength = rssiStrength(value);
      const edgeRim = Math.pow(4 * coverage * (1 - coverage), 1.35);
      const light = clamp(1 + (-slopeX * 0.9 - slopeY * 1.1) + heightStrength * 0.1, 0.74, 1.24);
      const edgeShade = clamp(1 - edgeRim * 0.16, 0.78, 1);
      const specular = Math.pow(heightStrength, 1.8) * coverage * 0.13;
      const [baseRed, baseGreen, baseBlue] = rssiToColor(value);
      let red = baseRed * light * edgeShade;
      let green = baseGreen * light * edgeShade;
      let blue = baseBlue * light * edgeShade;

      red += (255 - red) * specular;
      green += (255 - green) * specular;
      blue += (255 - blue) * specular;

      imageData.data[offset] = Math.round(clamp(red, 0, 255));
      imageData.data[offset + 1] = Math.round(clamp(green, 0, 255));
      imageData.data[offset + 2] = Math.round(clamp(blue, 0, 255));
      imageData.data[offset + 3] = Math.round(clamp(42 + coverage * 198 + edgeRim * 24, 0, 242));
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
  context.shadowColor = "rgba(15, 23, 42, 0.2)";
  context.shadowBlur = clamp(Math.round(maxDimension / 180), 3, 9);
  context.shadowOffsetX = clamp(Math.round(maxDimension / 700), 1, 3);
  context.shadowOffsetY = clamp(Math.round(maxDimension / 520), 1, 4);
  context.filter = `blur(${clamp(maxDimension / 420, 1.4, 4.8).toFixed(1)}px) saturate(1.12) contrast(1.04)`;
  context.drawImage(rawCanvas, 0, 0, width, height);
  context.filter = "none";
  context.shadowColor = "transparent";

  return {
    band,
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
    minRssi: count ? Number(minRssi.toFixed(1)) : 0,
    maxRssi: count ? Number(maxRssi.toFixed(1)) : 0,
    avgRssi: Number((total / Math.max(count, 1)).toFixed(1)),
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
  const longThin = aspect > 12 || aspect < 1 / 12;
  const tiny = component.area < Math.max(36, width * height * 0.00004);
  return tiny || (longThin && density < 0.72);
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
  const mainComponent = components[0];
  if (!mainComponent) return null;

  const mainPad = Math.round(Math.max(width, height) * 0.04);
  const mainBox: Bounds = {
    minX: Math.max(0, mainComponent.minX - mainPad),
    minY: Math.max(0, mainComponent.minY - mainPad),
    maxX: Math.min(width - 1, mainComponent.maxX + mainPad),
    maxY: Math.min(height - 1, mainComponent.maxY + mainPad),
  };
  const overlapsMainBox = (component: MaskComponent): boolean =>
    component.maxX >= mainBox.minX &&
    component.minX <= mainBox.maxX &&
    component.maxY >= mainBox.minY &&
    component.minY <= mainBox.maxY;

  const structuralComponents = components.filter(
    (component) =>
      component === mainComponent ||
      (component.area >= mainComponent.area * 0.018 &&
        overlapsMainBox(component) &&
        !componentLooksLikeAnnotation(component, width, height)),
  );

  const mask = buildStructuralFootprintMask(structuralComponents, width, height);
  return mask.some((value) => value === 1) ? mask : null;
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
  const legendHeight = Math.round(18 * scale);
  const labelSpace = Math.round(22 * scale);
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
  const gradient = context.createLinearGradient(legendX, 0, legendX + legendW, 0);
  for (const tick of rssiLegendTicks) {
    const offset = Math.max(0, Math.min(1, (tick.value + 80) / 60));
    gradient.addColorStop(offset, tick.color);
  }

  context.fillStyle = gradient;
  context.fillRect(legendX, legendY, legendW, legendHeight);
  context.strokeStyle = "rgba(17, 24, 39, 0.16)";
  context.lineWidth = Math.max(1, Math.round(scale));
  context.strokeRect(legendX, legendY, legendW, legendHeight);

  context.fillStyle = "#111827";
  context.font = `${Math.max(8, Math.round(10 * scale))}px Segoe UI, Arial, sans-serif`;
  context.textBaseline = "top";
  rssiLegendTicks.forEach((tick, index) => {
    const x = legendX + (legendW * index) / Math.max(1, rssiLegendTicks.length - 1);
    context.textAlign = index === 0 ? "left" : index === rssiLegendTicks.length - 1 ? "right" : "center";
    context.fillText(tick.label, x, legendY + legendHeight + Math.round(4 * scale));
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
