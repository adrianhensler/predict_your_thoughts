import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { initializeDb } from "./db/index.js";
import { adminRouter, healthRouter, historyRouter, predictRouter, statsRouter, trackRouter } from "./routes/index.js";

const app = express();

app.disable("x-powered-by");

app.use(helmet());
app.use(
  cors({
    origin: config.ALLOWED_ORIGINS.length > 0 ? config.ALLOWED_ORIGINS : true,
    credentials: true
  })
);
app.use(express.json({ limit: `${config.REQUEST_MAX_INPUT_CHARS + 1024}b` }));

app.use(
  "/api",
  rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: "Too many requests. Slow down and retry shortly."
    }
  })
);

app.use((req, res, next) => {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  res.on("finish", () => {
    const ms = Date.now() - started;
    console.log(`${new Date().toISOString()} ${requestId} ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

app.use("/api/health", healthRouter);
app.use("/api/history", historyRouter);
app.use("/api/predict", predictRouter);
app.use("/api/track", trackRouter);
app.use("/api/stats", statsRouter);
app.use("/api/admin", adminRouter);
app.use("/admin", adminRouter);

const staticDir = path.resolve(process.cwd(), "dist/client");
const servingStatic = fs.existsSync(staticDir);
if (servingStatic) {
  app.use(express.static(staticDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  console.error("Unhandled server error", message);
  res.status(500).json({ success: false, error: message });
});

async function bootstrap() {
  await initializeDb();
  app.listen(config.PORT, () => {
    console.log(`API listening on :${config.PORT}`);
    if (servingStatic) {
      console.log(`UI served on http://localhost:${config.PORT}/`);
    } else {
      console.log("No built UI detected; use npm run dev and open http://localhost:5173/");
    }
    console.log(`Default provider: ${config.DEFAULT_PROVIDER}`);
    console.log(`Daily budget cap: $${config.DAILY_BUDGET_USD}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
