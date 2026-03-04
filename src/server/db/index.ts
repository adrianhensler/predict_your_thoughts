import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import { config } from "../config.js";
import type { HistoryItem, Mode, Provider, Suggestion } from "../../shared/types.js";

type DbHandle = Database<sqlite3.Database, sqlite3.Statement>;
let db: DbHandle | null = null;

function isReadonlyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("SQLITE_READONLY") || error.message.includes("EACCES");
}

async function openAndMigrateDb(filename: string): Promise<DbHandle> {
  const handle = await open({
    filename,
    driver: sqlite3.Database
  });

  await handle.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      event_type TEXT NOT NULL CHECK(event_type IN ('predict', 'track')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('professional', 'playful')),
      success BOOLEAN NOT NULL,
      latency INTEGER NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      estimated_cost REAL,
      error TEXT,
      session_id TEXT,
      fallback_used BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_provider ON events(provider);
    CREATE INDEX IF NOT EXISTS idx_events_success ON events(success);
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);

    CREATE TABLE IF NOT EXISTS prediction_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      source_text TEXT NOT NULL,
      prediction TEXT NOT NULL,
      suggestions_json TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      estimated_cost REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_history_session_id ON prediction_history(session_id);
    CREATE INDEX IF NOT EXISTS idx_history_created_at ON prediction_history(created_at);
  `);

  try {
    await handle.exec("ALTER TABLE events ADD COLUMN fallback_used BOOLEAN DEFAULT 0;");
  } catch {
    // column already exists
  }

  await handle.exec(`
    CREATE TABLE IF NOT EXISTS _pyt_write_probe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await handle.run("INSERT INTO _pyt_write_probe DEFAULT VALUES;");
  await handle.run("DELETE FROM _pyt_write_probe WHERE id = (SELECT MAX(id) FROM _pyt_write_probe);");

  return handle;
}

export async function initializeDb() {
  const dbPath = config.DATABASE_URL.replace("sqlite://", "");
  const resolvedPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
  const fallbackPath = path.join(os.tmpdir(), "predict_your_thoughts.db");

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  try {
    db = await openAndMigrateDb(resolvedPath);
  } catch (error) {
    if (!isReadonlyError(error)) {
      throw error;
    }

    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    console.warn(`Primary SQLite path is read-only (${resolvedPath}). Falling back to ${fallbackPath}.`);
    db = await openAndMigrateDb(fallbackPath);
  }

  return db;
}

export async function getDb() {
  if (!db) {
    throw new Error("Database not initialized");
  }
  return db;
}

export async function recordEvent(event: {
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
  sessionId?: string;
  fallbackUsed?: boolean;
}) {
  const db = await getDb();

  await db.run(
    `INSERT INTO events (
      event_type, provider, model, mode, success, latency,
      prompt_tokens, completion_tokens, estimated_cost, error, session_id, fallback_used
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.eventType,
      event.provider,
      event.model,
      event.mode,
      event.success ? 1 : 0,
      event.latency,
      event.promptTokens || null,
      event.completionTokens || null,
      event.estimatedCost || null,
      event.error || null,
      event.sessionId || null,
      event.fallbackUsed ? 1 : 0
    ]
  );
}

export async function recordPredictionHistory(entry: {
  sessionId: string;
  sourceText: string;
  prediction: string;
  suggestions: Suggestion[];
  provider: Provider;
  model: string;
  mode: Mode;
  estimatedCost?: number;
}) {
  const db = await getDb();
  await db.run(
    `INSERT INTO prediction_history (
      session_id, source_text, prediction, suggestions_json, provider, model, mode, estimated_cost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.sessionId,
      entry.sourceText,
      entry.prediction,
      JSON.stringify(entry.suggestions),
      entry.provider,
      entry.model,
      entry.mode,
      entry.estimatedCost ?? null
    ]
  );
}

