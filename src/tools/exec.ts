/**
 * exec_command 业务层：参数校验 → 危险闸门 → SSH 执行 → 审计。
 * REST 路由与 MCP server 共用这里，保证两条入口行为完全一致。
 */
import { z } from "zod";
import { config } from "../config.js";
import { audit, log } from "../logger.js";
import { exec, fingerprint } from "../ssh/client.js";
import { inspect, issueToken, redeemToken } from "./guard.js";

export const ExecInputSchema = z.object({
  command: z
    .string()
    .min(1, "command 不能为空")
    .describe("要在 MacBook 上执行的 shell 命令，支持多行脚本、管道、重定向、heredoc"),
  cwd: z
    .string()
    .optional()
    .describe("工作目录，支持 ~ 展开，例如 ~/projects/myapp。默认为用户主目录"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`超时（毫秒）。默认 ${config.DEFAULT_TIMEOUT_MS}，上限 ${config.MAX_TIMEOUT_MS}`),
  env: z.record(z.string()).optional().describe("追加的环境变量"),
  stdin: z.string().optional().describe("喂给命令的标准输入"),
  confirmToken: z
    .string()
    .optional()
    .describe("危险命令的确认令牌。首次调用被拦截时接口会返回该令牌，原样带回即可执行"),
});

export type ExecInput = z.infer<typeof ExecInputSchema>;

export type ExecOutcome =
  | {
      status: "needs_confirmation";
      confirmToken: string;
      expiresInMs: number;
      reasons: Array<{ id: string; label: string }>;
      message: string;
    }
  | {
      status: "ok";
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      truncated: boolean;
      durationMs: number;
      cwd: string;
    };

export async function runExec(input: ExecInput, ctx: { requestId: string; via: "rest" | "mcp" }): Promise<ExecOutcome> {
  const cwd = input.cwd?.trim() || "~";
  const verdict = inspect(input.command);

  if (verdict.dangerous) {
    if (!input.confirmToken) {
      const { token, expiresInMs } = issueToken(input.command, cwd);
      const labels = verdict.matched.map((m) => m.label).join("；");
      log.warn("危险命令被拦截，已签发确认令牌", {
        requestId: ctx.requestId,
        fingerprint: fingerprint(input.command),
        matched: verdict.matched.map((m) => m.id),
      });
      audit({ requestId: ctx.requestId, action: "exec_command", via: ctx.via, cwd, ok: false, detail: { command: input.command, blocked: verdict.matched }, error: "needs_confirmation" });
      return {
        status: "needs_confirmation",
        confirmToken: token,
        expiresInMs,
        reasons: verdict.matched,
        message:
          `这条命令涉及不可逆的高风险操作（${labels}），已暂停执行。\n` +
          `请先向用户说明将要发生什么并取得同意，然后把 confirmToken 原样带上重新调用本接口即可执行。\n` +
          `令牌 ${Math.round(expiresInMs / 1000)} 秒内有效，且只对这一条命令生效。`,
      };
    }
    const redeem = redeemToken(input.confirmToken, input.command, cwd);
    if (!redeem.ok) {
      return {
        status: "needs_confirmation",
        confirmToken: issueToken(input.command, cwd).token,
        expiresInMs: config.CONFIRM_TTL_MS,
        reasons: verdict.matched,
        message: `${redeem.reason}。已重新签发令牌，请用新令牌重试。`,
      };
    }
    log.warn("危险命令经确认后放行", { requestId: ctx.requestId, matched: verdict.matched.map((m) => m.id) });
  }

  const started = Date.now();
  try {
    const result = await exec(input.command, {
      cwd,
      timeoutMs: input.timeoutMs,
      env: input.env,
      stdin: input.stdin,
    });

    audit({
      requestId: ctx.requestId,
      action: "exec_command",
      via: ctx.via,
      cwd,
      detail: { command: input.command, confirmed: Boolean(input.confirmToken) },
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ok: result.exitCode === 0,
    });

    return {
      status: "ok",
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: result.durationMs,
      cwd: result.cwd,
    };
  } catch (err) {
    const message = (err as Error).message;
    log.error("exec_command 执行失败", { requestId: ctx.requestId, error: message });
    audit({
      requestId: ctx.requestId,
      action: "exec_command",
      via: ctx.via,
      cwd,
      detail: { command: input.command },
      durationMs: Date.now() - started,
      ok: false,
      error: message,
    });
    throw err;
  }
}
