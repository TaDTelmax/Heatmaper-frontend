export type Rgba = [number, number, number, number];

export type Rgb = [number, number, number];

type ColorStop = {
  rssi: number;
  color: Rgb;
};

export const RSSI_LEGEND_MIN = -90;
export const RSSI_LEGEND_MAX = -30;

export const rssiColorStops: ColorStop[] = [
  { rssi: -95, color: [10, 15, 28] },
  { rssi: -88, color: [69, 20, 38] },
  { rssi: -85, color: [118, 24, 36] },
  { rssi: -80, color: [190, 32, 38] },
  { rssi: -75, color: [239, 83, 36] },
  { rssi: -68, color: [249, 153, 36] },
  { rssi: -61, color: [246, 215, 63] },
  { rssi: -55, color: [158, 218, 62] },
  { rssi: -50, color: [47, 188, 92] },
  { rssi: -30, color: [0, 148, 68] },
];

export const legendStops = [
  { label: "<= -90 dBm", value: -90 },
  { label: "-85", value: -85 },
  { label: "-80", value: -80 },
  { label: "-75", value: -75 },
  { label: "-68", value: -68 },
  { label: "-61", value: -61 },
  { label: "-50", value: -50 },
  { label: ">= -30 dBm", value: -30 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function srgbToLinear(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const normalized = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(clamp(normalized, 0, 1) * 255);
}

function mixPerceptual(a: number, b: number, t: number): number {
  return linearToSrgb(srgbToLinear(a) + (srgbToLinear(b) - srgbToLinear(a)) * t);
}

function readableTextColor(color: Rgb): string {
  const luminance = (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
  return luminance < 0.44 ? "#ffffff" : "#111827";
}

export function rssiToLegendOffset(rssi: number): number {
  return clamp((rssi - RSSI_LEGEND_MIN) / Math.max(RSSI_LEGEND_MAX - RSSI_LEGEND_MIN, 1), 0, 1);
}

export function rssiToColor(rssi: number, alpha = 255): Rgba {
  const value = clamp(rssi, rssiColorStops[0].rssi, rssiColorStops[rssiColorStops.length - 1].rssi);

  for (let index = 0; index < rssiColorStops.length - 1; index += 1) {
    const left = rssiColorStops[index];
    const right = rssiColorStops[index + 1];
    if (value >= left.rssi && value <= right.rssi) {
      const t = (value - left.rssi) / (right.rssi - left.rssi);
      return [
        mixPerceptual(left.color[0], right.color[0], t),
        mixPerceptual(left.color[1], right.color[1], t),
        mixPerceptual(left.color[2], right.color[2], t),
        alpha,
      ];
    }
  }

  const nearest = value < rssiColorStops[0].rssi ? rssiColorStops[0].color : rssiColorStops[rssiColorStops.length - 1].color;
  return [nearest[0], nearest[1], nearest[2], alpha];
}

export const rssiLegendTicks = legendStops.map((stop) => {
  const [red, green, blue] = rssiToColor(stop.value);
  const rgb: Rgb = [red, green, blue];
  return {
    ...stop,
    color: `rgb(${red}, ${green}, ${blue})`,
    textColor: readableTextColor(rgb),
    offset: rssiToLegendOffset(stop.value),
  };
});

// Mapeia valores de dBm para cores conforme escala fornecida na imagem
export function dbmToColor(dbm: number): string {
  if (dbm <= -80) return '#ff0000'; // vermelho
  if (dbm <= -75) return '#ff6600'; // laranja forte
  if (dbm <= -70) return '#ff9900'; // laranja
  if (dbm <= -65) return '#ffcc00'; // amarelo escuro
  if (dbm <= -60) return '#ffff00'; // amarelo
  if (dbm <= -55) return '#ccff00'; // amarelo esverdeado
  if (dbm <= -50) return '#66ff00'; // verde claro
  if (dbm <= -45) return '#00ff00'; // verde
  if (dbm <= -40) return '#00ffcc'; // verde-água
  if (dbm <= -35) return '#00ccff'; // azul claro
  if (dbm <= -30) return '#0066ff'; // azul
  return '#0033ff'; // azul escuro para > -30
}
