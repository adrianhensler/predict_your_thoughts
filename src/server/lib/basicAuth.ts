import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

function unauthorized(res: Response): void {
  res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
  res.status(401).send("Authentication required");
}

export function adminBasicAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.ADMIN_PASSWORD) {
    unauthorized(res);
    return;
  }

  const authorization = req.headers.authorization;
  if (!authorization || !authorization.startsWith("Basic ")) {
    unauthorized(res);
    return;
  }

  const encoded = authorization.replace("Basic ", "").trim();
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    unauthorized(res);
    return;
  }

  const password = decoded.slice(separatorIndex + 1);
  if (password !== config.ADMIN_PASSWORD) {
    unauthorized(res);
    return;
  }

  next();
}
