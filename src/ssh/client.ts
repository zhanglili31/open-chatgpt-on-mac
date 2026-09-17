/**
 * SSH 执行与文件传输封装。
 *
 * exec 的关键设计 —— 脚本用 base64 传输：
 *   命令通过 SSH 传给远端 shell 时，会经历「本地拼串 → sshd → 用户 shell」两层解析，
 *   命令里只要出现引号、反引号、$、换行就会被解析走样。把整段脚本 base64 编码后
 *   用单引号包住传过去、在远端解码再 eval，中间层看到的只有 [A-Za-z0-9+/=]，
 *   转义问题彻底消失，多行脚本、内嵌引号、heredoc 全部原样执行。
 *
 * 超时：远端自带 watchdog 递归杀进程树（macOS 无 GNU timeout 命令可用），
 *      本地再加一层兜底 timer，两层都失效时至少 channel 会被关掉。
 */
import { createHash } from "node:crypto";
import type { SFTPWrapper } from "ssh2";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getConnection } from "./connection.js";

/** 文件不存在：这是调用方给错了路径，不是服务故障，必须和 500 区分开 */
export class FileNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`文件不存在：${path}`);
    this.name = "FileNotFoundError";
  }
}

/** 路径存在但不是能读写的普通文件：同样是调用方的问题，不该算服务故障 */
export class InvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPathError";
  }
}

/** SFTP 用数字状态码，NO_SUCH_FILE = 2；Node 的 fs 风格错误则是 "ENOENT" */
function isNoSuchFile(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e.code === 2 || e.code === "ENOENT" || /no such file/i.test(e.message ?? "");
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  stdin?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
  cwd: string;
}

/** 并发闸门：同时在 MacBook 上跑的命令数不超过 MAX_CONCURRENCY */
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    };
  }

  get stats() {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }
}

const semaphore = new Semaphore(config.MAX_CONCURRENCY);
export const concurrency = () => semaphore.stats;

/** 单引号安全包裹：把 ' 换成 '\'' */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 达到上限后停止累积、但继续消费流，避免远端写阻塞导致命令卡死 */
class BoundedBuffer {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;
  truncated = false;
  constructor(private readonly limit: number) {}

  push(chunk: Buffer) {
    this.total += chunk.length;
    if (this.kept >= this.limit) {
      this.truncated = true;
      return;
    }
    const room = this.limit - this.kept;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.kept += chunk.length;
    } else {
      this.chunks.push(chunk.subarray(0, room));
      this.kept += room;
      this.truncated = true;
    }
  }

  /** 统一在末尾解码，避免按 chunk 解码把多字节 UTF-8 字符切碎 */
  toString(): string {
    const text = Buffer.concat(this.chunks).toString("utf8");
    if (!this.truncated) return text;
    const dropped = this.total - this.kept;
    return `${text}\n\n… [输出被截断：已省略 ${dropped} 字节，共 ${this.total} 字节。请用管道过滤，例如 | tail -n 200 或 | grep]`;
  }
}

const MAX_SCRIPT_BYTES = 256 * 1024;

/**
 * 构造远端包装脚本。
 * 用户脚本在子进程里跑，watchdog 到点用 pgrep 递归杀整棵进程树
 * （只杀直接子进程的话，npm / docker 这类会留下一堆孤儿继续占资源）。
 */
