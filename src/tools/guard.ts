/**
 * 危险操作确认闸门。
 *
 * 设计原则：这不是白名单。默认放行一切，只拦下「做错了就回不来」的少数动作。
 * 日常开发命令（git / npm / pnpm / 编译 / 测试 / grep / find / ls / cat /
 * rm -rf node_modules 这类）一律直接执行，绝不打断。
 *
 * 命中时不是拒绝，而是返回一枚 confirmToken；模型把 token 带回来即放行。
 * token 与「命令 + cwd」绑定且有有效期，防止模型拿旧 token 放行另一条命令。
 */
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

export interface DangerRule {
  id: string;
  label: string;
  test: (script: string) => boolean;
}

const has = (re: RegExp) => (s: string) => re.test(s);

export const RULES: DangerRule[] = [
  {
    id: "rm-recursive-critical",
    // 只拦目标危险的递归删除；rm -rf node_modules / dist / .next 这类日常清理照常放行
    label: "递归删除关键路径（/ 、~ 、$HOME 、通配符）",
    test: has(/\brm\s+(-\w+\s+)*-\w*[rR]\w*\s+[^\n;|&]*(\s|=|^)(\/(\s|$)|\/\*|~(\/\s*)?(\s|$)|\$HOME(\s|$)|\*(\s|$)|\.\.\/)/),
  },
  {
    id: "rm-home-or-root",
    label: "删除根目录或用户主目录",
    test: has(/\brm\b[^\n;|&]*\s(\/|~|\$HOME)(\s|$)/),
  },
  {
    id: "sudo",
    label: "以管理员权限执行（sudo / doas / su -）",
    test: has(/(^|[\n;|&`]|\s)(sudo|doas)\s+|(^|\n)\s*su\s+-/),
  },
  {
    id: "power",
    label: "关机 / 重启 / 强制休眠",
    test: has(/\b(shutdown|reboot|halt)\b|\bpmset\s+sleepnow\b/),
  },
  {
    id: "disk",
    label: "磁盘操作（diskutil / mkfs / newfs / fdisk / dd 写设备）",
    test: has(/\b(diskutil|mkfs(\.\w+)?|newfs(_\w+)?|fdisk|asr)\b|\bgpt\s+destroy\b|\bdd\b[^\n]*\bof=\/dev\//),
  },
  {
    id: "ssh-config",
    label: "修改 SSH 服务配置或授权密钥",
    test: has(/\/etc\/ssh\/(sshd?_config|ssh_host)|authorized_keys|\bsystemsetup\s+-setremotelogin\b/),
  },
  {
    id: "firewall",
    label: "修改防火墙 / 代理 / 网络过滤规则",
    test: has(/\b(pfctl|ipfw|socketfilterfw)\b|\bnetworksetup\s+-set(webproxy|securewebproxy|socksfirewallproxy|proxyautodiscovery)/),
  },
  {
    id: "security-posture",
    label: "关闭系统安全机制（SIP / Gatekeeper / FileVault）",
    test: has(/\b(csrutil|fdesetup)\b|\bspctl\s+--master-disable\b/),
  },
  {
    id: "system-daemon",
    label: "改动系统级 launchd 服务",
    test: has(/\blaunchctl\s+(unload|disable|bootout|remove)\b[^\n]*(\/System|\/Library\/LaunchDaemons)/),
  },
  {
    id: "perm-sweep",
    label: "对根目录或主目录递归改权限 / 属主",
    test: has(/\b(chmod|chown)\b[^\n]*\s-\w*R\w*\s+[^\n]*(\s\/(\s|$)|\s~(\s|$)|\$HOME)/),
  },
  {
    id: "remote-exec",
    label: "下载并直接执行远程脚本（curl | sh）",
    test: has(/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?\w*sh\b/),
  },
  {
    id: "fork-bomb",
    label: "fork 炸弹",
    test: has(/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/),
  },
  {
    id: "git-destructive",
    label: "不可恢复的 Git 操作（force push / clean -xfd / reset --hard 到远端）",
    test: has(/\bgit\s+push\b[^\n]*(--force(?!-with-lease)|\s-f\b)|\bgit\s+clean\b[^\n]*-\w*x\w*f|\bgit\s+reset\s+--hard\s+origin\//),
  },
  {
    id: "credential-dump",
    label: "读取或导出钥匙串凭证",
    test: has(/\bsecurity\s+(dump-keychain|find-generic-password|find-internet-password)\b/),
  },
];

export interface DangerVerdict {
  dangerous: boolean;
  matched: Array<{ id: string; label: string }>;
}

export function inspect(script: string): DangerVerdict {
  const matched = RULES.filter((r) => r.test(script)).map((r) => ({ id: r.id, label: r.label }));
  return { dangerous: matched.length > 0, matched };
}

// ── 确认令牌 ───────────────────────────────────────────────
interface TokenEntry {
  hash: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();
const SEP = String.fromCharCode(0);

function bind(script: string, cwd: string): string {
  return createHash("sha256").update(`${cwd}${SEP}${script}`).digest("hex");
}

export function issueToken(script: string, cwd: string): { token: string; expiresInMs: number } {
  sweep();
  const token = randomBytes(16).toString("hex");
  tokens.set(token, { hash: bind(script, cwd), expiresAt: Date.now() + config.CONFIRM_TTL_MS });
  return { token, expiresInMs: config.CONFIRM_TTL_MS };
}

/** 一次性核销：用过即删，同一枚 token 不能放行第二条命令 */
export function redeemToken(token: string, script: string, cwd: string): { ok: boolean; reason?: string } {
  sweep();
  const entry = tokens.get(token);
  if (!entry) return { ok: false, reason: "确认令牌无效或已过期，请重新提交该命令以获取新令牌" };
  tokens.delete(token);
  if (entry.expiresAt < Date.now()) return { ok: false, reason: "确认令牌已过期" };
  if (entry.hash !== bind(script, cwd)) {
    return { ok: false, reason: "确认令牌与本次命令不匹配：令牌只对当初申请它的那条命令和 cwd 有效" };
  }
  return { ok: true };
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.expiresAt < now) tokens.delete(k);
}
