/**
 * 轻量 JSONL 日志：同时写控制台与文件，按天切分。
 * 两条流：app.log（运行日志/错误）、audit.log（每一次远程操作的审计记录）。
 * 落盘前统一脱敏，token / key / password 一律不落原文。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

mkdirSync(config.LOG_DIR, { recursive: true });

const SECRET_KEYS = /^(authorization|api_?token|token|password|passphrase|secret|private_?key|cookie)$/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/gi;

/** 递归脱敏：敏感字段整体替换，普通字符串里的 token 形态也打码 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function stamp() {
  return new Date().toISOString();
}

function writeLine(file: string, payload: Record<string, unknown>) {
  const day = stamp().slice(0, 10);
  try {
    appendFileSync(join(config.LOG_DIR, `${file}-${day}.log`), `${JSON.stringify(payload)}\n`, "utf8");
  } catch (err) {
    console.error(`[logger] 写日志失败: ${(err as Error).message}`);
  }
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[config.LOG_LEVEL]) return;
  const payload = { ts: stamp(), level, msg, ...(meta ? (redact(meta) as Record<string, unknown>) : {}) };
  writeLine("app", payload);
  const line = `[${payload.ts}] ${level.toUpperCase()} ${msg}`;
  if (level === "error") console.error(line, meta ? redact(meta) : "");
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};

/** 审计流：每一次落到 MacBook 上的操作都在这里留痕，用于事后追责 */
export function audit(entry: {
  requestId: string;
  action: string;
  via: "rest" | "mcp";
  cwd?: string;
  detail?: unknown;
  exitCode?: number | null;
  durationMs?: number;
  ok: boolean;
  error?: string;
}) {
  writeLine("audit", { ts: stamp(), ...(redact(entry) as Record<string, unknown>) });
}
