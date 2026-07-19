#!/bin/sh
# OpenWebCode 安装脚本（Linux tar.gz 分发包用，POSIX sh）
#
# 用法（在解压后的包根目录执行）:
#   ./install.sh [--prefix <dir>] [--with-systemd]
#
# 参数:
#   --prefix <dir>   安装前缀，默认 ~/.local
#   --with-systemd   额外写入 ~/.config/systemd/user/openwebcode.service
#
# 动作:
#   1. 把包内运行时（bin/ server/ web/，以及可选的 node/）复制到
#      <prefix>/lib/openwebcode/（重跑整体覆盖，幂等）；
#   2. 生成启动脚本 <prefix>/bin/owc；
#   3. --with-systemd 时写用户级 systemd unit（仅写文件并打印启用提示，
#      不主动执行 systemctl）。
#
# 卸载（以默认前缀为例）:
#   rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc
#   rm -f  ~/.config/systemd/user/openwebcode.service
#   rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/openwebcode"   # 用户数据，按需
set -eu

PREFIX="$HOME/.local"
WITH_SYSTEMD=0

usage() {
    echo "用法: $0 [--prefix <dir>] [--with-systemd]" >&2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --prefix)
            [ $# -ge 2 ] || { echo "install.sh: --prefix 需要一个目录参数" >&2; exit 2; }
            PREFIX=$2
            shift 2
            ;;
        --prefix=*)
            PREFIX=${1#--prefix=}
            shift
            ;;
        --with-systemd)
            WITH_SYSTEMD=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "install.sh: 未知参数 $1" >&2
            usage
            exit 2
            ;;
    esac
done

[ -n "$PREFIX" ] && [ "$PREFIX" != "/" ] || { echo "install.sh: 非法 prefix: $PREFIX" >&2; exit 2; }

# 包根目录 = 脚本所在目录（tar.gz 顶层即 install.sh + bin/ + server/ + web/ [+ node/]）
SRC_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
LIB_DIR="$PREFIX/lib/openwebcode"

for d in bin server web; do
    if [ ! -d "$SRC_DIR/$d" ]; then
        echo "install.sh: 包内容不完整（缺少 $d/），请在解压后的包根目录运行" >&2
        exit 1
    fi
done

mkdir -p "$PREFIX/lib" "$PREFIX/bin"
rm -rf "$LIB_DIR"
mkdir -p "$LIB_DIR"
cp -R "$SRC_DIR/bin" "$SRC_DIR/server" "$SRC_DIR/web" "$LIB_DIR/"
if [ -d "$SRC_DIR/node" ]; then
    cp -R "$SRC_DIR/node" "$LIB_DIR/"
fi
chmod +x "$LIB_DIR/bin/owc-exec" 2>/dev/null || true

# 启动脚本 <prefix>/bin/owc：
#   - OWC_CORE_PATH 指向包内 owc-exec（server 默认按源码树相对路径找 core，安装后必须显式指定）
#   - OWC_PORT 默认 3000（server 自身兜底是 3210，启动脚本统一为 3000；可用环境变量覆盖）
#   - OWC_DATA_DIR 默认 ${XDG_DATA_HOME:-~/.local/share}/openwebcode，避免写进安装目录
#   - 优先用包内 node（node/bin/node），没有则回落系统 node（要求 >= 20）
cat > "$PREFIX/bin/owc" <<EOF
#!/bin/sh
# OpenWebCode 启动脚本（由 packaging/install.sh 生成；重跑 install.sh 会覆盖）
OWC_HOME='$LIB_DIR'
export OWC_CORE_PATH="\$OWC_HOME/bin/owc-exec"
: "\${OWC_PORT:=3000}"
export OWC_PORT
: "\${OWC_DATA_DIR:=\${XDG_DATA_HOME:-\$HOME/.local/share}/openwebcode}"
export OWC_DATA_DIR
if [ -x "\$OWC_HOME/node/bin/node" ]; then
    OWC_NODE="\$OWC_HOME/node/bin/node"
else
    OWC_NODE=node
fi
# owc run ... 走 headless CLI；不带 run 则启动 server
if [ "\${1:-}" = "run" ]; then
    exec "\$OWC_NODE" "\$OWC_HOME/server/dist/cli.js" "\$@"
fi
exec "\$OWC_NODE" "\$OWC_HOME/server/dist/index.js" "\$@"
EOF
chmod +x "$PREFIX/bin/owc"

if [ "$WITH_SYSTEMD" -eq 1 ]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/openwebcode.service" <<EOF
[Unit]
Description=OpenWebCode server
After=network-online.target

[Service]
ExecStart=$PREFIX/bin/owc
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    echo "已写入 $UNIT_DIR/openwebcode.service"
    echo "启用服务: systemctl --user daemon-reload && systemctl --user enable --now openwebcode"
fi

echo "安装完成: $LIB_DIR"
echo "启动:     $PREFIX/bin/owc  （浏览器打开 http://127.0.0.1:3000）"
