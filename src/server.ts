/**
 * 服务入口：把 REST（给 GPT Actions）和 MCP（给 ChatGPT 连接器）挂在同一个进程上。
 *
 * 只监听 127.0.0.1，公网 TLS 由 nginx 终结（见 deploy/nginx.conf）。
 * 直接把这个端口暴露到公网等于把一台电脑的完整控制权挂在裸 HTTP 上，绝对不要这么干。
 */
import { serve, type HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Hono } from "hono";
import { config } from "./config.js";
import { log } from "./logger.js";
import { handleMcpRequest } from "./mcp/server.js";
import { api } from "./routes/api.js";
import { health } from "./routes/health.js";
import { bearerAuth, requestContext } from "./routes/middleware.js";
import { closeConnection } from "./ssh/connection.js";

const app = new Hono<{ Bindings: HttpBindings }>();

app.use("*", requestContext);

app.route("/", health);
app.route("/api", api);

// MCP 端点：Streamable HTTP 需要直接操作原始 Node 流（SSE 长连接），
// 所以绕开 Hono 的 Response 封装，交回 @hono/node-server 的 already-sent 约定。
app.all("/mcp", bearerAuth, async (c) => {
  const { incoming, outgoing } = c.env;
  let body: unknown;
  if (c.req.method === "POST") {
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "请求体不是合法 JSON" }, id: null }, 400);
    }
  }
  await handleMcpRequest(incoming, outgoing, body);
  return RESPONSE_ALREADY_SENT;
});

app.get("/", (c) =>
  c.json({
    service: "chatgpt-on-mac",
    description: "ChatGPT → HTTPS → SSH → MacBook",
    endpoints: {
      rest: ["POST /api/exec_command", "POST /api/read_file", "POST /api/write_file"],
      mcp: "ALL /mcp",
      health: ["GET /health", "GET /health/ssh"],
    },
  }),
);

app.notFound((c) => c.json({ error: "not_found", message: `无此端点: ${c.req.method} ${c.req.path}` }, 404));

app.onError((err, c) => {
  log.error("未捕获的请求异常", { requestId: c.get("requestId"), path: c.req.path, error: err.message, stack: err.stack });
  return c.json({ error: "internal_error", message: err.message, requestId: c.get("requestId") }, 500);
});

const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
  log.info("服务已启动", {
    address: `http://${config.HOST}:${info.port}`,
    sshTarget: `${config.SSH_USER}@${config.SSH_HOST}:${config.SSH_PORT}`,
    maxConcurrency: config.MAX_CONCURRENCY,
    hostKeyVerification: config.SSH_HOST_FINGERPRINT ? "enabled" : "DISABLED（建议配置 SSH_HOST_FINGERPRINT）",
  });
});

// 进程级兜底：任何漏网的异常都要落盘，不能静默死掉
process.on("uncaughtException", (err) => log.error("uncaughtException", { error: err.message, stack: err.stack }));
process.on("unhandledRejection", (reason) => log.error("unhandledRejection", { reason: String(reason) }));

function shutdown(signal: string) {
  log.info("收到退出信号，正在关闭", { signal });
  closeConnection();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
