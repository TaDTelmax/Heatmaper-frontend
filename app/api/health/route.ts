import { NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export async function GET() {
  try {
    const response = await fetch(`${BACKEND_URL}/health`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { status: "error", detail: "Backend FastAPI indisponivel." },
        { status: response.status },
      );
    }

    return NextResponse.json({
      status: "ok",
      backend: "fastapi",
      backend_url: BACKEND_URL,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado.";
    return NextResponse.json(
      { status: "error", detail: `Nao foi possivel conectar ao backend FastAPI: ${message}` },
      { status: 502 },
    );
  }
}
