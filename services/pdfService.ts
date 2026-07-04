"use client";

// Output DPI the backend renders at when it can crop directly from the PDF's
// vector paths (see `_tryBackendCropPdf` / backend `crop_floorplan`'s
// `out_dpi` default). Auto-detected scale ("ESCALA 1:N" in the title block)
// must be computed against whichever DPI actually produced the final image,
// not the pdfjs preview render's DPI, or the resulting px/m is wrong.
const BACKEND_CROP_OUT_DPI = 250;

type PdfjsLib = typeof import("pdfjs-dist");
let pdfjsCache: PdfjsLib | null = null;

async function loadPdfjsLib(): Promise<PdfjsLib> {
  if (pdfjsCache) return pdfjsCache;
  const lib = await import("pdfjs-dist");
  lib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${lib.version}/build/pdf.worker.min.mjs`;
  pdfjsCache = lib;
  return lib;
}

export type PdfInfo = {
  pageCount: number;
  title: string | null;
};

export async function getPdfInfo(file: File): Promise<PdfInfo> {
  const lib = await loadPdfjsLib();
  const buffer = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buffer }).promise;
  let title: string | null = null;
  try {
    const meta = await doc.getMetadata();
    title = ((meta.info as Record<string, unknown>)?.Title as string) ?? null;
    if (title === "") title = null;
  } catch {
    // metadata not available
  }
  const result: PdfInfo = { pageCount: doc.numPages, title };
  await doc.cleanup();
  return result;
}

export type PdfMeasurements = {
  scaleFactor: string | null;
  areaSqM: number | null;
  widthM: number | null;
  heightM: number | null;
  rooms: string[];
};

const ROOM_KEYWORDS = [
  "sala de estar", "sala de jantar", "sala", "quarto",
  "dormitório", "dormitorio", "suíte", "suite",
  "banheiro", "lavabo", "wc", "bwc",
  "cozinha", "copa", "despensa",
  "lavanderia", "área de serviço", "area de servico",
  "garagem", "varanda", "sacada",
  "corredor", "hall", "circulação", "circulacao",
  "escritório", "escritorio", "closet",
];

function parseNumber(str: string): number | null {
  const normalized = str.replace(",", ".").replace(/\s/g, "");
  const value = parseFloat(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parseMeasurements(text: string): PdfMeasurements {
  const lower = text.toLowerCase();

  const scaleMatch = text.match(/1\s*[:\/]\s*(\d+)/i);
  const scaleFactor = scaleMatch ? `1:${scaleMatch[1]}` : null;

  // Area: "150m²", "150 m2", "150,50m²"
  const areaMatch = text.match(/([\d]+[,.]?[\d]*)\s*m[²2]/i);
  const areaSqM = areaMatch ? parseNumber(areaMatch[1]) : null;

  // Dimensions: "12,00 x 8,00", "12.5 X 8.0"
  let widthM: number | null = null;
  let heightM: number | null = null;
  const dimMatch = text.match(/([\d]+[,.][\d]+)\s*[xX×]\s*([\d]+[,.][\d]+)/);
  if (dimMatch) {
    const w = parseNumber(dimMatch[1]);
    const h = parseNumber(dimMatch[2]);
    if (w && h && w < 1000 && h < 1000) {
      widthM = w;
      heightM = h;
    }
  }

  const rooms: string[] = [];
  for (const room of ROOM_KEYWORDS) {
    if (lower.includes(room)) {
      const label = room.charAt(0).toUpperCase() + room.slice(1);
      if (!rooms.includes(label)) rooms.push(label);
    }
  }

  return { scaleFactor, areaSqM, widthM, heightM, rooms };
}

export type PdfPageResult = {
  dataUrl: string;
  width: number;
  height: number;
  imageBlob: Blob;
  pageCount: number;
  detectedScale: number | null;
  textSnippet: string;
};

function parseScaleFromText(text: string, renderDpi: number): number | null {
  const match = text.match(/1\s*[:\/]\s*(\d+)/);
  if (!match) return null;
  const scaleFactor = parseInt(match[1], 10);
  if (scaleFactor < 1 || scaleFactor > 10000) return null;
  return Math.round((renderDpi * 39.3701) / scaleFactor);
}

type PixelBBox = { left: number; top: number; right: number; bottom: number };

// Isolates the largest contiguous dense region within [left,right]x[top,bottom]
// via a fine-grained density grid + 4-connected flood fill. A legend/title
// block panel can be just as locally dense as the floor plan itself, but it's
// always a smaller, separate island across a white gap — connected-component
// analysis (unlike a simple "scan for the first dense pixel" heuristic) tells
// them apart by area rather than density, and a small grid cell size (~1% of
// the image's longest side) keeps even a narrow separating gap resolvable.
// Returns null when nothing clearly smaller than the whole region is found
// (nothing to gain — avoids shrinking a plan that has no separate legend).
function isolateLargestDenseCluster(
  left: number,
  top: number,
  right: number,
  bottom: number,
  dark: (x: number, y: number) => boolean,
): PixelBBox | null {
  const w = right - left;
  const h = bottom - top;
  if (w < 60 || h < 60) return null;

  const cellSize = Math.max(3, Math.round(Math.max(w, h) / 300));
  const gw = Math.max(1, Math.ceil(w / cellSize));
  const gh = Math.max(1, Math.ceil(h / cellSize));
  const sampleStep = Math.max(1, Math.round(cellSize / 4));

  const density = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy += 1) {
    const y0 = top + gy * cellSize;
    const y1 = Math.min(bottom, y0 + cellSize);
    for (let gx = 0; gx < gw; gx += 1) {
      const x0 = left + gx * cellSize;
      const x1 = Math.min(right, x0 + cellSize);
      let n = 0;
      let t = 0;
      for (let y = y0; y < y1; y += sampleStep) {
        for (let x = x0; x < x1; x += sampleStep) {
          if (dark(x, y)) n += 1;
          t += 1;
        }
      }
      density[gy * gw + gx] = t > 0 ? n / t : 0;
    }
  }

  const DENSE_CELL = 0.035;
  const binary = new Uint8Array(gw * gh);
  for (let i = 0; i < density.length; i += 1) {
    binary[i] = density[i] >= DENSE_CELL ? 1 : 0;
  }

  // 4-connected flood fill, iterative (no recursion) — find the largest island.
  const visited = new Uint8Array(gw * gh);
  let best: { cells: number; gx0: number; gy0: number; gx1: number; gy1: number } | null = null;
  const stack: number[] = [];

  for (let start = 0; start < binary.length; start += 1) {
    if (binary[start] !== 1 || visited[start]) continue;
    let cells = 0;
    const gy0Start = Math.floor(start / gw);
    const gx0Start = start - gy0Start * gw;
    let gx0 = gx0Start, gy0 = gy0Start, gx1 = gx0Start, gy1 = gy0Start;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length) {
      const cur = stack.pop() as number;
      const cy = Math.floor(cur / gw);
      const cx = cur - cy * gw;
      cells += 1;
      if (cx < gx0) gx0 = cx;
      if (cx > gx1) gx1 = cx;
      if (cy < gy0) gy0 = cy;
      if (cy > gy1) gy1 = cy;
      if (cx > 0 && binary[cur - 1] === 1 && !visited[cur - 1]) { visited[cur - 1] = 1; stack.push(cur - 1); }
      if (cx < gw - 1 && binary[cur + 1] === 1 && !visited[cur + 1]) { visited[cur + 1] = 1; stack.push(cur + 1); }
      if (cy > 0 && binary[cur - gw] === 1 && !visited[cur - gw]) { visited[cur - gw] = 1; stack.push(cur - gw); }
      if (cy < gh - 1 && binary[cur + gw] === 1 && !visited[cur + gw]) { visited[cur + gw] = 1; stack.push(cur + gw); }
    }
    if (!best || cells > best.cells) best = { cells, gx0, gy0, gx1, gy1 };
  }

  if (!best || best.cells < 4) return null;

  let bx0 = left + best.gx0 * cellSize;
  let by0 = top + best.gy0 * cellSize;
  let bx1 = Math.min(right, left + (best.gx1 + 1) * cellSize);
  let by1 = Math.min(bottom, top + (best.gy1 + 1) * cellSize);

  const clusterArea = (bx1 - bx0) * (by1 - by0);
  if (clusterArea >= w * h * 0.92) return null;

  // Tighten to actual dark-pixel extents within the cluster (grid cells are
  // coarse; this trims any leftover margin at cell resolution).
  function rowHasDark(y: number, x0: number, x1: number): boolean {
    const step = Math.max(1, Math.round((x1 - x0) / 500));
    for (let x = x0; x < x1; x += step) if (dark(x, y)) return true;
    return false;
  }
  function colHasDark(x: number, y0: number, y1: number): boolean {
    const step = Math.max(1, Math.round((y1 - y0) / 500));
    for (let y = y0; y < y1; y += step) if (dark(x, y)) return true;
    return false;
  }
  while (by0 < by1 && !rowHasDark(by0, bx0, bx1)) by0 += 1;
  while (by1 > by0 && !rowHasDark(by1, bx0, bx1)) by1 -= 1;
  while (bx0 < bx1 && !colHasDark(bx0, by0, by1)) bx0 += 1;
  while (bx1 > bx0 && !colHasDark(bx1, by0, by1)) bx1 -= 1;

  if (bx1 - bx0 < 40 || by1 - by0 < 40) return null;

  return { left: bx0, top: by0, right: bx1, bottom: by1 };
}

// Crops a canvas to the 2D floor plan drawing area.
//
// Step 1 — bounding-box trim: removes rows/cols that are entirely white at
//   every edge (top, bottom, left, right).
// Step 2 — legend removal: scans inward from each edge (up to MAX_STRIP of
//   the content span). Legend text / info strips are sparse (density ≈ 2–4 %).
//   Drawing border lines are solid (density ≈ 50–100 %). The scan stops at
//   the first row/col whose density ≥ DENSE — that becomes the new crop edge.
//   Using span instead of density fails when legend items appear at both
//   extremes of a row (large span despite sparse content).
export function cropFloorplanFromCanvas(sourceCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = sourceCanvas.getContext("2d");
  if (!ctx) return sourceCanvas;

  const { width, height } = sourceCanvas;
  const px = ctx.getImageData(0, 0, width, height).data;
  const BG = 246; // pixels lighter than this on all RGB channels = white/background

  function dark(x: number, y: number): boolean {
    const i = (y * width + x) * 4;
    return px[i] < BG || px[i + 1] < BG || px[i + 2] < BG;
  }

  function rowDensity(y: number, x0: number, x1: number): number {
    const step = Math.max(1, Math.round((x1 - x0) / 600));
    let n = 0, t = 0;
    for (let x = x0; x < x1; x += step) { if (dark(x, y)) n++; t++; }
    return t > 0 ? n / t : 0;
  }

  function colDensity(x: number, y0: number, y1: number): number {
    const step = Math.max(1, Math.round((y1 - y0) / 600));
    let n = 0, t = 0;
    for (let y = y0; y < y1; y += step) { if (dark(x, y)) n++; t++; }
    return t > 0 ? n / t : 0;
  }

  // ── Step 1: bounding-box trim ────────────────────────────────────────────
  const EDGE = 0.003;
  let top = 0, bottom = height - 1, left = 0, right = width - 1;
  while (top    < bottom && rowDensity(top,    0,     width)  < EDGE) top++;
  while (bottom > top    && rowDensity(bottom, 0,     width)  < EDGE) bottom--;
  while (left   < right  && colDensity(left,   0,     height) < EDGE) left++;
  while (right  > left   && colDensity(right,  0,     height) < EDGE) right--;

  const cH = bottom - top;
  const cW = right  - left;
  if (cH < 20 || cW < 20) return sourceCanvas;

  // ── Step 1b: largest-cluster isolation ───────────────────────────────────
  // A dense legend/title-block panel (color swatches, tables, logos) can be
  // just as "dark" as the drawing itself, so Step 2's "first dense row/col
  // from the edge" scan stops immediately at the legend and never reaches
  // the white gap that actually separates it from the floor plan. Instead,
  // build a coarse density grid over the trimmed region, connected-component
  // it, and keep only the largest cluster — the floor plan is reliably the
  // biggest contiguous dense region, while legends/title blocks are smaller,
  // separate islands with a clear white gap around them.
  const clustered = isolateLargestDenseCluster(left, top, right, bottom, dark);
  if (clustered) {
    left = clustered.left;
    top = clustered.top;
    right = clustered.right;
    bottom = clustered.bottom;
  }
  const clusteredH = bottom - top;
  const clusteredW = right - left;

  // ── Step 2: legend strip removal ─────────────────────────────────────────
  // Scan inward from each bounding-box edge. Skip rows/cols with density below
  // DENSE (legend text, white gaps). Stop at the first dense row/col — either
  // the floor plan frame border (solid line, density ~100 %) or the first real
  // drawing content (density ~5–10 %). MAX_STRIP caps how far we look inward.
  const DENSE     = 0.05; // ≥ 5 % of sampled pixels must be dark to qualify
  const MAX_STRIP = 0.25; // never remove more than 25 % from any single edge

  function findBorderRow(fromY: number, limitY: number): number {
    const dir = fromY > limitY ? -1 : 1;
    for (let y = fromY; dir < 0 ? y >= limitY : y <= limitY; y += dir) {
      if (rowDensity(y, left, right) >= DENSE) return y;
    }
    return fromY;
  }

  function findBorderCol(fromX: number, limitX: number, y0: number, y1: number): number {
    const dir = fromX > limitX ? -1 : 1;
    for (let x = fromX; dir < 0 ? x >= limitX : x <= limitX; x += dir) {
      if (colDensity(x, y0, y1) >= DENSE) return x;
    }
    return fromX;
  }

  const maxH = Math.round(clusteredH * MAX_STRIP);
  const maxW = Math.round(clusteredW * MAX_STRIP);

  // Vertical cuts first, then use refined bounds for horizontal cuts
  const cutBottom = findBorderRow(bottom, Math.max(top + Math.round(clusteredH * 0.5), bottom - maxH));
  const cutTop    = findBorderRow(top,    Math.min(bottom - Math.round(clusteredH * 0.5), top + maxH));
  const cutRight  = findBorderCol(right,  Math.max(left + Math.round(clusteredW * 0.5), right - maxW), cutTop, cutBottom);
  const cutLeft   = findBorderCol(left,   Math.min(right - Math.round(clusteredW * 0.5), left + maxW), cutTop, cutBottom);

  // ── Output ───────────────────────────────────────────────────────────────
  const outW = cutRight - cutLeft + 1;
  const outH = cutBottom - cutTop + 1;

  if (outW < 80 || outH < 80 || (outW >= width * 0.99 && outH >= height * 0.99)) {
    return sourceCanvas;
  }

  const out    = document.createElement("canvas");
  out.width    = outW;
  out.height   = outH;
  const outCtx = out.getContext("2d");
  if (!outCtx) return sourceCanvas;
  outCtx.fillStyle = "#ffffff";
  outCtx.fillRect(0, 0, outW, outH);
  outCtx.drawImage(sourceCanvas, cutLeft, cutTop, outW, outH, 0, 0, outW, outH);
  return out;
}

// Info about a post-crop aspect-ratio correction against a known real-world
// width/height. `mismatchRatio` is the relative difference between the raw
// cropped pixel aspect ratio and the target real-world aspect ratio (0 = exact
// match). `applied` tells whether padding was added to close that gap.
export type AspectCorrectionInfo = {
  rawAspectRatio: number;
  targetAspectRatio: number;
  mismatchRatio: number;
  applied: boolean;
};

export type AspectCorrectionResult = AspectCorrectionInfo & { canvas: HTMLCanvasElement };

// Tolerance below which the raw crop's pixel aspect ratio is considered close
// enough to the target real-world aspect ratio to skip padding entirely.
const ASPECT_CORRECTION_TOLERANCE = 0.02; // 2%

// Makes a cropped canvas's pixel aspect ratio exactly match a known real-world
// width/height ratio, so a single px/m is metrically accurate on both axes
// (frontend/domain/coordinate/transform.ts assumes one isotropic px/m).
//
// Never resamples/stretches the drawing: when the pixel aspect ratio doesn't
// match the target, the *shorter* pixel dimension is padded with a centered
// white border until the ratio matches exactly. The original artwork is drawn
// at 1:1 scale, untouched.
export function correctCanvasAspectRatio(
  canvas: HTMLCanvasElement,
  knownWidthM: number,
  knownHeightM: number,
): AspectCorrectionResult {
  const { width, height } = canvas;
  const rawAspectRatio = width / Math.max(height, 1);
  const targetAspectRatio = knownWidthM / Math.max(knownHeightM, 0.0001);
  const mismatchRatio = Math.abs(rawAspectRatio - targetAspectRatio) / targetAspectRatio;

  if (!Number.isFinite(targetAspectRatio) || targetAspectRatio <= 0 || mismatchRatio <= ASPECT_CORRECTION_TOLERANCE) {
    return { canvas, rawAspectRatio, targetAspectRatio, mismatchRatio, applied: false };
  }

  // Pad whichever dimension is proportionally short so width/knownWidthM ===
  // height/knownHeightM afterwards (exact, no cropping/stretching involved).
  let outW = width;
  let outH = height;
  if (rawAspectRatio > targetAspectRatio) {
    outH = Math.round(width / targetAspectRatio);
  } else {
    outW = Math.round(height * targetAspectRatio);
  }

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext("2d");
  if (!outCtx) return { canvas, rawAspectRatio, targetAspectRatio, mismatchRatio, applied: false };

  outCtx.fillStyle = "#ffffff";
  outCtx.fillRect(0, 0, outW, outH);
  const offsetX = Math.round((outW - width) / 2);
  const offsetY = Math.round((outH - height) / 2);
  outCtx.drawImage(canvas, offsetX, offsetY);

  return { canvas: out, rawAspectRatio, targetAspectRatio, mismatchRatio, applied: true };
}

export async function cropFloorplanDataUrl(
  dataUrl: string,
  width: number,
  height: number,
  knownWidthM?: number,
  knownHeightM?: number,
): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  alreadyCropped: boolean;
  aspectCorrection: AspectCorrectionInfo | null;
}> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Nao foi possivel carregar a imagem para recorte."));
    img.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponivel para recorte.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  const cropped = cropFloorplanFromCanvas(canvas);

  let finalCanvas = cropped;
  let aspectCorrection: AspectCorrectionResult | null = null;
  if (knownWidthM && knownWidthM > 0 && knownHeightM && knownHeightM > 0) {
    aspectCorrection = correctCanvasAspectRatio(cropped, knownWidthM, knownHeightM);
    finalCanvas = aspectCorrection.canvas;
  }

  return {
    dataUrl: finalCanvas.toDataURL("image/png"),
    width: finalCanvas.width,
    height: finalCanvas.height,
    alreadyCropped: cropped === canvas && finalCanvas === cropped,
    aspectCorrection: aspectCorrection
      ? { rawAspectRatio: aspectCorrection.rawAspectRatio, targetAspectRatio: aspectCorrection.targetAspectRatio, mismatchRatio: aspectCorrection.mismatchRatio, applied: aspectCorrection.applied }
      : null,
  };
}

const BACKEND = "http://localhost:8000";

export async function renderPdfPage(
  file: File,
  pageNumber: number,
  renderScale = 2.0,
): Promise<PdfPageResult> {
  // ── Step 1: metadata + text (scale detection)
  const lib = await loadPdfjsLib();
  const buffer = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buffer }).promise;
  const pageCount = doc.numPages;
  const page = await doc.getPage(pageNumber);

  let fullText = "";
  try {
    const textData = await page.getTextContent();
    fullText = textData.items
      .filter((item) => "str" in item)
      .map((item) => (item as { str: string }).str)
      .join(" ");
  } catch {
    // text extraction not critical
  }
  // Title-block annotations (e.g. "ESCALA 1:50") are frequently emitted late
  // in the PDF's content-stream text order — on this real-world plan the
  // scale label sits at character ~4900 of a ~5300-char extraction. Scale
  // detection must run on the full text; only the *stored/displayed*
  // snippet (room-keyword matching, UI preview) is truncated for size.
  const textSnippet = fullText.slice(0, 3000);

  const renderDpi = renderScale * 72;
  const previewDetectedScale = parseScaleFromText(fullText, renderDpi);
  const backendCropDetectedScale = parseScaleFromText(fullText, BACKEND_CROP_OUT_DPI);

  // ── Step 2: render page to canvas via pdfjs
  const viewport = page.getViewport({ scale: renderScale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport }).promise;
  await doc.cleanup();

  // ── Step 3a: try backend crop directly on the original PDF bytes. This uses
  // PyMuPDF's vector-path density analysis (see backend/app/floorplan_cropper.py
  // `crop_floorplan`), which separates the floor-plan drawing from legends/
  // title blocks by actual geometry — far more reliable than any raster/pixel
  // density heuristic, especially when a legend panel is itself visually dense
  // (color swatches, tables, logos) and doesn't look "sparse" to a pixel scan.
  const backendPdfResult = await _tryBackendCropPdf(file, pageNumber);
  if (backendPdfResult) {
    return { ...backendPdfResult, pageCount, detectedScale: backendCropDetectedScale, textSnippet };
  }

  // ── Step 3b: try backend crop on the rendered PNG (raster heuristic; covers
  // scanned/raster PDFs where PyMuPDF has no vector paths to analyze)
  const renderedBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))),
      "image/png",
    );
  });

  const backendResult = await _tryBackendCropImage(renderedBlob);
  if (backendResult) {
    return { ...backendResult, pageCount, detectedScale: previewDetectedScale, textSnippet };
  }

  // ── Step 4: browser-side crop fallback
  const outputCanvas = cropFloorplanFromCanvas(canvas);
  const dataUrl = outputCanvas.toDataURL("image/png");
  const imageBlob = await new Promise<Blob>((resolve, reject) => {
    outputCanvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))),
      "image/png",
    );
  });

  return {
    dataUrl,
    width: outputCanvas.width,
    height: outputCanvas.height,
    imageBlob,
    pageCount,
    detectedScale: previewDetectedScale,
    textSnippet,
  };
}

/**
 * Send the original PDF bytes to the backend for vector-path crop analysis
 * (PyMuPDF `get_drawings()` density clustering — see `crop_floorplan` in
 * backend/app/floorplan_cropper.py). Far more accurate than any raster/pixel
 * heuristic for vector-exported architectural PDFs. Returns null if the
 * backend is unavailable, the PDF has no usable vector paths, or it errors —
 * callers should fall back to the raster-based crop attempts.
 */
async function _tryBackendCropPdf(
  file: File,
  pageNumber: number,
): Promise<Pick<PdfPageResult, "dataUrl" | "width" | "height" | "imageBlob"> | null> {
  try {
    const form = new FormData();
    form.append("floor_plan", file, file.name || "floorplan.pdf");
    form.append("page", String(Math.max(0, pageNumber - 1)));
    form.append("out_dpi", String(BACKEND_CROP_OUT_DPI));

    const response = await fetch(`${BACKEND}/api/crop-floorplan`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) return null;

    const croppedBlob = await response.blob();
    const dataUrl = await _blobToDataUrl(croppedBlob);
    const { width, height } = await _imageDimensions(dataUrl);

    return { dataUrl, width, height, imageBlob: croppedBlob };
  } catch {
    return null;
  }
}

/**
 * Send a rendered PNG to the backend for structural crop analysis.
 * Returns null if the backend is unavailable or returns an error.
 */
async function _tryBackendCropImage(
  imageBlob: Blob,
): Promise<Pick<PdfPageResult, "dataUrl" | "width" | "height" | "imageBlob"> | null> {
  try {
    const form = new FormData();
    form.append("floor_plan", imageBlob, "floorplan.png");

    const response = await fetch(`${BACKEND}/api/crop-floorplan`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) return null;

    const croppedBlob = await response.blob();
    const dataUrl = await _blobToDataUrl(croppedBlob);
    const { width, height } = await _imageDimensions(dataUrl);

    return { dataUrl, width, height, imageBlob: croppedBlob };
  } catch {
    return null;
  }
}

function _blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function _imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Invalid image"));
    img.src = dataUrl;
  });
}
