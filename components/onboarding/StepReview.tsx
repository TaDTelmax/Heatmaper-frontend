"use client";

import { ClipboardCheck } from "lucide-react";
import {
  averageRssi,
  bestPoint,
  validateHeatmapReadiness,
  worstPoint,
} from "@/domain/heatmap/validation";
import type { FloorplanImage, RouterPlacement, ScaleCalibration } from "@/types/floorplan";
import type { MeasurementPoint } from "@/types/measurement";
import { Fact, IssueList } from "./StepUploadFloorplan";

type StepReviewProps = {
  floorplan: FloorplanImage;
  scale: ScaleCalibration;
  aps: RouterPlacement[];
  points: MeasurementPoint[];
};

function pointLabel(point: MeasurementPoint | null, band: "24ghz" | "5ghz"): string {
  if (!point) return "-";
  const rssi = band === "24ghz" ? point.rssi_24ghz : point.rssi_5ghz;
  return `${point.point_id} (${rssi ?? "-"} dBm)`;
}

export function StepReview({ floorplan, scale, aps, points }: StepReviewProps) {
  const avg24 = averageRssi(points, "24ghz");
  const avg5 = averageRssi(points, "5ghz");
  const worst24 = worstPoint(points, "24ghz");
  const best24 = bestPoint(points, "24ghz");
  const worst5 = worstPoint(points, "5ghz");
  const best5 = bestPoint(points, "5ghz");
  const issues = validateHeatmapReadiness(floorplan, scale, aps, points);

  return (
    <section className="stepPanel">
      <div className="stepHeader">
        <span className="stepIcon" aria-hidden="true"><ClipboardCheck size={18} /></span>
        <div>
          <h2>Revisão dos dados</h2>
          <p>Resumo completo antes de gerar os mapas. Verifique se todos os valores estão corretos.</p>
        </div>
      </div>

      <div className="factGrid reviewFacts">
        <Fact label="Dimensões" value={`${floorplan.width} × ${floorplan.height}px`} />
        <Fact label="Escala" value={`${scale.pxPerMeter.toFixed(2)} px/m`} />
        <Fact label="Access Points" value={aps.length ? aps.map((ap) => ap.ssid || ap.id.slice(0, 6)).join(", ") : "—"} />
        <Fact label="Pontos medidos" value={points.length} />
        <Fact label="RSSI médio 2.4 GHz" value={avg24 === null ? "—" : `${avg24.toFixed(1)} dBm`} />
        <Fact label="RSSI médio 5 GHz" value={avg5 === null ? "—" : `${avg5.toFixed(1)} dBm`} />
        <Fact label="Pior ponto 2.4 GHz" value={pointLabel(worst24, "24ghz")} />
        <Fact label="Melhor ponto 2.4 GHz" value={pointLabel(best24, "24ghz")} />
        <Fact label="Pior ponto 5 GHz" value={pointLabel(worst5, "5ghz")} />
        <Fact label="Melhor ponto 5 GHz" value={pointLabel(best5, "5ghz")} />
      </div>

      <IssueList issues={issues} />
    </section>
  );
}
