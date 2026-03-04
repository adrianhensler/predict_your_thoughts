export type Provider = "openrouter" | "openai" | "anthropic" | "ollama";
export type Mode = "professional" | "playful";

export interface PredictionRequest {
  text: string;
  provider?: Provider;
  model?: string;
  mode?: Mode;
  sessionId?: string;
}

export interface HistoryItem {
  id: number;
  sessionId: string;
  sourceText: string;
  prediction: string;
  suggestions: Suggestion[];
  provider: Provider;
  model: string;
  mode: Mode;
  estimatedCost?: number;
  createdAt: string;
}

export interface PredictionResponse {
  success: boolean;
  prediction?: string;
  suggestions?: Suggestion[];
  provider: Provider;
  model: string;
  latency: number;
  tokens?: {
    prompt?: number;
    completion?: number;
  };
  estimatedCost?: number;
  fallbackUsed?: boolean;
  error?: string;
}

export interface Suggestion {
  type: 'grammar' | 'tone' | 'clarity' | 'style';
  text: string;
}

export interface UsageEvent {
  id?: number;
  timestamp: string;
  eventType: "predict" | "track";
  provider: Provider;
  model: string;
  mode: Mode;
  success: boolean;
  latency: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCost?: number;
  error?: string;
}

export interface StatsResponse {
  success: boolean;
  data: {
    totalEvents: number;
    totalPredictions: number;
    successRate: number;
    avgLatency: number;
    todaySpend: number;
    spendByProvider: Record<string, number>;
    spendByModel: Record<string, number>;
    totalRequestsByProvider: Record<string, number>;
    budget: {
      dailyCapUsd: number;
      remainingUsd: number;
      hitCap: boolean;
    };
  };
}

export interface HistoryResponse {
  success: boolean;
  data: HistoryItem[];
}

export interface HealthResponse {
  success: boolean;
  uptime: number;
  timestamp: string;
  providers: {
    openrouter: boolean;
    openai: boolean;
    anthropic: boolean;
    ollama: boolean;
  };
}

export interface ModelPreset {
  label: string;
  provider: Provider;
  model: string;
  cheap?: boolean;
}
