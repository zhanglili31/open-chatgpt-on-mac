#!/bin/bash
# VPS 端一键部署。在 VPS 上以 root 执行。
#
# 做四件事：建服务账号 → 生成连 MacBook 用的密钥 → 装 systemd 服务 → 配 nginx + 证书。
# 脚本对已有站点是零影响的：只新增 /etc/nginx/conf.d/<域名>.conf，不改动任何现有文件。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/chatgpt-on-mac}"
APP_USER="${APP_USER:-cgm}"
DOMAIN="${DOMAIN:-mac.example.com}"
SSH_PORT="${SSH_PORT:-2222}"
MAC_USER="${MAC_USER:-}"          # MacBook 上的登录用户名，必填
CERT_EMAIL="${CERT_EMAIL:-}"      # Let's Encrypt 通知邮箱
SKIP_NGINX="${SKIP_NGINX:-0}"     # 设为 1 跳过第 6 步，适用于已自行配好反代的情况

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行"
[ -n "$MAC_USER" ]   || die "必须指定 MAC_USER，例如：MAC_USER=youruser bash setup-vps.sh"
[ -d "$APP_DIR/dist" ] || die "$APP_DIR/dist 不存在，请先在本地 npm run build 并把代码同步上来"

bold "== 1/6 服务账号 =="
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP_DIR" "$APP_USER"
ok "账号 $APP_USER 就绪"

bold "== 2/6 生成连 MacBook 的密钥 =="
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$APP_DIR/.ssh"
KEY="$APP_DIR/.ssh/id_bridge"
if [ -f "$KEY" ]; then
  ok "密钥已存在：$KEY"
else
  ssh-keygen -t ed25519 -N "" -C "cgm-bridge@$DOMAIN" -f "$KEY"
  chown "$APP_USER:$APP_USER" "$KEY" "$KEY.pub"
  chmod 600 "$KEY"
  ok "已生成：$KEY"
fi

bold "== 3/6 生成 .env =="
if [ -f "$APP_DIR/.env" ]; then
  ok ".env 已存在，跳过（要重建请先删掉它）"
else
  API_TOKEN="$(openssl rand -hex 32)"
  cat > "$APP_DIR/.env" <<ENVEOF
HOST=127.0.0.1
PORT=8787

API_TOKEN=$API_TOKEN

SSH_HOST=127.0.0.1
SSH_PORT=$SSH_PORT
SSH_USER=$MAC_USER
SSH_PRIVATE_KEY_PATH=$APP_DIR/.ssh/id_bridge
SSH_HOST_FINGERPRINT=

DEFAULT_TIMEOUT_MS=60000
MAX_TIMEOUT_MS=900000
MAX_OUTPUT_BYTES=200000
MAX_CONCURRENCY=4
MAX_READ_BYTES=5242880
CONFIRM_TTL_MS=300000

LOG_DIR=$APP_DIR/logs
LOG_LEVEL=info
ENVEOF
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  ok "已生成 .env，API_TOKEN 见下方输出"
fi

install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_DIR/logs"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/dist" "$APP_DIR/node_modules" 2>/dev/null || true

bold "== 4/6 sshd 及时回收断掉的隧道 =="
# MacBook 休眠或断网后，VPS 这侧的 sshd 若不主动探活，会一直占着 2222 端口，
# 新隧道因 ExitOnForwardFailure 绑不上端口，表现为「隧道一直连不上」。
DROPIN=/etc/ssh/sshd_config.d/10-cgm-tunnel.conf
if [ -d /etc/ssh/sshd_config.d ]; then
  if [ ! -f "$DROPIN" ]; then
    cat > "$DROPIN" <<'SSHDEOF'
# 每 30 秒探活，连续 3 次无响应即断开并释放转发端口
ClientAliveInterval 30
ClientAliveCountMax 3
SSHDEOF
    sshd -t && systemctl reload sshd && ok "已写入 $DROPIN 并重载 sshd"
  else
    ok "$DROPIN 已存在"
  fi
else
  printf '\033[33m!\033[0m 本机 sshd 不支持 sshd_config.d，请手动在 /etc/ssh/sshd_config 加：\n'
  printf '    ClientAliveInterval 30\n    ClientAliveCountMax 3\n'
fi

bold "== 5/6 systemd 服务 =="
cp "$APP_DIR/deploy/vps/chatgpt-on-mac.service" /etc/systemd/system/chatgpt-on-mac.service
systemctl daemon-reload
systemctl enable --now chatgpt-on-mac
sleep 2
systemctl is-active --quiet chatgpt-on-mac && ok "服务已启动" || die "服务启动失败，看日志：journalctl -u chatgpt-on-mac -n 50"

bold "== 6/6 nginx + 证书 =="
if [ "$SKIP_NGINX" = "1" ]; then
  ok "已按 SKIP_NGINX=1 跳过 nginx 配置"
else
CONF="/etc/nginx/conf.d/$DOMAIN.conf"
if [ -f "$CONF" ]; then
  ok "$CONF 已存在，跳过"
else
  sed "s/mac\.example\.com/$DOMAIN/g" "$APP_DIR/deploy/vps/nginx.conf" > "$CONF"
  # 证书还没签发时 443 块会让 nginx 起不来，先只留 80 块跑完 certbot
  if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    awk '/^server \{$/{n++} n<2' "$CONF" > "$CONF.tmp" && mv "$CONF.tmp" "$CONF"
    nginx -t && systemctl reload nginx
    command -v certbot >/dev/null || die "未安装 certbot，请先安装后重跑"
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
      ${CERT_EMAIL:+--email "$CERT_EMAIL"} ${CERT_EMAIL:---register-unsafely-without-email} \
      --redirect
    # certbot 只会补出最简 443 块，用完整配置覆盖回去（此时证书已存在）
    sed "s/mac\.example\.com/$DOMAIN/g" "$APP_DIR/deploy/vps/nginx.conf" > "$CONF"
  fi
  nginx -t && systemctl reload nginx
  ok "nginx 已配置：https://$DOMAIN"
fi
fi

echo
bold "════════ 部署完成 ════════"
echo
bold "① 把这行公钥加到 MacBook 的 ~/.ssh/authorized_keys："
echo
cat "$KEY.pub"
echo
echo "   在 MacBook 上执行："
echo "   echo '$(cat "$KEY.pub")' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
echo
bold "② ChatGPT 里要填的 API Token："
grep '^API_TOKEN=' "$APP_DIR/.env" | cut -d= -f2
echo
bold "③ 验证整条链路："
echo "   curl -s https://$DOMAIN/health"
echo "   curl -s https://$DOMAIN/health/ssh -H \"Authorization: Bearer \$(grep ^API_TOKEN= $APP_DIR/.env | cut -d= -f2)\""
