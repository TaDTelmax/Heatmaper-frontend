"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Flame,
  Map as MapIcon,
  RadioTower,
  RotateCcw,
  Wifi,
} from "lucide-react";
import { StepFinalResult } from "@/components/onboarding/StepFinalResult";
import { StepGenerateHeatmap } from "@/components/onboarding/StepGenerateHeatmap";
import { StepMeasurementPoints } from "@/components/onboarding/StepMeasurementPoints";
import { StepReview } from "@/components/onboarding/StepReview";
import { StepRouterPlacement } from "@/components/onboarding/StepRouterPlacement";
import { StepRssiInput } from "@/components/onboarding/StepRssiInput";
import { StepScaleCalibration } from "@/components/onboarding/StepScaleCalibration";
import { StepUploadFloorplan } from "@/components/onboarding/StepUploadFloorplan";
import { withComputedDistances } from "@/domain/heatmap/distance";
import { isCalibrated, recomputeWorld } from "@/domain/coordinate";
import {
  DEFAULT_IDW_POWER,
  composeHeatmapChart,
  composeOverlay,
  createFloorplanRfModel,
  createHeatmapLayer,
  renderFloorWithPoints,
} from "@/domain/heatmap/idw";
import {
  hasBlockingIssues,
  validateFloorplanImage,
  validateHeatmapReadiness,
  validateMeasurementPoints,
  validateRouter,
  validateRssi,
  validateScale,
  validateFloorplanFile,
} from "@/domain/heatmap/validation";
import { enhanceFloorplanBW } from "@/services/floorplanEnhancer";
import { transformFloorplanImage, transformPixelCoordinate, type FloorplanTransformKind } from "@/services/floorplanTransform";
import type { AspectCorrectionInfo } from "@/services/pdfService";
import { cropFloorplanDataUrl, getPdfInfo, parseMeasurements, renderPdfPage } from "@/services/pdfService";
import type {
  Calibration,
  CalibrationState,
  FloorplanImage,
  RouterPlacement,
  ScaleCalibration,
} from "@/types/floorplan";
import type { HeatmapResult, WallSegment, WifiBand } from "@/types/heatmap";
import type { MeasurementPoint, ValidationIssue } from "@/types/measurement";
import type { SpatialElement } from "@/types/spatialElement";

type StepKey = "upload" | "scale" | "router" | "points" | "rssi" | "review" | "generate" | "result";

const GENERATION_MAX_DIMENSION = 1200;
const DENSE_GENERATION_MAX_DIMENSION = 900;
const DENSE_GENERATION_POINT_COUNT = 120;
const GENERATION_MAX_POINTS = 600;

const steps: { key: StepKey; label: string; description: string }[] = [
  { key: "upload", label: "Planta", description: "Envie a planta" },
  { key: "scale", label: "Escala", description: "Calibre a escala" },
  { key: "router", label: "Access Point", description: "Posicione o AP" },
  { key: "points", label: "Pontos", description: "Marque medições" },
  { key: "rssi", label: "RSSI", description: "Insira os valores" },
  { key: "review", label: "Revisão", description: "Verifique tudo" },
  { key: "generate", label: "Gerar", description: "Configure e gere" },
  { key: "result", label: "Resultado", description: "Heatmap final" },
];

const defaultScale: ScaleCalibration = {
  mode: "two-point",
  pxPerMeter: 0,
  manualPxPerMeter: 0,
  knownDistanceM: 1,
  calibrationPoints: [],
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Nao foi possivel ler a planta."));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Nao foi possivel abrir a imagem."));
    image.src = src;
  });
}

function scaledDimension(value: number, scaleFactor: number): number {
  return Math.max(1, Math.round(value * scaleFactor));
}


