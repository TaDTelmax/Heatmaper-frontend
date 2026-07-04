import type { CsvMeasurementRow, MeasurementPoint, ValidationIssue } from "@/types/measurement";

type CsvImportResult = {
  rows: CsvMeasurementRow[];
  hasCoordinates: boolean;
  errors: string[];
};

const coordinateKeys = ["x_px", "x", "coord_x", "pos_x", "x_lat", "xlat", "lat", "latitude"];
const coordinateYKeys = ["y_px", "y", "coord_y", "pos_y", "y_lon", "ylon", "lon", "lng", "longitude"];
const surveyCoordinateKeys = new Set(["x_lat", "xlat", "lat", "latitude", "y_lon", "ylon", "lon", "lng", "longitude"]);
const SURVEY_IMPORT_TARGET_POINTS = 900;

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

function rssiValue(target: number | null | undefined, source: number | null | undefined): number | null {
  if (target === null || target === undefined) return source ?? null;
  if (source === null || source === undefined) return target;
  return source > target ? source : target;
}

function coordinateKey(x: number | null | undefined, y: number | null | undefined): string | null {
  if (x === null || x === undefined || y === null || y === undefined) return null;
  return `coord:${x.toFixed(6)}:${y.toFixed(6)}`;
}

function coordinateKind(header: string): CsvMeasurementRow["coordinate_kind"] {
  return surveyCoordinateKeys.has(header) ? "survey" : "pixel";
}

function pickCoordinate(row: Record<string, string>, exactKeys: string[], fuzzyKeys: string[] = []): { value: string | undefined; kind: CsvMeasurementRow["coordinate_kind"] } {
  for (const key of exactKeys) {
    if (key in row) return { value: row[key], kind: coordinateKind(key) };
  }
  for (const key of Object.keys(row)) {
    if (fuzzyKeys.some((fuzzy) => key.includes(fuzzy))) return { value: row[key], kind: coordinateKind(key) };
  }
  return { value: undefined, kind: null };
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
  const numeric = parseNumber(value);
  if (numeric !== null) {
    if ((numeric >= 2400 && numeric < 2500) || (numeric >= 2 && numeric < 3) || Math.round(numeric) === 24) return "24";
    if ((numeric >= 4900 && numeric < 5925) || Math.round(numeric) === 5) return "5";
    if ((numeric >= 5925 && numeric < 7125) || Math.round(numeric) === 6) return "6";
  }
  const text = normalizeHeader(value ?? "");
  if (!text) return null;
  if (text.includes("2_4") || text.includes("24")) return "24";
  if (text.includes("5ghz") || text === "5g" || text === "5") return "5";
  if (text.includes("6ghz") || text === "6g" || text === "6") return "6";
  if (text.includes("5")) return "5";
  return null;
}

function normalizeBandFromChannel(value: string | undefined): "24" | "5" | null {
  const channel = parseNumber(value);
  if (channel === null) return null;
  if (channel >= 1 && channel <= 14) return "24";
  if (channel >= 32 && channel <= 196) return "5";
  return null;
}

// Fallback for survey exports that carry an SSID but no channel/band column.
// Router vendors almost always mark the 5GHz (and 6GHz) radio's SSID with a
// suffix like "-5G"/"5GHz"/"6G", while the 2.4GHz radio keeps the bare SSID
// — but that's a positive signal only in one direction: plenty of routers
// run a single SSID with no band marker at all (or, per a same-name
// dual-band setup, an *identical* SSID on both radios), so "no marker" must
// NOT be read as "therefore 2.4GHz". Only fires on an explicit marker.
function normalizeBandFromSsid(ssid: string | undefined): "24" | "5" | "6" | null {
  if (!ssid) return null;
  const text = normalizeHeader(ssid);
  if (!text) return null;
  if (/(^|_)6g(hz)?(_|$)/.test(text)) return "6";
  if (/(^|_)5g(hz)?(_|$)/.test(text)) return "5";
  if (/(^|_)2_4g(hz)?(_|$)/.test(text)) return "24";
  return null;
}

