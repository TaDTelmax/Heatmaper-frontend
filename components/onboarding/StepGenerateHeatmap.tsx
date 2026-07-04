"use client";

import { Flame, Info, Loader2, RadioTower, ScanLine, Wifi } from "lucide-react";
import { DEFAULT_IDW_POWER } from "@/domain/heatmap/idw";
import { hasBlockingIssues } from "@/domain/heatmap/validation";
import type { ValidationIssue } from "@/types/measurement";
import { IssueList } from "./StepUploadFloorplan";

type StepGenerateHeatmapProps = {
  issues: ValidationIssue[];
  opacity: number;
  power: number;
  interpolationRadiusM: number;
  gaussianBlurPx: number;
  useWallAttenuation: boolean;
  isGenerating: boolean;
  onOpacityChange: (opacity: number) => void;
  onPowerChange: (power: number) => void;
  onInterpolationRadiusChange: (radiusM: number) => void;
  onGaussianBlurChange: (blurPx: number) => void;
  onUseWallAttenuationChange: (enabled: boolean) => void;
  onGenerate: () => void;
};

export function StepGenerateHeatmap({
  issues,
  opacity,
  power,
  interpolationRadiusM,
  gaussianBlurPx,
  useWallAttenuation,
  isGenerating,
  onOpacityChange,
  onPowerChange,
  onInterpolationRadiusChange,
  onGaussianBlurChange,
  onUseWallAttenuationChange,
  onGenerate,
}: StepGenerateHeatmapProps) {
  const blocked = hasBlockingIssues(issues);

  return (
    <section className="stepPanel">
      <div className="stepHeader">
        <span className="stepIcon" aria-hidden="true"><Flame size={18} /></span>
        <div>
          <h2>Gerar heatmap</h2>
          <p>Configure o motor RF e gere mapas continuos de cobertura 2.4 GHz, 5 GHz e 6 GHz.</p>
        </div>
      </div>

      <div className="formulaBox" role="region" aria-label="Formula IDW">
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6, color: "var(--text-2)", fontSize: 12, fontWeight: 600 }}>
          <Info size={13} aria-hidden="true" />
          Interpolacao IDW - Inverse Distance Weighting
        </div>
        <code>RSSI(x,y) = Sum(RSSI_i / d_i^p) / Sum(1 / d_i^p)</code>
        <code>Cada ponto medido ancora sua propria mancha de interpolacao</code>
      </div>

      <div className="formGrid two">
        <label className="field" htmlFor="idw-power">
          Potencia IDW (p)
          <input
            id="idw-power"
            type="number"
            min="1"
            max="5"
            step="0.1"
            value={power}
            placeholder={String(DEFAULT_IDW_POWER)}
            onChange={(event) => onPowerChange(Number(event.target.value))}
            aria-describedby="idw-power-hint"
          />
          <small id="idw-power-hint" style={{ color: "var(--muted)", fontSize: 11 }}>
            Use 1.8 a 2.4 para manchas RF suaves e continuas
          </small>
        </label>

        <label className="field rangeField" htmlFor="interpolation-radius">
          <span>
            Raio RF
            <b style={{ marginLeft: "auto", color: "var(--accent)" }}>{interpolationRadiusM.toFixed(0)} m</b>
          </span>
          <input
            id="interpolation-radius"
            type="range"
            min="8"
            max="80"
            step="1"
            value={interpolationRadiusM}
            onChange={(event) => onInterpolationRadiusChange(Number(event.target.value))}
            aria-label={`Raio de interpolacao RF: ${interpolationRadiusM.toFixed(0)} metros`}
          />
          <small style={{ color: "var(--muted)", fontSize: 11 }}>
            Limita a influencia de cada medicao na propagacao indoor
          </small>
        </label>

        <label className="field rangeField" htmlFor="overlay-opacity">
          <span>
            Opacidade do overlay
            <b style={{ marginLeft: "auto", color: "var(--accent)" }}>{Math.round(opacity * 100)}%</b>
          </span>
          <input
            id="overlay-opacity"
            type="range"
            min="0.15"
            max="0.95"
            step="0.01"
            value={opacity}
            onChange={(event) => onOpacityChange(Number(event.target.value))}
            aria-label={`Opacidade do overlay: ${Math.round(opacity * 100)}%`}
          />
          <small style={{ color: "var(--muted)", fontSize: 11 }}>
            Quanto o heatmap sobrepoe a planta (15%-95%)
          </small>
        </label>

        <label className="field rangeField" htmlFor="gaussian-blur">
          <span>
            Suavizacao gaussiana
            <b style={{ marginLeft: "auto", color: "var(--accent)" }}>{gaussianBlurPx.toFixed(0)} px</b>
          </span>
          <input
            id="gaussian-blur"
            type="range"
            min="0"
            max="42"
            step="1"
            value={gaussianBlurPx}
            onChange={(event) => onGaussianBlurChange(Number(event.target.value))}
            aria-label={`Suavizacao gaussiana: ${gaussianBlurPx.toFixed(0)} pixels`}
          />
          <small style={{ color: "var(--muted)", fontSize: 11 }}>
            Remove banding e mantem transicoes organicas
          </small>
        </label>
      </div>

      <div className="rfOptionGrid" aria-label="Opcoes RF">
        <label className="toggleOption" htmlFor="wall-attenuation">
          <input
            id="wall-attenuation"
            type="checkbox"
            checked={useWallAttenuation}
            onChange={(event) => onUseWallAttenuationChange(event.target.checked)}
          />
          <span><ScanLine size={15} aria-hidden="true" /> Atenuacao por paredes</span>
        </label>
        <div className="rfCapability"><RadioTower size={15} aria-hidden="true" /> 2.4 GHz, 5 GHz e 6 GHz com perdas distintas</div>
        <div className="rfCapability"><Wifi size={15} aria-hidden="true" /> IDW continuo + decaimento ponderado</div>
      </div>

      <IssueList issues={issues} />

      <button
        className="primaryButton large"
        type="button"
        disabled={blocked || isGenerating}
        onClick={onGenerate}
        aria-label={isGenerating ? "Gerando heatmaps, aguarde" : "Gerar heatmaps para 2.4 GHz, 5 GHz e 6 GHz"}
        aria-busy={isGenerating}
      >
        {isGenerating ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Wifi size={18} aria-hidden="true" />}
        {isGenerating ? "Gerando heatmaps..." : "Gerar tri-band RF"}
      </button>
    </section>
  );
}
