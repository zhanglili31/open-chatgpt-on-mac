/**
 * 健康检查。
 * /health   —— 不需要认证，只回服务自身是否活着，不暴露任何内部信息（供 nginx / 监控探活）
 * /health/ssh —— 需要认证，真的到 MacBook 上跑一条命令，确认整条链路通
 * /openapi.yaml —— 不需要认证，供 ChatGPT 的「Import from URL」抓取。
 *   这里只暴露接口形状，不含任何凭证；真正的门禁在 /api/* 的 Bearer 校验上。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { concurrency } from "../ssh/client.js";
import { ping } from "../ssh/connection.js";
import { bearerAuth } from "./middleware.js";

export const health = new Hono();

// 启动时读一次并缓存：这份 schema 只随发版变化，没必要每次请求都读盘
const SPEC_PATH = join(process.cwd(), "openapi.yaml");
const SPEC = existsSync(SPEC_PATH) ? readFileSync(SPEC_PATH, "utf8") : null;

health.get("/openapi.yaml", (c) => {
  if (!SPEC) return c.json({ error: "not_found", message: `openapi.yaml 不在 ${SPEC_PATH}` }, 404);
  return c.body(SPEC, 200, { "content-type": "application/yaml; charset=utf-8" });
});

health.get("/health", (c) => c.json({ status: "ok", service: "chatgpt-on-mac", time: new Date().toISOString() }));

health.get("/health/ssh", bearerAuth, async (c) => {
  const started = Date.now();
  const result = await ping();
  return c.json(
    {
      status: result.ok ? "ok" : "unreachable",
      detail: result.detail,
      latencyMs: Date.now() - started,
      concurrency: concurrency(),
    },
    result.ok ? 200 : 503,
  );
});
