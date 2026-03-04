import { Router } from "express";
import { z } from "zod";
import { recordEvent } from "../db/index.js";
import { config } from "../config.js";

const schema = z.object({
  provider: z.enum(["openrouter", "openai", "anthropic", "ollama"]).default(config.DEFAULT_PROVIDER),
  model: z.string().default(config.DEFAULT_MODEL),
  mode: z.enum(["professional", "playful"]).default("professional"),
  success: z.boolean().default(true),
  latency: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
  sessionId: z.string().optional()
});

export const trackRouter = Router();

trackRouter.post("/", async (req, res, next) => {
  try {
    const data = schema.parse(req.body ?? {});
    await recordEvent({
      eventType: "track",
      provider: data.provider,
      model: data.model,
      mode: data.mode,
      success: data.success,
      latency: data.latency,
      error: data.error,
      sessionId: data.sessionId
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});