function buildWrapper(script: string, cwdExpr: string, timeoutMs: number, env?: Record<string, string>): string {
  const payload = Buffer.from(script, "utf8").toString("base64");
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));

  const envLines = env
    ? Object.entries(env)
        .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        .map(([k, v]) => `export ${k}=${sq(v)}`)
        .join("\n")
    : "";

  // Homebrew / nvm 常见路径兜底：非交互登录 shell 不一定读到 ~/.zshrc，
  // 缺了它 node、git、pnpm 全部找不到，这是远程执行最常见的翻车点。
  return [
    `export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$PATH"`,
    `[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1`,
    `export LANG=\${LANG:-en_US.UTF-8} LC_ALL=\${LC_ALL:-en_US.UTF-8}`,
    envLines,
    `__cgm_cwd=${cwdExpr}`,
    `cd -- "$__cgm_cwd" 2>/dev/null || { printf '%s\\n' "cwd 不存在或不可进入: $__cgm_cwd" >&2; exit 127; }`,
    `__cgm_payload="$(printf '%s' ${sq(payload)} | base64 -d 2>/dev/null || printf '%s' ${sq(payload)} | base64 -D)"`,
    `__cgm_kill() { local __p="$1" __c; for __c in $(pgrep -P "$__p" 2>/dev/null); do __cgm_kill "$__c"; done; kill -9 "$__p" 2>/dev/null; }`,
    `{ eval "$__cgm_payload"; } &`,
    `__cgm_child=$!`,
    `{ sleep ${timeoutSec}; __cgm_kill "$__cgm_child"; } >/dev/null 2>&1 &`,
    `__cgm_killer=$!`,
    `wait "$__cgm_child"; __cgm_rc=$?`,
    `kill "$__cgm_killer" >/dev/null 2>&1`,
    `exit "$__cgm_rc"`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function exec(script: string, options: ExecOptions = {}): Promise<ExecResult> {
  const bytes = Buffer.byteLength(script, "utf8");
  if (bytes > MAX_SCRIPT_BYTES) {
    throw new Error(`命令脚本过大（${bytes} 字节 > ${MAX_SCRIPT_BYTES}）。请先用 write_file 把脚本落到 MacBook 上再执行。`);
  }

  const cwd = options.cwd?.trim() || "~";
  const timeoutMs = Math.min(options.timeoutMs ?? config.DEFAULT_TIMEOUT_MS, config.MAX_TIMEOUT_MS);
  const maxOutputBytes = Math.min(options.maxOutputBytes ?? config.MAX_OUTPUT_BYTES, config.MAX_OUTPUT_BYTES);

  // cwd 支持 ~ 与 ~/projects：只把开头的 ~ 换成 $HOME 并用双引号让 shell 展开，
  // 其余部分仍走单引号，避免路径里的空格和特殊字符被二次解析。
  const cwdExpr = cwd.startsWith("~")
    ? `"$HOME"${sq(cwd.slice(1))}`
    : sq(cwd);
  const finalWrapper = buildWrapper(script, cwdExpr, timeoutMs, options.env);

  const release = await semaphore.acquire();
  const started = Date.now();

  try {
    const conn = await getConnection();
    return await new Promise<ExecResult>((resolve, reject) => {
      conn.exec(finalWrapper, { pty: false }, (err, stream) => {
        if (err) {
          reject(new Error(`打开 SSH channel 失败: ${err.message}`));
          return;
        }

        const out = new BoundedBuffer(maxOutputBytes);
        const errBuf = new BoundedBuffer(maxOutputBytes);
        let exitCode: number | null = null;
        let signal: string | null = null;
        let localTimedOut = false;
        let settled = false;

        // 本地兜底：远端 watchdog 失效（例如 pgrep 缺失）时仍要收场
        const guard = setTimeout(() => {
          localTimedOut = true;
          try { stream.close(); } catch { /* ignore */ }
        }, timeoutMs + 5_000);

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          const durationMs = Date.now() - started;
          // 远端 watchdog 杀进程树后 exit code 是 137(128+SIGKILL)，结合耗时判定超时
          const timedOut = localTimedOut || (exitCode === 137 && durationMs >= timeoutMs - 500);
          resolve({
            stdout: out.toString(),
            stderr: errBuf.toString(),
            exitCode,
            signal,
            timedOut,
            truncated: out.truncated || errBuf.truncated,
            stdoutBytes: out.total,
            stderrBytes: errBuf.total,
            durationMs,
            cwd,
          });
        };

        stream.on("data", (d: Buffer) => out.push(d));
        stream.stderr.on("data", (d: Buffer) => errBuf.push(d));
        stream.on("exit", (code: number | null, sig?: string) => {
          exitCode = code;
          signal = sig ?? null;
        });
        stream.on("close", finish);
        stream.on("error", (e: Error) => {
          log.warn("exec stream 出错", { error: e.message });
          finish();
        });

        if (options.stdin !== undefined) stream.end(options.stdin);
        else stream.end();
      });
    });
  } finally {
    release();
  }
}

