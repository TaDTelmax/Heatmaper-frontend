"use client";

import { Download, FileJson, FileText, ImageDown, Table2 } from "lucide-react";
import { rssiLegendTicks } from "@/domain/heatmap/colorScale";
import {
  buildProjectJson,
  createSimplePdfReport,
  downloadBlob,
  downloadDataUrl,
  downloadTextFile,
  exportCsv,
} from "@/services/exportService";
import type { FloorplanImage, RouterPlacement, ScaleCalibration } from "@/types/floorplan";
import type { HeatmapResult, WifiBand } from "@/types/heatmap";
import { bandLabels } from "@/types/heatmap";
import type { MeasurementPoint } from "@/types/measurement";

type StepFinalResultProps = {
  floorplan: FloorplanImage;
  scale: ScaleCalibration;
  ap: RouterPlacement | null;
  points: MeasurementPoint[];
  result: HeatmapResult | null;
  selectedBand: WifiBand;
  onSelectedBandChange: (band: WifiBand) => void;
};

export function StepFinalResult({
  floorplan,
  scale,
  ap,
  points,
  result,
  selectedBand,
  onSelectedBandChange,
}: StepFinalResultProps) {
  if (!result) {
    return (
      <section className="stepPanel">
        <div className="emptyState compact">
          <strong>Heatmap ainda nao gerado.</strong>
          <span>Volte uma etapa e gere os mapas das duas bandas.</span>
        </div>
      </section>
    );
  }

  const finalResult = result;
  const selectedOverlay = selectedBand === "24ghz" ? finalResult.overlay24 : finalResult.overlay5;
  const selectedHeatmap = selectedBand === "24ghz" ? finalResult.heatmap24 : finalResult.heatmap5;

  function exportJson() {
    downloadTextFile(buildProjectJson(floorplan, scale, ap, points, finalResult), "wifi-heatmap-projeto.json", "application/json;charset=utf-8");
  }

  function exportPdf() {
    const pdf = createSimplePdfReport({
      floorplan,
      scale,
      ap,
      points,
      generatedAt: finalResult.generatedAt,
    });
    downloadBlob(pdf, "wifi-heatmap-relatorio.pdf");
  }

  return (
    <section className="stepPanel wide">
      <div className="stepHeader">
        <span className="stepIcon"><ImageDown size={18} /></span>
        <div>
          <h2>Resultado final</h2>
          <p>Arquivos finais alinhados a {floorplan.width}x{floorplan.height}px.</p>
        </div>
      </div>

      <div className="resultTabs" role="radiogroup" aria-label="Banda do overlay final">
        {(["24ghz", "5ghz"] as WifiBand[]).map((band) => (
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

      <div className="resultGallery">
        <ResultImage title="Planta original" src={floorplan.dataUrl} />
        <ResultImage title="Planta com pontos" src={finalResult.floorWithPoints} />
        <ResultImage title="Mapa 2.4GHz" src={finalResult.chart24} />
        <ResultImage title="Mapa 5GHz" src={finalResult.chart5} />
        <ResultImage title={`Overlay final ${bandLabels[selectedBand]}`} src={selectedOverlay} featured />
      </div>

      <div className="legendBar" aria-label="Legenda RSSI">
        {rssiLegendTicks.map((stop) => (
          <span key={stop.label}>
            <i style={{ background: stop.color }} />
            {stop.label}
          </span>
        ))}
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
        <button className="secondaryButton" type="button" onClick={() => downloadDataUrl(selectedOverlay, `wifi-heatmap-overlay-${selectedBand}.png`)}>
          <ImageDown size={16} />
          PNG overlay
        </button>
        <button className="secondaryButton" type="button" onClick={exportJson}>
          <FileJson size={16} />
          JSON projeto
        </button>
        <button className="secondaryButton" type="button" onClick={exportPdf}>
          <FileText size={16} />
          PDF simples
        </button>
      </div>

      <div className="factGrid">
        <div className="fact">
          <span>RSSI minimo</span>
          <b>{selectedHeatmap.minRssi} dBm</b>
        </div>
        <div className="fact">
          <span>RSSI maximo</span>
          <b>{selectedHeatmap.maxRssi} dBm</b>
        </div>
        <div className="fact">
          <span>RSSI medio</span>
          <b>{selectedHeatmap.avgRssi} dBm</b>
        </div>
      </div>

      <div className="tableShell final">
        <table className="dataTable">
          <thead>
            <tr>
              <th>point_id</th>
              <th>x_px</th>
              <th>y_px</th>
              <th>rssi_24ghz</th>
              <th>rssi_5ghz</th>
              <th>distance_m</th>
              <th>timestamp</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.point_id}>
                <td>{point.point_id}</td>
                <td>{point.x_px.toFixed(1)}</td>
                <td>{point.y_px.toFixed(1)}</td>
                <td>{point.rssi_24ghz ?? "-"}</td>
                <td>{point.rssi_5ghz ?? "-"}</td>
                <td>{point.distance_m === null ? "-" : point.distance_m.toFixed(2)}</td>
                <td>{point.timestamp}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ResultImage({ title, src, featured = false }: { title: string; src: string; featured?: boolean }) {
  return (
    <figure className={`resultImage ${featured ? "featured" : ""}`}>
      <img src={src} alt={title} />
      <figcaption>{title}</figcaption>
    </figure>
  );
}