function pxPerMeterFromKnownDimensions(
  widthPx: number,
  heightPx: number,
  knownWidthM: number | undefined,
  knownHeightM: number | undefined,
): number {
  const fromW = knownWidthM && knownWidthM > 0 ? widthPx / knownWidthM : null;
  const fromH = knownHeightM && knownHeightM > 0 ? heightPx / knownHeightM : null;
  if (fromW !== null && fromH !== null) return (fromW + fromH) / 2;
  if (fromW !== null) return fromW;
  if (fromH !== null) return fromH;
  return 0;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function strongestRssi(target: number | null | undefined, source: number | null | undefined): number | null {
  if (target === null || target === undefined) return source ?? null;
  if (source === null || source === undefined) return target;
  return source > target ? source : target;
}

function sampledGenerationPoints(points: MeasurementPoint[], limit: number): MeasurementPoint[] {
  if (points.length <= limit) return points;
  const sampled: MeasurementPoint[] = [];
  const used = new Set<string>();
  const step = (points.length - 1) / Math.max(limit - 1, 1);

  for (let index = 0; index < limit; index += 1) {
    const point = points[Math.round(index * step)];
    if (!point || used.has(point.point_id)) continue;
    sampled.push(point);
    used.add(point.point_id);
  }

  return sampled;
}

function compactPointsForGeneration(points: MeasurementPoint[], floorplan: FloorplanImage): MeasurementPoint[] {
  if (points.length <= GENERATION_MAX_POINTS) return points;
  const cellSize = Math.max(8, Math.ceil(Math.sqrt(Math.max(floorplan.width * floorplan.height, 1) / GENERATION_MAX_POINTS)));
  const buckets = new Map<
    string,
    {
      first: MeasurementPoint;
      sumX: number;
      sumY: number;
      count: number;
      rssi_24ghz: number | null;
      rssi_5ghz: number | null;
      rssi_6ghz: number | null;
      source: MeasurementPoint["source"];
    }
  >();

  for (const point of points) {
    if (!Number.isFinite(point.x_px) || !Number.isFinite(point.y_px)) continue;
    const key = `${Math.round(point.x_px / cellSize)}:${Math.round(point.y_px / cellSize)}`;
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, {
        first: point,
        sumX: point.x_px,
        sumY: point.y_px,
        count: 1,
        rssi_24ghz: point.rssi_24ghz,
        rssi_5ghz: point.rssi_5ghz,
        rssi_6ghz: point.rssi_6ghz ?? null,
        source: point.source,
      });
      continue;
    }
    bucket.sumX += point.x_px;
    bucket.sumY += point.y_px;
    bucket.count += 1;
    bucket.rssi_24ghz = strongestRssi(bucket.rssi_24ghz, point.rssi_24ghz);
    bucket.rssi_5ghz = strongestRssi(bucket.rssi_5ghz, point.rssi_5ghz);
    bucket.rssi_6ghz = strongestRssi(bucket.rssi_6ghz, point.rssi_6ghz);
    if (point.source === "csv") bucket.source = "csv";
  }

  const compacted = [...buckets.values()].map((bucket, index) => ({
    ...bucket.first,
    point_id: `G${index + 1}`,
    x_px: rounded(bucket.sumX / bucket.count),
    y_px: rounded(bucket.sumY / bucket.count),
    rssi_24ghz: bucket.rssi_24ghz,
    rssi_5ghz: bucket.rssi_5ghz,
    rssi_6ghz: bucket.rssi_6ghz,
    source: bucket.source,
  }));

  return sampledGenerationPoints(compacted, GENERATION_MAX_POINTS);
}

function scaleMeasurementPoint(point: MeasurementPoint, scaleFactor: number): MeasurementPoint {
  return {
    ...point,
    x_px: point.x_px * scaleFactor,
    y_px: point.y_px * scaleFactor,
    distance_m: point.distance_m,
  };
}

function scaleAps(aps: RouterPlacement[], scaleFactor: number): RouterPlacement[] {
  return aps.map((ap) => ({
    ...ap,
    ap_x_px: ap.ap_x_px * scaleFactor,
    ap_y_px: ap.ap_y_px * scaleFactor,
  }));
}

function scaleWalls(walls: WallSegment[], scaleFactor: number): WallSegment[] {
  return walls.map((wall) => ({
    ...wall,
    start: { x: wall.start.x * scaleFactor, y: wall.start.y * scaleFactor },
    end: { x: wall.end.x * scaleFactor, y: wall.end.y * scaleFactor },
  }));
}

