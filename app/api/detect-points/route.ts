import { NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

type DetectionResponse = {
  points?: unknown;
};

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const response = await fetch(`${BACKEND_URL}/api/detect-points`, {
      method: "POST",
      body: form,
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json(
        { detail: "Backend FastAPI retornou uma resposta invalida." },
        { status: response.status },
      );
    }
    const body = (await response.json()) as DetectionResponse;
    if (!response.ok) {
      return NextResponse.json(body, { status: response.status });
    }
    if (!Array.isArray(body.points)) {
      return NextResponse.json(
        { detail: "Backend FastAPI nao devolveu pontos detectados." },
        { status: 502 },
      );
    }
    return NextResponse.json(body, {
      headers: {
        "Cache-Control": "no-store",
        "X-Detection-Processed-By": "fastapi",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado.";
    return NextResponse.json(
      { detail: `Nao foi possivel conectar ao backend FastAPI: ${message}` },
      { status: 502 },
    );
  }
}
