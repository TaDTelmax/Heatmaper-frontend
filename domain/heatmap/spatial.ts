import type { RfPoint } from "@/types/heatmap";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function distance(a: RfPoint, b: RfPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, Number.EPSILON), 0, 1);
  return t * t * (3 - 2 * t);
}

function orientation(a: RfPoint, b: RfPoint, c: RfPoint): number {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a: RfPoint, b: RfPoint, c: RfPoint): boolean {
  return (
    b.x <= Math.max(a.x, c.x) + 1e-9 &&
    b.x + 1e-9 >= Math.min(a.x, c.x) &&
    b.y <= Math.max(a.y, c.y) + 1e-9 &&
    b.y + 1e-9 >= Math.min(a.y, c.y)
  );
}

export function segmentsIntersect(a: RfPoint, b: RfPoint, c: RfPoint, d: RfPoint): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
}

export function pointInPolygon(point: RfPoint, polygon: RfPoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects = pi.y > point.y !== pj.y > point.y;
    if (!intersects) continue;
    const denominator = Math.abs(pj.y - pi.y) < Number.EPSILON ? Number.EPSILON : pj.y - pi.y;
    const x = ((pj.x - pi.x) * (point.y - pi.y)) / denominator + pi.x;
    if (point.x < x) inside = !inside;
  }
  return inside;
}

export function polygonCentroid(points: RfPoint[]): RfPoint {
  if (!points.length) return { x: 0, y: 0 };
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    twiceArea += cross;
    cx += (current.x + next.x) * cross;
    cy += (current.y + next.y) * cross;
  }

  if (Math.abs(twiceArea) < 1e-9) {
    const total = points.reduce<RfPoint>((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
    return { x: total.x / points.length, y: total.y / points.length };
  }

  return {
    x: cx / (3 * twiceArea),
    y: cy / (3 * twiceArea),
  };
}

export function sampleLine(start: RfPoint, end: RfPoint, stepPx: number): RfPoint[] {
  const length = distance(start, end);
  const steps = Math.max(1, Math.ceil(length / Math.max(stepPx, 1)));
  const samples: RfPoint[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    samples.push({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    });
  }
  return samples;
}
