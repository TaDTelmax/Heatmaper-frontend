"use client";

import type { ChangeEvent } from "react";
import { useRef, useState } from "react";
import { FileSpreadsheet, UploadCloud } from "lucide-react";
import { validateMeasurementPoints, validateRssi } from "@/domain/heatmap/validation";
import { normalizeCsvPointId, parseMeasurementCsv, pointIdAliases } from "@/services/csvService";
import type { FloorplanImage, RouterPlacement } from "@/types/floorplan";
import type { CsvMeasurementRow, MeasurementPoint } from "@/types/measurement";
import { IssueList } from "./StepUploadFloorplan";

type StepRssiInputProps = {
  floorplan: FloorplanImage;
  ap: RouterPlacement | null;
  points: MeasurementPoint[];
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

export function StepRssiInput({ floorplan, ap, points, onChange }: StepRssiInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  function updatePoint(pointId: string, patch: Partial<MeasurementPoint>) {
    onChange(points.map((point) => (point.point_id === pointId ? { ...point, ...patch } : point)));
  }

  async function importCsv(file: File) {
    const text = await file.text();
    const result = parseMeasurementCsv(text);
    if (result.errors.length) {
      setImportMessage(result.errors.join(" "));
    }
    if (!result.rows.length) return;

    if (!result.hasCoordinates && !points.length) {
      setImportMessage("CSV sem x_px/y_px: marque os pontos na planta antes de importar.");
      return;
    }

    if (result.hasCoordinates && !points.length) {
      const imported = result.rows.map(rowToPoint).filter((point): point is MeasurementPoint => point !== null);
      onChange(imported);
      setImportMessage(`${imported.length} pontos importados com coordenadas.`);
      return;
    }

    const byId = new Map<string, CsvMeasurementRow>();
    result.rows.forEach((row) => addRowAliases(byId, row));
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
        csv_distance_m: row.distance_m ?? point.csv_distance_m ?? null,
        timestamp: row.timestamp || point.timestamp,
        source: row.x_px !== null && row.x_px !== undefined ? "csv" : point.source,
      };
    });

    const appended = result.rows
      .filter((row) => !usedRows.has(row))
      .map(rowToPoint)
      .filter((point): point is MeasurementPoint => point !== null);
    onChange([...merged, ...appended]);
    const unmatched = result.rows.length - matched - appended.length;
    const parts = [`${matched} pontos atualizados`];
    if (appended.length) parts.push(`${appended.length} adicionados`);
    if (unmatched > 0) parts.push(`${unmatched} sem ponto/coordenada correspondente`);
    setImportMessage(`CSV importado: ${parts.join(", ")}.`);
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
          <p>Valores esperados entre -20 e -100 dBm.</p>
        </div>
      </div>

      <div className="toolbar">
        <button className="secondaryButton" type="button" onClick={() => inputRef.current?.click()}>
          <UploadCloud size={16} />
          Importar CSV
        </button>
        <span className="toolHint">{floorplan.width}x{floorplan.height}px | AP {ap ? "definido" : "pendente"}</span>
        <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={handleFile} hidden />
      </div>

      {importMessage && <div className="inlineNotice">{importMessage}</div>}

      <div className="tableShell">
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
                    max="-20"
                    value={point.rssi_24ghz ?? ""}
                    onChange={(event) => updatePoint(point.point_id, { rssi_24ghz: parseInputNumber(event.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="-100"
                    max="-20"
                    value={point.rssi_5ghz ?? ""}
                    onChange={(event) => updatePoint(point.point_id, { rssi_5ghz: parseInputNumber(event.target.value) })}
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
