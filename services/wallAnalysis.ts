import type { WallMaterial, WallSegment } from "@/types/heatmap";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

type ApiWall = {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  material: string;
  confidence: number;
  thickness_px: number;
};

export type WallAnalysisResult = {
  walls: ApiWall[];
  width: number;
  height: number;
  count: number;
  method: "pdf-vector" | "image-hough" | "ai-vision";
  model?: string;
};

const KNOWN_MATERIALS = new Set<WallMaterial>([
  "drywall", "glass", "wood", "brick", "concrete", "reinforced_concrete", "stone", "metal",
]);

function toWallMaterial(value: string): WallMaterial {
  return KNOWN_MATERIALS.has(value as WallMaterial) ? (value as WallMaterial) : "concrete";
}

export async function analyzeBarriersWithAI(
  file: File,
  targetWidth: number,
  targetHeight: number,
  model = "claude-haiku-4-5-20251001",
): Promise<WallSegment[]> {
  const form = new FormData();
  form.append("floor_plan", file);
  form.append("render_width", String(targetWidth));
  form.append("render_height", String(targetHeight));
  form.append("model", model);

  const response = await fetch(`${BACKEND_URL}/api/analyze-barriers-ai`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: "" })) as { detail?: string };
    throw new Error(body.detail || `Analise IA falhou (${response.status})`);
  }

  const result = (await response.json()) as WallAnalysisResult;

  return result.walls.map((wall, index) => ({
    id: wall.id || `ai-wall-${index + 1}`,
    start: { x: Math.round(wall.start.x * 10) / 10, y: Math.round(wall.start.y * 10) / 10 },
    end: { x: Math.round(wall.end.x * 10) / 10, y: Math.round(wall.end.y * 10) / 10 },
    material: toWallMaterial(wall.material),
  }));
}

export async function analyzeWallsFromDataUrl(
  dataUrl: string,
  targetWidth: number,
  targetHeight: number,
): Promise<WallSegment[]> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const ext = blob.type === "image/jpeg" ? "jpeg" : "png";
  const file = new File([blob], `floorplan.${ext}`, { type: blob.type || "image/png" });
  return analyzeWallsFromFile(file, targetWidth, targetHeight, 0);
}

export async function analyzeWallsFromFile(
  file: File,
  targetWidth: number,
  targetHeight: number,
  page = 0,
): Promise<WallSegment[]> {
  const form = new FormData();
  form.append("floor_plan", file);
  form.append("page", String(page));
  form.append("render_width", String(targetWidth));

  const response = await fetch(`${BACKEND_URL}/api/analyze-walls`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Analise falhou (${response.status}): ${body.slice(0, 200)}`);
  }

  const result = (await response.json()) as WallAnalysisResult;

  const scaleX = targetWidth / Math.max(result.width, 1);
  const scaleY = targetHeight / Math.max(result.height, 1);

  return result.walls.map((wall, index) => ({
    id: wall.id || `analyzed-wall-${index + 1}`,
    start: {
      x: Math.round(wall.start.x * scaleX * 10) / 10,
      y: Math.round(wall.start.y * scaleY * 10) / 10,
    },
    end: {
      x: Math.round(wall.end.x * scaleX * 10) / 10,
      y: Math.round(wall.end.y * scaleY * 10) / 10,
    },
    material: toWallMaterial(wall.material),
  }));
}
