/**
 * read_file / write_file 业务层。
 *
 * 为什么文件读写不走 exec_command：
 * - 读：cat 会把二进制、非 UTF-8 编码的内容打成乱码，也没法可靠地报告真实大小；
 * - 写：heredoc 写源码文件一旦内容里出现反引号、$、或与定界符同名的行就会被 shell
 *   解析或提前截断，写进去的文件和模型想写的不是一回事。
 * SFTP 是二进制安全的字节通道，这两件事只能交给它。
 */
import { z } from "zod";
import { config } from "../config.js";
import { audit, log } from "../logger.js";
import { readFile, writeFile } from "../ssh/client.js";
import { inspect, issueToken, redeemToken } from "./guard.js";

export const ReadFileInputSchema = z.object({
  path: z.string().min(1).describe("MacBook 上的文件路径，支持 ~ 展开，例如 ~/projects/app/src/index.ts"),
  encoding: z
    .enum(["utf8", "base64"])
    .optional()
    .describe("utf8 返回文本（默认）；二进制文件用 base64"),
});
export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export const WriteFileInputSchema = z.object({
  path: z.string().min(1).describe("目标文件路径，支持 ~ 展开。父目录不存在会自动创建"),
  content: z.string().describe("文件内容。任意字符都安全，不需要做 shell 转义"),
  encoding: z.enum(["utf8", "base64"]).optional().describe("content 的编码，默认 utf8"),
  append: z.boolean().optional().describe("true 表示追加到文件末尾，默认 false 覆盖"),
  confirmToken: z.string().optional().describe("写入敏感路径时需要的确认令牌"),
});
export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

/** 写入这些路径等同于改系统配置或凭证，走和危险命令一样的确认流程 */
const SENSITIVE_WRITE = /(^|\/)(\.ssh\/(authorized_keys|config|id_\w+)|\.zprofile|\.zshrc|\.bash_profile|\.bashrc)$|^\/etc\/|^\/Library\/LaunchDaemons\/|^\/System\//;

export async function runReadFile(input: ReadFileInput, ctx: { requestId: string; via: "rest" | "mcp" }) {
  try {
    const result = await readFile(input.path, input.encoding ?? "utf8");
    audit({ requestId: ctx.requestId, action: "read_file", via: ctx.via, detail: { path: result.path, size: result.size }, ok: true });
    return {
      status: "ok" as const,
      ...result,
      note: result.truncated
        ? `文件共 ${result.size} 字节，超过上限 ${config.MAX_READ_BYTES}，只返回了前 ${config.MAX_READ_BYTES} 字节。需要看后面的内容请用 exec_command 配合 sed -n 或 tail。`
        : undefined,
    };
  } catch (err) {
    const message = (err as Error).message;
    log.error("read_file 失败", { requestId: ctx.requestId, path: input.path, error: message });
    audit({ requestId: ctx.requestId, action: "read_file", via: ctx.via, detail: { path: input.path }, ok: false, error: message });
    throw err;
  }
}

export type WriteOutcome =
  | { status: "needs_confirmation"; confirmToken: string; expiresInMs: number; message: string }
  | { status: "ok"; path: string; bytesWritten: number; created: boolean };

export async function runWriteFile(input: WriteFileInput, ctx: { requestId: string; via: "rest" | "mcp" }): Promise<WriteOutcome> {
  const sensitive = SENSITIVE_WRITE.test(input.path) || inspect(`write ${input.path}`).dangerous;

  if (sensitive) {
    if (!input.confirmToken) {
      const { token, expiresInMs } = issueToken(input.content, input.path);
      audit({ requestId: ctx.requestId, action: "write_file", via: ctx.via, detail: { path: input.path }, ok: false, error: "needs_confirmation" });
      return {
        status: "needs_confirmation",
        confirmToken: token,
        expiresInMs,
        message:
          `${input.path} 属于系统或登录相关的敏感文件，写错会导致无法登录或隧道断开，已暂停。\n` +
          `请先向用户确认，再带上 confirmToken 重新调用。`,
      };
    }
    const redeem = redeemToken(input.confirmToken, input.content, input.path);
    if (!redeem.ok) {
      const { token, expiresInMs } = issueToken(input.content, input.path);
      return { status: "needs_confirmation", confirmToken: token, expiresInMs, message: `${redeem.reason}。已重新签发令牌。` };
    }
  }

  try {
    const result = await writeFile(input.path, input.content, input.encoding ?? "utf8", input.append ?? false);
    audit({ requestId: ctx.requestId, action: "write_file", via: ctx.via, detail: { path: result.path, bytes: result.bytesWritten, append: input.append ?? false }, ok: true });
    return { status: "ok", ...result };
  } catch (err) {
    const message = (err as Error).message;
    log.error("write_file 失败", { requestId: ctx.requestId, path: input.path, error: message });
    audit({ requestId: ctx.requestId, action: "write_file", via: ctx.via, detail: { path: input.path }, ok: false, error: message });
    throw err;
  }
}
