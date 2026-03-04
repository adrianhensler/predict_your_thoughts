import { useEffect, useMemo, useRef, useState } from "react";
import { MODEL_PRESETS } from "@shared/modelPresets";
import type { HistoryItem, Mode, Provider, Suggestion } from "@shared/types";
import { getHistory, getStats, predictStream } from "./api";

const DEFAULT_TEXT = "Start writing your notes here...";

function getSessionId(): string {
  const existing = window.localStorage.getItem("pyt_session_id");
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  window.localStorage.setItem("pyt_session_id", created);
  return created;
}

export function App() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [provider, setProvider] = useState<Provider>("openrouter");
  const [mode, setMode] = useState<Mode>("professional");
  const [model, setModel] = useState("openai/gpt-4o-mini");
  const [prediction, setPrediction] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [estimatedCost, setEstimatedCost] = useState<number>(0);
  const [todaySpend, setTodaySpend] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fallbackUsed, setFallbackUsed] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const sessionIdRef = useRef(getSessionId());
  const streamAbortRef = useRef<AbortController | null>(null);

  const selectedPreset = useMemo(
    () => MODEL_PRESETS.find((preset) => preset.provider === provider && preset.model === model)?.label,
    [provider, model]
  );

  useEffect(() => {
    let active = true;

    const timer = setTimeout(async () => {
      if (text.trim().length < 20) {
        return;
      }

      setLoading(true);
      setStreaming(true);
      setError("");
      setFallbackUsed(false);
      streamAbortRef.current?.abort();
      streamAbortRef.current = new AbortController();

      try {
        await predictStream(
          {
          text,
          provider,
          model,
          mode,
          sessionId: sessionIdRef.current
          },
          {
            onDelta: (delta) => {
              if (!active) {
                return;
              }
              setPrediction((current) => current + delta);
            },
            onDone: (response) => {
              if (!active) {
                return;
              }
              setPrediction(response.prediction ?? "");
              setSuggestions(response.suggestions ?? []);
              setLatency(response.latency ?? null);
              setEstimatedCost(response.estimatedCost ?? 0);
              setFallbackUsed(Boolean(response.fallbackUsed));
              setStreaming(false);
              void getHistory(sessionIdRef.current, 8)
                .then((res) => setHistory(res.data))
                .catch(() => undefined);
            }
          },
          { signal: streamAbortRef.current.signal }
        );
      } catch (requestError) {
        if (!active) {
          return;
        }
        if (requestError instanceof Error && requestError.name === "AbortError") {
          return;
        }
        const message = requestError instanceof Error ? requestError.message : "Prediction failed";
        setError(message);
      } finally {
        if (active) {
          setLoading(false);
          setStreaming(false);
        }
      }
    }, 1200);

    return () => {
      active = false;
      clearTimeout(timer);
      streamAbortRef.current?.abort();
    };
  }, [text, provider, mode, model]);

  useEffect(() => {
    void getHistory(sessionIdRef.current, 8)
      .then((res) => setHistory(res.data))
      .catch(() => undefined);

    const timer = setInterval(async () => {
      try {
        const stats = await getStats();
        setTodaySpend(stats.data.todaySpend);
      } catch {
        // non-blocking in UI
      }
    }, 10000);

    return () => clearInterval(timer);
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Predict Your Thoughts</h1>
          <p>Type naturally. The assistant predicts what comes next and nudges your writing quality.</p>
        </div>
        <div className="meter-card">
          <span>Today spend</span>
          <strong>${todaySpend.toFixed(4)}</strong>
        </div>
      </header>

      <section className="controls">
        <label>
          Provider
          <select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
            <option value="openrouter">OpenRouter</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama</option>
          </select>
        </label>

        <label>
          Model preset
          <select
            value={selectedPreset ?? "custom"}
            onChange={(event) => {
              const preset = MODEL_PRESETS.find((item) => item.label === event.target.value);
              if (!preset) {
                return;
              }
              setProvider(preset.provider);
              setModel(preset.model);
            }}
          >
            <option value="custom">Custom</option>
            {MODEL_PRESETS.map((preset) => (
              <option key={preset.label} value={preset.label}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Model override
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>

        <label>
          Tone mode
          <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
            <option value="professional">Professional</option>
            <option value="playful">Playful</option>
          </select>
        </label>
      </section>

      <section className="workspace">
        <article className="panel">
          <h2>Editor</h2>
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={16} />
        </article>

        <article className="panel">
          <h2>Prediction</h2>
          {loading ? <p className="status">Thinking...</p> : null}
          {error ? <p className="status error">{error}</p> : null}
          {fallbackUsed ? <p className="status warn">Economy model fallback active</p> : null}
          <p className="prediction">{prediction || "No prediction yet."}{streaming ? <span className="caret">|</span> : null}</p>

          <h3>Suggestions</h3>
          <ul>
            {suggestions.length === 0 ? <li>No suggestions yet.</li> : null}
            {suggestions.map((suggestion) => (
              <li key={`${suggestion.type}-${suggestion.text}`}>{suggestion.text}</li>
            ))}
          </ul>

          <h3>Recent accepted predictions</h3>
          <ul className="history-list">
            {history.length === 0 ? <li>No saved history yet.</li> : null}
            {history.map((item) => (
              <li key={item.id}>
                <strong>{item.prediction}</strong>
                <span> ({new Date(item.createdAt).toLocaleTimeString()})</span>
              </li>
            ))}
          </ul>

          <div className="meta-row">
            <span>Latency: {latency ?? "-"} ms</span>
            <span>Est. request cost: ${estimatedCost.toFixed(6)}</span>
          </div>
        </article>
      </section>
    </main>
  );
}
