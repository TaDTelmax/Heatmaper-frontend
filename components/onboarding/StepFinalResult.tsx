"use client";

import type { PointerEvent } from "react";
import { useState } from "react";
import {
  Download,
  Eye,
  EyeOff,
  FileJson,
  ImageDown,
  Layers,
  LocateFixed,
  Minus,
  Plus,
  RadioTower,
  Table2,
  Wifi,
} from "lucide-react";
import { rssiLegendTicks } from "@/domain/heatmap/colorScale";
import {
  buildProjectJson,
  downloadDataUrl,
  downloadTextFile,
  exportCsv,
} from "@/services/exportService";
import type { FloorplanImage, RouterPlacement, ScaleCalibration } from "@/types/floorplan";
import type { HeatmapResult, WallSegment, WifiBand } from "@/types/heatmap";
import { bandLabels } from "@/types/heatmap";
import type { MeasurementPoint } from "@/types/measurement";

type StepFinalResultProps = {
  floorplan: FloorplanImage;
  scale: ScaleCalibration;
  aps: RouterPlacement[];
  points: MeasurementPoint[];
  walls: WallSegment[];
  result: HeatmapResult | null;
  selectedBand: WifiBand;
  onSelectedBandChange: (band: WifiBand) => void;
};

type LayerToggleProps = {
  active: boolean;
  label: string;
  onClick: () => void;
};

const MAX_RENDERED_RESULT_POINTS = 900;

