/**
 * MCP 工具定义。
 * 逻辑全部复用 src/tools/ 下的实现，这里只负责 schema 声明和结果格式化，
 * 保证 MCP 与 REST 两条入口的行为、限制、审计完全一致。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { runExec } from "../tools/exec.js";
import { runReadFile, runWriteFile } from "../tools/files.js";

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (payload: unknown): TextResult => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
const err = (message: string): TextResult => ({ content: [{ type: "text", text: message }], isError: true });

export function registerTools(server: McpServer, requestId: string) {
  server.registerTool(
    "exec_command",
    {
      title: "在 MacBook 上执行命令",
      description:
        "通过 SSH 在用户的 MacBook 上执行任意 shell 命令，等价于用户自己在终端里敲命令。" +
        "可以跑 git、npm、pnpm、python、node、java、docker、make、测试、编译、启动服务、查看日志、" +
        "以及 ls/cat/grep/find/mkdir/mv/rm 等一切文件操作。支持多行脚本、管道、重定向和 heredoc。" +
        "命令返回非 0 退出码属于正常结果（例如测试失败），不是接口错误。" +
        "长时间运行的服务请用 nohup 或 & 放到后台，否则会被超时中断。",
      inputSchema: {
        command: z.string().min(1).describe("要执行的 shell 命令，支持多行脚本"),
        cwd: z.string().optional().describe("工作目录，支持 ~ 展开，例如 ~/projects/myapp。默认用户主目录"),
        timeoutMs: z.number().int().positive().optional().describe(`超时毫秒数，默认 ${config.DEFAULT_TIMEOUT_MS}，上限 ${config.MAX_TIMEOUT_MS}`),
        env: z.record(z.string()).optional().describe("追加的环境变量"),
        stdin: z.string().optional().describe("喂给命令的标准输入"),
        confirmToken: z.string().optional().describe("危险命令被拦截时返回的确认令牌，原样带回即可放行"),
      },
    },
    async (args) => {
      try {
        const outcome = await runExec(args, { requestId, via: "mcp" });
        return ok(outcome);
      } catch (e) {
        return err(`执行失败：${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "读取 MacBook 上的文件",
      description:
        "以二进制安全的方式读取文件内容（走 SFTP，不经过 shell）。" +
        "读源码、配置、日志用默认的 utf8；读图片等二进制文件用 base64。" +
        "只想看文件的某几行时，用 exec_command 配合 sed -n 或 grep 更省。",
      inputSchema: {
        path: z.string().min(1).describe("文件路径，支持 ~ 展开"),
        encoding: z.enum(["utf8", "base64"]).optional().describe("默认 utf8"),
      },
    },
    async (args) => {
      try {
        return ok(await runReadFile(args, { requestId, via: "mcp" }));
      } catch (e) {
        return err(`读取失败：${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "写入 MacBook 上的文件",
      description:
        "以二进制安全的方式写文件（走 SFTP，不经过 shell），内容里的反引号、$、引号都不需要转义。" +
        "父目录不存在会自动创建。写代码文件一律用这个工具，不要用 exec_command 配 heredoc。",
      inputSchema: {
        path: z.string().min(1).describe("目标文件路径，支持 ~ 展开"),
        content: z.string().describe("文件内容，任意字符都安全"),
        encoding: z.enum(["utf8", "base64"]).optional().describe("content 的编码，默认 utf8"),
        append: z.boolean().optional().describe("true 追加，默认 false 覆盖"),
        confirmToken: z.string().optional().describe("写敏感路径时需要的确认令牌"),
      },
    },
    async (args) => {
      try {
        const outcome = await runWriteFile(args, { requestId, via: "mcp" });
        return ok(outcome);
      } catch (e) {
        return err(`写入失败：${(e as Error).message}`);
      }
    },
  );
}