function mergeRows(target: CsvMeasurementRow, source: CsvMeasurementRow): CsvMeasurementRow {
  return {
    point_id: target.point_id || source.point_id,
    x_px: target.x_px ?? source.x_px ?? null,
    y_px: target.y_px ?? source.y_px ?? null,
    coordinate_kind: target.coordinate_kind ?? source.coordinate_kind ?? null,
    rssi_24ghz: rssiValue(target.rssi_24ghz, source.rssi_24ghz),
    rssi_5ghz: rssiValue(target.rssi_5ghz, source.rssi_5ghz),
    rssi_6ghz: rssiValue(target.rssi_6ghz, source.rssi_6ghz),
    distance_m: target.distance_m ?? source.distance_m ?? null,
    timestamp: target.timestamp || source.timestamp || null,
  };
}

type BandKey = "24" | "5" | "6";

function bandRssiField(band: BandKey): "rssi_24ghz" | "rssi_5ghz" | "rssi_6ghz" {
  return band === "24" ? "rssi_24ghz" : band === "5" ? "rssi_5ghz" : "rssi_6ghz";
}

type MacBandStat = { mac: string; count: number; hasSsid: boolean };

// A TamoGraph-style survey CSV records one reading per detected AP per dwell
// point, so neighboring networks (other households, guest/hidden SSIDs) show
// up alongside the router actually being surveyed. Each Signal Level page in
// a TamoGraph report is scoped to exactly one MAC per band; naively taking
// "strongest reading per band at each coordinate" (the old behavior here)
// lets a neighbor's beacon leak in wherever it happens to be marginally
// stronger, or whenever the target router's own beacon wasn't captured at
// that exact dwell point. Instead, per band, treat whichever MAC is seen most
// consistently as the surveyed router (highest sample count — a real target
// router responds far more often than any transient neighbor), preferring a
// MAC with a visible SSID over a blank/hidden sibling BSSID when counts are
// close (a router's hidden secondary radio can rival the main one in count).
function selectDominantMacByBand(statsByBand: Map<BandKey, Map<string, MacBandStat>>): Map<BandKey, string> {
  const dominant = new Map<BandKey, string>();
  for (const [band, macStats] of statsByBand) {
    const candidates = [...macStats.values()];
    if (!candidates.length) continue;
    candidates.sort((a, b) => {
      if (a.hasSsid !== b.hasSsid) return a.hasSsid ? -1 : 1;
      return b.count - a.count;
    });
    dominant.set(band, candidates[0].mac);
  }
  return dominant;
}