function sampledPoints(points: MeasurementPoint[], limit: number): MeasurementPoint[] {
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

// Kept in sync with FloorplanCanvas.tsx's marker sizing so calibration-time
// markers and the final-result overlay read at the same relative scale.
function markerRadiusForFloorplan(floorplan: FloorplanImage): number {
  const size = Math.max(floorplan.width, floorplan.height);
  return Math.round(Math.min(42, Math.max(6, size * 0.0075)) * 10) / 10;
}

export function StepFinalResult({
  floorplan,
  scale,
  aps,
  points,
  walls,
  result,
  selectedBand,
  onSelectedBandChange,
}: StepFinalResultProps) {
  const [showFloorplan, setShowFloorplan] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showAp, setShowAp] = useState(true);
  const [showPoints, setShowPoints] = useState(false);
  const [showRfLayout, setShowRfLayout] = useState(true);
  const [viewerOpacity, setViewerOpacity] = useState(result?.opacity ?? 0.68);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragOrigin, setDragOrigin] = useState<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const renderedPoints = sampledPoints(points, MAX_RENDERED_RESULT_POINTS);
  const markerRadius = markerRadiusForFloorplan(floorplan);
  const markerTextSize = Math.max(6.5, markerRadius * 1.02);
  const markerTextY = markerRadius * 0.34;
  const apRadius = markerRadius * 1.25;
  const apCoreRadius = markerRadius * 0.66;
  const apIconSize = markerRadius * 1.18;

  if (!result) {
    return (
      <section className="stepPanel">
        <div className="emptyState compact">
          <strong>Heatmap ainda nao gerado.</strong>
          <span>Volte uma etapa e gere os mapas tri-band.</span>
        </div>
      </section>
    );
  }

  const finalResult = result;
  const selectedOverlay =
    selectedBand === "24ghz" ? finalResult.overlay24 : selectedBand === "5ghz" ? finalResult.overlay5 : finalResult.overlay6;
  const selectedHeatmap =
    selectedBand === "24ghz" ? finalResult.heatmap24 : selectedBand === "5ghz" ? finalResult.heatmap5 : finalResult.heatmap6;

  function exportJson() {
    downloadTextFile(buildProjectJson(floorplan, scale, aps, points, finalResult, walls), "wifi-heatmap-projeto.json", "application/json;charset=utf-8");
  }

  function handlePanStart(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragOrigin({ x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y });
  }

  function handlePanMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragOrigin) return;
    setPan({
      x: dragOrigin.panX + event.clientX - dragOrigin.x,
      y: dragOrigin.panY + event.clientY - dragOrigin.y,
    });
  }

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  return (
    <section className="stepPanel wide">
      <div className="stepHeader">
        <span className="stepIcon"><ImageDown size={18} /></span>
        <div>
          <h2>Resultado final</h2>
          <p>Overlay RF continuo alinhado a {floorplan.width}x{floorplan.height}px.</p>
        </div>
      </div>

      <div className="rfWorkbench">
        <div className="rfToolbar">
          <div className="resultTabs" role="radiogroup" aria-label="Banda do overlay final">
            {(["24ghz", "5ghz", "6ghz"] as WifiBand[]).map((band) => (
              <button
                key={band}
                type="button"
                className={selectedBand === band ? "active" : ""}
                onClick={() => onSelectedBandChange(band)}
                aria-checked={selectedBand === band}
                role="radio"
              >
                {bandLabels[band]}
              </button>
            ))}
          </div>

          <div className="layerToggles" aria-label="Camadas do mapa">
            <LayerToggle active={showFloorplan} label="Planta" onClick={() => setShowFloorplan((value) => !value)} />
            <LayerToggle active={showHeatmap} label="Heatmap" onClick={() => setShowHeatmap((value) => !value)} />
            <LayerToggle active={showAp} label="AP" onClick={() => setShowAp((value) => !value)} />
            <LayerToggle active={showPoints} label="Pontos medidos" onClick={() => setShowPoints((value) => !value)} />
            <LayerToggle active={showRfLayout} label="RF layout" onClick={() => setShowRfLayout((value) => !value)} />
          </div>

          <div className="zoomTools" aria-label="Zoom e pan">
            <button className="iconButton" type="button" onClick={() => setZoom((value) => Math.max(0.65, Number((value - 0.15).toFixed(2))))} title="Diminuir zoom">
              <Minus size={15} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button className="iconButton" type="button" onClick={() => setZoom((value) => Math.min(3, Number((value + 0.15).toFixed(2))))} title="Aumentar zoom">
              <Plus size={15} />
            </button>
            <button className="iconButton" type="button" onClick={resetView} title="Centralizar">
              <LocateFixed size={15} />
            </button>
          </div>
        </div>

        <div className="rfViewerGrid">
          <div
            className="rfViewport"
            onPointerDown={handlePanStart}
            onPointerMove={handlePanMove}
            onPointerUp={() => setDragOrigin(null)}
            onPointerCancel={() => setDragOrigin(null)}
          >
            <div
              className="rfScene"
              style={{
                aspectRatio: `${floorplan.width} / ${floorplan.height}`,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
            >
              {showFloorplan && <img className="rfFloorLayer" src={floorplan.dataUrl} alt="Planta baixa" draggable={false} />}
              {showHeatmap && (
                <img
                  className="rfHeatmapLayer"
                  src={selectedHeatmap.dataUrl}
                  alt={`Heatmap ${bandLabels[selectedBand]}`}
                  draggable={false}
                  style={{ opacity: viewerOpacity }}
                />
              )}
              <svg className="rfMarkerLayer" viewBox={`0 0 ${floorplan.width} ${floorplan.height}`} preserveAspectRatio="none" aria-hidden="true">
                {showRfLayout &&
                  walls.map((wall) => (
                    <line
                      key={wall.id ?? `${wall.start.x}-${wall.start.y}-${wall.end.x}-${wall.end.y}`}
                      x1={wall.start.x}
                      y1={wall.start.y}
                      x2={wall.end.x}
                      y2={wall.end.y}
                      className={`rfWallLine material-${wall.material}`}
                    />
                  ))}
                {showAp && aps.map((ap) => (
                  <g key={ap.id} className="rfApMarker" transform={`translate(${ap.ap_x_px} ${ap.ap_y_px})`}>
                    <circle className="rfApHalo" r={apRadius} />
                    <circle className="rfApCore" r={apCoreRadius} />
                    <RadioTower className="rfApIcon" size={apIconSize} x={-apIconSize / 2} y={-apIconSize / 2} />
                  </g>
                ))}
                {showPoints &&
                  renderedPoints.map((point) => (
                    <g key={point.point_id} className="rfMeasurementMarker" transform={`translate(${point.x_px} ${point.y_px})`}>
                      <circle r={markerRadius} />
                      <text y={markerTextY} style={{ fontSize: markerTextSize }}>{point.point_id.replace(/^P/i, "")}</text>
                    </g>
                  ))}
              </svg>
            </div>
          </div>

          <aside className="rfInspector">
            <div className="inspectorHeader">
              <Wifi size={16} />
              <strong>{bandLabels[selectedBand]} RF</strong>
            </div>

            <label className="field rangeField compactRange" htmlFor="viewer-opacity">
              <span>
                Opacidade
                <b>{Math.round(viewerOpacity * 100)}%</b>
              </span>
              <input
                id="viewer-opacity"
                type="range"
                min="0.15"
                max="0.95"
                step="0.01"
                value={viewerOpacity}
                onChange={(event) => setViewerOpacity(Number(event.target.value))}
              />
            </label>

            <div className="rfLegend" aria-label="Legenda RSSI">
              <div
                className="rfLegendScale"
                style={{ gridTemplateColumns: `repeat(${rssiLegendTicks.length}, minmax(24px, 1fr))` }}
              >
                {rssiLegendTicks.map((tick) => (
                  <i key={tick.label} style={{ background: tick.color }} />
                ))}
                {rssiLegendTicks.map((tick) => (
                  <span key={`${tick.label}-label`}>{tick.label}</span>
                ))}
              </div>
            </div>

            <div className="factGrid compactFacts">
              <div className="fact"><span>Min RSSI</span><b>{selectedHeatmap.minRssi} dBm</b></div>
              <div className="fact"><span>Max RSSI</span><b>{selectedHeatmap.maxRssi} dBm</b></div>
              <div className="fact"><span>Media</span><b>{selectedHeatmap.avgRssi} dBm</b></div>
              <div className="fact"><span>Cobertura</span><b>{selectedHeatmap.coveragePercentage}%</b></div>
              <div className="fact"><span>Dead zones</span><b>{selectedHeatmap.deadZonePercentage}%</b></div>
              <div className="fact"><span>Amostra</span><b>{selectedHeatmap.sampleStep}px</b></div>
              <div className="fact"><span>Roaming</span><b>{selectedHeatmap.roomAnalysis[0]?.roamingQuality ?? 0}%</b></div>
              <div className="fact"><span>Salas/zonas</span><b>{selectedHeatmap.roomAnalysis.length}</b></div>
              <div className="fact"><span>Pontos definidos</span><b>{points.length}</b></div>
              <div className="fact"><span>Pontos usados</span><b>{selectedHeatmap.pointAnalysis.length}</b></div>
            </div>
          </aside>
        </div>
      </div>

      <div className="roomAnalysisPanel">
        <div className="sectionTitle">
          <Layers size={16} aria-hidden="true" />
          <strong>Analise por sala</strong>
        </div>
        {selectedHeatmap.roomAnalysis.length ? (
          <div className="tableShell final">
            <table className="dataTable roomTable">
              <thead>
                <tr>
                  <th>Zona</th>
                  <th>Area</th>
                  <th>Amostras</th>
                  <th>Media</th>
                  <th>Melhor/Pior</th>
                  <th>Cobertura</th>
                  <th>Fraco</th>
                  <th>Dead zone</th>
                  <th>Roaming</th>
                  <th>Throughput</th>
                  <th>Latencia</th>
                  <th>Canal</th>
                </tr>
              </thead>
              <tbody>
                {selectedHeatmap.roomAnalysis.map((room) => (
                  <tr key={room.id}>
                    <td>{room.name}</td>
                    <td>{room.areaM2 === null ? `${room.areaPx}px2` : `${room.areaM2} m2`}</td>
                    <td>{room.sampleCount}</td>
                    <td>{room.avgRssi} dBm</td>
                    <td>{room.bestRssi} / {room.worstRssi} dBm</td>
                    <td>{room.coveragePercentage}%</td>
                    <td>{room.weakCoveragePercentage}%</td>
                    <td>{room.deadZonePercentage}%</td>
                    <td>{room.roamingQuality}%</td>
                    <td>{room.estimatedThroughputMbps} Mbps</td>
                    <td>{room.estimatedLatencyMs} ms</td>
                    <td>{room.channelQuality}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="emptyState compact">
            <strong>Nenhuma zona indoor valida nesta banda.</strong>
            <span>As salas detectadas aparecem aqui quando ha mascara interna e campo RF ativo.</span>
          </div>
        )}
      </div>

      <div className="exportGrid">
        <button className="secondaryButton" type="button" onClick={() => downloadTextFile(exportCsv(points), "wifi-heatmap-pontos.csv", "text/csv;charset=utf-8")}>
          <Table2 size={16} />
          CSV final
        </button>
        <button className="secondaryButton" type="button" onClick={() => downloadDataUrl(finalResult.chart24, "wifi-heatmap-24ghz.png")}>
          <Download size={16} />
          PNG 2.4
        </button>
        <button className="secondaryButton" type="button" onClick={() => downloadDataUrl(finalResult.chart5, "wifi-heatmap-5ghz.png")}>
          <Download size={16} />
          PNG 5
        </button>
        <button className="secondaryButton" type="button" onClick={() => downloadDataUrl(finalResult.chart6, "wifi-heatmap-6ghz.png")}>
          <Download size={16} />
          PNG 6
        </button>
        <button className="secondaryButton" type="button" onClick={() => downloadDataUrl(selectedOverlay, `wifi-heatmap-overlay-${selectedBand}.png`)}>
          <ImageDown size={16} />
          PNG overlay
        </button>
        <button className="secondaryButton" type="button" onClick={exportJson}>
          <FileJson size={16} />
          JSON projeto
        </button>
      </div>
    </section>
  );
}

function LayerToggle({ active, label, onClick }: LayerToggleProps) {
  return (
    <button className={`layerToggle ${active ? "active" : ""}`} type="button" onClick={onClick} aria-pressed={active}>
      {active ? <Eye size={14} /> : <EyeOff size={14} />}
      {label}
    </button>
  );
}
