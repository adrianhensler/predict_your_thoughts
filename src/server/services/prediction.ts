import type { Mode, Provider, Suggestion } from "../../shared/types.js";

const OPENROUTER_COST_PER_1K = 0.0005;
const OPENAI_COST_PER_1K = 0.0006;
const ANTHROPIC_COST_PER_1K = 0.003;

export function estimateCostUsd(provider: Provider, promptTokens = 0, completionTokens = 0): number {
  const totalTokens = promptTokens + completionTokens;
  if (totalTokens <= 0) {
    return 0;
  }

  const rate =
    provider === "openrouter"
      ? OPENROUTER_COST_PER_1K
      : provider === "openai"
        ? OPENAI_COST_PER_1K
        : provider === "anthropic"
          ? ANTHROPIC_COST_PER_1K
          : 0;

  return Number(((totalTokens / 1000) * rate).toFixed(6));
}

export function parsePredictionPayload(rawText: string, mode: Mode): { prediction: string; suggestions: Suggestion[] } {
  const cleaned = rawText.trim();

  const normalized = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^"?json"?\s*/i, "")
    .trim();

  const jsonCandidate = (() => {
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return normalized.slice(start, end + 1);
    }
    return normalized;
  })();

  try {
    const parsed = JSON.parse(jsonCandidate) as { prediction?: string; suggestions?: string[] };
    const prediction = (parsed.prediction ?? "").trim();
    const suggestions = (parsed.suggestions ?? []).slice(0, 2).map((text, index) => ({
      type: index === 0 ? "clarity" : "tone",
      text: text.trim()
    })) as Suggestion[];

    if (prediction.length > 0) {
      return { prediction, suggestions };
    }
  } catch {
    // fall through to best-effort parser
  }

  const fallbackPrediction = normalized.split("\n")[0]?.slice(0, 240) || "";
  const fallbackSuggestions: Suggestion[] =
    mode === "playful"
      ? [
          { type: "style", text: "Try a more playful verb in your next sentence." },
          { type: "tone", text: "Lean into humor without losing clarity." }
        ]
      : [
          { type: "grammar", text: "Consider tightening sentence structure for readability." },
          { type: "clarity", text: "State the main point earlier in the paragraph." }
        ];

  return {
    prediction: fallbackPrediction,
    suggestions: fallbackSuggestions
  };
}

export function shouldSkipPrediction(previousText: string | null, nextText: string): boolean {
  if (!previousText) {
    return false;
  }

  const prev = previousText.trim();
  const next = nextText.trim();

  if (prev === next) {
    return true;
  }

  const sizeDiff = Math.abs(prev.length - next.length);
  return sizeDiff < 4;
}