async function getSftp(): Promise<SFTPWrapper> {
  const conn = await getConnection();
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(new Error(`打开 SFTP 失败: ${err.message}`)) : resolve(sftp)));
  });
}

/** 把 ~ 展开成绝对路径；SFTP 不认 ~，必须先解析 */
async function resolvePath(p: string): Promise<string> {
  if (!p.startsWith("~")) return p;
  const sftp = await getSftp();
  const home = await new Promise<string>((resolve, reject) => {
    sftp.realpath(".", (err, abs) => (err ? reject(err) : resolve(abs)));
  });
  return p === "~" ? home : `${home}${p.slice(1)}`;
}

export interface ReadFileResult {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  size: number;
  truncated: boolean;
}

export async function readFile(path: string, encoding: "utf8" | "base64" = "utf8"): Promise<ReadFileResult> {
  const release = await semaphore.acquire();
  try {
    const abs = await resolvePath(path);
    const sftp = await getSftp();

    const stats = await new Promise<{ size: number; isFile: boolean }>((resolve, reject) => {
      sftp.stat(abs, (err, st) => {
        if (err) reject(isNoSuchFile(err) ? new FileNotFoundError(abs) : new Error(`读取失败：${abs} —— ${err.message}`));
        else resolve({ size: st.size, isFile: st.isFile() });
      });
    });
    if (!stats.isFile) throw new InvalidPathError(`不是普通文件（可能是目录或符号链接）：${abs}。列目录请用 exec_command 跑 ls。`);

    const limit = config.MAX_READ_BYTES;
    const truncated = stats.size > limit;
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      const rs = sftp.createReadStream(abs, truncated ? { start: 0, end: limit - 1 } : {});
      rs.on("data", (c: Buffer) => chunks.push(c));
      rs.on("error", (e: Error) => reject(isNoSuchFile(e) ? new FileNotFoundError(abs) : new Error(`读取失败：${abs} —— ${e.message}`)));
      rs.on("end", () => resolve());
    });

    const buf = Buffer.concat(chunks);
    return {
      path: abs,
      content: encoding === "base64" ? buf.toString("base64") : buf.toString("utf8"),
      encoding,
      size: stats.size,
      truncated,
    };
  } finally {
    release();
  }
}

/** SFTP 没有 mkdir -p，自己按层建 */
async function mkdirp(sftp: SFTPWrapper, dir: string): Promise<void> {
  const parts = dir.split("/").filter(Boolean);
  let cur = dir.startsWith("/") ? "" : ".";
  for (const part of parts) {
    cur = `${cur}/${part}`;
    await new Promise<void>((resolve) => {
      sftp.mkdir(cur, () => resolve()); // 已存在会报错，直接忽略
    });
  }
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export async function writeFile(
  path: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
  append = false,
): Promise<WriteFileResult> {
  const release = await semaphore.acquire();
  try {
    const abs = await resolvePath(path);
    const sftp = await getSftp();

    const existed = await new Promise<boolean>((resolve) => sftp.stat(abs, (err) => resolve(!err)));
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    if (dir) await mkdirp(sftp, dir);

    const buf = Buffer.from(content, encoding);
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(abs, { flags: append ? "a" : "w" });
      ws.on("error", (e: Error) => reject(new Error(`写入失败：${abs} —— ${e.message}`)));
      ws.on("close", () => resolve());
      ws.end(buf);
    });

    return { path: abs, bytesWritten: buf.length, created: !existed };
  } finally {
    release();
  }
}

/** 给审计日志用的命令指纹，避免把完整命令重复写进两条日志流 */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
