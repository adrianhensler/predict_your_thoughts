import { z } from "zod";
import type { Provider } from "../shared/types.js";

const providerEnum = z.enum(["openrouter", "openai", "anthropic", "ollama"]);

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  ALLOWED_ORIGINS: z.string().default(""),
  DATABASE_URL: z.string().default("sqlite://./data/predict_your_thoughts.db"),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),

  DEFAULT_PROVIDER: providerEnum.default("openrouter"),
  DEFAULT_MODEL: z.string().default("openai/gpt-4o-mini"),
  FALLBACK_PROVIDER: providerEnum.default("openrouter"),
  FALLBACK_MODEL: z.string().default("meta-llama/llama-3.1-8b-instruct"),
  MODEL_ALLOWLIST: z.string().default(""),
  ADMIN_PASSWORD: z.string().optional(),

  PLAYFUL_MODE_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),

  DAILY_BUDGET_USD: z.coerce.number().positive().default(3),
  WARNING_BUDGET_PERCENT: z.coerce.number().min(1).max(100).default(80),
  REQUEST_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(4000),
  REQUEST_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(400),
  MIN_TEXT_THRESHOLD: z.coerce.number().int().positive().default(20),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(600)
});

const parsed = schema.parse(process.env);

const allowedOrigins = parsed.ALLOWED_ORIGINS.split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const modelAllowlist = parsed.MODEL_ALLOWLIST.split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const providerAvailability: Record<Provider, boolean> = {
  openrouter: Boolean(parsed.OPENROUTER_API_KEY),
  openai: Boolean(parsed.OPENAI_API_KEY),
  anthropic: Boolean(parsed.ANTHROPIC_API_KEY),
  ollama: Boolean(parsed.OLLAMA_BASE_URL)
};

export const config = {
  ...parsed,
  ALLOWED_ORIGINS: allowedOrigins,
  MODEL_ALLOWLIST: modelAllowlist,
  providerAvailability
};

if (!Object.values(providerAvailability).some(Boolean)) {
  throw new Error("No providers configured. Add at least one API key or OLLAMA_BASE_URL.");
}

if (config.NODE_ENV === "production" && !config.ADMIN_PASSWORD) {
  throw new Error("ADMIN_PASSWORD is required in production for /admin/cost.");
}
