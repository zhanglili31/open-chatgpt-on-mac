# 给 AI 的部署手册

这份文件是写给 AI 编码助手（Claude Code / Codex / Cursor / 等）看的。
用户把这个仓库交给你，说"帮我部署"，你就按本文从头做到尾。

**目标**：让用户的 ChatGPT 网页版能够通过 SSH 操作他自己的 Mac。

---

## 0. 先跟用户要这四样信息

缺任何一样都没法继续。一次问完，别挤牙膏：

| 要问什么 | 怎么验证 | 用户不知道时怎么办 |
|---|---|---|
| **VPS 的 IP 或 SSH 别名** | `ssh <目标> 'echo ok'` 能通 | 让他去云服务商控制台看公网 IP |
| **准备用的域名** | 必须是他能改 DNS 的域名 | 必须有，ChatGPT 不接受 IP 和自签证书 |
| **Mac 的登录用户名** | 让他在终端敲 `whoami` | 就是 `whoami` 的输出 |
| **Let's Encrypt 邮箱**（可选） | 用于证书到期提醒 | 不填也行，脚本会跳过 |

---

## 1. 前置检查（全部通过才往下走）

```bash
# 本机（用户的 Mac）
node -v                                   # 需要 >= 18
nc -z -G 2 127.0.0.1 22 && echo "远程登录已开" || echo "远程登录未开"

# VPS
ssh <VPS> 'for c in nginx certbot node npm openssl rsync; do printf "%-10s %s\n" $c "$(command -v $c || echo 缺失)"; done'
ssh <VPS> 'node -v; ss -lnt | grep -E ":(80|443|2222|8787)" || echo "端口都空闲"'

# DNS 是否已解析到 VPS（从 VPS 上查，避免本机 DNS 被代理劫持）
ssh <VPS> 'dig +short <域名> @8.8.8.8'
```

**如果「远程登录未开」**：这一步必须用户自己做，需要管理员密码。告诉他：

> 系统设置 → 通用 → 共享 → **远程登录** 打开。

别让他跑 `sudo systemsetup -setremotelogin on` —— 新版 macOS 上这条命令会报
`requires Full Disk Access privileges`，图形界面反而更简单。你可以帮他打开面板：

```bash
open "x-apple.systempreferences:com.apple.Sharing-Settings.extension"
```

**如果 VPS 缺 nginx / certbot / node**：先帮他装。

**如果 DNS 还没解析**：让他去域名商后台加一条 A 记录指向 VPS IP，然后等几分钟再查。

---

## 2. 改掉两个默认值

```bash
# deploy/vps/setup-vps.sh 第 10 行
DOMAIN="${DOMAIN:-mac.example.com}"       # → 用户的真实域名

# deploy/macbook/setup-tunnel.sh 第 11 行
VPS_HOST="${VPS_HOST:-203.0.113.10}"      # → 用户的 VPS IP
```

`openapi.yaml` 里的 `servers.url` 不用改 —— 服务会在运行时提供
`/openapi.yaml` 端点，但**那份内容来自仓库里的文件**，所以还是要改：

```bash
# openapi.yaml 第 10 行
- url: https://mac.example.com            # → https://用户的域名
```

---

## 3. 部署到 VPS

```bash
# 在仓库根目录
npm install
bash deploy/sync.sh                       # 构建 + rsync 到 VPS + 装生产依赖
```

`deploy/sync.sh` 顶部的 `VPS` 变量默认是 `myvps`，改成用户的 SSH 别名或
`root@IP`，或者用环境变量传：`VPS=root@1.2.3.4 bash deploy/sync.sh`。

然后在 VPS 上：

```bash
ssh <VPS> 'cd /opt/chatgpt-on-mac && MAC_USER=<用户名> CERT_EMAIL=<邮箱> bash deploy/vps/setup-vps.sh'
```

这个脚本会做六件事，每步都有校验：建服务账号 → 生成密钥 → 生成 `.env` →
配 sshd 保活 → 装 systemd 服务 → 配 nginx + 申请证书。

