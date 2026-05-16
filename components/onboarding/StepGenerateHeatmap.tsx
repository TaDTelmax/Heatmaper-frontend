"use client";

import type { PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Flame, Info, Loader2, RadioTower, ScanLine, Trash2, Wifi } from "lucide-react";
import { materialLossProfiles } from "@/domain/heatmap/attenuation";
import { DEFAULT_IDW_POWER } from "@/domain/heatmap/idw";
import {
  type AutoWallDetectionResult,
  createFloorplanMaterialSampler,
  detectWallSegmentsFromFloorplan,
  detectWallMaterialFromTrace,
  type FloorplanMaterialSampler,
  type MaterialTraceAnalysis,
} from "@/domain/heatmap/materialDetection";
import { hasBlockingIssues } from "@/domain/heatmap/validation";
import type { FloorplanImage } from "@/types/floorplan";
import type { RfPoint, WallMaterial, WallSegment } from "@/types/heatmap";
import type { ValidationIssue } from "@/types/measurement";
import { IssueList } from "./StepUploadFloorplan";

type StepGenerateHeatmapProps = {
  issues: ValidationIssue[];
  floorplan: FloorplanImage;
  walls: WallSegment[];
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
  onWallsChange: (walls: WallSegment[]) => void;
  onGenerate: () => void;
};

