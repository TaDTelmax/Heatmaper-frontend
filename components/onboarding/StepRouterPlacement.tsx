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

const defaultDutConfig = {
  frequency: "tri-band",
  txPower: 20,
  antennaGainDbi: 3,
  antennaPattern: "omni",
  antennaAzimuthDeg: 0,
  channel: 44,
  propagationRadiusM: 28,
} satisfies Omit<RouterPlacement, "ap_x_px" | "ap_y_px">;

function withDutDefaults(ap: RouterPlacement): RouterPlacement {
  return {
    ...defaultDutConfig,
    ...ap,
  };
}

export function StepRouterPlacement({ floorplan, ap, onSetAp }: StepRouterPlacementProps) {
  const dut = ap ? withDutDefaults(ap) : null;

  function updateDut(patch: Partial<RouterPlacement>) {
    if (!dut) return;
    onSetAp(withDutDefaults({ ...dut, ...patch }));
  }

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
        onCanvasClick={(point) => onSetAp(withDutDefaults({ ...(ap ?? { ap_x_px: point.x_px, ap_y_px: point.y_px }), ap_x_px: point.x_px, ap_y_px: point.y_px }))}
      />

      <div className="formGrid two">
        <label className="field" htmlFor="dut-tx-power">
          Potencia TX (dBm)
          <input
            id="dut-tx-power"
            type="number"
            min="0"
            max="30"
            step="1"
            disabled={!dut}
            value={dut?.txPower ?? defaultDutConfig.txPower}
            onChange={(event) => updateDut({ txPower: Number(event.target.value) })}
          />
        </label>

        <label className="field" htmlFor="dut-antenna-gain">
          Ganho antena (dBi)
          <input
            id="dut-antenna-gain"
            type="number"
            min="0"
            max="12"
            step="0.5"
            disabled={!dut}
            value={dut?.antennaGainDbi ?? defaultDutConfig.antennaGainDbi}
            onChange={(event) => updateDut({ antennaGainDbi: Number(event.target.value) })}
          />
        </label>

        <label className="field" htmlFor="dut-channel">
          Canal
          <input
            id="dut-channel"
            type="number"
            min="1"
            max="233"
            step="1"
            disabled={!dut}
            value={dut?.channel ?? defaultDutConfig.channel}
            onChange={(event) => updateDut({ channel: Number(event.target.value) })}
          />
        </label>

        <label className="field" htmlFor="dut-radius">
          Raio RF (m)
          <input
            id="dut-radius"
            type="number"
            min="4"
            max="120"
            step="1"
            disabled={!dut}
            value={dut?.propagationRadiusM ?? defaultDutConfig.propagationRadiusM}
            onChange={(event) => updateDut({ propagationRadiusM: Number(event.target.value) })}
          />
        </label>

        <label className="field" htmlFor="dut-pattern">
          Padrao antena
          <select
            id="dut-pattern"
            disabled={!dut}
            value={dut?.antennaPattern ?? defaultDutConfig.antennaPattern}
            onChange={(event) => updateDut({ antennaPattern: event.target.value as RouterPlacement["antennaPattern"] })}
          >
            <option value="omni">Omnidirecional</option>
            <option value="directional">Direcional</option>
          </select>
        </label>
      </div>

      <div className="factGrid">
        <Fact label="ap_x_px" value={ap ? ap.ap_x_px.toFixed(1) : "-"} />
        <Fact label="ap_y_px" value={ap ? ap.ap_y_px.toFixed(1) : "-"} />
        <Fact label="TX" value={dut ? `${dut.txPower} dBm` : "-"} />
        <Fact label="Antena" value={dut ? `${dut.antennaGainDbi} dBi` : "-"} />
        <Fact label="Canal" value={dut ? dut.channel ?? "-" : "-"} />
        <Fact label="Raio" value={dut ? `${dut.propagationRadiusM} m` : "-"} />
      </div>
    </section>
  );
}