**脚本结束时会打印两样东西，必须记下来交给用户**：
- 一行 `ssh-ed25519 ...` 公钥（下一步要用）
- 一个 `API_TOKEN`（最后配 ChatGPT 要用）

> **如果 VPS 上已经跑着别的网站**：这个脚本是安全的，它只新增
> `/etc/nginx/conf.d/<域名>.conf`，不改任何现有文件。但执行前最好先备份：
> `ssh <VPS> 'tar czf /root/nginx-backup-$(date +%F).tar.gz /etc/nginx/'`
> 并在 reload nginx 后逐个确认原有站点仍正常。

---

## 4. 授权 VPS 登录 Mac

把上一步的公钥装到用户的 Mac：

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
grep -qF '<公钥>' ~/.ssh/authorized_keys || echo '<公钥>' >> ~/.ssh/authorized_keys
```

---

## 5. 建立隧道

```bash
VPS_ADMIN=<VPS别名或root@IP> bash deploy/macbook/setup-tunnel.sh
```

脚本会生成隧道专用密钥、在 VPS 上建受限账号（`restrict,port-forwarding`）、
写 launchd 配置并启动。

**如果用户还没开远程登录**，加 `SKIP_SSHD_CHECK=1` 可以先把隧道配好，
等他打开开关后立刻可用。

---

## 6. 验证整条链路

按这个顺序查，能快速定位问题出在哪一段：

```bash
# ① 隧道有没有建起来
ssh <VPS> 'ss -lnt | grep 2222'

# ② VPS 能不能经隧道登录 Mac
ssh <VPS> 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i /opt/chatgpt-on-mac/.ssh/id_bridge -p 2222 <用户名>@127.0.0.1 "hostname; sw_vers -productVersion"'

# ③ 服务活着吗
ssh <VPS> 'systemctl is-active chatgpt-on-mac; curl -s http://127.0.0.1:8787/health'

# ④ 公网 HTTPS 通吗
curl -s https://<域名>/health

# ⑤ 全链路（最关键的一条）
TOKEN=$(ssh <VPS> 'grep ^API_TOKEN= /opt/chatgpt-on-mac/.env | cut -d= -f2')
curl -s -X POST https://<域名>/api/exec_command \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"command":"hostname; sw_vers -productVersion; pwd"}'
```

⑤ 返回用户 Mac 的机器名，就算成功。

---

## 7. 加固：配置主机指纹（建议做）

防止有人在 VPS 上抢占 2222 端口冒充用户的 Mac：

```bash
# 在 VPS 上取指纹（隧道必须已建立）
ssh <VPS> "ssh-keyscan -p 2222 -t ed25519 127.0.0.1 2>/dev/null | awk '{print \$3}' | base64 -d | openssl dgst -sha256 -binary | openssl base64 | tr -d '='"

# 写进 .env 后重启
ssh <VPS> "sed -i 's|^SSH_HOST_FINGERPRINT=.*|SSH_HOST_FINGERPRINT=<指纹>|' /opt/chatgpt-on-mac/.env && systemctl restart chatgpt-on-mac"
```

**必须用 `-t ed25519` 取指纹**。macOS 同时提供 ed25519 / ecdsa / rsa 三种主机密钥，
代码里已锁定 ed25519，用别的算法取的指纹会导致连接被误判为中间人攻击。

改完记得重新验证第 6 步的 ⑤，确认没把链路搞断。

---

## 8. 配置 ChatGPT

这一步在浏览器里做，需要用户登录 ChatGPT。如果你有浏览器操作能力可以代劳，
否则把步骤讲清楚让用户自己点。

1. 打开 `https://chatgpt.com/gpts/editor` → 切到 **Configure**
2. **Name** 填「我的电脑」之类
3. **Instructions** 粘贴 `docs/gpt-instructions.md` 的全部内容
4. 拉到底 → **Create new action**
5. **Schema** → 点 **Import from URL** → 填 `https://<域名>/openapi.yaml`
6. **Authentication** 齿轮 → `API Key` + 填 Token + Auth Type 选 **Bearer**
7. **Privacy policy** 填 `https://<域名>/health`
8. 右上 **Create** → 选 **Only me** → **Save**

