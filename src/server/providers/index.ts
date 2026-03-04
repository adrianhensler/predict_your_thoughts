import { config } from "../config.js";
import type { Mode, Provider } from "../../shared/types.js";

export interface ProviderResult {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ProviderStreamHandlers {
  onDelta: (text: string) => void;
  onDone: (payload: ProviderResult) => void;
}

interface PredictInput {
  provider: Provider;
  model: string;
  text: string;
  mode: Mode;
  maxTokens: number;
  context?: string;
}

const TIMEOUT_MS = config.PROVIDER_TIMEOUT_MS;
const OLLAMA_TIMEOUT_MS = config.OLLAMA_TIMEOUT_MS;

function buildSystemPrompt(mode: Mode): string {
  if (mode === "playful") {
    return "You are a playful writing assistant. Predict the likely next sentence and then provide 2 brief suggestions on style/clarity. Keep responses concise.";
  }
  return "You are a professional writing assistant. Predict the likely next sentence and then provide 2 brief suggestions focused on clarity, grammar, and focus. Keep responses concise.";
}

function parseModelOutput(text: string): string {
  return text.trim().replace(/^"|"$/g, "");
}

function buildUserPrompt(input: PredictInput): string {
  const contextSection = input.context
    ? `\n\nRecent accepted predictions and notes:\n${input.context}\n`
    : "";
  return `Text so far:\n${input.text}${contextSection}\nReturn strictly as JSON with keys: prediction (string), suggestions (array of up to 2 strings).`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Provider timeout")), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function extractSseData(rawChunk: string): string[] {
  return rawChunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

async function readSseStream(
  response: Response,
  parseData: (data: string) => { delta?: string; done?: boolean; promptTokens?: number; completionTokens?: number },
  handlers: ProviderStreamHandlers
): Promise<void> {
  if (!response.body) {
    throw new Error("Provider returned empty stream body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let fullText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    accumulated += decoder.decode(value, { stream: true });
    const parts = accumulated.split("\n\n");
    accumulated = parts.pop() ?? "";

    for (const part of parts) {
      const events = extractSseData(part);
      for (const event of events) {
        const parsed = parseData(event);
        if (typeof parsed.promptTokens === "number") {
          promptTokens = parsed.promptTokens;
        }
        if (typeof parsed.completionTokens === "number") {
          completionTokens = parsed.completionTokens;
        }
        if (parsed.delta) {
          fullText += parsed.delta;
          handlers.onDelta(parsed.delta);
        }
        if (parsed.done) {
          handlers.onDone({
            text: parseModelOutput(fullText),
            promptTokens,
            completionTokens
          });
          return;
        }
      }
    }
  }

  handlers.onDone({
    text: parseModelOutput(fullText),
    promptTokens,
    completionTokens
  });
}

async function predictOpenRouter(input: PredictInput): Promise<ProviderResult> {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("OpenRouter key missing");
  }

  const response = await withTimeout(
    fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        messages: [
          { role: "system", content: buildSystemPrompt(input.mode) },
          {
            role: "user",
            content: buildUserPrompt(input)
          }
        ]
      })
    }),
    TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${body.slice(0, 300)}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: parseModelOutput(body.choices?.[0]?.message?.content ?? ""),
    promptTokens: body.usage?.prompt_tokens,
    completionTokens: body.usage?.completion_tokens
  };
}

async function streamOpenRouter(input: PredictInput, handlers: ProviderStreamHandlers): Promise<void> {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("OpenRouter key missing");
  }

  const response = await withTimeout(
    fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: buildSystemPrompt(input.mode) },
          {
            role: "user",
            content: buildUserPrompt(input)
          }
        ]
      })
    }),
    TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter stream error ${response.status}: ${body.slice(0, 300)}`);
  }

  await readSseStream(
    response,
    (data) => {
      if (data === "[DONE]") {
        return { done: true };
      }
      const payload = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        delta: payload.choices?.[0]?.delta?.content,
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens
      };
    },
    handlers
  );
}

async function predictOpenAI(input: PredictInput): Promise<ProviderResult> {
  if (!config.OPENAI_API_KEY) {
    throw new Error("OpenAI key missing");
  }

  const response = await withTimeout(
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        messages: [
          { role: "system", content: buildSystemPrompt(input.mode) },
          {
            role: "user",
            content: buildUserPrompt(input)
          }
        ]
      })
    }),
    OLLAMA_TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${body.slice(0, 300)}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: parseModelOutput(body.choices?.[0]?.message?.content ?? ""),
    promptTokens: body.usage?.prompt_tokens,
    completionTokens: body.usage?.completion_tokens
  };
}

async function streamOpenAI(input: PredictInput, handlers: ProviderStreamHandlers): Promise<void> {
  if (!config.OPENAI_API_KEY) {
    throw new Error("OpenAI key missing");
  }

  const response = await withTimeout(
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: buildSystemPrompt(input.mode) },
          {
            role: "user",
            content: buildUserPrompt(input)
          }
        ]
      })
    }),
    OLLAMA_TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI stream error ${response.status}: ${body.slice(0, 300)}`);
  }

  await readSseStream(
    response,
    (data) => {
      if (data === "[DONE]") {
        return { done: true };
      }
      const payload = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        delta: payload.choices?.[0]?.delta?.content,
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens
      };
    },
    handlers
  );
}

