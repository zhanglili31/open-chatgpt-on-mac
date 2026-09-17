/**
 * 通用中间件：请求 ID、访问日志、Bearer 认证。
 */
import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { log } from "../logger.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export const requestContext: MiddlewareHandler = async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);

  const started = Date.now();
  await next();

  log.info("http", {
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - started,
    ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "-",
    ua: c.req.header("user-agent") ?? "-",
  });
};

/** 定长比较，避免通过响应耗时逐字节猜 token */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();

  if (!token || !safeEqual(token, config.API_TOKEN)) {
    log.warn("认证失败", {
      requestId: c.get("requestId"),
      path: c.req.path,
      ip: c.req.header("x-forwarded-for") ?? "-",
      hasHeader: Boolean(header),
    });
    return c.json({ error: "unauthorized", message: "缺少或错误的 Bearer token" }, 401);
  }
  await next();
};

export function fail(c: Context, status: 400 | 401 | 404 | 500 | 503, error: string, message: string) {
  return c.json({ error, message, requestId: c.get("requestId") }, status);
}
