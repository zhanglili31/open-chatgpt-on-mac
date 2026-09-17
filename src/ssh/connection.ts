/**
 * SSH 连接管理：维持一条到 MacBook 的长连接，所有命令复用它开 channel。
 *
 * 为什么不是每次请求新建连接：TCP 三次握手 + 密钥交换 + 认证要 300ms~1s，
 * 而 SSH 协议原生支持一条连接上并行多个 channel，复用是零代价的。
 *
 * 反向隧道随时可能断（MacBook 合盖、换网、VPS 重启），因此：
 * - keepalive 主动探活，15s 一次、连续 3 次无响应即判死
 * - 任何 error/close/end 都把单例置空，下次请求自动重建
 * - 重建失败按指数退避，避免隧道没起来时疯狂重试打爆日志
 */
import { createHash } from "node:crypto";
import { Client, type ConnectConfig } from "ssh2";
import { config } from "../config.js";
import { log } from "../logger.js";

export class SshUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshUnavailableError";
  }
}

let client: Client | null = null;
let pending: Promise<Client> | null = null;
let consecutiveFailures = 0;
let nextRetryAt = 0;

function buildConnectConfig(): ConnectConfig {
  const cfg: ConnectConfig = {
    host: config.SSH_HOST,
    port: config.SSH_PORT,
    username: config.SSH_USER,
    privateKey: config.privateKey,
    passphrase: config.SSH_PASSPHRASE || undefined,
    readyTimeout: 15_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
  };

  // 主机公钥指纹校验：防止有人在 VPS 上抢占 2222 端口冒充 MacBook。
  // 留空则跳过（首次部署方便，但生产务必填上）。
  const expected = config.SSH_HOST_FINGERPRINT?.trim();
  if (expected) {
    // macOS 的 sshd 同时提供 ed25519 / ecdsa / rsa 三种主机密钥。
    // 不锁定算法的话，某次协商换成 ecdsa 就会算出另一个指纹、被误判成中间人，
    // 表现为「隧道明明是通的，服务却突然连不上」。指纹按 ed25519 生成，就锁死 ed25519。
    cfg.algorithms = { serverHostKey: ["ssh-ed25519"] };
    cfg.hostVerifier = (key: Buffer) => {
      const actual = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
      const want = expected.replace(/^SHA256:/i, "").replace(/=+$/, "");
      const ok = actual === want;
      if (!ok) log.error("SSH 主机指纹不匹配，拒绝连接", { expected: want, actual });
      return ok;
    };
  }
  return cfg;
}

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      c.removeAllListeners();
      try { c.end(); } catch { /* 连接尚未建立时 end 会抛，忽略 */ }
      reject(err);
    };

    c.on("ready", () => {
      if (settled) return;
      settled = true;
      consecutiveFailures = 0;
      log.info("SSH 已连接", { host: config.SSH_HOST, port: config.SSH_PORT, user: config.SSH_USER });
      resolve(c);
    });

    c.on("error", (err) => {
      if (settled) {
        // 连接建立之后才出的错：作废单例，下次请求重连
        log.warn("SSH 连接出错，将重建", { error: err.message });
        invalidate(c);
      } else {
        fail(err);
      }
    });

    c.on("close", () => { if (settled) { log.warn("SSH 连接已关闭"); invalidate(c); } });
    c.on("end", () => { if (settled) invalidate(c); });

    try {
      c.connect(buildConnectConfig());
    } catch (err) {
      fail(err as Error);
    }
  });
}

function invalidate(c: Client) {
  if (client === c) client = null;
  try { c.removeAllListeners(); c.end(); } catch { /* 已断开，忽略 */ }
}

/** 取一条可用连接；并发调用共享同一次重连，不会打出多条连接 */
export async function getConnection(): Promise<Client> {
  if (client) return client;
  if (pending) return pending;

  const now = Date.now();
  if (now < nextRetryAt) {
    throw new SshUnavailableError(
      `SSH 隧道不可用（${Math.ceil((nextRetryAt - now) / 1000)}s 后重试）。` +
        `请确认 MacBook 的反向隧道已建立：VPS 上 ${config.SSH_HOST}:${config.SSH_PORT} 应处于监听状态。`,
    );
  }

  pending = connect()
    .then((c) => {
      client = c;
      return c;
    })
    .catch((err: Error) => {
      consecutiveFailures += 1;
      // 指数退避，上限 30s
      const backoff = Math.min(30_000, 1000 * 2 ** Math.min(consecutiveFailures, 5));
      nextRetryAt = Date.now() + backoff;
      log.error("SSH 连接失败", { error: err.message, consecutiveFailures, backoffMs: backoff });
      throw new SshUnavailableError(
        `无法连接 MacBook（${config.SSH_HOST}:${config.SSH_PORT}）：${err.message}。` +
          `常见原因：反向 SSH 隧道未建立、MacBook 未开启「远程登录」、或公钥未写入 authorized_keys。`,
      );
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}

/** 健康检查：跑一条最廉价的命令确认链路真的通（不只是 TCP 活着） */
export async function ping(): Promise<{ ok: boolean; detail: string }> {
  try {
    const c = await getConnection();
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, detail: "健康检查超时（5s）" }), 5000);
      c.exec("echo __ok__", (err, stream) => {
        if (err) {
          clearTimeout(timer);
          resolve({ ok: false, detail: err.message });
          return;
        }
        let out = "";
        stream.on("data", (d: Buffer) => { out += d.toString("utf8"); });
        stream.on("close", () => {
          clearTimeout(timer);
          resolve(out.includes("__ok__") ? { ok: true, detail: "ok" } : { ok: false, detail: `异常响应: ${out.slice(0, 200)}` });
        });
      });
    });
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export function closeConnection() {
  if (client) {
    const c = client;
    client = null;
    try { c.end(); } catch { /* ignore */ }
  }
}
