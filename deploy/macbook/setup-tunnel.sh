#!/bin/bash
# MacBook 端一键配置：生成隧道专用密钥 → 装到 VPS → 用 launchd 保活反向隧道。
#
# 这台电脑上不安装任何第三方软件：
#   - sshd 是 macOS 自带的（系统设置里的「远程登录」）
#   - 隧道保活用 macOS 自带的 launchd，不需要 autossh
#
# 用法：bash setup-tunnel.sh
set -euo pipefail

VPS_HOST="${VPS_HOST:-203.0.113.10}"
# 配置 VPS 用的 root 通道，可传别名：VPS_ADMIN=myvps bash setup-tunnel.sh
VPS_ADMIN="${VPS_ADMIN:-root@$VPS_HOST}"
VPS_TUNNEL_USER="${VPS_TUNNEL_USER:-cgmtunnel}"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
REMOTE_BIND_PORT="${REMOTE_BIND_PORT:-2222}"
KEY_PATH="$HOME/.ssh/id_cgm_tunnel"
LABEL="io.github.chatgpt-on-mac.tunnel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/cgm-tunnel"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

bold "== 1/5 检查「远程登录」是否已开启 =="
# 直接探端口，比 systemsetup -getremotelogin 更准也不需要 sudo
if nc -z -G 2 127.0.0.1 22 2>/dev/null; then
  ok "远程登录已开启（22 端口在监听）"
else
  warn "远程登录未开启 —— 隧道建起来也没用，VPS 转发过来会被拒绝。"
  warn "请在「系统设置 → 通用 → 共享 → 远程登录」里打开，或执行："
  warn "    sudo systemsetup -setremotelogin on"
  if [ "${SKIP_SSHD_CHECK:-0}" = "1" ]; then
    warn "已按 SKIP_SSHD_CHECK=1 继续：隧道会先建好，等你打开远程登录后即刻可用。"
  else
    read -r -p "打开后按回车继续，或 Ctrl-C 退出（想先把隧道配好可设 SKIP_SSHD_CHECK=1）：" _
  fi
fi

bold "== 2/5 准备隧道专用密钥 =="
if [ -f "$KEY_PATH" ]; then
  ok "已存在：$KEY_PATH"
else
  ssh-keygen -t ed25519 -N "" -C "cgm-tunnel@$(scutil --get LocalHostName 2>/dev/null || hostname)" -f "$KEY_PATH"
  ok "已生成：$KEY_PATH"
fi

bold "== 3/5 把公钥装到 VPS 的隧道账号 =="
echo "接下来需要 VPS 的 root 权限来创建受限账号 ${VPS_TUNNEL_USER}。"
PUBKEY="$(cat "$KEY_PATH.pub")"
ssh "$VPS_ADMIN" bash -s <<REMOTE
set -euo pipefail
id -u "$VPS_TUNNEL_USER" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$VPS_TUNNEL_USER"
# sshd 要求 home 不能被 group/other 写，否则会拒绝读 authorized_keys
install -d -m 755 -o "$VPS_TUNNEL_USER" -g "$VPS_TUNNEL_USER" "/home/$VPS_TUNNEL_USER"
install -d -m 700 -o "$VPS_TUNNEL_USER" -g "$VPS_TUNNEL_USER" "/home/$VPS_TUNNEL_USER/.ssh"
# restrict 先关掉一切能力，再单独打开端口转发：
# 这把密钥即使泄漏，拿到的也只是「在 VPS 上开一个转发端口」，不能执行任何命令。
LINE='restrict,port-forwarding,command="echo tunnel-only" $PUBKEY'
touch "/home/$VPS_TUNNEL_USER/.ssh/authorized_keys"
grep -qF "$PUBKEY" "/home/$VPS_TUNNEL_USER/.ssh/authorized_keys" || echo "\$LINE" >> "/home/$VPS_TUNNEL_USER/.ssh/authorized_keys"
chown "$VPS_TUNNEL_USER:$VPS_TUNNEL_USER" "/home/$VPS_TUNNEL_USER/.ssh/authorized_keys"
chmod 600 "/home/$VPS_TUNNEL_USER/.ssh/authorized_keys"
echo "VPS 侧隧道账号就绪"
REMOTE
ok "公钥已装到 $VPS_TUNNEL_USER@$VPS_HOST"

bold "== 4/5 写入 launchd 保活配置 =="
mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-NT</string>
    <!-- 90 秒内探测不到对端就主动退出，交给 launchd 重启，这是断网/休眠后自愈的关键 -->
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <!-- 远端端口没绑上就别假装隧道还在：立刻退出重来 -->
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>StrictHostKeyChecking=accept-new</string>
    <string>-o</string><string>IdentitiesOnly=yes</string>
    <string>-o</string><string>BatchMode=yes</string>
    <string>-i</string><string>$KEY_PATH</string>
    <string>-p</string><string>$VPS_SSH_PORT</string>
    <!-- 只绑 VPS 的回环地址：MacBook 的 SSH 端口不出现在公网上 -->
    <string>-R</string><string>127.0.0.1:$REMOTE_BIND_PORT:localhost:22</string>
    <string>$VPS_TUNNEL_USER@$VPS_HOST</string>
  </array>

  <key>RunAtLoad</key><true/>
  <!-- 进程退出就重启；ThrottleInterval 防止网络没恢复时疯狂重连 -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>

  <key>StandardOutPath</key><string>$LOG_DIR/tunnel.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/tunnel.err.log</string>
</dict>
</plist>
PLISTEOF
ok "已写入 $PLIST"

bold "== 5/5 启动隧道 =="
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3

if ssh "$VPS_ADMIN" "ss -lnt | grep -q '127.0.0.1:$REMOTE_BIND_PORT'"; then
  ok "隧道已建立：VPS 的 127.0.0.1:$REMOTE_BIND_PORT 现在通往这台 MacBook"
else
  warn "VPS 上没看到 $REMOTE_BIND_PORT 监听，检查日志：tail -f $LOG_DIR/tunnel.err.log"
  exit 1
fi

echo
bold "完成。常用命令："
echo "  查看状态： launchctl print gui/$(id -u)/$LABEL | head -20"
echo "  重启隧道： launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  停止隧道： launchctl bootout gui/$(id -u)/$LABEL"
echo "  查看日志： tail -f $LOG_DIR/tunnel.err.log"
