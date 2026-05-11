"use client";

import { Flame, Info, Loader2, Wifi } from "lucide-react";
import { DEFAULT_IDW_POWER } from "@/domain/heatmap/idw";
import { hasBlockingIssues } from "@/domain/heatmap/validation";
import type { ValidationIssue } from "@/types/measurement";
import { IssueList } from "./StepUploadFloorplan";

type StepGenerateHeatmapProps = {
  issues: ValidationIssue[];
  opacity: number;
  power: number;
  isGenerating: boolean;
  onOpacityChange: (opacity: number) => void;
  onPowerChange: (power: number) => void;
  onGenerate: () => void;
};

export function StepGenerateHeatmap({
  issues,
  opacity,
  power,
  isGenerating,
  onOpacityChange,
  onPowerChange,
  onGenerate,
}: StepGenerateHeatmapProps) {
  const blocked = hasBlockingIssues(issues);

  return (
    <section className="stepPanel">
      <div className="stepHeader">
        <span className="stepIcon" aria-hidden="true"><Flame size={18} /></span>
        <div>
          <h2>Gerar heatmap</h2>
          <p>Configure os parâmetros de interpolação IDW e gere os mapas de cobertura 2.4 GHz e 5 GHz.</p>
        </div>
      </div>

      <div className="formulaBox" role="region" aria-label="Fórmula IDW">
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6, color: "var(--text-2)", fontSize: 12, fontWeight: 600 }}>
          <Info size={13} aria-hidden="true" />
          Interpolação IDW — Inverse Distance Weighting
        </div>
        <code>RSSI(x,y) = Σ(RSSI_i / d_i^p) / Σ(1 / d_i^p)</code>
        <code>d_i = distância até o ponto medido | p ideal = 2.2</code>
      </div>

      <div className="formGrid two">
        <label className="field" htmlFor="idw-power">
          Potência IDW (p)
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
            Use 2 a 3; o padrão ideal é 2.2
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
            Quanto o heatmap sobrepõe a planta (15%–95%)
          </small>
        </label>
      </div>

      <IssueList issues={issues} />

      <button
        className="primaryButton large"
        type="button"
        disabled={blocked || isGenerating}
        onClick={onGenerate}
        aria-label={isGenerating ? "Gerando heatmaps, aguarde" : "Gerar heatmaps para 2.4 GHz e 5 GHz"}
        aria-busy={isGenerating}
      >
        {isGenerating ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Wifi size={18} aria-hidden="true" />}
        {isGenerating ? "Gerando heatmaps…" : "Gerar 2.4 GHz e 5 GHz"}
      </button>
    </section>
  );
}
