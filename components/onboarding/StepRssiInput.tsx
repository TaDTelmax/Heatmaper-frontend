"use client";

import type { ChangeEvent } from "react";
import { useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, FileSpreadsheet, Move, UploadCloud } from "lucide-react";
import { validateMeasurementPoints, validateRssi } from "@/domain/heatmap/validation";
import { normalizeCsvPointId, parseMeasurementCsv, pointIdAliases, prepareCsvRowsForFloorplan } from "@/services/csvService";
import type { FloorplanImage, RouterPlacement } from "@/types/floorplan";
import type { CsvMeasurementRow, MeasurementPoint } from "@/types/measurement";
import { FloorplanCanvas } from "./FloorplanCanvas";
import { IssueList } from "./StepUploadFloorplan";

const MAX_VISIBLE_RSSI_ROWS = 600;

type StepRssiInputProps = {
  floorplan: FloorplanImage;
  aps: RouterPlacement[];
  points: MeasurementPoint[];
  pxPerMeter: number;
  onChange: (points: MeasurementPoint[]) => void;
};

function parseInputNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rowToPoint(row: CsvMeasurementRow, index: number): MeasurementPoint | null {
  if (row.x_px === null || row.x_px === undefined || row.y_px === null || row.y_px === undefined) return null;
  return {
    point_id: normalizeCsvPointId(row.point_id, index + 1),
    x_px: row.x_px,
    y_px: row.y_px,
    rssi_24ghz: row.rssi_24ghz ?? null,
    rssi_5ghz: row.rssi_5ghz ?? null,
    rssi_6ghz: row.rssi_6ghz ?? null,
    distance_m: null,
    csv_distance_m: row.distance_m ?? null,
    timestamp: row.timestamp || new Date().toISOString(),
    source: "csv",
  };
}

function addRowAliases(map: Map<string, CsvMeasurementRow>, row: CsvMeasurementRow) {
  for (const alias of pointIdAliases(row.point_id)) {
    map.set(alias, row);
  }
}

function findRowForPoint(map: Map<string, CsvMeasurementRow>, pointId: string): CsvMeasurementRow | undefined {
  for (const alias of pointIdAliases(pointId)) {
    const row = map.get(alias);
    if (row) return row;
  }
  return undefined;
}

const NUDGE_STEPS_M = [0.05, 0.2, 0.5] as const;

