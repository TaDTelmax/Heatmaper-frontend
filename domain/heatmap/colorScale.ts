export type Rgba = [number, number, number, number];

export type Rgb = [number, number, number];

type ColorStop = {
  rssi: number;
  color: Rgb;
};

export const rssiColorStops: ColorStop[] = [
  { rssi: -80, color: [250, 4, 1] },
  { rssi: -75, color: [252, 98, 6] },
  { rssi: -70, color: [253, 189, 19] },
  { rssi: -65, color: [233, 252, 25] },
  { rssi: -60, color: [143, 251, 17] },
  { rssi: -55, color: [49, 250, 8] },
  { rssi: -50, color: [3, 250, 54] },
  { rssi: -45, color: [1, 252, 141] },
  { rssi: -40, color: [0, 253, 232] },
  { rssi: -35, color: [0, 213, 254] },
  { rssi: -30, color: [6, 162, 254] },
  { rssi: -20, color: [1, 107, 254] },
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
  { label: "-30", value: -30 },
  { label: ">= -20 dBm", value: -20 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

export function rssiToColor(rssi: number, alpha = 255): Rgba {
  const value = clamp(rssi, rssiColorStops[0].rssi, rssiColorStops[rssiColorStops.length - 1].rssi);

  for (let index = 0; index < rssiColorStops.length - 1; index += 1) {
    const left = rssiColorStops[index];
    const right = rssiColorStops[index + 1];
    if (value >= left.rssi && value <= right.rssi) {
      const t = (value - left.rssi) / (right.rssi - left.rssi);
      return [
        mix(left.color[0], right.color[0], t),
        mix(left.color[1], right.color[1], t),
        mix(left.color[2], right.color[2], t),
        alpha,
      ];
    }
  }

  const nearest = value < rssiColorStops[0].rssi ? rssiColorStops[0].color : rssiColorStops[rssiColorStops.length - 1].color;
  return [nearest[0], nearest[1], nearest[2], alpha];
}

export const rssiLegendTicks = legendStops.map((stop) => {
  const [red, green, blue] = rssiToColor(stop.value);
  return {
    ...stop,
    color: `rgb(${red}, ${green}, ${blue})`,
  };
});
