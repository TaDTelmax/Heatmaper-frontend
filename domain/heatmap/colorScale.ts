export type Rgba = [number, number, number, number];

export type Rgb = [number, number, number];

type ColorStop = {
  rssi: number;
  color: Rgb;
};

export const RSSI_LEGEND_MIN = -80;
export const RSSI_LEGEND_MAX = -20;

// TamoGraph Site Survey divides [-80, -20] dBm into 11 equal steps (60/11 dB
// each, ~5.4545) and rounds each boundary to the nearest integer for display.
// Reproduced here (not evenly-5-dB, unlike a naive scale) so our contour
// bands and legend land on the exact same dBm boundaries and colors as the
// reference reports (sampled directly from a TamoGraph PDF's legend swatches
// — see reference/render in the calibration session that established this).
const TAMOGRAPH_STEP_COUNT = 11;

export const contourBreakpointsDb: number[] = Array.from(
  { length: TAMOGRAPH_STEP_COUNT + 1 },
  (_, index) => RSSI_LEGEND_MIN + (index * (RSSI_LEGEND_MAX - RSSI_LEGEND_MIN)) / TAMOGRAPH_STEP_COUNT,
);

export const rssiColorStops: ColorStop[] = [
  { rssi: -85, color: [250, 5, 0] },
  { rssi: contourBreakpointsDb[0], color: [250, 5, 0] },
  { rssi: contourBreakpointsDb[1], color: [255, 100, 8] },
  { rssi: contourBreakpointsDb[2], color: [254, 190, 20] },
  { rssi: contourBreakpointsDb[3], color: [236, 252, 27] },
  { rssi: contourBreakpointsDb[4], color: [144, 253, 18] },
  { rssi: contourBreakpointsDb[5], color: [51, 251, 11] },
  { rssi: contourBreakpointsDb[6], color: [7, 252, 56] },
  { rssi: contourBreakpointsDb[7], color: [4, 253, 142] },
  { rssi: contourBreakpointsDb[8], color: [2, 255, 234] },
  { rssi: contourBreakpointsDb[9], color: [1, 214, 255] },
  { rssi: contourBreakpointsDb[10], color: [1, 162, 255] },
  { rssi: contourBreakpointsDb[11], color: [0, 107, 255] },
];

export const legendStops = [
  { label: "<= -80 dBm", value: contourBreakpointsDb[0] },
  { label: "-75", value: contourBreakpointsDb[1] },
  { label: "-69", value: contourBreakpointsDb[2] },
  { label: "-64", value: contourBreakpointsDb[3] },
  { label: "-58", value: contourBreakpointsDb[4] },
  { label: "-53", value: contourBreakpointsDb[5] },
  { label: "-47", value: contourBreakpointsDb[6] },
  { label: "-42", value: contourBreakpointsDb[7] },
  { label: "-36", value: contourBreakpointsDb[8] },
  { label: "-31", value: contourBreakpointsDb[9] },
  { label: "-25", value: contourBreakpointsDb[10] },
  { label: ">= -20 dBm", value: contourBreakpointsDb[11] },
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
