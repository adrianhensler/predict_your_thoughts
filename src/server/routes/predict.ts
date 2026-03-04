import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { getRecentPredictionHistory, getTodaySpend, recordEvent, recordPredictionHistory } from "../db/index.js";
import { predictWithProvider, streamWithProvider, type ProviderResult } from "../providers/index.js";
import { estimateCostUsd, parsePredictionPayload, shouldSkipPrediction } from "../services/prediction.js";
import type { Mode, Provider } from "../../shared/types.js";

const schema = z.object({
  text: z.string().min(1).max(config.REQUEST_MAX_INPUT_CHARS),
  provider: z.enum(["openrouter", "openai", "anthropic", "ollama"]).optional(),
  model: z.string().optional(),
  mode: z.enum(["professional", "playful"]).optional(),
  sessionId: z.string().optional()
});

const lastTextBySession = new Map<string, string>();

interface PredictContext {
  provider: Provider;
  model: string;
  mode: Mode;
  fallbackUsed: boolean;
}

function pickProvider(candidate?: Provider): Provider {
  const desired = candidate ?? config.DEFAULT_PROVIDER;
  if (config.providerAvailability[desired]) {
    return desired;
  }
  const firstAvailable = (Object.entries(config.providerAvailability).find(([, available]) => available)?.[0] ?? "ollama") as Provider;
  return firstAvailable;
}

function pickMode(candidate?: Mode): Mode {
  if (candidate === "playful" && !config.PLAYFUL_MODE_ENABLED) {
    return "professional";
  }
  return candidate ?? "professional";
}

function enforceModelAllowlist(model: string): boolean {
  if (config.MODEL_ALLOWLIST.length === 0) {
    return true;
  }
  return config.MODEL_ALLOWLIST.includes(model);
}

function getResolvedContext(body: z.infer<typeof schema>, todaySpend: number): PredictContext {
  const budgetWarningThreshold = config.DAILY_BUDGET_USD * (config.WARNING_BUDGET_PERCENT / 100);
  const budgetWarning = todaySpend >= budgetWarningThreshold;

  if (budgetWarning) {
    return {
      provider: config.FALLBACK_PROVIDER,
      model: config.FALLBACK_MODEL,
      mode: pickMode(body.mode),
      fallbackUsed: true
    };
  }

  return {
    provider: pickProvider(body.provider),
    model: body.model ?? config.DEFAULT_MODEL,
    mode: pickMode(body.mode),
    fallbackUsed: false
  };
}

async function predictWithFallback(
  context: PredictContext,
  text: string,
  maxTokens: number,
  promptContext?: string
): Promise<{ result: ProviderResult; context: PredictContext }> {
  try {
    const result = await predictWithProvider({
      provider: context.provider,
      model: context.model,
      text,
      mode: context.mode,
      maxTokens,
      context: promptContext
    });
    return { result, context };
  } catch (error) {
    if (context.fallbackUsed || context.provider === "ollama") {
      throw error;
    }
    const reason = error instanceof Error ? error.message : "unknown";
    console.warn(`Primary provider failed, switching to fallback: ${reason}`);
    const fallbackContext: PredictContext = {
      provider: config.FALLBACK_PROVIDER,
      model: config.FALLBACK_MODEL,
      mode: context.mode,
      fallbackUsed: true
    };
    const result = await predictWithProvider({
      provider: fallbackContext.provider,
      model: fallbackContext.model,
      text,
      mode: fallbackContext.mode,
      maxTokens,
      context: promptContext
    });
    return { result, context: fallbackContext };
  }
}

async function validateRequest(body: z.infer<typeof schema>, sessionId: string): Promise<{ context: PredictContext; text: string }> {
  const text = body.text.trim();
  if (text.length < config.MIN_TEXT_THRESHOLD) {
    throw new Error(`Enter at least ${config.MIN_TEXT_THRESHOLD} characters before prediction.`);
  }

  const todaySpend = await getTodaySpend();
  if (todaySpend >= config.DAILY_BUDGET_USD) {
    throw new Error("Daily budget cap reached. Try again tomorrow or raise DAILY_BUDGET_USD.");
  }

  const context = getResolvedContext(body, todaySpend);
  if (!enforceModelAllowlist(context.model)) {
    throw new Error("Model not allowed by MODEL_ALLOWLIST policy.");
  }

  const previous = lastTextBySession.get(sessionId) ?? null;
  if (shouldSkipPrediction(previous, text)) {
    throw new Error("SKIP_PREDICTION");
  }

  return { context, text };
}

export const predictRouter = Router();

function buildPromptContext(history: Array<{ prediction: string; suggestions: { text: string }[] }>): string | undefined {
  if (history.length === 0) {
    return undefined;
  }

  return history
    .map((item, index) => {
      const suggestions = item.suggestions.slice(0, 2).map((s) => s.text).join(" | ");
      return `#${index + 1} prediction: ${item.prediction}\n#${index + 1} suggestions: ${suggestions}`;
    })
    .join("\n");
}

