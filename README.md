# Wi-Fi Heatmap Frontend

Frontend Next.js para onboarding guiado de heatmap Wi-Fi.

O fluxo cobre upload da planta, escala, AP, pontos de medicao dinamicos pelo CSV ou marcacao manual, RSSI, revisao, geracao IDW e exportacoes. O heatmap final e gerado no navegador usando a largura e altura originais da planta.

## Rodar

```powershell
cd frontend
npm install
npm run dev
```

Por padrao a deteccao automatica chama `/api/detect-points` no proprio Next.js. O Next repassa a requisicao para o FastAPI usando `BACKEND_URL=http://localhost:8000`; se o backend nao estiver disponivel, o frontend tenta uma deteccao simples de marcadores vermelhos no navegador.
