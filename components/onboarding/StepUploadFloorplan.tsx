"use client";

import type { ChangeEvent, DragEvent } from "react";
import { useRef, useState } from "react";
import { CheckCircle2, FileImage, Trash2, UploadCloud } from "lucide-react";
import { validateFloorplanImage } from "@/domain/heatmap/validation";
import type { FloorplanImage } from "@/types/floorplan";

type StepUploadFloorplanProps = {
  floorplan: FloorplanImage | null;
  onUpload: (file: File) => void | Promise<void>;
  onClear: () => void;
};

export function StepUploadFloorplan({ floorplan, onUpload, onClear }: StepUploadFloorplanProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const issues = floorplan ? validateFloorplanImage(floorplan) : [];

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploadError(null);
    Promise.resolve(onUpload(file)).catch((error) => {
      setUploadError(error instanceof Error ? error.message : "Não foi possível carregar a planta.");
    });
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    handleFiles(event.dataTransfer.files);
  }

  return (
    <section className="stepPanel">
      <div className="stepHeader">
        <span className="stepIcon" aria-hidden="true"><UploadCloud size={18} /></span>
        <div>
          <h2>Upload da planta baixa</h2>
          <p>Envie a planta do ambiente em PNG ou JPG. A origem (0,0) deve ser o canto superior esquerdo.</p>
        </div>
      </div>

      <label
        className={`uploadZone ${dragging ? "dragging" : ""} ${floorplan ? "loaded" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        aria-label="Área de upload — arraste ou clique para selecionar a planta"
      >
        <FileImage size={28} aria-hidden="true" />
        <strong>{floorplan ? floorplan.fileName : "Arraste a planta ou clique para selecionar"}</strong>
        <span>
          {floorplan
            ? `${floorplan.width} × ${floorplan.height} px · ${(floorplan.fileSize / 1024 / 1024).toFixed(2)} MB`
            : "PNG ou JPG · máx. 12 MB"}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg"
          onChange={(event: ChangeEvent<HTMLInputElement>) => handleFiles(event.target.files)}
          aria-hidden="true"
          tabIndex={-1}
        />
      </label>

      {floorplan && (
        <div className="previewGrid">
          <img className="floorPreview" src={floorplan.dataUrl} alt={`Preview da planta: ${floorplan.fileName}`} />
          <div style={{ display: "grid", gap: 12 }}>
            <div className="factGrid">
              <Fact label="Resolução" value={`${floorplan.width} × ${floorplan.height}px`} />
              <Fact label="Proporção" value={floorplan.aspectRatio.toFixed(2)} />
              <Fact label="Tamanho" value={`${(floorplan.fileSize / 1024 / 1024).toFixed(2)} MB`} />
              <Fact label="Eixos" value="x→ direita, y↓ baixo" />
            </div>
            <button className="dangerButton" type="button" onClick={onClear} aria-label="Remover planta e reiniciar projeto">
              <Trash2 size={15} />
              Remover planta
            </button>
          </div>
        </div>
      )}

      <IssueList
        issues={[
          ...issues,
          ...(uploadError ? [{ severity: "error" as const, message: uploadError }] : []),
        ]}
      />
    </section>
  );
}

export function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function IssueList({ issues }: { issues: { severity: "error" | "warning"; message: string; point_id?: string }[] }) {
  if (!issues.length) {
    return (
      <div className="issueList ok" role="status" aria-live="polite">
        <CheckCircle2 size={16} aria-hidden="true" />
        Validação sem bloqueios — pode avançar.
      </div>
    );
  }

  return (
    <div className="issueList" role="alert" aria-live="polite">
      {issues.map((issue, index) => (
        <div key={`${issue.message}-${index}`} className={`issue ${issue.severity}`}>
          <span>{issue.severity === "error" ? "Erro" : "Atenção"}</span>
          <p>{issue.point_id ? `Ponto ${issue.point_id}: ${issue.message}` : issue.message}</p>
        </div>
      ))}
    </div>
  );
}