predictRouter.post("/", async (req, res, next) => {
  const started = Date.now();
  try {
    const body = schema.parse(req.body ?? {});
    const sessionId = body.sessionId ?? "anonymous";

    const { context, text } = await validateRequest(body, sessionId);
    const recent = await getRecentPredictionHistory(sessionId, 3);
    const promptContext = buildPromptContext(recent);
    const { result, context: usedContext } = await predictWithFallback(context, text, config.REQUEST_MAX_OUTPUT_TOKENS, promptContext);

    lastTextBySession.set(sessionId, text);

    const parsed = parsePredictionPayload(result.text, usedContext.mode);
    const estimatedCost = estimateCostUsd(usedContext.provider, result.promptTokens, result.completionTokens);
    const latency = Date.now() - started;

    await recordEvent({
      eventType: "predict",
      provider: usedContext.provider,
      model: usedContext.model,
      mode: usedContext.mode,
      success: true,
      latency,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      estimatedCost,
      sessionId,
      fallbackUsed: usedContext.fallbackUsed
    });

    await recordPredictionHistory({
      sessionId,
      sourceText: text,
      prediction: parsed.prediction,
      suggestions: parsed.suggestions,
      provider: usedContext.provider,
      model: usedContext.model,
      mode: usedContext.mode,
      estimatedCost
    });

    return res.json({
      success: true,
      provider: usedContext.provider,
      model: usedContext.model,
      mode: usedContext.mode,
      latency,
      prediction: parsed.prediction,
      suggestions: parsed.suggestions,
      tokens: {
        prompt: result.promptTokens,
        completion: result.completionTokens
      },
      estimatedCost,
      fallbackUsed: usedContext.fallbackUsed
    });
  } catch (error) {
    if (error instanceof Error && error.message === "SKIP_PREDICTION") {
      return res.json({ success: true, skipped: true, prediction: "", suggestions: [] });
    }

    const latency = Date.now() - started;
    const safeError = error instanceof Error ? error.message : "Prediction failed";
    const body = req.body as { provider?: Provider; model?: string; mode?: Mode; sessionId?: string };
    const provider = pickProvider(body?.provider);
    const model = body?.model ?? config.DEFAULT_MODEL;
    const mode = pickMode(body?.mode);

    try {
      await recordEvent({
        eventType: "predict",
        provider,
        model,
        mode,
        success: false,
        latency,
        error: safeError.slice(0, 300),
        sessionId: body?.sessionId
      });
    } catch (recordError) {
      console.error("Failed to persist failed prediction event", recordError);
    }

    if (safeError.includes("budget cap") || safeError.includes("at least") || safeError.includes("allowlist")) {
      return res.status(422).json({ success: false, error: safeError });
    }
    return next(error);
  }
});

predictRouter.post("/stream", async (req, res, next) => {
  const started = Date.now();
  try {
    const body = schema.parse(req.body ?? {});
    const sessionId = body.sessionId ?? "anonymous";
    const { context, text } = await validateRequest(body, sessionId);
    const recent = await getRecentPredictionHistory(sessionId, 3);
    const promptContext = buildPromptContext(recent);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullText = "";
    let resultTokens: { prompt?: number; completion?: number } = {};
    let usedContext = context;

    const sendEvent = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const runStream = async (candidate: PredictContext) => {
      await streamWithProvider(
        {
          provider: candidate.provider,
          model: candidate.model,
          text,
          mode: candidate.mode,
          maxTokens: config.REQUEST_MAX_OUTPUT_TOKENS,
          context: promptContext
        },
        {
          onDelta: (delta) => {
            fullText += delta;
            sendEvent({ type: "delta", text: delta });
          },
          onDone: (finalResult) => {
            resultTokens = {
              prompt: finalResult.promptTokens,
              completion: finalResult.completionTokens
            };
          }
        }
      );
    };

    try {
      await runStream(context);
    } catch (primaryError) {
      if (context.fallbackUsed || context.provider === "ollama") {
        throw primaryError;
      }
      usedContext = {
        provider: config.FALLBACK_PROVIDER,
        model: config.FALLBACK_MODEL,
        mode: context.mode,
        fallbackUsed: true
      };
      fullText = "";
      await runStream(usedContext);
    }

    lastTextBySession.set(sessionId, text);

    const parsed = parsePredictionPayload(fullText, usedContext.mode);
    const latency = Date.now() - started;
    const estimatedCost = estimateCostUsd(usedContext.provider, resultTokens.prompt, resultTokens.completion);

    await recordEvent({
      eventType: "predict",
      provider: usedContext.provider,
      model: usedContext.model,
      mode: usedContext.mode,
      success: true,
      latency,
      promptTokens: resultTokens.prompt,
      completionTokens: resultTokens.completion,
      estimatedCost,
      sessionId,
      fallbackUsed: usedContext.fallbackUsed
    });

    await recordPredictionHistory({
      sessionId,
      sourceText: text,
      prediction: parsed.prediction,
      suggestions: parsed.suggestions,
      provider: usedContext.provider,
      model: usedContext.model,
      mode: usedContext.mode,
      estimatedCost
    });

    sendEvent({
      type: "done",
      provider: usedContext.provider,
      model: usedContext.model,
      latency,
      prediction: parsed.prediction,
      suggestions: parsed.suggestions,
      tokens: resultTokens,
      estimatedCost,
      fallbackUsed: usedContext.fallbackUsed
    });
    res.end();
  } catch (error) {
    const latency = Date.now() - started;
    const message = error instanceof Error ? error.message : "Streaming failed";

    if (message === "SKIP_PREDICTION") {
      return res.json({ success: true, skipped: true, prediction: "", suggestions: [] });
    }

    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      res.end();
      return;
    }

    const body = req.body as { provider?: Provider; model?: string; mode?: Mode; sessionId?: string };
    try {
      await recordEvent({
        eventType: "predict",
        provider: pickProvider(body?.provider),
        model: body?.model ?? config.DEFAULT_MODEL,
        mode: pickMode(body?.mode),
        success: false,
        latency,
        error: message.slice(0, 300),
        sessionId: body?.sessionId
      });
    } catch (recordError) {
      console.error("Failed to persist failed stream event", recordError);
    }

    if (message.includes("budget cap") || message.includes("at least") || message.includes("allowlist")) {
      return res.status(422).json({ success: false, error: message });
    }
    return next(error);
  }
});
