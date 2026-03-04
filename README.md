# Predict Your Thoughts

Predict Your Thoughts is a web notepad that generates a likely next sentence while you type, then gives concise writing suggestions.

The title is intentionally a light cultural nod to Orwell's *1984* (predictive thought / surveillance themes), while the app itself is built as a practical writing assistant.

This project is designed for small VPS hosting and includes built-in cost controls so API usage does not run away.

## What It Does

- Real-time streaming prediction with debounced calls (not every keystroke)
- Writing suggestions for grammar, tone, and clarity
- Keeps accepted predictions per session for quick review context
- Mode toggle: `professional` or `playful`
- Provider/model selection with presets + manual model override
- Usage tracking in SQLite (latency, token metadata, estimated cost)
- Daily budget cap enforcement
- Automatic cheap-model fallback near budget threshold or on provider failure
- Password-protected admin cost dashboard at `/admin/cost`

## Stack

- Frontend: React + Vite + TypeScript
- Backend: Express + TypeScript
- Database: SQLite
- Providers: OpenRouter (default), OpenAI, Anthropic, Ollama
- Deploy: Docker Compose

## Security and Cost Notes

- API keys stay server-side only; the frontend never receives them.
- `.env` is gitignored.
- Requests are protected with CORS, `helmet`, and rate limits.
- Cost controls include:
  - daily hard cap (`DAILY_BUDGET_USD`)
  - request size/token limits
  - minimum text threshold before prediction
  - unchanged-text skip logic

## Quick Start (Local)

1) Install dependencies

```bash
npm install
```

2) Create environment file

```bash
cp .env.example .env
```

3) Add at least one provider credential in `.env`

- `OPENROUTER_API_KEY` (recommended default)
- or `OPENAI_API_KEY`
- or `ANTHROPIC_API_KEY`
- or `OLLAMA_BASE_URL` for local Ollama

If Ollama runs on your host while app runs in a guest VM, set `OLLAMA_BASE_URL` to the host-reachable IP (for example Hyper-V gateway such as `http://172.18.144.1:11434`).

4) Run development mode

```bash
npm run dev
```

- API: `http://localhost:3000`
- UI: `http://localhost:5173`

## Production With Docker Compose

1) Configure `.env`

```bash
cp .env.example .env
```

2) Build and start

```bash
docker compose up -d --build
```

3) View logs

```bash
docker compose logs -f app
```

4) Stop

```bash
docker compose down
```

SQLite data is persisted via `./data` volume mount.

## Environment Variables

See `.env.example` for all options. Common ones:

- `DEFAULT_PROVIDER=openrouter`
- `DEFAULT_MODEL=openai/gpt-4o-mini`
- `FALLBACK_PROVIDER=openrouter`
- `FALLBACK_MODEL=meta-llama/llama-3.1-8b-instruct`
- `ADMIN_PASSWORD=<set-a-strong-password>`
- `DAILY_BUDGET_USD=3`
- `REQUEST_MAX_INPUT_CHARS=4000`
- `REQUEST_MAX_OUTPUT_TOKENS=400`
- `PROVIDER_TIMEOUT_MS=20000`
- `OLLAMA_TIMEOUT_MS=300000`
- `RATE_LIMIT_MAX_REQUESTS=600`

## API Endpoints

- `GET /api/health`
- `POST /api/predict`
- `POST /api/predict/stream`
- `GET /api/history?sessionId=<id>&limit=10`
- `POST /api/track`
- `GET /api/stats`
- `GET /api/admin/stats` (HTTP Basic auth)
- `GET /admin/cost` (HTTP Basic auth)

## Current Scope

This is an MVP focused on writing prediction quality, observability, and controlled API spend.

Future additions (optional): auth, collaborative docs, advanced analytics dashboards, image workflows.
