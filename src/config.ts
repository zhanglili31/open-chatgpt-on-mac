/**
 * 运行期配置：全部来自环境变量，启动时用 zod 强校验。
 * 缺少必填项直接退出，绝不静默使用默认值（密钥类配置不允许有默认值）。
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * 本地开发时加载 .env。
 * 生产由 systemd 的 EnvironmentFile 注入，不会走到这里；
 * 手写解析是为了不为这十几行引一个依赖（VPS 上是 Node 18，没有 --env-file）。
 */
function loadDotEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // 已存在的环境变量优先，命令行传入的不会被文件覆盖
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv(process.env.ENV_FILE ?? ".env");

const intFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: intFromEnv(8787),

  API_TOKEN: z.string().min(16, "API_TOKEN 至少 16 位，请用 openssl rand -hex 32 生成"),

  SSH_HOST: z.string().default("127.0.0.1"),
  SSH_PORT: intFromEnv(2222),
  SSH_USER: z.string().min(1, "SSH_USER 必填：MacBook 上的登录用户名"),
  SSH_PRIVATE_KEY_PATH: z.string().optional(),
  SSH_PRIVATE_KEY: z.string().optional(),
  SSH_PASSPHRASE: z.string().optional(),
  SSH_HOST_FINGERPRINT: z.string().optional(),

  DEFAULT_TIMEOUT_MS: intFromEnv(60_000),
  MAX_TIMEOUT_MS: intFromEnv(900_000),
  MAX_OUTPUT_BYTES: intFromEnv(200_000),
  MAX_CONCURRENCY: intFromEnv(4),
  MAX_READ_BYTES: intFromEnv(5 * 1024 * 1024),
  CONFIRM_TTL_MS: intFromEnv(300_000),

  LOG_DIR: z.string().default("./logs"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    console.error(`[config] 环境变量校验失败：\n${lines.join("\n")}`);
    process.exit(1);
  }
  const env = parsed.data;

  // 私钥：路径优先，其次直接内容。两者都没有则拒绝启动——本服务禁用密码登录。
  let privateKey: Buffer;
  if (env.SSH_PRIVATE_KEY_PATH) {
    try {
      privateKey = readFileSync(env.SSH_PRIVATE_KEY_PATH);
    } catch (err) {
      console.error(`[config] 读取 SSH_PRIVATE_KEY_PATH 失败: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (env.SSH_PRIVATE_KEY) {
    privateKey = Buffer.from(env.SSH_PRIVATE_KEY.replace(/\\n/g, "\n"), "utf8");
  } else {
    console.error("[config] 必须提供 SSH_PRIVATE_KEY_PATH 或 SSH_PRIVATE_KEY（本服务不支持密码登录）");
    process.exit(1);
  }

  return { ...env, privateKey };
}

export const config = load();
export type Config = typeof config;