---

## 已知的坑（都是实际踩过的）

| 现象 | 原因 | 怎么办 |
|---|---|---|
| ChatGPT 报 `description has length N exceeding limit of 300` | 每个 operation 的 description 上限 300 字符 | 改短 `openapi.yaml` 里的 description，详细说明搬去 Instructions |
| ChatGPT 一直转圈，服务端没收到任何请求 | 有个 Allow/Deny 确认框没点 | 让用户往上翻点 Allow。**排查时先看 nginx 日志有没有请求进来**，最快 |
| 全部返回 401 | Auth Type 选成了 Basic | 改成 Bearer |
| 全部返回 503 | 隧道断了 | `launchctl kickstart -k gui/$(id -u)/io.github.chatgpt-on-mac.tunnel` |
| `command not found`（本机明明有） | 非交互 shell 读不到 `~/.zshrc` | 让用户把 PATH 配置写进 `~/.zprofile` |
| 隧道日志报 `remote port forwarding failed` | VPS 上 2222 被僵尸连接占着 | 确认 `setup-vps.sh` 写的 `ClientAliveInterval` 生效了 |
| 编译/安装依赖被掐断 | 用了默认 60 秒超时 | 让 ChatGPT 调用时传 `timeoutMs`（上限 900000） |
| 脚本报 `unbound variable` 且变量名后带乱码 | bash 把紧跟变量名的中文字节吞进了变量名 | 用 `${VAR}` 加花括号明确边界 |

---

## 绝对不要做的事

1. **不要把真实的 Token、密钥、公钥、域名写进仓库里的任何文件。**
   这些都是部署时生成的，只存在于 VPS 的 `.env` 和用户的 ChatGPT 配置里。
2. **不要在用户没明确同意时改动 VPS 上已有的服务。**
   如果 VPS 上跑着别的网站，reload nginx 前先备份、先 `nginx -t`，之后逐个确认原站点正常。
3. **不要跳过验证直接说"部署完成"。** 必须跑完第 6 步的 ⑤ 并看到真实主机名。
4. **不要用 `curl ... | bash` 之类的方式安装东西** —— 这个项目的 guard 会拦，
   而且用户装的是一个能控制自己电脑的系统，来源必须可审计。

---

## 架构速览（改代码前先读这段）

```
ChatGPT ──HTTPS+Bearer──> nginx(443) ──> Node(127.0.0.1:8787) ──ssh2──> 127.0.0.1:2222
                                                                              │
                                                              Mac 主动建立的反向隧道
                                                                              ▼
                                                                    Mac 的 sshd(22)
```

- `src/routes/api.ts` 和 `src/mcp/tools.ts` 是两个入口，**都复用 `src/tools/` 下的同一份实现**，
  改业务逻辑只改 `src/tools/`，两边自动一致。
- `src/ssh/client.ts` 里 exec 用 **base64 传脚本**：命令要穿过「本地拼串 → sshd → 远端 shell」
  两层解析，只要有引号反引号就会走样，base64 让中间层只看到 `[A-Za-z0-9+/=]`。改这块要格外小心。
- 超时是**远端 watchdog 递归杀进程树** + 本地 timer 兜底两层。macOS 没有 GNU `timeout` 命令，
  所以用 `pgrep -P` 自己实现，只杀直接子进程会留下一堆孤儿。
- `src/tools/guard.ts` 是确认制不是白名单，默认放行。加规则就在 `RULES` 数组里加一条正则。

改完必须跑 `npx tsc -p tsconfig.json --noEmit`，然后 `bash deploy/sync.sh` 重新部署。