export function parseMeasurementCsv(text: string): CsvImportResult {
  const errors: string[] = [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return { rows: [], hasCoordinates: false, errors: ["CSV vazio."] };

  const delimiter = detectDelimiter(normalized);
  const lines = splitCsvRecords(normalized);
  const headers = splitCsvLine(lines[0], delimiter).map(normalizeHeader);
  const generatedIdsByCoordinate = new Map<string, string>();

  const parsedRows: { key: string; parsed: CsvMeasurementRow; mac: string | null; band: BandKey | null }[] = [];
  const macStatsByBand = new Map<BandKey, Map<string, MacBandStat>>();

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const values = splitCsvLine(lines[lineIndex], delimiter);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    const xPick = pickCoordinate(row, coordinateKeys, ["x_px", "coord_x", "pos_x", "latitude"]);
    const yPick = pickCoordinate(row, coordinateYKeys, ["y_px", "coord_y", "pos_y", "longitude"]);
    const x_px = parseNumber(xPick.value);
    const y_px = parseNumber(yPick.value);
    const coordKey = coordinateKey(x_px, y_px);
    const rawPointId = pickFuzzy(row, ["point_id", "id", "point", "ponto", "ambiente_numero"], ["ponto", "point"]);
    let pointId = normalizeCsvPointId(rawPointId);
    if (!pointId && coordKey) {
      if (!generatedIdsByCoordinate.has(coordKey)) generatedIdsByCoordinate.set(coordKey, `P${generatedIdsByCoordinate.size + 1}`);
      pointId = generatedIdsByCoordinate.get(coordKey) as string;
    }
    if (!pointId) pointId = normalizeCsvPointId(undefined, lineIndex);
    const ssid = pickFuzzy(row, ["ssid"])?.trim() || "";
    const band =
      normalizeBand(pickFuzzy(row, ["band", "banda", "frequency", "frequencia", "freq"])) ??
      normalizeBandFromChannel(pickFuzzy(row, ["channel", "ch", "canal"])) ??
      normalizeBandFromSsid(ssid);
    const genericRssi = parseNumber(pickFuzzy(row, ["rssi", "dbm", "signal", "sinal"]));
    const mac = pickFuzzy(row, ["mac", "bssid"])?.trim().toUpperCase() || null;
    const parsed: CsvMeasurementRow = {
      point_id: pointId,
      x_px,
      y_px,
      coordinate_kind: xPick.kind === "survey" || yPick.kind === "survey" ? "survey" : xPick.kind ?? yPick.kind ?? null,
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

    if (mac && band) {
      const macStats = macStatsByBand.get(band) ?? new Map<string, MacBandStat>();
      const stat = macStats.get(mac) ?? { mac, count: 0, hasSsid: false };
      stat.count += 1;
      if (ssid) stat.hasSsid = true;
      macStats.set(mac, stat);
      macStatsByBand.set(band, macStats);
    }

    const key = rawPointId ? normalizeCsvPointId(parsed.point_id).toLowerCase() : coordKey ?? normalizeCsvPointId(parsed.point_id).toLowerCase();
    parsedRows.push({ key, parsed, mac, band });
  }

  const dominantMacByBand = selectDominantMacByBand(macStatsByBand);

  const rowsById = new Map<string, CsvMeasurementRow>();
  for (const { key, parsed, mac, band } of parsedRows) {
    if (mac && band) {
      const dominantMac = dominantMacByBand.get(band);
      if (dominantMac && mac !== dominantMac) {
        parsed[bandRssiField(band)] = null;
      }
    }
    rowsById.set(key, rowsById.has(key) ? mergeRows(rowsById.get(key) as CsvMeasurementRow, parsed) : parsed);
  }

  const rows = [...rowsById.values()];
  const hasCoordinates = rows.some((row) => row.x_px !== null && row.x_px !== undefined && row.y_px !== null && row.y_px !== undefined);
  return { rows, hasCoordinates, errors };
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function scaleCoordinate(value: number, sourceMin: number, sourceMax: number, targetMin: number, targetMax: number): number {
  const sourceRange = sourceMax - sourceMin;
  if (!Number.isFinite(sourceRange) || Math.abs(sourceRange) < Number.EPSILON) return rounded((targetMin + targetMax) / 2);
  const clampedValue = clamp(value, sourceMin, sourceMax);
  return rounded(targetMin + ((clampedValue - sourceMin) / sourceRange) * (targetMax - targetMin));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = clamp(Math.round((sorted.length - 1) * ratio), 0, sorted.length - 1);
  return sorted[index];
}

function robustRange(values: number[]): { min: number; max: number } {
  const min = percentile(values, 0.01);
  const max = percentile(values, 0.99);
  if (Math.abs(max - min) >= Number.EPSILON) return { min, max };
  return {
    min: values.reduce((current, value) => Math.min(current, value), Number.POSITIVE_INFINITY),
    max: values.reduce((current, value) => Math.max(current, value), Number.NEGATIVE_INFINITY),
  };
}

// True (non-percentile) minimum. Used as the metric placement anchor: since
// robustRange's "min" is the 1st percentile, ~1% of legitimate (non-sentinel)
// points sit below it by construction, which placed them at negative pixel
// coordinates ("fora da planta") even though nothing was actually wrong with
// that reading. The anchor must be the true minimum so every surviving point
// maps to x_px/y_px >= the margin, never negative.
function trueMin(values: number[]): number {
  return values.reduce((current, value) => Math.min(current, value), Number.POSITIVE_INFINITY);
}

// Small constant offset (px) so metrically-placed points don't sit exactly on
// the plan's (0,0) corner. NOT a stretch-to-fill margin: the true surveyed
// footprint size is preserved as-is via pxPerMeter.
const SURVEY_METRIC_MARGIN_PX = 24;
// A per-row survey value further than this many multiples of the robust
// (1st-99th percentile) spread from the median is treated as a corrupted
// sentinel (e.g. GPS-lock-failure values like 3.66e7) and dropped.
const SURVEY_OUTLIER_SPREAD_FACTOR = 500;
// If more than this fraction of placed points fall outside the floorplan
// canvas after metric placement, warn the user (likely crop/calibration
// mismatch upstream, not a CSV import bug).
const SURVEY_OUT_OF_BOUNDS_WARN_RATIO = 0.1;

function issue(severity: ValidationIssue["severity"], message: string, code: string): ValidationIssue {
  return { severity, message, code };
}

// Median absolute deviation: like the median's own "spread", but (unlike a
// min/max range) it stays robust even when a small number of the values are
// wildly corrupted sentinels, because up to ~50% of samples can be extreme
// outliers before this statistic itself gets pulled off course.
function medianAbsoluteDeviation(values: number[], median: number): number {
  return percentile(values.map((value) => Math.abs(value - median)), 0.5);
}

function isSentinelOutlier(value: number, median: number, mad: number): boolean {
  const safeMad = Math.max(mad, 1e-2);
  return Math.abs(value - median) > safeMad * SURVEY_OUTLIER_SPREAD_FACTOR;
}

export function prepareCsvRowsForFloorplan(
  rows: CsvMeasurementRow[],
  floorplan: { width: number; height: number },
  pxPerMeter = 0,
): { rows: CsvMeasurementRow[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const surveyRows = rows.filter(
    (row) => row.coordinate_kind === "survey" && row.x_px !== null && row.x_px !== undefined && row.y_px !== null && row.y_px !== undefined,
  );
  if (!surveyRows.length) return { rows, issues };

  const xValues = surveyRows.map((row) => row.x_px as number);
  const yValues = surveyRows.map((row) => row.y_px as number);
  const xMedian = percentile(xValues, 0.5);
  const yMedian = percentile(yValues, 0.5);
  const xMad = medianAbsoluteDeviation(xValues, xMedian);
  const yMad = medianAbsoluteDeviation(yValues, yMedian);
  const isRowSentinel = (x: number, y: number) => isSentinelOutlier(x, xMedian, xMad) || isSentinelOutlier(y, yMedian, yMad);

  // Reference corner for isotropic placement: the robust (1st-99th
  // percentile) bounding box, computed only from rows that survive sentinel
  // rejection so a single corrupted reading can't drag the reference corner.
  const cleanSurveyRows = surveyRows.filter((row) => !isRowSentinel(row.x_px as number, row.y_px as number));
  const cleanXValues = cleanSurveyRows.length ? cleanSurveyRows.map((row) => row.x_px as number) : xValues;
  const cleanYValues = cleanSurveyRows.length ? cleanSurveyRows.map((row) => row.y_px as number) : yValues;
  const xRange = robustRange(cleanXValues);
  const yRange = robustRange(cleanYValues);
  const xTrueMin = trueMin(cleanXValues);
  const yTrueMin = trueMin(cleanYValues);

  const isCalibrated = Number.isFinite(pxPerMeter) && pxPerMeter > 0;

  let normalized: CsvMeasurementRow[];
  if (isCalibrated) {
    // Survey X/Y are real-world meters. Map both axes with the SAME
    // pxPerMeter (isotropic) so the true aspect ratio of the walked survey
    // is preserved instead of being stretched to fill the canvas. Anchored on
    // the true min (not a percentile) so no surviving point can land negative.
    normalized = rows.map((row) => {
      if (row.coordinate_kind !== "survey" || row.x_px === null || row.x_px === undefined || row.y_px === null || row.y_px === undefined) return row;
      if (isRowSentinel(row.x_px, row.y_px)) {
        return { ...row, x_px: null, y_px: null, coordinate_kind: null };
      }
      return {
        ...row,
        x_px: rounded(SURVEY_METRIC_MARGIN_PX + (row.x_px - xTrueMin) * pxPerMeter),
        y_px: rounded(SURVEY_METRIC_MARGIN_PX + (row.y_px - yTrueMin) * pxPerMeter),
        coordinate_kind: "pixel" as const,
      };
    });
  } else {
    // Fallback (best-effort only): no metric scale yet, so stretch the
    // robust survey range to fill the canvas. Flagged to the caller so the
    // UI can tell the user this is an approximation pending calibration.
    const paddingX = clamp(floorplan.width * 0.04, 12, 48);
    const paddingY = clamp(floorplan.height * 0.04, 12, 48);
    const maxTargetX = Math.max(paddingX, floorplan.width - paddingX - 1);
    const maxTargetY = Math.max(paddingY, floorplan.height - paddingY - 1);
    normalized = rows.map((row) => {
      if (row.coordinate_kind !== "survey" || row.x_px === null || row.x_px === undefined || row.y_px === null || row.y_px === undefined) return row;
      return {
        ...row,
        x_px: scaleCoordinate(row.x_px, xRange.min, xRange.max, paddingX, maxTargetX),
        y_px: scaleCoordinate(row.y_px, yRange.min, yRange.max, paddingY, maxTargetY),
        coordinate_kind: "pixel" as const,
      };
    });
    issues.push(
      issue(
        "warning",
        "Planta ainda sem escala calibrada: os pontos do CSV de survey foram ajustados para caber na imagem (posicionamento aproximado). Calibre a escala e reimporte o CSV para posicionar os pontos com precisao metrica.",
        "csv_survey_uncalibrated",
      ),
    );
  }

  const cellSize = Math.max(8, Math.ceil(Math.sqrt(Math.max(floorplan.width * floorplan.height, 1) / SURVEY_IMPORT_TARGET_POINTS)));
  const buckets = new Map<string, { row: CsvMeasurementRow; sumX: number; sumY: number; count: number }>();
  const passthrough: CsvMeasurementRow[] = [];

  for (const row of normalized) {
    if (row.x_px === null || row.x_px === undefined || row.y_px === null || row.y_px === undefined) {
      passthrough.push(row);
      continue;
    }
    const key = `${Math.round(row.x_px / cellSize)}:${Math.round(row.y_px / cellSize)}`;
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { row, sumX: row.x_px, sumY: row.y_px, count: 1 });
      continue;
    }
    bucket.row = mergeRows(bucket.row, row);
    bucket.sumX += row.x_px;
    bucket.sumY += row.y_px;
    bucket.count += 1;
  }

  const consolidated = [...buckets.values()].map((bucket, index) => ({
    ...bucket.row,
    point_id: `P${index + 1}`,
    x_px: rounded(bucket.sumX / bucket.count),
    y_px: rounded(bucket.sumY / bucket.count),
    coordinate_kind: "pixel" as const,
  }));

  if (isCalibrated && consolidated.length) {
    const outOfBounds = consolidated.filter(
      (row) => row.x_px < 0 || row.x_px >= floorplan.width || row.y_px < 0 || row.y_px >= floorplan.height,
    );
    if (outOfBounds.length / consolidated.length > SURVEY_OUT_OF_BOUNDS_WARN_RATIO) {
      const pct = Math.round((outOfBounds.length / consolidated.length) * 100);
      issues.push(
        issue(
          "warning",
          `${outOfBounds.length} de ${consolidated.length} pontos do survey (${pct}%) ficaram fora da planta apos o posicionamento metrico. Verifique se o recorte e a calibracao da planta correspondem a area realmente percorrida.`,
          "csv_survey_out_of_bounds",
        ),
      );
    }
  }

  return { rows: [...consolidated, ...passthrough], issues };
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
