/**
 * REST API —— 给 ChatGPT Custom GPT Actions 用的入口。
 *
 * 响应约定：
 * - 命令本身执行失败（exitCode 非 0）仍返回 200，把 exitCode/stderr 交给模型判断，
 *   因为「测试没通过」「grep 没匹配到」都是正常结果，不是接口错误；
 * - 只有链路问题（隧道断、认证失败、参数非法）才返回非 2xx；
 * - 危险命令待确认返回 409，body 里带 confirmToken，模型带回来即可放行。
 */
import { Hono } from "hono";
import { ZodError } from "zod";
import { FileNotFoundError, InvalidPathError } from "../ssh/client.js";
import { SshUnavailableError } from "../ssh/connection.js";
import { ExecInputSchema, runExec } from "../tools/exec.js";
import { ReadFileInputSchema, WriteFileInputSchema, runReadFile, runWriteFile } from "../tools/files.js";
import { bearerAuth, fail } from "./middleware.js";

export const api = new Hono();

api.use("*", bearerAuth);

/** 把各类异常收敛成统一的错误响应，避免把堆栈泄漏给模型 */
function handleError(c: Parameters<typeof fail>[0], err: unknown) {
  if (err instanceof FileNotFoundError) {
    // 路径写错是调用方的问题，报成 500 会让模型误判成服务故障、转而放弃或重试
    return c.json({ error: "not_found", message: err.message, requestId: c.get("requestId") }, 404);
  }
  if (err instanceof InvalidPathError) {
    return fail(c, 400, "invalid_path", err.message);
  }
  if (err instanceof ZodError) {
    const detail = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return fail(c, 400, "invalid_request", `参数不合法：${detail}`);
  }
  if (err instanceof SshUnavailableError) {
    return fail(c, 503, "ssh_unavailable", err.message);
  }
  return fail(c, 500, "internal_error", (err as Error).message);
}

api.post("/exec_command", async (c) => {
  try {
    const input = ExecInputSchema.parse(await c.req.json());
    const outcome = await runExec(input, { requestId: c.get("requestId"), via: "rest" });
    if (outcome.status === "needs_confirmation") return c.json(outcome, 409);
    return c.json(outcome, 200);
  } catch (err) {
    return handleError(c, err);
  }
});

api.post("/read_file", async (c) => {
  try {
    const input = ReadFileInputSchema.parse(await c.req.json());
    return c.json(await runReadFile(input, { requestId: c.get("requestId"), via: "rest" }), 200);
  } catch (err) {
    return handleError(c, err);
  }
});

api.post("/write_file", async (c) => {
  try {
    const input = WriteFileInputSchema.parse(await c.req.json());
    const outcome = await runWriteFile(input, { requestId: c.get("requestId"), via: "rest" });
    if (outcome.status === "needs_confirmation") return c.json(outcome, 409);
    return c.json(outcome, 200);
  } catch (err) {
    return handleError(c, err);
  }
});
