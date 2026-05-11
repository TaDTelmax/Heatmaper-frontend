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
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sumX: number;
  sumY: number;
};

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
  const visited = new Uint8Array(width * height);
  const components: Component[] = [];

  function isMarkerPixel(index: number): boolean {
    const offset = index * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];
    return alpha > 80 && red > 160 && green < 145 && blue < 130 && red - green > 42 && red - blue > 58;
  }

  for (let start = 0; start < width * height; start += 1) {
    if (visited[start] || !isMarkerPixel(start)) continue;
    const stack = [start];
    visited[start] = 1;
    const component: Component = {
      area: 0,
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
      component.sumX += x;
      component.sumY += y;

      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!visited[next] && isMarkerPixel(next)) {
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const density = component.area / Math.max(boxWidth * boxHeight, 1);
    if (component.area >= 18 && component.area <= 4200 && boxWidth <= 110 && boxHeight <= 110 && density > 0.12) {
      components.push(component);
    }
  }

  const sorted = components
    .sort((a, b) => a.sumY / a.area - b.sumY / b.area || a.sumX / a.area - b.sumX / b.area);

  return {
    points: sorted.map((component, index) =>
      createPoint(`P${index + 1}`, component.sumX / component.area, component.sumY / component.area, "detected"),
    ),
    detail: sorted.length ? "Pontos vermelhos detectados na imagem." : "Nenhum marcador visual encontrado.",
  };
}

export async function detectMeasurementPoints(file: File): Promise<DetectionResult> {
  const backend = await backendDetection(file);
  if (backend) return backend;
  return browserRedMarkerDetection(file);
}
