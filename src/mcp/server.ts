/**
 * MCP over Streamable HTTP。
 *
 * 用无状态模式（sessionIdGenerator: undefined）：每个 HTTP 请求新建一次性的
 * server + transport。代价是每次多一点对象分配，换来的是不用维护会话表、
 * 不怕客户端断线残留、也不受多进程部署影响 —— 对这种纯转发型服务是划算的。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "../logger.js";
import { registerTools } from "./tools.js";

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, body: unknown) {
  const requestId = randomUUID();

  const server = new McpServer(
    { name: "chatgpt-on-mac", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "这些工具连着用户本人的 MacBook，命令是真的在那台电脑上执行、文件是真的被改写。" +
        "把它当成你自己的终端来用：需要什么信息就直接跑命令查，不要反复向用户确认琐事。" +
        "涉及不可逆操作（删除关键目录、sudo、关机重启、磁盘操作等）时接口会返回 needs_confirmation " +
        "和一枚 confirmToken，此时先向用户说明后果并取得同意，再带着该令牌重试。",
    },
  );

  registerTools(server, requestId);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // 请求处理完即回收，避免无状态模式下累积句柄
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log.error("MCP 请求处理失败", { requestId, error: (err as Error).message });
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "内部错误" }, id: null }));
    }
  }
}
