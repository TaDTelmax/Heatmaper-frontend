import type { MeasurementPoint } from "@/types/measurement";

type BackendDetectionPoint = {
  point_id: string;
  x_px: number;
  y_px: number;
};

type DetectionResult = {
  points: MeasurementPoint[];
  detail: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function createPoint(point_id: string, x_px: number, y_px: number, source: MeasurementPoint["source"]): MeasurementPoint {
  return {
    point_id,
    x_px: Math.round(x_px * 100) / 100,
    y_px: Math.round(y_px * 100) / 100,
    rssi_24ghz: null,
    rssi_5ghz: null,
    rssi_6ghz: null,
    distance_m: null,
    timestamp: nowIso(),
    source,
  };
}

async function backendDetection(file: File): Promise<DetectionResult | null> {
  try {
    const form = new FormData();
    form.append("floor_plan", file);
    const response = await fetch("/api/detect-points", { method: "POST", body: form });
    if (!response.ok) return null;
    const body = (await response.json()) as { points?: BackendDetectionPoint[]; detail?: string };
    if (!Array.isArray(body.points) || !body.points.length) return null;
    return {
      points: body.points
        .map((point, index) => createPoint(point.point_id || `P${index + 1}`, point.x_px, point.y_px, "detected")),
      detail: body.detail || "Pontos detectados pelo backend.",
    };
  } catch {
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Nao foi possivel carregar a planta."));
    image.src = src;
  });
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Nao foi possivel ler a imagem."));
    reader.readAsDataURL(file);
  });
}

type Component = {
  area: number;
  redArea: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sumX: number;
  sumY: number;
};

type MarkerCandidate = {
  x_px: number;
  y_px: number;
  score: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function detectionLimits(width: number, height: number) {
  const maxDimension = Math.max(width, height);
  const area = width * height;
  return {
    minArea: Math.max(18, Math.round(area * 0.000006)),
    maxArea: Math.max(700, Math.min(6500, Math.round(area * 0.0022))),
    minBox: clamp(Math.round(maxDimension * 0.004), 6, 18),
    maxBox: clamp(Math.round(maxDimension * 0.055), 38, 118),
    minDistance: clamp(Math.round(maxDimension * 0.018), 18, 62),
    maxPoints: clamp(Math.round(Math.sqrt(area) / 18), 8, 80),
  };
}

function dedupeCandidates(candidates: MarkerCandidate[], width: number, height: number): MarkerCandidate[] {
  const limits = detectionLimits(width, height);
  const accepted: MarkerCandidate[] = [];

  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    const duplicate = accepted.some((point) => Math.hypot(point.x_px - candidate.x_px, point.y_px - candidate.y_px) < limits.minDistance);
    if (!duplicate) accepted.push(candidate);
    if (accepted.length >= limits.maxPoints) break;
  }

  return accepted.sort((a, b) => a.y_px - b.y_px || a.x_px - b.x_px);
}

function pointsFromCandidates(candidates: MarkerCandidate[], source: MeasurementPoint["source"]): MeasurementPoint[] {
  return candidates.map((candidate, index) => createPoint(`P${index + 1}`, candidate.x_px, candidate.y_px, source));
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
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

function candidatesFromComponents(components: Component[], width: number, height: number): MarkerCandidate[] {
  const limits = detectionLimits(width, height);
  const maxDimension = Math.max(width, height);
  const candidates: MarkerCandidate[] = [];

  for (const component of components) {
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const longAxis = Math.max(boxWidth, boxHeight);
    const shortAxis = Math.min(boxWidth, boxHeight);
    const aspect = boxWidth / Math.max(boxHeight, 1);
    const redDensity = component.redArea / Math.max(boxWidth * boxHeight, 1);
    const componentDensity = component.area / Math.max(boxWidth * boxHeight, 1);
    const longThinAnnotation = longAxis > maxDimension * 0.08 && shortAxis <= Math.max(8, maxDimension * 0.01);

    if (component.redArea < limits.minArea || component.redArea > limits.maxArea) continue;
    if (boxWidth < limits.minBox || boxHeight < limits.minBox) continue;
    if (boxWidth > limits.maxBox || boxHeight > limits.maxBox) continue;
    if (aspect < 0.5 || aspect > 2) continue;
    if (redDensity < 0.045 || componentDensity > 0.96) continue;
    if (longThinAnnotation) continue;

    const shapeScore = Math.min(aspect, 1 / aspect);
    const densityScore = clamp(redDensity * 4.2, 0.2, 1.4);
    candidates.push({
      x_px: component.sumX / Math.max(component.redArea, 1),
      y_px: component.sumY / Math.max(component.redArea, 1),
      score: component.redArea * shapeScore * densityScore,
    });
  }

  return dedupeCandidates(candidates, width, height);
}

async function browserRedMarkerDetection(file: File): Promise<DetectionResult> {
  const dataUrl = await fileToDataUrl(file);
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas indisponivel para deteccao.");
  context.drawImage(image, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const redMask = new Uint8Array(width * height);
  const dilation = clamp(Math.round(Math.max(width, height) / 900), 1, 4);
  const isMarkerPixel = (index: number): boolean => {
    const offset = index * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const saturation = maxChannel <= 0 ? 0 : (maxChannel - minChannel) / maxChannel;
    return alpha > 80 && red > 155 && green < 150 && blue < 140 && red - green > 44 && red - blue > 58 && saturation > 0.32;
  };

  for (let index = 0; index < width * height; index += 1) {
    if (isMarkerPixel(index)) redMask[index] = 1;
  }

  const markerMask = dilateMask(redMask, width, height, dilation);
  const visited = new Uint8Array(width * height);
  const components: Component[] = [];

  for (let start = 0; start < width * height; start += 1) {
    if (visited[start] || !markerMask[start]) continue;
    const stack = [start];
    visited[start] = 1;
    const component: Component = {
      area: 0,
      redArea: 0,
      minX: width,
      minY: height,
      maxX: 0,
      maxY: 0,
      sumX: 0,
      sumY: 0,
    };
    while (stack.length) {
      const current = stack.pop() as number;
      const x = current % width;
      const y = Math.floor(current / width);
      component.area += 1;
      component.minX = Math.min(component.minX, x);
      component.minY = Math.min(component.minY, y);
      component.maxX = Math.max(component.maxX, x);
      component.maxY = Math.max(component.maxY, y);
      if (redMask[current]) {
        component.redArea += 1;
        component.sumX += x;
        component.sumY += y;
      }

      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!visited[next] && markerMask[next]) {
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    components.push(component);
  }

  const candidates = candidatesFromComponents(components, width, height);
  const points = pointsFromCandidates(candidates, "detected");

  return {
    points,
    detail: points.length
      ? `Marcadores vermelhos detectados dinamicamente (${points.length}).`
      : "Nenhum marcador vermelho valido encontrado.",
  };
}

export async function detectMeasurementPoints(file: File): Promise<DetectionResult> {
  const browser = await browserRedMarkerDetection(file);
  if (browser.points.length) return browser;

  const backend = await backendDetection(file);
  if (!backend) return browser;
  const dataUrl = await fileToDataUrl(file);
  const image = await loadImage(dataUrl);
  const candidates = backend.points.map((point) => ({
    x_px: point.x_px,
    y_px: point.y_px,
    score: 1,
  }));
  const points = pointsFromCandidates(dedupeCandidates(candidates, image.naturalWidth, image.naturalHeight), "detected");
  return {
    points,
    detail: points.length
      ? `Backend usado como fallback com deduplicacao dinamica (${points.length}).`
      : "Nenhum marcador visual encontrado.",
  };
}
