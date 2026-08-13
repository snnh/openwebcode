#!/bin/sh
# OpenWebCode Docker 入口脚本
#
# 以 root 启动（默认）时：
#   1. 创建并修正数据目录属主 —— 命名卷首次挂载时为 root 属主，而 server 启动会
#      执行 ensureDirWithMode(0700)，非属主直接 EACCES；
#   2. 可选 OWC_WORKSPACE 只修正顶层目录属主（不递归，避免大仓库启动慢）；
#   3. setpriv 降权到 owc 用户后启动 server（agent 执行的命令同样以 owc 运行）。
# 以非 root 启动（compose 里自定义 user:）时跳过修正与降权，属主由用户负责。
set -eu

DATA_DIR="${OWC_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA_DIR"
    chown -R owc:owc "$DATA_DIR"
    if [ -n "${OWC_WORKSPACE:-}" ] && [ -d "$OWC_WORKSPACE" ]; then
        chown owc:owc "$OWC_WORKSPACE" 2>/dev/null || true
    fi
    # setpriv 来自 util-linux（slim 镜像自带），避免引入 gosu/su-exec 等额外二进制
    exec setpriv --reuid=owc --regid=owc --init-groups \
        node /opt/openwebcode/server/dist/index.js "$@"
fi

exec node /opt/openwebcode/server/dist/index.js "$@"
