"use client";

// Manual orientation fix for floor plans that render sideways or upside-down
// relative to the user's expectation (common with architectural PDFs authored
// with an arbitrary page orientation). Pure canvas transform, no resampling
// distortion — only 90-degree rotations and axis mirrors.
export type FloorplanTransformKind = "rotate-cw" | "rotate-ccw" | "rotate-180" | "flip-h" | "flip-v";

export type FloorplanTransformResult = {
  dataUrl: string;
  width: number;
  height: number;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Nao foi possivel carregar a imagem para transformar."));
    img.src = src;
  });
}

export async function transformFloorplanImage(
  dataUrl: string,
  kind: FloorplanTransformKind,
): Promise<FloorplanTransformResult> {
  const image = await loadImage(dataUrl);
  const srcW = image.naturalWidth;
  const srcH = image.naturalHeight;
  const swapped = kind === "rotate-cw" || kind === "rotate-ccw";
  const outW = swapped ? srcH : srcW;
  const outH = swapped ? srcW : srcH;

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponivel para transformar a planta.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW, outH);

  ctx.save();
  switch (kind) {
    case "rotate-cw":
      ctx.translate(outW, 0);
      ctx.rotate(Math.PI / 2);
      break;
    case "rotate-ccw":
      ctx.translate(0, outH);
      ctx.rotate(-Math.PI / 2);
      break;
    case "rotate-180":
      ctx.translate(outW, outH);
      ctx.rotate(Math.PI);
      break;
    case "flip-h":
      ctx.translate(outW, 0);
      ctx.scale(-1, 1);
      break;
    case "flip-v":
      ctx.translate(0, outH);
      ctx.scale(1, -1);
      break;
  }
  ctx.drawImage(image, 0, 0, srcW, srcH);
  ctx.restore();

  return { dataUrl: canvas.toDataURL("image/png"), width: outW, height: outH };
}

// Maps a pixel coordinate through the same geometric transform applied to the
// image (derived from the canvas transform matrices in transformFloorplanImage)
// so previously-placed APs/points/walls stay put on the walls they were
// measured against, instead of being wiped whenever the plan is rotated or
// mirrored. `oldWidth`/`oldHeight` are the floorplan's dimensions *before*
// this transform (i.e. what the coordinate was originally placed against).
export function transformPixelCoordinate(
  x: number,
  y: number,
  kind: FloorplanTransformKind,
  oldWidth: number,
  oldHeight: number,
): { x: number; y: number } {
  switch (kind) {
    case "rotate-cw":
      return { x: oldHeight - y, y: x };
    case "rotate-ccw":
      return { x: y, y: oldWidth - x };
    case "rotate-180":
      return { x: oldWidth - x, y: oldHeight - y };
    case "flip-h":
      return { x: oldWidth - x, y };
    case "flip-v":
      return { x, y: oldHeight - y };
  }
}
