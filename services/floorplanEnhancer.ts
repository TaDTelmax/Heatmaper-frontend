"use client";

const BACKEND = "http://localhost:8000";

export type EnhanceResult = {
  dataUrl: string;
  width: number;
  height: number;
};

async function tryBackendEnhance(blob: Blob): Promise<EnhanceResult | null> {
  try {
    const form = new FormData();
    form.append("floor_plan", blob, "floorplan.png");

    const response = await fetch(`${BACKEND}/api/enhance-floorplan`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;

    const resultBlob = await response.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Leitura do resultado falhou."));
      reader.readAsDataURL(resultBlob);
    });
    const dimensions = await imageDimensions(dataUrl);
    return { dataUrl, ...dimensions };
  } catch {
    return null;
  }
}

function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Imagem inválida retornada."));
    img.src = dataUrl;
  });
}

// Plain canvas threshold — no CLAHE/adaptive-threshold/hatch-cleanup like the
// backend's OpenCV pipeline, but keeps "Gerar Planta P&B" working when the
// backend is unreachable (down, CORS-blocked, or a browser extension
// intercepting the request) instead of throwing an unhandled error.
async function browserFallbackEnhance(sourceDataUrl: string): Promise<EnhanceResult> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Nao foi possivel carregar a imagem para processar."));
    img.src = sourceDataUrl;
  });

  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponivel para processar a planta.");
  ctx.drawImage(image, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const THRESHOLD = 200;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const value = luminance < THRESHOLD ? 0 : 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  return { dataUrl: canvas.toDataURL("image/png"), width, height };
}

export async function enhanceFloorplanBW(sourceDataUrl: string): Promise<EnhanceResult> {
  const res = await fetch(sourceDataUrl);
  const blob = await res.blob();

  const backendResult = await tryBackendEnhance(blob);
  if (backendResult) return backendResult;

  return browserFallbackEnhance(sourceDataUrl);
}
