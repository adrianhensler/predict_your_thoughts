import { Router } from "express";
import { config } from "../config.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    success: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    providers: config.providerAvailability
  });
});
