import { clamp, sampleLine, segmentsIntersect } from "./spatial";
import type { ObstacleMap, RfPoint, WallMaterial, WallSegment, WifiBand } from "@/types/heatmap";

type MaterialProfile = {
  label: string;
  attenuationDb: number;
  reflectionFactor: number;
  absorptionFactor: number;
  penetrationFactor: number;
};

export const materialLossProfiles: Record<WallMaterial, MaterialProfile> = {
  drywall: { label: "Gesso acartonado", attenuationDb: 3, reflectionFactor: 0.08, absorptionFactor: 0.22, penetrationFactor: 0.9 },
  glass: { label: "Vidro", attenuationDb: 5, reflectionFactor: 0.18, absorptionFactor: 0.18, penetrationFactor: 0.72 },
  wood: { label: "Madeira", attenuationDb: 4, reflectionFactor: 0.1, absorptionFactor: 0.28, penetrationFactor: 0.82 },
  brick: { label: "Tijolo", attenuationDb: 8, reflectionFactor: 0.18, absorptionFactor: 0.46, penetrationFactor: 0.58 },
  concrete: { label: "Concreto", attenuationDb: 12, reflectionFactor: 0.24, absorptionFactor: 0.62, penetrationFactor: 0.42 },
  reinforced_concrete: { label: "Concreto armado", attenuationDb: 16, reflectionFactor: 0.34, absorptionFactor: 0.74, penetrationFactor: 0.28 },
  metal: { label: "Metal / nucleo de elevador", attenuationDb: 22, reflectionFactor: 0.68, absorptionFactor: 0.86, penetrationFactor: 0.12 },
};

const bandProfiles: Record<
  WifiBand,
  { pathLossExponent: number; wallMultiplier: number; defaultRadiusM: number; shadowMultiplier: number; diffractionCredit: number }
> = {
  "24ghz": { pathLossExponent: 1.72, wallMultiplier: 0.86, defaultRadiusM: 42, shadowMultiplier: 0.82, diffractionCredit: 0.34 },
  "5ghz": { pathLossExponent: 2.12, wallMultiplier: 1.18, defaultRadiusM: 28, shadowMultiplier: 1.05, diffractionCredit: 0.22 },
  "6ghz": { pathLossExponent: 2.34, wallMultiplier: 1.34, defaultRadiusM: 22, shadowMultiplier: 1.18, diffractionCredit: 0.16 },
};

export function defaultInterpolationRadiusM(band: WifiBand): number {
  return bandProfiles[band].defaultRadiusM;
}

export function distanceDecayDb(distanceM: number, band: WifiBand): number {
  if (distanceM <= 0) return 0;
  const profile = bandProfiles[band];
  return 10 * profile.pathLossExponent * Math.log10(1 + distanceM);
}

export function materialLossDb(material: WallMaterial, band: WifiBand, thicknessM = 0.12): number {
  const base = materialLossProfiles[material]?.attenuationDb ?? materialLossProfiles.drywall.attenuationDb;
  const thicknessFactor = clamp(thicknessM / 0.12, 0.65, 2.4);
  return base * bandProfiles[band].wallMultiplier * thicknessFactor;
}

function wallCrossingAngleFactor(start: RfPoint, end: RfPoint, wall: WallSegment): number {
  const pathAngle = Math.atan2(end.y - start.y, end.x - start.x);
  const wallAngle = Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x);
  const delta = Math.abs(Math.sin(pathAngle - wallAngle));
  return clamp(1 / Math.max(delta, 0.26), 1, 2.8);
}

export function explicitWallLossDb(start: RfPoint, end: RfPoint, walls: WallSegment[], band: WifiBand): number {
  if (!walls.length) return 0;
  let loss = 0;
  for (const wall of walls) {
    if (segmentsIntersect(start, end, wall.start, wall.end)) {
      const profile = materialLossProfiles[wall.material] ?? materialLossProfiles.drywall;
      const angleFactor = wallCrossingAngleFactor(start, end, wall);
      const penetrationLoss = materialLossDb(wall.material, band, wall.thicknessM) * angleFactor * (1.08 - profile.penetrationFactor * 0.22);
      const reflectionLoss = profile.reflectionFactor * bandProfiles[band].wallMultiplier * 2.6;
      const absorptionLoss = profile.absorptionFactor * bandProfiles[band].shadowMultiplier * 1.8;
      loss += penetrationLoss + reflectionLoss + absorptionLoss;
    }
  }
  return loss;
}

export function obstacleLossDb(
  start: RfPoint,
  end: RfPoint,
  obstacleMap: ObstacleMap | null | undefined,
  pxPerMeter: number,
  band: WifiBand,
): number {
  if (!obstacleMap || !obstacleMap.data.length) return 0;
  const samples = sampleLine(start, end, 2.5);
  let runs = 0;
  let runPixels = 0;
  let insideRun = false;

  for (const sample of samples) {
    const x = Math.round(sample.x);
    const y = Math.round(sample.y);
    const inside = x >= 0 && y >= 0 && x < obstacleMap.width && y < obstacleMap.height;
    const blocked = inside ? obstacleMap.data[y * obstacleMap.width + x] === 1 : false;
    if (blocked) {
      runPixels += 1;
      if (!insideRun) {
        runs += 1;
        insideRun = true;
      }
    } else {
      insideRun = false;
    }
  }

  if (!runs) return 0;
  const runMeters = runPixels / Math.max(pxPerMeter, 1);
  const profile = materialLossProfiles[obstacleMap.material] ?? materialLossProfiles.drywall;
  const materialBase = materialLossDb(obstacleMap.material, band, 0.1);
  const crossingLoss = runs * materialBase * (0.44 + profile.absorptionFactor * 0.22);
  const grazingLoss = Math.min(12, runMeters * materialBase * (0.28 + profile.reflectionFactor * 0.18));
  return crossingLoss + grazingLoss;
}

export function propagationLossDb(params: {
  start: RfPoint;
  end: RfPoint;
  band: WifiBand;
  pxPerMeter: number;
  walls?: WallSegment[];
  obstacleMap?: ObstacleMap | null;
  useWallAttenuation?: boolean;
}): { distanceDb: number; wallDb: number; shadowDb: number; diffractionCreditDb: number; totalDb: number } {
  const distanceM = Math.hypot(params.end.x - params.start.x, params.end.y - params.start.y) / Math.max(params.pxPerMeter, 1);
  const distanceDb = distanceDecayDb(distanceM, params.band);
  const explicitDb = params.useWallAttenuation === false ? 0 : explicitWallLossDb(params.start, params.end, params.walls ?? [], params.band);
  const inferredDb =
    params.useWallAttenuation === false
      ? 0
      : obstacleLossDb(params.start, params.end, params.obstacleMap, params.pxPerMeter, params.band);
  const wallDb = explicitDb + inferredDb;
  const profile = bandProfiles[params.band];
  const shadowDb = Math.min(18, wallDb * 0.18 * profile.shadowMultiplier + Math.sqrt(Math.max(wallDb, 0)) * 0.45);
  const diffractionCreditDb = wallDb > 0 ? Math.min(wallDb * 0.18, profile.diffractionCredit * Math.sqrt(distanceM + 1)) : 0;
  return {
    distanceDb,
    wallDb,
    shadowDb,
    diffractionCreditDb,
    totalDb: distanceDb + wallDb + shadowDb - diffractionCreditDb,
  };
}
