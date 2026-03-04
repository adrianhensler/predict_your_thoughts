import { Router } from "express";
import { getStats, getTodaySpend } from "../db/index.js";
import { config } from "../config.js";

export const statsRouter = Router();

statsRouter.get("/", async (_req, res, next) => {
  try {
    const [stats, todaySpend] = await Promise.all([getStats(), getTodaySpend()]);
    const remainingUsd = Math.max(0, Number((config.DAILY_BUDGET_USD - todaySpend).toFixed(4)));

    res.json({
      success: true,
      data: {
        ...stats,
        todaySpend,
        budget: {
          dailyCapUsd: config.DAILY_BUDGET_USD,
          remainingUsd,
          hitCap: todaySpend >= config.DAILY_BUDGET_USD
        }
      }
    });
  } catch (error) {
    next(error);
  }
});
