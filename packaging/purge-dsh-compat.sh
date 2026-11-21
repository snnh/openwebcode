#!/bin/sh
# 显式清理已下线的 dsh 兼容模式残留。
# 实际逻辑在 purge-dsh-compat.mjs；本脚本只负责找到 Node 运行时后转发参数。
# 发布包根目录会同时携带两个文件；源码仓库可直接运行
#   sh packaging/purge-dsh-compat.sh --prefix ... --data-dir ... --yes
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
MODULE=''
for candidate in \
    "$SCRIPT_DIR/purge-dsh-compat.mjs" \
    "$SCRIPT_DIR/../scripts/purge-dsh-compat.mjs" \
    "$SCRIPT_DIR/scripts/purge-dsh-compat.mjs"; do
    if [ -f "$candidate" ]; then
        MODULE=$candidate
        break
    fi
done
if [ -z "$MODULE" ]; then
    echo "purge-dsh-compat.sh: 未找到 purge-dsh-compat.mjs" >&2
    exit 2
fi

NODE_BIN=${OWC_PURGE_NODE:-}
if [ -z "$NODE_BIN" ]; then
    for candidate in "$SCRIPT_DIR/node/bin/node" "$SCRIPT_DIR/../lib/openwebcode/node/bin/node"; do
        if [ -x "$candidate" ]; then
            NODE_BIN=$candidate
            break
        fi
    done
fi
if [ -z "$NODE_BIN" ]; then
    NODE_BIN=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE_BIN" ]; then
    echo "purge-dsh-compat.sh: 未找到 Node.js；可用 OWC_PURGE_NODE 指定 node 路径" >&2
    exit 2
fi

exec "$NODE_BIN" "$MODULE" "$@"
