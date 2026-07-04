"use client";

import { Plus, Trash2, RadioTower } from "lucide-react";
import { useState } from "react";
import type { Coordinate, FloorplanImage, RouterPlacement } from "@/types/floorplan";
import { FloorplanCanvas } from "./FloorplanCanvas";

type StepRouterPlacementProps = {
  floorplan: FloorplanImage;
  aps: RouterPlacement[];
  onSetAps: (aps: RouterPlacement[]) => void;
};

function newAp(): RouterPlacement {
  return { id: crypto.randomUUID(), ap_x_px: -1, ap_y_px: -1 };
}

export function StepRouterPlacement({ floorplan, aps, onSetAps }: StepRouterPlacementProps) {
  const [selectedApId, setSelectedApId] = useState<string | null>(aps[0]?.id ?? null);
  const selectedAp = aps.find((ap) => ap.id === selectedApId) ?? null;

  function addAp() {
    const ap = newAp();
    onSetAps([...aps, ap]);
    setSelectedApId(ap.id);
  }

  function removeAp(id: string) {
    const next = aps.filter((ap) => ap.id !== id);
    onSetAps(next);
    if (selectedApId === id) setSelectedApId(next[0]?.id ?? null);
  }

  function updateSelected(patch: Partial<RouterPlacement>) {
    if (!selectedAp) return;
    onSetAps(aps.map((ap) => (ap.id === selectedAp.id ? { ...ap, ...patch } : ap)));
  }

  function handleCanvasClick(point: Coordinate) {
    if (!selectedAp) {
      const ap = { ...newAp(), ap_x_px: point.x_px, ap_y_px: point.y_px };
      onSetAps([...aps, ap]);
      setSelectedApId(ap.id);
    } else {
      updateSelected({ ap_x_px: point.x_px, ap_y_px: point.y_px });
    }
  }

  const placedAps = aps.filter((ap) => ap.ap_x_px >= 0 && ap.ap_y_px >= 0);
  const isPlaced = selectedAp && selectedAp.ap_x_px >= 0 && selectedAp.ap_y_px >= 0;

  return (
    <section className="stepPanel">
      <div className="stepHeader">
        <span className="stepIcon"><RadioTower size={18} /></span>
        <div>
          <h2>Definir APs/Roteadores</h2>
          <p>
            {selectedAp
              ? "Clique na planta para posicionar o AP selecionado."
              : "Adicione um AP e clique na planta para posiciona-lo."}
          </p>
        </div>
      </div>

      <FloorplanCanvas
        floorplan={floorplan}
        aps={placedAps}
        selectedApId={selectedApId}
        onCanvasClick={handleCanvasClick}
        onApSelect={setSelectedApId}
      />

      <div className="apList">
        {aps.map((ap, index) => (
          <div
            key={ap.id}
            className={`apListItem ${selectedApId === ap.id ? "selected" : ""}`}
            onClick={() => setSelectedApId(ap.id)}
          >
            <span className="apIndex">{index + 1}</span>
            <span className="apLabel">{ap.ssid || `AP ${index + 1}`}</span>
            {ap.ap_x_px < 0 && <span className="apUnplaced">sem posicao</span>}
            <button
              type="button"
              className="apRemoveBtn"
              aria-label="Remover AP"
              onClick={(e) => { e.stopPropagation(); removeAp(ap.id); }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button type="button" className="apAddBtn" onClick={addAp}>
          <Plus size={14} /> Adicionar AP
        </button>
      </div>

      {selectedAp && (
        <div className="formGrid two">
          <label className="field" htmlFor="ap-ssid">
            SSID
            <input
              id="ap-ssid"
              type="text"
              placeholder="Nome da rede"
              value={selectedAp.ssid ?? ""}
              onChange={(e) => updateSelected({ ssid: e.target.value || undefined })}
            />
          </label>

          <label className="field" htmlFor="ap-mac">
            MAC
            <input
              id="ap-mac"
              type="text"
              placeholder="AA:BB:CC:DD:EE:FF"
              value={selectedAp.mac ?? ""}
              onChange={(e) => updateSelected({ mac: e.target.value || undefined })}
            />
          </label>

          <label className="field" htmlFor="ap-vendor">
            Fabricante
            <input
              id="ap-vendor"
              type="text"
              placeholder="Ex: TP-Link"
              value={selectedAp.vendor ?? ""}
              onChange={(e) => updateSelected({ vendor: e.target.value || undefined })}
            />
          </label>

          <label className="field" htmlFor="ap-channel">
            Canal
            <input
              id="ap-channel"
              type="number"
              min="1"
              max="233"
              step="1"
              placeholder="-"
              value={selectedAp.channel ?? ""}
              onChange={(e) => updateSelected({ channel: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>

          <label className="field" htmlFor="ap-signal">
            Sinal (dBm)
            <input
              id="ap-signal"
              type="number"
              min="-100"
              max="-10"
              step="1"
              placeholder="-"
              value={selectedAp.signalDbm ?? ""}
              onChange={(e) => updateSelected({ signalDbm: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>

          <label className="field" htmlFor="ap-maxrate">
            Max Rate (Mbps)
            <input
              id="ap-maxrate"
              type="number"
              min="0"
              step="1"
              placeholder="-"
              value={selectedAp.maxRateMbps ?? ""}
              onChange={(e) => updateSelected({ maxRateMbps: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>

          <label className="field" htmlFor="ap-encryption">
            Criptografia
            <input
              id="ap-encryption"
              type="text"
              placeholder="Ex: WPA2, WPA3"
              value={selectedAp.encryption ?? ""}
              onChange={(e) => updateSelected({ encryption: e.target.value || undefined })}
            />
          </label>
        </div>
      )}

      {selectedAp && !isPlaced && (
        <p className="fieldHint">Clique na planta para posicionar este AP.</p>
      )}
    </section>
  );
}