async function resizeFloorplanForGeneration(floorplan: FloorplanImage, scaleFactor: number): Promise<string> {
  if (scaleFactor >= 0.999) return floorplan.dataUrl;
  const image = await loadImage(floorplan.dataUrl);
  const width = scaledDimension(floorplan.width, scaleFactor);
  const height = scaledDimension(floorplan.height, scaleFactor);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas indisponivel para reduzir a planta.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

async function createGenerationWorkspace(
  floorplan: FloorplanImage,
  points: MeasurementPoint[],
  aps: RouterPlacement[],
  walls: WallSegment[],
  pxPerMeter: number,
  gaussianBlurPx: number,
) {
  const generationPoints = compactPointsForGeneration(points, floorplan);
  const maxDimension = Math.max(floorplan.width, floorplan.height);
  const targetMaxDimension = generationPoints.length > DENSE_GENERATION_POINT_COUNT ? DENSE_GENERATION_MAX_DIMENSION : GENERATION_MAX_DIMENSION;
  const scaleFactor = Math.min(1, targetMaxDimension / Math.max(maxDimension, 1));
  return {
    dataUrl: await resizeFloorplanForGeneration(floorplan, scaleFactor),
    width: scaledDimension(floorplan.width, scaleFactor),
    height: scaledDimension(floorplan.height, scaleFactor),
    points: generationPoints.map((point) => scaleMeasurementPoint(point, scaleFactor)),
    aps: scaleAps(aps, scaleFactor),
    walls: scaleWalls(walls, scaleFactor),
    pxPerMeter: Math.max(pxPerMeter * scaleFactor, 0.01),
    gaussianBlurPx: gaussianScaled(scaleFactor, gaussianBlurPx),
    scaleFactor,
  };
}

function gaussianScaled(scaleFactor: number, value: number): number {
  return Math.max(2, value * scaleFactor);
}

function derive6GhzFrom5Ghz(heatmap5: HeatmapResult["heatmap5"]): HeatmapResult["heatmap6"] {
  return {
    ...heatmap5,
    band: "6ghz",
    minRssi: Number((heatmap5.minRssi - 4.5).toFixed(1)),
    maxRssi: Number((heatmap5.maxRssi - 4.5).toFixed(1)),
    avgRssi: Number((heatmap5.avgRssi - 4.5).toFixed(1)),
  };
}

function hasExplicit6Ghz(points: MeasurementPoint[]): boolean {
  return points.some((point) => point.rssi_6ghz !== null && point.rssi_6ghz !== undefined);
}

// Stable identity for a floorplan image. Changing the image changes this key,
// which invalidates calibration (Constitution Principle I; FR-014).
function floorplanKeyOf(floorplan: FloorplanImage | null): string {
  if (!floorplan) return "none";
  return `${floorplan.fileName}:${floorplan.fileSize}:${floorplan.width}x${floorplan.height}:${floorplan.enhanced ? "bw" : "raw"}`;
}

// Derive the authoritative CalibrationState from the editable scale draft. The
// metric coordinate (meters) becomes the source of truth; the px draft remains
// the editable input. An unset/invalid scale yields an uncalibrated state.
function buildCalibrationState(floorplanKey: string, scale: ScaleCalibration): CalibrationState {
  if (!Number.isFinite(scale.pxPerMeter) || scale.pxPerMeter <= 0) {
    return { status: "uncalibrated", calibration: null, floorplanKey };
  }
  const calibration: Calibration = {
    ...scale,
    metersPerPixel: 1 / scale.pxPerMeter,
    originPx: { x_px: 0, y_px: 0 },
  };
  return { status: "calibrated", calibration, floorplanKey };
}

// Project the px-based AP + measurement points onto the shared SpatialElement
// shape. World coordinates are filled by recomputeWorld under the current
// calibration; the pixel anchor stays fixed (rendering reference).
function buildSpatialElements(aps: RouterPlacement[], points: MeasurementPoint[]): SpatialElement[] {
  const elements: SpatialElement[] = [];
  for (const ap of aps) {
    elements.push({ anchor: { x_px: ap.ap_x_px, y_px: ap.ap_y_px }, world: null, kind: "router" });
  }
  for (const point of points) {
    elements.push({ anchor: { x_px: point.x_px, y_px: point.y_px }, world: null, kind: "measurement" });
  }
  return elements;
}

export default function Page() {
  const [currentStep, setCurrentStep] = useState<StepKey>("upload");
  const [floorFile, setFloorFile] = useState<File | null>(null);
  const [floorplan, setFloorplan] = useState<FloorplanImage | null>(null);
  const [scale, setScale] = useState<ScaleCalibration>(defaultScale);
  const [aps, setAps] = useState<RouterPlacement[]>([]);
  const [points, setPoints] = useState<MeasurementPoint[]>([]);
  const [walls, setWalls] = useState<WallSegment[]>([]);
  const [result, setResult] = useState<HeatmapResult | null>(null);
  const [selectedBand, setSelectedBand] = useState<WifiBand>("24ghz");
  const [overlayOpacity, setOverlayOpacity] = useState(0.86);
  const [idwPower, setIdwPower] = useState(DEFAULT_IDW_POWER);
  const [interpolationRadiusM, setInterpolationRadiusM] = useState(42);
  const [gaussianBlurPx, setGaussianBlurPx] = useState(26);
  const [useWallAttenuation, setUseWallAttenuation] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCropping, setIsCropping] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [cropAspectInfo, setCropAspectInfo] = useState<AspectCorrectionInfo | null>(null);
  const currentIndex = steps.findIndex((step) => step.key === currentStep);

  // Authoritative spatial layer derived from the editable px draft.
  // `calibration` (metric, gated) is the source of truth; `elements` carry the
  // authoritative world coordinates (meters) for the AP and measurement points.
  const floorplanKey = useMemo(() => floorplanKeyOf(floorplan), [floorplan]);
  const calibration = useMemo<CalibrationState>(
    () => buildCalibrationState(floorplanKey, scale),
    [floorplanKey, scale],
  );
  const elements = useMemo<SpatialElement[]>(
    () => recomputeWorld(buildSpatialElements(aps, points), calibration),
    [aps, points, calibration],
  );
  const calibrated = isCalibrated(calibration);
  const apWorld = useMemo(
    () => elements.find((element) => element.kind === "router")?.world ?? null,
    [elements],
  );

  const readinessIssues = useMemo(() => {
    if (!floorplan) return [{ severity: "error", message: "Planta baixa obrigatoria.", code: "floorplan_required" }] satisfies ValidationIssue[];
    return validateHeatmapReadiness(floorplan, scale, aps, points);
  }, [floorplan, scale, aps, points]);

  const currentIssues = useMemo(() => {
    if (!floorplan && currentStep !== "upload") {
      return [{ severity: "error", message: "Envie a planta baixa para continuar.", code: "floorplan_required" }] satisfies ValidationIssue[];
    }
    if (currentStep === "upload") return floorplan ? validateFloorplanImage(floorplan) : [];
    if (currentStep === "scale") return validateScale(scale);
    if (currentStep === "router") return validateRouter(aps, floorplan);
    if (currentStep === "points") return validateMeasurementPoints(points, floorplan, { requireAtLeastOne: false });
    if (currentStep === "rssi") return [...validateMeasurementPoints(points, floorplan), ...validateRssi(points)];
    if (currentStep === "review" || currentStep === "generate") {
      return generationError
        ? [...readinessIssues, { severity: "error", message: generationError, code: "generation_error" } satisfies ValidationIssue]
        : readinessIssues;
    }
    if (currentStep === "result" && !result) {
      return [{ severity: "error", message: "Gere o heatmap antes de ver o resultado.", code: "result_required" }] satisfies ValidationIssue[];
    }
    return [];
  }, [aps, currentStep, floorplan, generationError, points, readinessIssues, result, scale]);

  const canAdvance = !hasBlockingIssues(currentIssues) && (currentStep !== "result" || result !== null);

  async function uploadFloorplan(file: File, pdfPage = 1) {
    const fileIssues = validateFloorplanFile(file);

    let dataUrl: string;
    let width: number;
    let height: number;
    let pdfInfo: FloorplanImage["pdf"] | undefined;
    let nextScale = defaultScale;

    if (file.type === "application/pdf") {
      const [rendered, info] = await Promise.all([
        renderPdfPage(file, pdfPage),
        getPdfInfo(file),
      ]);
      dataUrl = rendered.dataUrl;
      width = rendered.width;
      height = rendered.height;
      const measurements = parseMeasurements(rendered.textSnippet);
      pdfInfo = {
        pageCount: info.pageCount,
        selectedPage: pdfPage,
        detectedScale: rendered.detectedScale,
        textSnippet: rendered.textSnippet,
        measurements,
      };
      // Deliberately NOT auto-applied as the active calibration: a title-block
      // "ESCALA 1:N" label doesn't reliably match the exported PDF's actual
      // geometry (common export-pipeline drift, e.g. CAD "print to PDF" with
      // a fit-to-page/rounding step) — on a real test plan this produced a
      // scale ~8% off from the true building size. It's still shown to the
      // user (pdfInfo.detectedScale, surfaced in the upload step) as a
      // starting-point suggestion; the user must confirm scale explicitly
      // (two-point measurement or known real dimensions), which measures the
      // actual rendered image rather than trusting the drawing's own label.
    } else {
      dataUrl = await readFileAsDataUrl(file);
      const image = await loadImage(dataUrl);
      width = image.naturalWidth;
      height = image.naturalHeight;
    }

    const asset: FloorplanImage = {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      dataUrl,
      width,
      height,
      aspectRatio: width / Math.max(height, 1),
      validation: fileIssues,
      pdf: pdfInfo,
    };
    setFloorFile(file);
    setFloorplan(asset);
    setScale(nextScale);
    setAps([]);
    setPoints([]);
    setWalls([]);
    setResult(null);
    setGenerationError(null);
    setCropAspectInfo(null);
    setCurrentStep("scale");
  }

  async function enhanceFloorplan() {
    if (!floorplan) return;
    const result = await enhanceFloorplanBW(floorplan.dataUrl);
    setFloorplan({
      ...floorplan,
      dataUrl: result.dataUrl,
      width: result.width,
      height: result.height,
      aspectRatio: result.width / Math.max(result.height, 1),
      enhanced: true,
    });
    setScale(defaultScale);
    setAps([]);
    setPoints([]);
    setWalls([]);
    setResult(null);
    setGenerationError(null);
    setCropAspectInfo(null);
  }

  // Manual orientation fix: rotate/mirror a plan that renders sideways or
  // upside-down relative to the real building. px/m is isotropic (same in
  // both axes) so it survives a rotation/flip unchanged — only the AP/point/
  // wall pixel coordinates need remapping through the same geometric
  // transform as the image, so they stay on the walls they were measured
  // against instead of being silently wiped.
  async function transformFloorplan(kind: FloorplanTransformKind) {
    if (!floorplan) return;
    const oldWidth = floorplan.width;
    const oldHeight = floorplan.height;
    const result = await transformFloorplanImage(floorplan.dataUrl, kind);
    setFloorplan({
      ...floorplan,
      dataUrl: result.dataUrl,
      width: result.width,
      height: result.height,
      aspectRatio: result.width / Math.max(result.height, 1),
    });
    setAps((current) =>
      current.map((ap) => {
        if (ap.ap_x_px < 0 || ap.ap_y_px < 0) return ap;
        const mapped = transformPixelCoordinate(ap.ap_x_px, ap.ap_y_px, kind, oldWidth, oldHeight);
        return { ...ap, ap_x_px: mapped.x, ap_y_px: mapped.y };
      }),
    );
    setPoints((current) =>
      current.map((point) => {
        const mapped = transformPixelCoordinate(point.x_px, point.y_px, kind, oldWidth, oldHeight);
        return { ...point, x_px: mapped.x, y_px: mapped.y };
      }),
    );
    setWalls((current) =>
      current.map((wall) => ({
        ...wall,
        start: transformPixelCoordinate(wall.start.x, wall.start.y, kind, oldWidth, oldHeight),
        end: transformPixelCoordinate(wall.end.x, wall.end.y, kind, oldWidth, oldHeight),
      })),
    );
    setResult(null);
    setGenerationError(null);
    setCropAspectInfo(null);
  }

  function clearProject() {
    setCurrentStep("upload");
    setFloorFile(null);
    setFloorplan(null);
    setScale(defaultScale);
    setAps([]);
    setPoints([]);
    setWalls([]);
    setResult(null);
    setGenerationError(null);
    setCropAspectInfo(null);
  }

  function updateScale(next: ScaleCalibration) {
    setScale(next);
    setPoints((current) => withComputedDistances(current, aps, next.pxPerMeter));
    setResult(null);
    setGenerationError(null);
  }

  async function cropAndRescaleFloorplan() {
    if (!floorplan || scale.mode !== "known-dimensions") return;
    setIsCropping(true);
    setGenerationError(null);
    try {
      const cropped = await cropFloorplanDataUrl(
        floorplan.dataUrl,
        floorplan.width,
        floorplan.height,
        scale.knownWidthM,
        scale.knownHeightM,
      );
      setCropAspectInfo(cropped.aspectCorrection);
      const newPxPerMeter = pxPerMeterFromKnownDimensions(cropped.width, cropped.height, scale.knownWidthM, scale.knownHeightM);
      if (!cropped.alreadyCropped) {
        setFloorplan({
          ...floorplan,
          dataUrl: cropped.dataUrl,
          width: cropped.width,
          height: cropped.height,
          aspectRatio: cropped.width / Math.max(cropped.height, 1),
        });
        setAps([]);
        setPoints([]);
        setWalls([]);
        setResult(null);
      }
      setScale({ ...scale, pxPerMeter: newPxPerMeter, manualPxPerMeter: newPxPerMeter });
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Nao foi possivel recortar a planta.");
    } finally {
      setIsCropping(false);
    }
  }

  function updateAps(next: RouterPlacement[]) {
    setAps(next);
    setPoints((current) => withComputedDistances(current, next, scale.pxPerMeter));
    setResult(null);
    setGenerationError(null);
  }

  function updatePoints(next: MeasurementPoint[]) {
    setPoints(withComputedDistances(next, aps, scale.pxPerMeter));
    setResult(null);
    setGenerationError(null);
  }

  function goNext() {
    if (!canAdvance) return;
    const nextStep = steps[Math.min(currentIndex + 1, steps.length - 1)];
    setCurrentStep(nextStep.key);
  }

  function goBack() {
    const previousStep = steps[Math.max(currentIndex - 1, 0)];
    setCurrentStep(previousStep.key);
  }

  function canOpenStep(stepKey: StepKey): boolean {
    const index = steps.findIndex((step) => step.key === stepKey);
    if (index <= currentIndex) return true;
    if (stepKey === "scale") return Boolean(floorplan);
    if (stepKey === "router") return Boolean(floorplan) && !hasBlockingIssues(validateScale(scale));
    if (stepKey === "points") return Boolean(floorplan) && !hasBlockingIssues(validateRouter(aps, floorplan));
    if (stepKey === "rssi") return Boolean(floorplan) && !hasBlockingIssues(validateRouter(aps, floorplan));
    if (stepKey === "review") return !hasBlockingIssues([...validateMeasurementPoints(points, floorplan), ...validateRssi(points)]);
    if (stepKey === "generate") return !hasBlockingIssues(readinessIssues);
    if (stepKey === "result") return Boolean(result);
    return false;
  }

  async function generateHeatmaps() {
    if (!floorplan || hasBlockingIssues(readinessIssues)) return;
    setIsGenerating(true);
    setGenerationError(null);
    try {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const generation = await createGenerationWorkspace(floorplan, points, aps, walls, scale.pxPerMeter, gaussianBlurPx);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const rfModel = await createFloorplanRfModel(generation.dataUrl, generation.width, generation.height);
      const engineOptions = {
        power: idwPower || DEFAULT_IDW_POWER,
        pxPerMeter: generation.pxPerMeter,
        interpolationRadiusM,
        gaussianBlurPx: generation.gaussianBlurPx,
        useWallAttenuation,
        accessPoints: generation.aps,
        houseMask: rfModel.houseMask,
        obstacleMap: useWallAttenuation ? rfModel.obstacleMap : null,
        compartmentMap: rfModel.compartmentMap,
        roomColorMap: rfModel.roomColorMap,
        roomColorCount: rfModel.roomColorCount,
        walls: generation.walls,
      };
      const heatmap24 = createHeatmapLayer(generation.width, generation.height, generation.points, "24ghz", engineOptions);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const heatmap5 = createHeatmapLayer(generation.width, generation.height, generation.points, "5ghz", engineOptions);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const heatmap6 = hasExplicit6Ghz(points)
        ? createHeatmapLayer(generation.width, generation.height, generation.points, "6ghz", engineOptions)
        : derive6GhzFrom5Ghz(heatmap5);
      const floorWithPoints = await renderFloorWithPoints(generation.dataUrl, generation.width, generation.height, generation.points, generation.aps);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const [overlay24, overlay5, overlay6] = await Promise.all([
        composeOverlay(generation.dataUrl, heatmap24.dataUrl, generation.width, generation.height, generation.points, generation.aps, overlayOpacity),
        composeOverlay(generation.dataUrl, heatmap5.dataUrl, generation.width, generation.height, generation.points, generation.aps, overlayOpacity),
        composeOverlay(generation.dataUrl, heatmap6.dataUrl, generation.width, generation.height, generation.points, generation.aps, overlayOpacity),
      ]);
      const [chart24, chart5, chart6] = await Promise.all([
        composeHeatmapChart(overlay24, generation.width, generation.height, "2.4GHz"),
        composeHeatmapChart(overlay5, generation.width, generation.height, "5GHz"),
        composeHeatmapChart(overlay6, generation.width, generation.height, hasExplicit6Ghz(points) ? "6GHz" : "6GHz derivado"),
      ]);
      setResult({
        heatmap24,
        heatmap5,
        heatmap6,
        overlay24,
        overlay5,
        overlay6,
        chart24,
        chart5,
        chart6,
        floorWithPoints,
        generatedAt: new Date().toISOString(),
        power: idwPower || DEFAULT_IDW_POWER,
        interpolationRadiusM,
        gaussianBlurPx,
        useWallAttenuation,
        opacity: overlayOpacity,
      });
      setCurrentStep("result");
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Nao foi possivel gerar o heatmap.");
    } finally {
      setIsGenerating(false);
    }
  }

  function renderStep() {
    if (currentStep === "upload" || !floorplan) {
      return (
        <StepUploadFloorplan
          floorplan={floorplan}
          onUpload={(file, page) => uploadFloorplan(file, page)}
          onClear={clearProject}
          onEnhance={enhanceFloorplan}
          onTransform={transformFloorplan}
        />
      );
    }
    if (currentStep === "scale") {
      return (
        <StepScaleCalibration
          floorplan={floorplan}
          scale={scale}
          onChange={updateScale}
          onCropFloorplan={cropAndRescaleFloorplan}
          isCropping={isCropping}
          cropError={generationError}
          cropAspectInfo={cropAspectInfo}
        />
      );
    }
    if (currentStep === "router") {
      return <StepRouterPlacement floorplan={floorplan} aps={aps} onSetAps={updateAps} />;
    }
    if (currentStep === "points") {
      return (
        <StepMeasurementPoints
          floorFile={floorFile}
          floorplan={floorplan}
          points={points}
          aps={aps}
          pxPerMeter={scale.pxPerMeter}
          onChange={updatePoints}
        />
      );
    }
    if (currentStep === "rssi") {
      return <StepRssiInput floorplan={floorplan} aps={aps} points={points} pxPerMeter={scale.pxPerMeter} onChange={updatePoints} />;
    }
    if (currentStep === "review") {
      return <StepReview floorplan={floorplan} scale={scale} aps={aps} points={points} />;
    }
    if (currentStep === "generate") {
      return (
        <StepGenerateHeatmap
          issues={currentIssues}
          opacity={overlayOpacity}
          power={idwPower}
          isGenerating={isGenerating}
          onOpacityChange={(value) => {
            setOverlayOpacity(value);
            setResult(null);
          }}
          onPowerChange={(value) => {
            setIdwPower(value);
            setResult(null);
          }}
          interpolationRadiusM={interpolationRadiusM}
          gaussianBlurPx={gaussianBlurPx}
          useWallAttenuation={useWallAttenuation}
          onInterpolationRadiusChange={(value) => {
            setInterpolationRadiusM(value);
            setResult(null);
          }}
          onGaussianBlurChange={(value) => {
            setGaussianBlurPx(value);
            setResult(null);
          }}
          onUseWallAttenuationChange={(value) => {
            setUseWallAttenuation(value);
            setResult(null);
          }}
          onGenerate={generateHeatmaps}
        />
      );
    }
    return (
      <StepFinalResult
        floorplan={floorplan}
        scale={scale}
        aps={aps}
        points={points}
        walls={walls}
        result={result}
        selectedBand={selectedBand}
        onSelectedBandChange={setSelectedBand}
      />
    );
  }

  return (
    <main className="appShell">
      <header className="topbar">
        <div className="brand">
          <span className="brandMark" aria-hidden="true"><Wifi size={18} /></span>
          <div>
            <strong>WiFi Heatmapper</strong>
            <small>Análise RSSI Indoor</small>
          </div>
        </div>

        <div className="topActions">
          <button
            className="iconButton"
            type="button"
            onClick={clearProject}
            aria-label="Reiniciar projeto"
            title="Reiniciar projeto"
          >
            <RotateCcw size={16} />
          </button>
          <button
            className="secondaryButton"
            type="button"
            disabled={currentIndex === 0 || isGenerating}
            onClick={goBack}
            aria-label="Etapa anterior"
          >
            <ArrowLeft size={15} />
            Anterior
          </button>
          {currentStep === "generate" ? (
            <button
              className="primaryButton"
              type="button"
              disabled={hasBlockingIssues(currentIssues) || isGenerating}
              onClick={generateHeatmaps}
              aria-label="Gerar heatmap"
            >
              <Flame size={15} />
              {isGenerating ? "Gerando…" : "Gerar Heatmap"}
            </button>
          ) : (
            <button
              className="primaryButton"
              type="button"
              disabled={!canAdvance || currentStep === "result"}
              onClick={goNext}
              aria-label="Próxima etapa"
            >
              Próximo
              <ArrowRight size={15} />
            </button>
          )}
        </div>
      </header>

      <section className="wizardLayout">
        <aside className="stepRail" aria-label="Etapas do fluxo">
          <div className="railHeader">
            <MapIcon size={14} aria-hidden="true" />
            <span>Fluxo de trabalho</span>
          </div>

          <div
            className="progressBar"
            role="progressbar"
            aria-valuenow={currentIndex + 1}
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-label={`Etapa ${currentIndex + 1} de ${steps.length}`}
            style={{ marginBottom: 10 }}
          >
            <div style={{ width: `${((currentIndex + 1) / steps.length) * 100}%` }} />
          </div>

          {steps.map((step, index) => {
            const active = step.key === currentStep;
            const complete = index < currentIndex || (step.key === "result" && Boolean(result));
            const unlocked = canOpenStep(step.key);
            return (
              <button
                key={step.key}
                type="button"
                className={`stepButton ${active ? "active" : ""} ${complete ? "complete" : ""}`}
                disabled={!unlocked || isGenerating}
                onClick={() => setCurrentStep(step.key)}
                aria-current={active ? "step" : undefined}
                aria-label={`${step.label}: ${step.description}${complete ? " (concluído)" : active ? " (atual)" : ""}`}
              >
                <span aria-hidden="true">{complete ? <CheckCircle2 size={14} /> : index + 1}</span>
                <div>
                  <b>{step.label}</b>
                  <small>{step.description}</small>
                </div>
              </button>
            );
          })}

          <div className="railSummary" aria-label="Resumo do projeto">
            <span
              title={
                aps.length
                  ? calibrated && apWorld
                    ? `${aps.length} AP(s) · ${apWorld.x.toFixed(2)}, ${apWorld.y.toFixed(2)} m`
                    : `${aps.length} AP(s) definido(s)`
                  : "AP não definido"
              }
            >
              <RadioTower size={13} aria-hidden="true" />
              {aps.length
                ? calibrated && apWorld
                  ? `${aps.length} AP(s) · ${apWorld.x.toFixed(2)}, ${apWorld.y.toFixed(2)} m`
                  : `${aps.length} AP(s)`
                : "AP pendente"}
            </span>
            <span
              title={
                calibrated
                  ? `${elements.filter((element) => element.kind === "measurement" && element.world).length} ponto(s) com coordenada real (m)`
                  : `${points.length} ponto(s) definido(s)`
              }
            >
              <MapIcon size={13} aria-hidden="true" />
              {points.length} ponto(s){calibrated ? " · reais" : ""}
            </span>
            <span title={calibrated ? `Escala: ${scale.pxPerMeter.toFixed(1)} px/m` : "Planta nao calibrada"}>
              <Wifi size={13} aria-hidden="true" />
              {calibrated ? `${scale.pxPerMeter.toFixed(1)} px / m` : "Nao calibrado"}
            </span>
          </div>
        </aside>

        <section className="workspace" aria-label="Conteúdo da etapa atual">
          {renderStep()}
        </section>
      </section>
    </main>
  );
}