export function StepGenerateHeatmap({
  issues,
  floorplan,
  walls,
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
  onWallsChange,
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

      <RfLayoutEditor
        floorplan={floorplan}
        walls={walls}
        onWallsChange={onWallsChange}
      />

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

type RfLayoutEditorProps = {
  floorplan: FloorplanImage;
  walls: WallSegment[];
  onWallsChange: (walls: WallSegment[]) => void;
};

const wallMaterialOptions: { value: WallMaterial }[] = [
  { value: "drywall" },
  { value: "glass" },
  { value: "wood" },
  { value: "brick" },
  { value: "concrete" },
  { value: "reinforced_concrete" },
  { value: "stone" },
  { value: "metal" },
];

function materialLabel(material: WallMaterial): string {
  return materialLossProfiles[material]?.label ?? material;
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

function wallKey(wall: WallSegment): string {
  return wall.id ?? `${wall.start.x}:${wall.start.y}:${wall.end.x}:${wall.end.y}:${wall.material}`;
}

function RfLayoutEditor({ floorplan, walls, onWallsChange }: RfLayoutEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [material, setMaterial] = useState<WallMaterial>("concrete");
  const [materialSampler, setMaterialSampler] = useState<FloorplanMaterialSampler | null>(null);
  const [samplerReady, setSamplerReady] = useState(false);
  const [autoDetection, setAutoDetection] = useState<AutoWallDetectionResult | null>(null);
  const [isDetectingWalls, setIsDetectingWalls] = useState(false);
  const [lastMaterialDetection, setLastMaterialDetection] = useState<MaterialTraceAnalysis | null>(null);
  const [pendingPoint, setPendingPoint] = useState<RfPoint | null>(null);
  const [hoverPoint, setHoverPoint] = useState<RfPoint | null>(null);
  const [selectedWallKey, setSelectedWallKey] = useState<string | null>(null);
  const autoDetectionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    setMaterialSampler(null);
    setSamplerReady(false);
    setAutoDetection(null);
    setLastMaterialDetection(null);
    setSelectedWallKey(null);

    createFloorplanMaterialSampler(floorplan.dataUrl, floorplan.width, floorplan.height)
      .then((sampler) => {
        if (active) setMaterialSampler(sampler);
      })
      .catch(() => {
        if (active) setMaterialSampler(null);
      })
      .finally(() => {
        if (active) setSamplerReady(true);
      });

    return () => {
      active = false;
    };
  }, [floorplan.dataUrl, floorplan.width, floorplan.height]);

  useEffect(() => {
    if (!materialSampler || !samplerReady || walls.length) return;
    const key = `${floorplan.fileName}-${floorplan.width}x${floorplan.height}-${floorplan.fileSize}`;
    if (autoDetectionKeyRef.current === key) return;
    autoDetectionKeyRef.current = key;
    const timer = window.setTimeout(() => runAutoWallDetection(), 0);
    return () => window.clearTimeout(timer);
  }, [floorplan.fileName, floorplan.fileSize, floorplan.width, floorplan.height, materialSampler, samplerReady, walls.length]);

  useEffect(() => {
    if (!selectedWallKey) return;
    if (!walls.some((wall) => wallKey(wall) === selectedWallKey)) {
      setSelectedWallKey(null);
    }
  }, [selectedWallKey, walls]);

  function coordinateFromEvent(event: PointerEvent<SVGSVGElement>): RfPoint {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.round((((event.clientX - rect.left) / rect.width) * floorplan.width) * 10) / 10,
      y: Math.round((((event.clientY - rect.top) / rect.height) * floorplan.height) * 10) / 10,
    };
  }

  function handleCanvasClick(event: PointerEvent<SVGSVGElement>) {
    const point = coordinateFromEvent(event);
    if (!pendingPoint) {
      setSelectedWallKey(null);
      setPendingPoint(point);
      return;
    }

    if (Math.hypot(point.x - pendingPoint.x, point.y - pendingPoint.y) < 8) {
      setPendingPoint(null);
      return;
    }

    const detected = detectWallMaterialFromTrace(materialSampler, pendingPoint, point, material);
    const wallMaterial = detected.material;

    onWallsChange([
      ...walls,
      {
        id: makeId("wall"),
        start: pendingPoint,
        end: point,
        material: wallMaterial,
      },
    ]);
    setMaterial(wallMaterial);
    setLastMaterialDetection(detected);
    setSelectedWallKey(null);
    setPendingPoint(null);
    setHoverPoint(null);
  }

  function handleWallPointerDown(event: PointerEvent<SVGGElement>, key: string) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedWallKey(key);
    setPendingPoint(null);
    setHoverPoint(null);
  }

  function undoLastWall() {
    onWallsChange(walls.slice(0, -1));
    setPendingPoint(null);
    setHoverPoint(null);
  }

  function removeSelectedWall() {
    if (!selectedWallKey) return;
    onWallsChange(walls.filter((wall) => wallKey(wall) !== selectedWallKey));
    setSelectedWallKey(null);
    setPendingPoint(null);
    setHoverPoint(null);
  }

  function runAutoWallDetection() {
    if (!materialSampler) return;
    setIsDetectingWalls(true);
    window.requestAnimationFrame(() => {
      const detected = detectWallSegmentsFromFloorplan(materialSampler, material);
      onWallsChange(detected.walls);
      setAutoDetection(detected);
      setLastMaterialDetection(null);
      if (detected.walls[0]) setMaterial(detected.walls[0].material);
      setPendingPoint(null);
      setHoverPoint(null);
      setSelectedWallKey(null);
      setIsDetectingWalls(false);
    });
  }

  return (
    <div className="rfLayoutEditor">
      <div className="rfLayoutToolbar">
        <div className="rfLayoutTitle">
          <ScanLine size={15} aria-hidden="true" />
          Paredes e materiais
        </div>

        <label className="field compactSelect" htmlFor="wall-material">
          Material padrao
          <select id="wall-material" value={material} onChange={(event) => setMaterial(event.target.value as WallMaterial)}>
            {wallMaterialOptions.map((option) => (
              <option key={option.value} value={option.value}>{materialLabel(option.value)}</option>
            ))}
          </select>
        </label>

        <button className="secondaryButton" type="button" onClick={runAutoWallDetection} disabled={!materialSampler || isDetectingWalls}>
          {isDetectingWalls ? "Detectando..." : "Detectar paredes"}
        </button>

        <button className="secondaryButton" type="button" onClick={undoLastWall} disabled={!walls.length}>
          Desfazer parede
        </button>

        <button className="dangerButton" type="button" onClick={removeSelectedWall} disabled={!selectedWallKey}>
          <Trash2 size={15} aria-hidden="true" />
          Remover parede
        </button>
      </div>

      <div className="rfLayoutCanvas" style={{ aspectRatio: `${floorplan.width} / ${floorplan.height}` }}>
        <img src={floorplan.dataUrl} alt="Planta para demarcacao RF" draggable={false} />
        <svg
          ref={svgRef}
          viewBox={`0 0 ${floorplan.width} ${floorplan.height}`}
          preserveAspectRatio="none"
          onPointerDown={handleCanvasClick}
          onPointerMove={(event) => pendingPoint && setHoverPoint(coordinateFromEvent(event))}
          onPointerLeave={() => setHoverPoint(null)}
        >
          {walls.map((wall) => {
            const key = wallKey(wall);
            const selected = selectedWallKey === key;
            return (
              <g key={key} className={`rfWallGroup${selected ? " selected" : ""}`} onPointerDown={(event) => handleWallPointerDown(event, key)}>
                <line
                  x1={wall.start.x}
                  y1={wall.start.y}
                  x2={wall.end.x}
                  y2={wall.end.y}
                  className="rfWallHitTarget"
                />
                {selected && (
                  <line
                    x1={wall.start.x}
                    y1={wall.start.y}
                    x2={wall.end.x}
                    y2={wall.end.y}
                    className="rfWallSelectionHalo"
                  />
                )}
                <line
                  x1={wall.start.x}
                  y1={wall.start.y}
                  x2={wall.end.x}
                  y2={wall.end.y}
                  className={`rfWallLine material-${wall.material}`}
                >
                  <title>{materialLabel(wall.material)}</title>
                </line>
              </g>
            );
          })}
          {pendingPoint && hoverPoint && (
            <line
              x1={pendingPoint.x}
              y1={pendingPoint.y}
              x2={hoverPoint.x}
              y2={hoverPoint.y}
              className={`rfWallPreview material-${material}`}
            />
          )}
          {pendingPoint && (
            <g className="rfPendingPoint" transform={`translate(${pendingPoint.x} ${pendingPoint.y})`}>
              <circle r="9" />
              <text y="-13">Inicio da parede</text>
            </g>
          )}
        </svg>
      </div>

      <div className="rfLayoutSummary" aria-label="Resumo de paredes e salas">
        <span>{walls.length} parede(s)</span>
        <span>{samplerReady ? "Deteccao automatica ativa" : "Lendo tracado da planta"}</span>
        {autoDetection && (
          <span>
            Auto: {autoDetection.horizontalCount} H / {autoDetection.verticalCount} V
          </span>
        )}
        {lastMaterialDetection && (
          <span>
            Material detectado: {materialLabel(lastMaterialDetection.material)} ({Math.round(lastMaterialDetection.confidence * 100)}%)
          </span>
        )}
        {selectedWallKey && <span>Parede selecionada</span>}
        <span>{pendingPoint ? "Segundo clique finaliza o ajuste" : "Clique para ajuste manual"}</span>
      </div>
    </div>
  );
}
