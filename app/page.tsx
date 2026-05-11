"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Flame,
  Map,
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
import {
  DEFAULT_IDW_POWER,
  composeHeatmapChart,
  composeOverlay,
  createHouseMaskFromFloorplan,
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
import type { FloorplanImage, RouterPlacement, ScaleCalibration } from "@/types/floorplan";
import type { HeatmapResult, WifiBand } from "@/types/heatmap";
import type { MeasurementPoint, ValidationIssue } from "@/types/measurement";

type StepKey = "upload" | "scale" | "router" | "points" | "rssi" | "review" | "generate" | "result";

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
  mode: "manual",
  pxPerMeter: 50,
  manualPxPerMeter: 50,
  knownDistanceM: 3,
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

export default function Page() {
  const [currentStep, setCurrentStep] = useState<StepKey>("upload");
  const [floorFile, setFloorFile] = useState<File | null>(null);
  const [floorplan, setFloorplan] = useState<FloorplanImage | null>(null);
  const [scale, setScale] = useState<ScaleCalibration>(defaultScale);
  const [ap, setAp] = useState<RouterPlacement | null>(null);
  const [points, setPoints] = useState<MeasurementPoint[]>([]);
  const [result, setResult] = useState<HeatmapResult | null>(null);
  const [selectedBand, setSelectedBand] = useState<WifiBand>("24ghz");
  const [overlayOpacity, setOverlayOpacity] = useState(0.68);
  const [idwPower, setIdwPower] = useState(DEFAULT_IDW_POWER);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const currentIndex = steps.findIndex((step) => step.key === currentStep);

  const readinessIssues = useMemo(() => {
    if (!floorplan) return [{ severity: "error", message: "Planta baixa obrigatoria.", code: "floorplan_required" }] satisfies ValidationIssue[];
    return validateHeatmapReadiness(floorplan, scale, ap, points);
  }, [floorplan, scale, ap, points]);

  const currentIssues = useMemo(() => {
    if (!floorplan && currentStep !== "upload") {
      return [{ severity: "error", message: "Envie a planta baixa para continuar.", code: "floorplan_required" }] satisfies ValidationIssue[];
    }
    if (currentStep === "upload") return floorplan ? validateFloorplanImage(floorplan) : [];
    if (currentStep === "scale") return validateScale(scale);
    if (currentStep === "router") return validateRouter(ap, floorplan);
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
  }, [ap, currentStep, floorplan, generationError, points, readinessIssues, result, scale]);

  const canAdvance = !hasBlockingIssues(currentIssues) && (currentStep !== "result" || result !== null);

  async function uploadFloorplan(file: File) {
    const fileIssues = validateFloorplanFile(file);
    const dataUrl = await readFileAsDataUrl(file);
    const image = await loadImage(dataUrl);
    const asset: FloorplanImage = {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      dataUrl,
      width: image.naturalWidth,
      height: image.naturalHeight,
      aspectRatio: image.naturalWidth / Math.max(image.naturalHeight, 1),
      validation: fileIssues,
    };
    setFloorFile(file);
    setFloorplan(asset);
    setScale(defaultScale);
    setAp(null);
    setPoints([]);
    setResult(null);
    setGenerationError(null);
    setCurrentStep("scale");
  }

  function clearProject() {
    setCurrentStep("upload");
    setFloorFile(null);
    setFloorplan(null);
    setScale(defaultScale);
    setAp(null);
    setPoints([]);
    setResult(null);
    setGenerationError(null);
  }

  function updateScale(next: ScaleCalibration) {
    setScale(next);
    setPoints((current) => withComputedDistances(current, ap, next.pxPerMeter));
    setResult(null);
    setGenerationError(null);
  }

  function updateAp(next: RouterPlacement) {
    setAp(next);
    setPoints((current) => withComputedDistances(current, next, scale.pxPerMeter));
    setResult(null);
    setGenerationError(null);
  }

  function updatePoints(next: MeasurementPoint[]) {
    setPoints(withComputedDistances(next, ap, scale.pxPerMeter));
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
    if (stepKey === "points") return Boolean(floorplan) && !hasBlockingIssues(validateRouter(ap, floorplan));
    if (stepKey === "rssi") return Boolean(floorplan) && !hasBlockingIssues(validateRouter(ap, floorplan));
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
      const houseMask = await createHouseMaskFromFloorplan(floorplan.dataUrl, floorplan.width, floorplan.height);
      const heatmap24 = createHeatmapLayer(floorplan.width, floorplan.height, points, "24ghz", idwPower || DEFAULT_IDW_POWER, houseMask);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const heatmap5 = createHeatmapLayer(floorplan.width, floorplan.height, points, "5ghz", idwPower || DEFAULT_IDW_POWER, houseMask);
      const floorWithPoints = await renderFloorWithPoints(floorplan.dataUrl, floorplan.width, floorplan.height, points, ap);
      const [overlay24, overlay5] = await Promise.all([
        composeOverlay(floorplan.dataUrl, heatmap24.dataUrl, floorplan.width, floorplan.height, points, ap, overlayOpacity),
        composeOverlay(floorplan.dataUrl, heatmap5.dataUrl, floorplan.width, floorplan.height, points, ap, overlayOpacity),
      ]);
      const [chart24, chart5] = await Promise.all([
        composeHeatmapChart(overlay24, floorplan.width, floorplan.height, "2.4GHz"),
        composeHeatmapChart(overlay5, floorplan.width, floorplan.height, "5GHz"),
      ]);
      setResult({
        heatmap24,
        heatmap5,
        overlay24,
        overlay5,
        chart24,
        chart5,
        floorWithPoints,
        generatedAt: new Date().toISOString(),
        power: idwPower || DEFAULT_IDW_POWER,
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
      return <StepUploadFloorplan floorplan={floorplan} onUpload={uploadFloorplan} onClear={clearProject} />;
    }
    if (currentStep === "scale") {
      return <StepScaleCalibration floorplan={floorplan} scale={scale} onChange={updateScale} />;
    }
    if (currentStep === "router") {
      return <StepRouterPlacement floorplan={floorplan} ap={ap} onSetAp={updateAp} />;
    }
    if (currentStep === "points") {
      return (
        <StepMeasurementPoints
          floorFile={floorFile}
          floorplan={floorplan}
          points={points}
          ap={ap}
          pxPerMeter={scale.pxPerMeter}
          onChange={updatePoints}
        />
      );
    }
    if (currentStep === "rssi") {
      return <StepRssiInput floorplan={floorplan} ap={ap} points={points} onChange={updatePoints} />;
    }
    if (currentStep === "review") {
      return <StepReview floorplan={floorplan} scale={scale} ap={ap} points={points} />;
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
          onGenerate={generateHeatmaps}
        />
      );
    }
    return (
      <StepFinalResult
        floorplan={floorplan}
        scale={scale}
        ap={ap}
        points={points}
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
            <Map size={14} aria-hidden="true" />
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
            <span title={ap ? `AP: ${ap.ap_x_px.toFixed(0)}, ${ap.ap_y_px.toFixed(0)} px` : "AP não definido"}>
              <RadioTower size={13} aria-hidden="true" />
              {ap ? `AP: ${ap.ap_x_px.toFixed(0)}, ${ap.ap_y_px.toFixed(0)} px` : "AP pendente"}
            </span>
            <span title={`${points.length} ponto(s) definido(s)`}>
              <Map size={13} aria-hidden="true" />
              {points.length} ponto(s)
            </span>
            <span title={`Escala: ${scale.pxPerMeter.toFixed(1)} px/m`}>
              <Wifi size={13} aria-hidden="true" />
              {scale.pxPerMeter.toFixed(1)} px / m
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
