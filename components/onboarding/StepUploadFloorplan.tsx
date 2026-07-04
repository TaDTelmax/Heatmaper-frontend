"use client";

import type { ChangeEvent, DragEvent } from "react";
import { useRef, useState } from "react";
import {
  CheckCircle2,
  FileImage,
  FileText,
  FlipHorizontal2,
  FlipVertical2,
  Loader2,
  RotateCcw as RotateCcwIcon,
  RotateCw,
  ScanLine,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { validateFloorplanImage } from "@/domain/heatmap/validation";
import { getPdfInfo } from "@/services/pdfService";
import type { FloorplanTransformKind } from "@/services/floorplanTransform";
import type { FloorplanImage } from "@/types/floorplan";

type StepUploadFloorplanProps = {
  floorplan: FloorplanImage | null;
  onUpload: (file: File, pdfPage?: number) => void | Promise<void>;
  onClear: () => void;
  onEnhance?: () => Promise<void>;
  onTransform?: (kind: FloorplanTransformKind) => Promise<void>;
};

type PdfPending = {
  file: File;
  pageCount: number;
  title: string | null;
  selectedPage: number;
};

export function StepUploadFloorplan({ floorplan, onUpload, onClear, onEnhance, onTransform }: StepUploadFloorplanProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pdfPending, setPdfPending] = useState<PdfPending | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const [transforming, setTransforming] = useState<FloorplanTransformKind | null>(null);
  const [transformError, setTransformError] = useState<string | null>(null);
  const issues = floorplan ? validateFloorplanImage(floorplan) : [];

  async function handleEnhance() {
    if (!onEnhance) return;
    setEnhancing(true);
    setEnhanceError(null);
    try {
      await onEnhance();
    } catch (err) {
      setEnhanceError(err instanceof Error ? err.message : "Falha ao processar a planta.");
    } finally {
      setEnhancing(false);
    }
  }

  async function handleTransform(kind: FloorplanTransformKind) {
    if (!onTransform) return;
    setTransforming(kind);
    setTransformError(null);
    try {
      await onTransform(kind);
    } catch (err) {
      setTransformError(err instanceof Error ? err.message : "Falha ao girar/espelhar a planta.");
    } finally {
      setTransforming(null);
    }
  }

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploadError(null);
    setPdfPending(null);

    if (file.type === "application/pdf") {
      setPdfLoading(true);
      try {
        const info = await getPdfInfo(file);
        if (info.pageCount === 1) {
          // Single page: skip picker, load immediately
          await triggerUpload(file, 1);
        } else {
          setPdfPending({ file, pageCount: info.pageCount, title: info.title, selectedPage: 1 });
        }
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "Não foi possível ler o PDF.");
      } finally {
        setPdfLoading(false);
      }
      return;
    }

    Promise.resolve(onUpload(file)).catch((error) => {
      setUploadError(error instanceof Error ? error.message : "Não foi possível carregar a planta.");
    });
  }

  async function triggerUpload(file: File, page: number) {
    setPdfLoading(true);
    try {
      await Promise.resolve(onUpload(file, page));
      setPdfPending(null);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Não foi possível carregar a planta.");
    } finally {
      setPdfLoading(false);
    }
  }

  async function confirmPdfPage() {
    if (!pdfPending) return;
    await triggerUpload(pdfPending.file, pdfPending.selectedPage);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    handleFiles(event.dataTransfer.files);
  }

  const isPdf = floorplan?.mimeType === "application/pdf";
  const pdf = floorplan?.pdf;

  return (
    <section className="stepPanel">
      <div className="stepHeader">
        <span className="stepIcon" aria-hidden="true"><UploadCloud size={18} /></span>
        <div>
          <h2>Upload da planta baixa</h2>
          <p>Envie a planta do ambiente em PNG, JPG ou PDF. A origem (0,0) deve ser o canto superior esquerdo.</p>
        </div>
      </div>

      {/* Upload zone — hidden when a PDF picker is shown */}
      {!pdfPending && (
        <label
          className={`uploadZone ${dragging ? "dragging" : ""} ${floorplan ? "loaded" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          aria-label="Área de upload — arraste ou clique para selecionar a planta"
        >
          {pdfLoading
            ? <Loader2 size={28} className="spin" aria-hidden="true" />
            : floorplan
              ? (isPdf ? <FileText size={28} aria-hidden="true" /> : <FileImage size={28} aria-hidden="true" />)
              : <FileImage size={28} aria-hidden="true" />}
          <strong>{floorplan ? floorplan.fileName : "Arraste a planta ou clique para selecionar"}</strong>
          <span>
            {floorplan
              ? `${floorplan.width} × ${floorplan.height} px · ${(floorplan.fileSize / 1024 / 1024).toFixed(2)} MB`
              : "PNG, JPG ou PDF · máx. 12 MB (PDF até 50 MB)"}
          </span>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,application/pdf"
            onChange={(event: ChangeEvent<HTMLInputElement>) => handleFiles(event.target.files)}
            aria-hidden="true"
            tabIndex={-1}
          />
        </label>
      )}

      {/* PDF multi-page picker */}
      {pdfPending && (
        <div style={{ display: "grid", gap: 14, padding: "18px 20px", border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--surface-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <FileText size={22} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
            <div>
              <strong style={{ display: "block", fontSize: 14, color: "var(--text)" }}>
                {pdfPending.title ?? pdfPending.file.name}
              </strong>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {pdfPending.pageCount} {pdfPending.pageCount === 1 ? "página" : "páginas"} · {(pdfPending.file.size / 1024 / 1024).toFixed(2)} MB
              </span>
            </div>
          </div>

          <div className="field">
            <label htmlFor="pdf-page-select">Selecione a página da planta</label>
            <select
              id="pdf-page-select"
              value={pdfPending.selectedPage}
              onChange={(e) => setPdfPending((prev) => prev ? { ...prev, selectedPage: Number(e.target.value) } : null)}
            >
              {Array.from({ length: pdfPending.pageCount }, (_, i) => (
                <option key={i + 1} value={i + 1}>Página {i + 1}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="primaryButton"
              type="button"
              disabled={pdfLoading}
              onClick={confirmPdfPage}
            >
              {pdfLoading ? <><Loader2 size={14} className="spin" /> Carregando…</> : "Carregar planta"}
            </button>
            <button
              className="secondaryButton"
              type="button"
              onClick={() => { setPdfPending(null); setUploadError(null); }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Preview after successful upload */}
      {floorplan && !pdfPending && (
        <div className="previewGrid">
          <img className="floorPreview" src={floorplan.dataUrl} alt={`Preview da planta: ${floorplan.fileName}`} />

          <div style={{ display: "grid", gap: 12 }}>
            <div className="factGrid">
              <Fact label="Resolução" value={`${floorplan.width} × ${floorplan.height}px`} />
              <Fact label="Proporção" value={floorplan.aspectRatio.toFixed(2)} />
              <Fact label="Tamanho" value={`${(floorplan.fileSize / 1024 / 1024).toFixed(2)} MB`} />
              {isPdf && pdf ? (
                <Fact label="Página PDF" value={`${pdf.selectedPage} / ${pdf.pageCount}`} />
              ) : (
                <Fact label="Eixos" value="x→ direita, y↓ baixo" />
              )}
            </div>

            {/* PDF extracted info */}
            {isPdf && pdf && (
              <PdfInfoPanel pdf={pdf} />
            )}

            {/* Orientation fix — rotate/mirror when the plan renders sideways
                or upside-down relative to the real building */}
            {onTransform && (
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={transforming !== null}
                    onClick={() => handleTransform("rotate-ccw")}
                    title="Girar planta 90° para a esquerda"
                  >
                    {transforming === "rotate-ccw" ? <Loader2 size={14} className="spin" /> : <RotateCcwIcon size={14} />}
                    Girar 90° esq.
                  </button>
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={transforming !== null}
                    onClick={() => handleTransform("rotate-cw")}
                    title="Girar planta 90° para a direita"
                  >
                    {transforming === "rotate-cw" ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />}
                    Girar 90° dir.
                  </button>
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={transforming !== null}
                    onClick={() => handleTransform("rotate-180")}
                    title="Girar planta 180°"
                  >
                    {transforming === "rotate-180" ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />}
                    Girar 180°
                  </button>
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={transforming !== null}
                    onClick={() => handleTransform("flip-v")}
                    title="Inverter de cabeça para baixo (espelhar verticalmente)"
                  >
                    {transforming === "flip-v" ? <Loader2 size={14} className="spin" /> : <FlipVertical2 size={14} />}
                    Inverter vertical
                  </button>
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={transforming !== null}
                    onClick={() => handleTransform("flip-h")}
                    title="Espelhar horizontalmente"
                  >
                    {transforming === "flip-h" ? <Loader2 size={14} className="spin" /> : <FlipHorizontal2 size={14} />}
                    Espelhar horizontal
                  </button>
                </div>
                {transformError && (
                  <span style={{ fontSize: 12, color: "var(--danger)" }}>{transformError}</span>
                )}
              </div>
            )}

            {/* Enhance to B&W */}
            {onEnhance && !floorplan.enhanced && (
              <div style={{ display: "grid", gap: 8 }}>
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={enhancing}
                  onClick={handleEnhance}
                  title="Processa a planta para preto e branco limpo — remove cores e ruído, reforça paredes"
                >
                  {enhancing
                    ? <><Loader2 size={14} className="spin" /> Processando…</>
                    : <><ScanLine size={14} /> Gerar Planta P&B</>}
                </button>
                {enhanceError && (
                  <span style={{ fontSize: 12, color: "var(--danger)" }}>{enhanceError}</span>
                )}
              </div>
            )}

            {floorplan.enhanced && (
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--ok)", fontWeight: 600 }}>
                <ScanLine size={14} />
                Planta convertida para P&B — ideal para heatmap.
              </div>
            )}

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

function PdfInfoPanel({ pdf }: { pdf: NonNullable<FloorplanImage["pdf"]> }) {
  const { measurements } = pdf;
  const hasData = measurements.scaleFactor || measurements.areaSqM || measurements.widthM || measurements.rooms.length > 0;

  if (!hasData && !pdf.detectedScale) return null;

  return (
    <div style={{ display: "grid", gap: 10, padding: "12px 14px", border: "1px solid rgba(34,211,238,0.20)", borderRadius: "var(--radius)", background: "var(--accent-soft)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--accent)", fontSize: 12, fontWeight: 700 }}>
        <FileText size={14} aria-hidden="true" />
        Informações extraídas do PDF
      </div>

      <div className="factGrid">
        {measurements.scaleFactor && (
          <Fact label="Escala" value={measurements.scaleFactor} />
        )}
        {pdf.detectedScale && (
          <Fact label="px / metro" value={`${pdf.detectedScale} px/m`} />
        )}
        {measurements.areaSqM && (
          <Fact label="Área total" value={`${measurements.areaSqM.toFixed(1)} m²`} />
        )}
        {measurements.widthM && measurements.heightM && (
          <Fact label="Dimensões" value={`${measurements.widthM.toFixed(2)} × ${measurements.heightM.toFixed(2)} m`} />
        )}
      </div>

      {measurements.rooms.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted)", marginBottom: 6 }}>
            Cômodos detectados
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {measurements.rooms.map((room) => (
              <span key={room} className="badge info">{room}</span>
            ))}
          </div>
        </div>
      )}

      {pdf.detectedScale && (
        <div style={{ fontSize: 11.5, color: "var(--accent)", opacity: 0.85 }}>
          Sugestão a partir do texto da planta — confirme a escala real na etapa de calibração antes de prosseguir (o rótulo do desenho nem sempre bate com o PDF exportado).
        </div>
      )}
    </div>
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
