import { Router } from "express";
import { z } from "zod";
import { getRecentPredictionHistory } from "../db/index.js";

const querySchema = z.object({
  sessionId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

export const historyRouter = Router();

historyRouter.get("/", async (req, res, next) => {
  try {
    const parsed = querySchema.parse(req.query);
    const data = await getRecentPredictionHistory(parsed.sessionId, parsed.limit);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});
