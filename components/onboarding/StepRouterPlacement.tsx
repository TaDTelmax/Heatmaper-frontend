"use client";

import { RadioTower } from "lucide-react";
import type { FloorplanImage, RouterPlacement } from "@/types/floorplan";
import { FloorplanCanvas } from "./FloorplanCanvas";
import { Fact } from "./StepUploadFloorplan";

type StepRouterPlacementProps = {
  floorplan: FloorplanImage;
  ap: RouterPlacement | null;
  onSetAp: (ap: RouterPlacement) => void;
};

export function StepRouterPlacement({ floorplan, ap, onSetAp }: StepRouterPlacementProps) {
  return (
    <section className="stepPanel">
      <div className="stepHeader">
        <span className="stepIcon"><RadioTower size={18} /></span>
        <div>
          <h2>Definir AP/Roteador</h2>
          <p>Clique na posicao real do roteador na planta.</p>
        </div>
      </div>

      <FloorplanCanvas
        floorplan={floorplan}
        ap={ap}
        onCanvasClick={(point) => onSetAp({ ap_x_px: point.x_px, ap_y_px: point.y_px })}
      />

      <div className="factGrid">
        <Fact label="ap_x_px" value={ap ? ap.ap_x_px.toFixed(1) : "-"} />
        <Fact label="ap_y_px" value={ap ? ap.ap_y_px.toFixed(1) : "-"} />
      </div>
    </section>
  );
}
