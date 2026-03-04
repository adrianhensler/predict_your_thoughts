import type { ModelPreset } from "./types";

export const MODEL_PRESETS: ModelPreset[] = [
  {
    label: "Balanced (OpenRouter)",
    provider: "openrouter",
    model: "openai/gpt-4o-mini"
  },
  {
    label: "Cheaper (OpenRouter)",
    provider: "openrouter",
    model: "meta-llama/llama-3.1-8b-instruct",
    cheap: true
  },
  {
    label: "OpenAI Mini",
    provider: "openai",
    model: "gpt-4o-mini"
  },
  {
    label: "Anthropic Sonnet",
    provider: "anthropic",
    model: "claude-3-5-sonnet-latest"
  },
  {
    label: "Local Ollama",
    provider: "ollama",
    model: "llama3.1:8b"
  },
  {
    label: "Local Qwen 3.5",
    provider: "ollama",
    model: "qwen3.5:latest",
    cheap: true
  }
];
