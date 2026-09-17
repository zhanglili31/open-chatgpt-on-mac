#!/bin/bash
# 本地构建并同步到 VPS，然后重启服务。
# 在本项目根目录执行：bash deploy/sync.sh
#
# 构建放在本地做：VPS 只有 2G 内存，tsc 和 devDependencies 没必要占它的资源。
set -euo pipefail

VPS="${VPS:-myvps}"
APP_DIR="${APP_DIR:-/opt/chatgpt-on-mac}"

cd "$(dirname "$0")/.."

echo "== 类型检查 =="
npx tsc -p tsconfig.json --noEmit

echo "== 构建 =="
rm -rf dist
npx tsc -p tsconfig.json

echo "== 同步到 $VPS:$APP_DIR =="
ssh "$VPS" "mkdir -p $APP_DIR"
# 注意：不同步 .env —— 那份配置由 VPS 上的 setup-vps.sh 生成并长期保留，
# 覆盖它会把 API_TOKEN 冲掉，导致 ChatGPT 侧全部 401。
# .ssh 同理：那是连 MacBook 的私钥，删了整个服务就废了。
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude logs --exclude .env --exclude .ssh \
  dist package.json package-lock.json openapi.yaml deploy \
  "$VPS:$APP_DIR/"

echo "== 安装生产依赖 =="
ssh "$VPS" "cd $APP_DIR && npm ci --omit=dev --no-audit --no-fund"

echo "== 重启服务 =="
ssh "$VPS" "systemctl restart chatgpt-on-mac && sleep 2 && systemctl is-active chatgpt-on-mac"

echo "== 健康检查 =="
ssh "$VPS" "curl -s -m 5 http://127.0.0.1:8787/health"
echo
echo "完成。"
