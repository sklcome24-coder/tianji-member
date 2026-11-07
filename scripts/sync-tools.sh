#!/bin/sh
# 把 tianji-platform 的工具頁抓進 ./tools（工具本身照舊在原 repo 維護，這裡只取用）
# 用法：sh scripts/sync-tools.sh [git 分支或標籤，預設 main]
set -e
cd "$(dirname "$0")/.."
REF="${1:-${TOOLS_REF:-main}}"
REPO="${TOOLS_REPO:-https://github.com/sklcome24-coder/tianji-platform}"
rm -rf tools.tmp
git clone --depth 1 --branch "$REF" "$REPO" tools.tmp
# 只保留工具頁與前端資源；Python 腳本、參考底本、部署腳本不放上會員站
mkdir -p tools.new
cp tools.tmp/ziwei.html tools.tmp/liuyao.html tools.tmp/xuankong.html tools.tmp/jingfang.html tools.new/
cp tools.tmp/apple-touch-icon*.png tools.new/ 2>/dev/null || true
cp -R tools.tmp/assets tools.new/assets
rm -rf tools tools.tmp
mv tools.new tools
echo "✔ 工具頁已同步（$REPO @ $REF）"
