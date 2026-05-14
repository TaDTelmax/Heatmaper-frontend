import type { CsvMeasurementRow, MeasurementPoint } from "@/types/measurement";

type CsvImportResult = {
  rows: CsvMeasurementRow[];
  hasCoordinates: boolean;
  errors: string[];
};

const coordinateKeys = ["x_px", "x", "coord_x", "pos_x"];
const coordinateYKeys = ["y_px", "y", "coord_y", "pos_y"];

function normalizeHeader(value: string): string {
  return value
    .trim()
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeCsvPointId(value: string | number | null | undefined, fallbackIndex?: number): string {
  const text = String(value ?? "").trim();
  if (!text) return fallbackIndex === undefined ? "" : `P${fallbackIndex}`;
  const numeric = text.match(/^(?:p|ponto|point)?[\s_-]*0*(\d+)$/i);
  if (numeric) return `P${Number(numeric[1])}`;
  return text;
}

export function pointIdAliases(value: string | number | null | undefined): string[] {
  const normalized = normalizeCsvPointId(value);
  const aliases = new Set<string>();
  if (normalized) aliases.add(normalized.toLowerCase());
  const numeric = normalized.match(/^p(\d+)$/i);
  if (numeric) {
    aliases.add(String(Number(numeric[1])));
    aliases.add(`p${Number(numeric[1])}`);
  }
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw) aliases.add(raw);
  return [...aliases];
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = value.trim().replace(/\s+/g, "");
  if (!text) return null;
  const numericText = text.replace(/[^\d,.\-+]/g, "");
  if (!numericText || numericText === "-" || numericText === "+") return null;
  const lastComma = numericText.lastIndexOf(",");
  const lastDot = numericText.lastIndexOf(".");
  const normalized = lastComma > lastDot
    ? numericText.replace(/\./g, "").replace(",", ".")
    : numericText.replace(/,/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function countDelimiter(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      count += 1;
    }
  }
  return count;
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? text.slice(0, 2048);
  const candidates = [",", ";", "\t"];
  return candidates
    .map((delimiter) => ({ delimiter, count: countDelimiter(firstLine, delimiter) }))
    .sort((a, b) => b.count - a.count)[0].delimiter;
}

function splitCsvRecords(text: string): string[] {
  const records: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      current += char;
      if (quoted && text[index + 1] === "\"") {
        current += text[index + 1];
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      if (current.trim()) records.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) records.push(current);
  return records;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function pick(row: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (key in row) return row[key];
  }
  return undefined;
}

function pickFuzzy(row: Record<string, string>, exactKeys: string[], fuzzyKeys: string[] = []): string | undefined {
  const exact = pick(row, exactKeys);
  if (exact !== undefined) return exact;
  for (const key of Object.keys(row)) {
    if (fuzzyKeys.some((fuzzy) => key.includes(fuzzy))) return row[key];
  }
  return undefined;
}

function pickBandRssi(row: Record<string, string>, band: "24" | "5" | "6"): string | undefined {
  const exact =
    band === "24"
      ? pick(row, ["rssi_24ghz", "rssi_24", "rssi_2_4ghz", "rssi_2_4", "24ghz", "2_4ghz"])
      : band === "5"
        ? pick(row, ["rssi_5ghz", "rssi_5", "5ghz", "5g"])
        : pick(row, ["rssi_6ghz", "rssi_6", "6ghz", "6g"]);
  if (exact !== undefined) return exact;

  for (const key of Object.keys(row)) {
    if (key.includes("quality") || key.includes("qualidade") || key.includes("nivel")) continue;
    const isRssi = key.includes("rssi") || key.includes("dbm") || key.includes("sinal") || key.includes("signal");
    const isBand =
      band === "24"
        ? key.includes("24") || key.includes("2_4")
        : band === "5"
          ? key.includes("5ghz") || key === "5g" || key.endsWith("_5")
          : key.includes("6ghz") || key === "6g" || key.endsWith("_6");
    if (isRssi && isBand) return row[key];
  }
  return undefined;
}

function normalizeBand(value: string | undefined): "24" | "5" | "6" | null {
  const text = normalizeHeader(value ?? "");
  if (!text) return null;
  if (text.includes("2_4") || text.includes("24")) return "24";
  if (text.includes("5")) return "5";
  if (text.includes("6")) return "6";
  return null;
}