export function StepRssiInput({ floorplan, aps, points, pxPerMeter, onChange }: StepRssiInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(points[0]?.point_id ?? null);
  const [nudgeStepM, setNudgeStepM] = useState<number>(NUDGE_STEPS_M[1]);
  const visiblePoints = points.length > MAX_VISIBLE_RSSI_ROWS ? points.slice(0, MAX_VISIBLE_RSSI_ROWS) : points;
  const hasSurveyPoints = points.some((point) => point.source === "csv");

  function updatePoint(pointId: string, patch: Partial<MeasurementPoint>) {
    onChange(points.map((point) => (point.point_id === pointId ? { ...point, ...patch } : point)));
  }

  // Manual alignment for imported survey points: a robot/app's own coordinate
  // frame has no inherent relationship to the floorplan's pixel frame (the
  // project's own docs list this as a known limitation), so an automatic
  // mapping can land points a bit outside real walls (e.g. in an exterior
  // strip). Nudges only "csv"-sourced points, in the real-world direction
  // implied by dx/dy meters, leaving manually-placed points untouched.
  function nudgeSurveyPoints(dxM: number, dyM: number) {
    if (!Number.isFinite(pxPerMeter) || pxPerMeter <= 0) return;
    const dxPx = dxM * pxPerMeter;
    const dyPx = dyM * pxPerMeter;
    onChange(
      points.map((point) =>
        point.source === "csv" ? { ...point, x_px: point.x_px + dxPx, y_px: point.y_px + dyPx } : point,
      ),
    );
  }

  async function importCsv(file: File) {
    const text = await file.text();
    const result = parseMeasurementCsv(text);
    const messages: string[] = [...result.errors];
    const { rows, issues: prepareIssues } = prepareCsvRowsForFloorplan(result.rows, floorplan, pxPerMeter);
    messages.push(...prepareIssues.map((prepareIssue) => prepareIssue.message));
    const hasCoordinates = rows.some((row) => row.x_px !== null && row.x_px !== undefined && row.y_px !== null && row.y_px !== undefined);
    const normalizedSurvey = result.rows.some((row) => row.coordinate_kind === "survey");
    if (!rows.length) {
      if (messages.length) setImportMessage(messages.join(" "));
      return;
    }

    if (!hasCoordinates && !points.length) {
      messages.push("CSV sem x_px/y_px: marque os pontos na planta antes de importar.");
      setImportMessage(messages.join(" "));
      return;
    }

    if (hasCoordinates) {
      const imported = rows.map(rowToPoint).filter((point): point is MeasurementPoint => point !== null);
      const shouldReplacePoints = !points.length || normalizedSurvey || imported.length > Math.max(points.length * 0.75, 50);
      if (shouldReplacePoints) {
        onChange(imported);
        setSelectedPointId(imported[0]?.point_id ?? null);
        messages.push(`${imported.length} pontos importados com coordenadas.${normalizedSurvey ? " Coordenadas de survey foram ajustadas para a planta e duplicidades consolidadas." : ""}`);
        setImportMessage(messages.join(" "));
        return;
      }
    }

    const byId = new Map<string, CsvMeasurementRow>();
    rows.forEach((row) => addRowAliases(byId, row));
    const usedRows = new Set<CsvMeasurementRow>();
    let matched = 0;
    const merged = points.map((point) => {
      const row = findRowForPoint(byId, point.point_id);
      if (!row) return point;
      usedRows.add(row);
      matched += 1;
      return {
        ...point,
        x_px: row.x_px ?? point.x_px,
        y_px: row.y_px ?? point.y_px,
        rssi_24ghz: row.rssi_24ghz ?? point.rssi_24ghz,
        rssi_5ghz: row.rssi_5ghz ?? point.rssi_5ghz,
        rssi_6ghz: row.rssi_6ghz ?? point.rssi_6ghz ?? null,
        csv_distance_m: row.distance_m ?? point.csv_distance_m ?? null,
        timestamp: row.timestamp || point.timestamp,
        source: row.x_px !== null && row.x_px !== undefined ? "csv" : point.source,
      };
    });

    const appended = rows
      .filter((row) => !usedRows.has(row))
      .map(rowToPoint)
      .filter((point): point is MeasurementPoint => point !== null);
    const nextPoints = [...merged, ...appended];
    onChange(nextPoints);
    setSelectedPointId(nextPoints[0]?.point_id ?? null);
    const unmatched = rows.length - matched - appended.length;
    const parts = [`${matched} pontos atualizados`];
    if (appended.length) parts.push(`${appended.length} adicionados`);
    if (unmatched > 0) parts.push(`${unmatched} sem ponto/coordenada correspondente`);
    if (normalizedSurvey) parts.push("coordenadas de survey ajustadas");
    messages.push(`CSV importado: ${parts.join(", ")}.`);
    setImportMessage(messages.join(" "));
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void importCsv(file);
    event.target.value = "";
  }

  return (
    <section className="stepPanel wide">
      <div className="stepHeader">
        <span className="stepIcon"><FileSpreadsheet size={18} /></span>
        <div>
          <h2>Medicoes RSSI</h2>
          <p>Valores esperados entre -10 e -100 dBm.</p>
        </div>
      </div>

      <div className="toolbar">
        <button className="secondaryButton" type="button" onClick={() => inputRef.current?.click()}>
          <UploadCloud size={16} />
          Importar CSV
        </button>
        <span className="toolHint">{floorplan.width}x{floorplan.height}px | {aps.length} AP(s)</span>
        <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={handleFile} hidden />
      </div>

      {importMessage && <div className="inlineNotice">{importMessage}</div>}
      {visiblePoints.length < points.length && (
        <div className="inlineNotice">
          Mostrando {visiblePoints.length} de {points.length} pontos importados. Todos continuam incluidos na validacao, geracao e exportacao.
        </div>
      )}
      {points.length > 0 && (
        <div className="rssiPreview">
          <div className="toolbar">
            <span className="toolHint">Previa na planta: {points.length} ponto(s)</span>
            {points.length > 900 && (
              <span className="toolHint">Renderizacao visual amostrada; todos os pontos seguem no calculo.</span>
            )}
          </div>
          <FloorplanCanvas
            floorplan={floorplan}
            points={points}
            aps={aps}
            selectedPointId={selectedPointId}
            onPointSelect={setSelectedPointId}
            className="rssiPreviewCanvas"
          />

          {hasSurveyPoints && (
            <div className="surveyAlignPanel" aria-label="Ajuste de alinhamento dos pontos importados">
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>
                <Move size={14} aria-hidden="true" />
                Ajustar alinhamento dos pontos importados
              </div>
              <p style={{ fontSize: 11.5, color: "var(--muted)", margin: 0 }}>
                Coordenadas de survey nao tem relacao automatica garantida com os pixels da planta. Se os pontos ficarem
                um pouco fora das paredes, desloque todos juntos ate alinhar com a planta.
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 32px)", gridTemplateRows: "repeat(2, 32px)", gap: 4 }}>
                  <span />
                  <button type="button" className="iconButton" title="Mover para cima" onClick={() => nudgeSurveyPoints(0, -nudgeStepM)}>
                    <ArrowUp size={15} />
                  </button>
                  <span />
                  <button type="button" className="iconButton" title="Mover para esquerda" onClick={() => nudgeSurveyPoints(-nudgeStepM, 0)}>
                    <ArrowLeft size={15} />
                  </button>
                  <button type="button" className="iconButton" title="Mover para baixo" onClick={() => nudgeSurveyPoints(0, nudgeStepM)}>
                    <ArrowDown size={15} />
                  </button>
                  <button type="button" className="iconButton" title="Mover para direita" onClick={() => nudgeSurveyPoints(nudgeStepM, 0)}>
                    <ArrowRight size={15} />
                  </button>
                </div>
                <label className="field compactSelect" htmlFor="nudge-step" style={{ minWidth: 120 }}>
                  Passo
                  <select id="nudge-step" value={nudgeStepM} onChange={(event) => setNudgeStepM(Number(event.target.value))}>
                    {NUDGE_STEPS_M.map((step) => (
                      <option key={step} value={step}>{(step * 100).toFixed(0)} cm</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="tableShell">
        <table className="dataTable">
          <thead>
            <tr>
              <th>point_id</th>
              <th>x_px</th>
              <th>y_px</th>
              <th>rssi_24ghz</th>
              <th>rssi_5ghz</th>
              <th>rssi_6ghz</th>
              <th>distance_m</th>
              <th>timestamp</th>
            </tr>
          </thead>
          <tbody>
            {visiblePoints.map((point) => (
              <tr key={point.point_id}>
                <td>{point.point_id}</td>
                <td>
                  <input type="number" value={point.x_px} onChange={(event) => updatePoint(point.point_id, { x_px: Number(event.target.value) })} />
                </td>
                <td>
                  <input type="number" value={point.y_px} onChange={(event) => updatePoint(point.point_id, { y_px: Number(event.target.value) })} />
                </td>
                <td>
                  <input
                    type="number"
                    min="-100"
                    max="-10"
                    value={point.rssi_24ghz ?? ""}
                    onChange={(event) => updatePoint(point.point_id, { rssi_24ghz: parseInputNumber(event.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="-100"
                    max="-10"
                    value={point.rssi_5ghz ?? ""}
                    onChange={(event) => updatePoint(point.point_id, { rssi_5ghz: parseInputNumber(event.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="-100"
                    max="-10"
                    value={point.rssi_6ghz ?? ""}
                    onChange={(event) => updatePoint(point.point_id, { rssi_6ghz: parseInputNumber(event.target.value) })}
                    placeholder="opcional"
                  />
                </td>
                <td>{point.distance_m === null ? "-" : point.distance_m.toFixed(2)}</td>
                <td>
                  <input value={point.timestamp} onChange={(event) => updatePoint(point.point_id, { timestamp: event.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="inlineNotice">
        -35 dBm forte, -80 dBm fraco. A distancia audita os dados; ela nao posiciona pontos sem x_px/y_px.
      </div>

      <IssueList issues={[...validateMeasurementPoints(points, floorplan), ...validateRssi(points)]} />
    </section>
  );
}
