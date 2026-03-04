import type { HistoryResponse, Mode, PredictionResponse, Provider, StatsResponse } from "@shared/types";

export interface PredictPayload {
  text: string;
  provider: Provider;
  model: string;
  mode: Mode;
  sessionId: string;
}

interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: (payload: PredictionResponse) => void;
}

interface StreamOptions {
  signal?: AbortSignal;
}

async function parseJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T;
  if (!response.ok) {
    const message = (data as { error?: string }).error ?? "Request failed";
    throw new Error(message);
  }
  return data;
}

export async function predict(payload: PredictPayload): Promise<PredictionResponse> {
  const response = await fetch("/api/predict", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  return parseJson<PredictionResponse>(response);
}

export async function getStats(): Promise<StatsResponse> {
  const response = await fetch("/api/stats");
  return parseJson<StatsResponse>(response);
}

export async function getHistory(sessionId: string, limit = 10): Promise<HistoryResponse> {
  const query = new URLSearchParams({ sessionId, limit: String(limit) });
  const response = await fetch(`/api/history?${query.toString()}`);
  return parseJson<HistoryResponse>(response);
}

export async function predictStream(payload: PredictPayload, handlers: StreamHandlers, options?: StreamOptions): Promise<void> {
  const response = await fetch("/api/predict/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: options?.signal
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Stream request failed" }));
    throw new Error(body.error ?? "Stream request failed");
  }

  if (!response.body) {
    throw new Error("Streaming not supported by this browser");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const line = chunk
        .split("\n")
        .find((item) => item.startsWith("data:"))
        ?.slice(5)
        .trim();

      if (!line) {
        continue;
      }

      const parsed = JSON.parse(line) as { type: string; text?: string; message?: string } & PredictionResponse;
      if (parsed.type === "delta" && parsed.text) {
        handlers.onDelta(parsed.text);
      }
      if (parsed.type === "done") {
        handlers.onDone(parsed);
        return;
      }
      if (parsed.type === "error") {
        throw new Error(parsed.message ?? "Stream error");
      }
    }
  }
}