function mergeRows(target: CsvMeasurementRow, source: CsvMeasurementRow): CsvMeasurementRow {
  return {
    point_id: target.point_id || source.point_id,
    x_px: target.x_px ?? source.x_px ?? null,
    y_px: target.y_px ?? source.y_px ?? null,
    rssi_24ghz: target.rssi_24ghz ?? source.rssi_24ghz ?? null,
    rssi_5ghz: target.rssi_5ghz ?? source.rssi_5ghz ?? null,
    rssi_6ghz: target.rssi_6ghz ?? source.rssi_6ghz ?? null,
    distance_m: target.distance_m ?? source.distance_m ?? null,
    timestamp: target.timestamp || source.timestamp || null,
  };
}

export function parseMeasurementCsv(text: string): CsvImportResult {
  const errors: string[] = [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return { rows: [], hasCoordinates: false, errors: ["CSV vazio."] };

  const delimiter = detectDelimiter(normalized);
  const lines = splitCsvRecords(normalized);
  const headers = splitCsvLine(lines[0], delimiter).map(normalizeHeader);
  const rowsById = new Map<string, CsvMeasurementRow>();

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const values = splitCsvLine(lines[lineIndex], delimiter);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    const pointId = normalizeCsvPointId(
      pickFuzzy(row, ["point_id", "id", "point", "ponto", "ambiente_numero"], ["ponto", "point"]),
      lineIndex,
    );
    const band = normalizeBand(pickFuzzy(row, ["band", "banda", "frequency", "frequencia", "freq"]));
    const genericRssi = parseNumber(pickFuzzy(row, ["rssi", "dbm", "signal", "sinal"]));
    const parsed: CsvMeasurementRow = {
      point_id: pointId,
      x_px: parseNumber(pickFuzzy(row, coordinateKeys, ["x_px", "coord_x", "pos_x"])),
      y_px: parseNumber(pickFuzzy(row, coordinateYKeys, ["y_px", "coord_y", "pos_y"])),
      rssi_24ghz: parseNumber(pickBandRssi(row, "24")),
      rssi_5ghz: parseNumber(pickBandRssi(row, "5")),
      rssi_6ghz: parseNumber(pickBandRssi(row, "6")),
      distance_m: parseNumber(pickFuzzy(row, ["distance_m", "distance", "distancia_m", "distancia", "dist"], ["distancia", "distance"])),
      timestamp: pickFuzzy(row, ["timestamp", "data_hora", "created_at", "data", "hora"])?.trim() || null,
    };
    if (band === "24" && parsed.rssi_24ghz === null) parsed.rssi_24ghz = genericRssi;
    if (band === "5" && parsed.rssi_5ghz === null) parsed.rssi_5ghz = genericRssi;
    if (band === "6" && parsed.rssi_6ghz === null) parsed.rssi_6ghz = genericRssi;
    if (!parsed.point_id) {
      errors.push(`Linha ${lineIndex + 1} sem point_id.`);
      continue;
    }

    const key = normalizeCsvPointId(parsed.point_id).toLowerCase();
    rowsById.set(key, rowsById.has(key) ? mergeRows(rowsById.get(key) as CsvMeasurementRow, parsed) : parsed);
  }

  const rows = [...rowsById.values()];
  const hasCoordinates = rows.some((row) => row.x_px !== null && row.x_px !== undefined && row.y_px !== null && row.y_px !== undefined);
  return { rows, hasCoordinates, errors };
}

function csvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n;]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

export function buildMeasurementsCsv(points: MeasurementPoint[]): string {
  const header = ["point_id", "x_px", "y_px", "rssi_24ghz", "rssi_5ghz", "rssi_6ghz", "distance_m", "timestamp"];
  const rows = points.map((point) =>
    [
      point.point_id,
      Math.round(point.x_px * 100) / 100,
      Math.round(point.y_px * 100) / 100,
      point.rssi_24ghz,
      point.rssi_5ghz,
      point.rssi_6ghz ?? "",
      point.distance_m,
      point.timestamp,
    ]
      .map(csvValue)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}
