export type Rgba = [number, number, number, number];

export type Rgb = [number, number, number];

type ColorStop = {
  rssi: number;
  color: Rgb;
};

export const RSSI_LEGEND_MIN = -80;
export const RSSI_LEGEND_MAX = -20;

export const rssiColorStops: ColorStop[] = [
  { rssi: -90, color: [185, 0, 0] },
  { rssi: -80, color: [255, 18, 0] },
  { rssi: -75, color: [255, 124, 0] },
  { rssi: -70, color: [255, 224, 0] },
  { rssi: -65, color: [178, 255, 0] },
  { rssi: -60, color: [58, 242, 0] },
  { rssi: -55, color: [0, 224, 42] },
  { rssi: -50, color: [0, 224, 132] },
  { rssi: -45, color: [0, 218, 224] },
  { rssi: -40, color: [0, 166, 255] },
  { rssi: -35, color: [0, 94, 255] },
  { rssi: -20, color: [0, 54, 214] },
];

export const legendStops = [
  { label: "<= -80 dBm", value: -80 },
  { label: "-75", value: -75 },
  { label: "-70", value: -70 },
  { label: "-65", value: -65 },
  { label: "-60", value: -60 },
  { label: "-55", value: -55 },
  { label: "-50", value: -50 },
  { label: "-45", value: -45 },
  { label: "-40", value: -40 },
  { label: "-35", value: -35 },
  { label: ">= -20 dBm", value: -20 },
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