async function predictAnthropic(input: PredictInput): Promise<ProviderResult> {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("Anthropic key missing");
  }

  const response = await withTimeout(
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        system: buildSystemPrompt(input.mode),
        messages: [
          {
            role: "user",
            content: buildUserPrompt(input)
          }
        ]
      })
    }),
    TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic error ${response.status}: ${body.slice(0, 300)}`);
  }

  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = body.content?.find((item) => item.type === "text")?.text;
  return {
    text: parseModelOutput(text ?? ""),
    promptTokens: body.usage?.input_tokens,
    completionTokens: body.usage?.output_tokens
  };
}

async function streamAnthropic(input: PredictInput, handlers: ProviderStreamHandlers): Promise<void> {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("Anthropic key missing");
  }

  const response = await withTimeout(
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        stream: true,
        system: buildSystemPrompt(input.mode),
        messages: [
          {
            role: "user",
            content: buildUserPrompt(input)
          }
        ]
      })
    }),
    TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic stream error ${response.status}: ${body.slice(0, 300)}`);
  }

  await readSseStream(
    response,
    (data) => {
      const payload = JSON.parse(data) as {
        type?: string;
        delta?: { text?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      };
      if (payload.type === "message_stop") {
        return {
          done: true,
          promptTokens: payload.message?.usage?.input_tokens,
          completionTokens: payload.message?.usage?.output_tokens
        };
      }
      return {
        delta: payload.delta?.text,
        promptTokens: payload.message?.usage?.input_tokens,
        completionTokens: payload.message?.usage?.output_tokens
      };
    },
    handlers
  );
}

async function predictOllama(input: PredictInput): Promise<ProviderResult> {
  const response = await withTimeout(
    fetch(`${config.OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        stream: false,
        prompt: `${buildSystemPrompt(input.mode)}\n\n${buildUserPrompt(input)}`,
        options: {
          num_predict: input.maxTokens
        }
      })
    }),
    OLLAMA_TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama error ${response.status}: ${body.slice(0, 300)}`);
  }

  const body = (await response.json()) as { response?: string; prompt_eval_count?: number; eval_count?: number };
  return {
    text: parseModelOutput(body.response ?? ""),
    promptTokens: body.prompt_eval_count,
    completionTokens: body.eval_count
  };
}

async function streamOllama(input: PredictInput, handlers: ProviderStreamHandlers): Promise<void> {
  const response = await withTimeout(
    fetch(`${config.OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        stream: true,
        prompt: `${buildSystemPrompt(input.mode)}\n\n${buildUserPrompt(input)}`,
        options: {
          num_predict: input.maxTokens
        }
      })
    }),
    OLLAMA_TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama stream error ${response.status}: ${body.slice(0, 300)}`);
  }
  if (!response.body) {
    throw new Error("Ollama stream had no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const payload = JSON.parse(line) as {
        response?: string;
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
      };

      if (payload.response) {
        fullText += payload.response;
        handlers.onDelta(payload.response);
      }

      if (payload.done) {
        promptTokens = payload.prompt_eval_count;
        completionTokens = payload.eval_count;
        handlers.onDone({
          text: parseModelOutput(fullText),
          promptTokens,
          completionTokens
        });
        return;
      }
    }
  }

  handlers.onDone({
    text: parseModelOutput(fullText),
    promptTokens,
    completionTokens
  });
}

export async function predictWithProvider(input: PredictInput): Promise<ProviderResult> {
  switch (input.provider) {
    case "openrouter":
      return predictOpenRouter(input);
    case "openai":
      return predictOpenAI(input);
    case "anthropic":
      return predictAnthropic(input);
    case "ollama":
      return predictOllama(input);
    default:
      throw new Error(`Unsupported provider: ${input.provider}`);
  }
}

export async function streamWithProvider(input: PredictInput, handlers: ProviderStreamHandlers): Promise<void> {
  switch (input.provider) {
    case "openrouter":
      return streamOpenRouter(input, handlers);
    case "openai":
      return streamOpenAI(input, handlers);
    case "anthropic":
      return streamAnthropic(input, handlers);
    case "ollama":
      return streamOllama(input, handlers);
    default:
      throw new Error(`Unsupported provider: ${input.provider}`);
  }
}