export async function getRecentPredictionHistory(sessionId: string, limit = 6): Promise<HistoryItem[]> {
  const db = await getDb();
  const rows = (await db.all(
    `SELECT id, session_id, source_text, prediction, suggestions_json, provider, model, mode, estimated_cost, created_at
     FROM prediction_history
     WHERE session_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [sessionId, limit]
  )) as Array<{
    id: number;
    session_id: string;
    source_text: string;
    prediction: string;
    suggestions_json: string;
    provider: Provider;
    model: string;
    mode: Mode;
    estimated_cost: number | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    sourceText: row.source_text,
    prediction: row.prediction,
    suggestions: JSON.parse(row.suggestions_json) as Suggestion[],
    provider: row.provider,
    model: row.model,
    mode: row.mode,
    estimatedCost: row.estimated_cost ?? undefined,
    createdAt: row.created_at
  }));
}

export async function getTodaySpend(): Promise<number> {
  const db = await getDb();

  const result = await db.get(
    `SELECT COALESCE(SUM(estimated_cost), 0) as total 
     FROM events 
     WHERE DATE(timestamp) = DATE('now') 
     AND event_type = 'predict'`
  );

  return result.total || 0;
}

export async function getStats() {
  const db = await getDb();

  const [
    totalEvents,
    totalPredictions,
    successRate,
    avgLatency,
    spendByProvider,
    spendByModel,
    totalRequestsByProvider,
    fallbackCount,
  ] = await Promise.all([
    db.get("SELECT COUNT(*) as count FROM events"),
    db.get(`SELECT COUNT(*) as count FROM events WHERE event_type = 'predict'`),
    db.get(`SELECT 
      CASE 
        WHEN COUNT(*) = 0 THEN 0 
        ELSE ROUND(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2)
      END as rate 
      FROM events WHERE event_type = 'predict'`),
    db.get(`SELECT ROUND(AVG(latency), 2) as avg FROM events WHERE event_type = 'predict' AND success = 1`),
    db.all(`SELECT provider, ROUND(SUM(estimated_cost), 4) as total 
            FROM events 
            WHERE DATE(timestamp) = DATE('now') 
            AND estimated_cost IS NOT NULL 
            GROUP BY provider`),
    db.all(`SELECT model, ROUND(SUM(estimated_cost), 4) as total 
            FROM events 
            WHERE DATE(timestamp) = DATE('now') 
            AND estimated_cost IS NOT NULL 
            GROUP BY model`),
    db.all(`SELECT provider, COUNT(*) as count 
            FROM events 
            WHERE event_type = 'predict' 
            GROUP BY provider`),
    db.get(`SELECT COUNT(*) as count FROM events WHERE event_type = 'predict' AND fallback_used = 1`)
  ]);
  
  const spendByProviderObj = Object.fromEntries(
    spendByProvider.map((row: { provider: string; total: number }) => [row.provider, row.total])
  );

  const spendByModelObj = Object.fromEntries(
    spendByModel.map((row: { model: string; total: number }) => [row.model, row.total])
  );

  const totalRequestsByProviderObj = Object.fromEntries(
    totalRequestsByProvider.map((row: { provider: string; count: number }) => [row.provider, row.count])
  );

  return {
    totalEvents: totalEvents.count,
    totalPredictions: totalPredictions.count,
    successRate: successRate.rate,
    avgLatency: avgLatency.avg || 0,
    spendByProvider: spendByProviderObj,
    spendByModel: spendByModelObj,
    totalRequestsByProvider: totalRequestsByProviderObj,
    fallbackCount: fallbackCount.count,
  };
}

export async function getAdminStats() {
  const db = await getDb();

  const [
    today,
    yesterday,
    sevenDay,
    allTime,
    hourlyVolume,
    modelRows,
    providerRows,
    fallbackRows,
    errors
  ] = await Promise.all([
    db.get(`SELECT COALESCE(SUM(estimated_cost), 0) as total FROM events WHERE event_type='predict' AND DATE(timestamp)=DATE('now')`),
    db.get(`SELECT COALESCE(SUM(estimated_cost), 0) as total FROM events WHERE event_type='predict' AND DATE(timestamp)=DATE('now', '-1 day')`),
    db.get(`SELECT COALESCE(SUM(estimated_cost), 0) as total FROM events WHERE event_type='predict' AND timestamp >= DATETIME('now', '-7 day')`),
    db.get(`SELECT COALESCE(SUM(estimated_cost), 0) as total FROM events WHERE event_type='predict'`),
    db.all(`SELECT STRFTIME('%Y-%m-%d %H:00:00', timestamp) as hour, COUNT(*) as count FROM events WHERE event_type='predict' AND timestamp >= DATETIME('now', '-24 hour') GROUP BY hour ORDER BY hour ASC`),
    db.all(`SELECT model, provider, COUNT(*) as calls, COALESCE(SUM(estimated_cost),0) as spend FROM events WHERE event_type='predict' GROUP BY model, provider ORDER BY spend DESC`),
    db.all(`SELECT provider, COUNT(*) as calls, COALESCE(SUM(estimated_cost),0) as spend FROM events WHERE event_type='predict' GROUP BY provider ORDER BY spend DESC`),
    db.get(`SELECT COUNT(*) as todayCount FROM events WHERE event_type='predict' AND fallback_used=1 AND DATE(timestamp)=DATE('now')`),
    db.get(`SELECT COUNT(*) as errorCount FROM events WHERE event_type='predict' AND success=0`)
  ]);

  return {
    spend: {
      today: Number(today.total || 0),
      yesterday: Number(yesterday.total || 0),
      sevenDay: Number(sevenDay.total || 0),
      allTime: Number(allTime.total || 0)
    },
    hourlyVolume,
    modelRows,
    providerRows,
    fallbackToday: fallbackRows.todayCount || 0,
    errorCount: errors.errorCount || 0
  };
}
