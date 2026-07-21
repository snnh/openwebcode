#!/bin/sh
# OpenWebCode 安装脚本（Linux tar.gz 分发包用，POSIX sh）
#
# 用法（在解压后的包根目录执行）:
#   ./install.sh [--prefix <dir>] [--port <n>] [--data-dir <dir>] \
#     [--host <addr>] [--use-system-node] [--with-systemd] [--yes]
#
# 未传 --yes 且 stdin/stdout 都是 TTY 时，会仅询问没有由命令行指定的选项。
# 这让直接运行时可配置，也不会让 CI、重定向或管道安装阻塞。
#
# 参数:
#   --prefix <dir>       安装前缀（绝对路径），默认 ~/.local
#   --port <n>           启动器的 OWC_PORT 默认值（1-65535，默认 3000）
#   --data-dir <dir>     启动器的 OWC_DATA_DIR 默认值（必须为绝对路径）
#   --host <addr>        启动器的 OWC_HOST 默认值（默认 127.0.0.1）
#   --use-system-node    不复制包内 node/，安装时验证系统 Node.js >= 20
#   --with-systemd       额外写入用户级 systemd unit（不主动执行 systemctl）
#   --yes                静默安装；即使在 TTY 也不提问
#
# --system 和 --with-desktop-entry 尚未实现；脚本会明确失败，绝不静默伪装为
# 系统安装或桌面集成。
#
# 动作:
#   1. 把包内运行时（bin/ server/ web/，以及可选的 node/）复制到
#      <prefix>/lib/openwebcode/（重跑整体覆盖，幂等）；
#   2. 生成启动脚本 <prefix>/bin/owc；
#   3. --with-systemd 时写用户级 systemd unit（仅写文件并打印启用提示）。
#
# 卸载（以默认前缀为例）:
#   rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc
#   rm -f  ~/.config/systemd/user/openwebcode.service
#   rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/openwebcode"   # 用户数据，按需
set -eu

die() {
    echo "install.sh: $1" >&2
    exit "${2:-2}"
}

usage() {
    cat >&2 <<'EOF'
用法: ./install.sh [选项]

  --prefix <dir>       安装前缀（绝对路径），默认 ~/.local
  --port <n>           启动器默认端口（1-65535，默认 3000）
  --data-dir <dir>     启动器默认数据目录（必须为绝对路径）
  --host <addr>        启动器默认监听地址（默认 127.0.0.1）
  --use-system-node    使用系统 Node.js（安装时要求 >= 20）
  --with-systemd       写入用户级 systemd unit，不自动启用
  --yes, -y            不交互；适合 CI、脚本和重定向输入
  -h, --help           显示本帮助

未传 --yes 且 stdin/stdout 都是 TTY 时，脚本只询问未由命令行指定的选项。
命令行选项优先；生成的默认值仍可被运行时的 OWC_PORT、OWC_DATA_DIR、
OWC_HOST 环境变量覆盖。
EOF
}

contains_control_character() {
    # 不能让换行或其他控制字符进入生成的 shell/systemd 文件。
    printf '%s' "$1" | LC_ALL=C grep -q '[[:cntrl:]]'
}

valid_prefix() {
    [ -n "$1" ] && [ "$1" != "/" ] || return 1
    case "$1" in
        /*) ;;
        *) return 1 ;;
    esac
    if contains_control_character "$1"; then return 1; fi
    return 0
}

valid_data_dir() {
    [ -n "$1" ] && [ "$1" != "/" ] || return 1
    case "$1" in
        /*) ;;
        *) return 1 ;;
    esac
    if contains_control_character "$1"; then return 1; fi
    return 0
}

# 成功时把去除前导零后的十进制值放入 NORMALIZED_PORT，避免不同 shell 对
# 08 等值的八进制解释差异。
normalise_port() {
    candidate=$1
    case "$candidate" in
        ''|*[!0123456789]*) return 1 ;;
    esac
    while [ "${candidate#0}" != "$candidate" ]; do
        candidate=${candidate#0}
    done
    [ -n "$candidate" ] || candidate=0
    [ "${#candidate}" -le 5 ] || return 1
    [ "$candidate" -ge 1 ] && [ "$candidate" -le 65535 ] || return 1
    NORMALIZED_PORT=$candidate
    return 0
}

valid_host() {
    [ -n "$1" ] || return 1
    # 允许普通 DNS 名、IPv4 与未加方括号的 IPv6；不接受 URL 或 shell
    # 元字符。Node.js 负责最终的 DNS/IP 解析。
    case "$1" in
        -*|.|..|*..*|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-]*) return 1 ;;
    esac
    if contains_control_character "$1"; then return 1; fi
    return 0
}

is_loopback_host() {
    case "$1" in
        localhost|127.*|::1) return 0 ;;
        *) return 1 ;;
    esac
}

shell_quote() {
    # 生成器只对已校验、无控制字符的值调用此函数。单引号转义后可安全地
    # 写入 POSIX shell 启动器，即使路径中含空格或单引号。
    printf '%s' "$1" | sed "s/'/'\\\\''/g; 1s/^/'/; \$s/\$/'/"
}

ask_value() {
    prompt=$1
    default_value=$2
    printf '%s [%s]: ' "$prompt" "$default_value" >&2
    if IFS= read -r answer; then
        if [ -n "$answer" ]; then
            REPLY=$answer
        else
            REPLY=$default_value
        fi
    else
        # TTY 在安装途中被关闭时，不无限等待；保留安全的已有默认值。
        REPLY=$default_value
    fi
}

ask_yes_no() {
    prompt=$1
    default_answer=$2
    while :; do
        if [ "$default_answer" = yes ]; then
            suffix='Y/n'
        else
            suffix='y/N'
        fi
        printf '%s [%s]: ' "$prompt" "$suffix" >&2
        if ! IFS= read -r answer; then
            REPLY=$default_answer
            return 0
        fi
        case "$answer" in
            '') REPLY=$default_answer; return 0 ;;
            y|Y|yes|YES|Yes) REPLY=yes; return 0 ;;
            n|N|no|NO|No) REPLY=no; return 0 ;;
            *) echo "请输入 y 或 n。" >&2 ;;
        esac
    done
}

ask_until_valid() {
    prompt=$1
    default_value=$2
    validator=$3
    hint=$4
    while :; do
        ask_value "$prompt" "$default_value"
        if "$validator" "$REPLY"; then
            return 0
        fi
        echo "无效值；$hint。" >&2
    done
}

[ -n "${HOME:-}" ] || die "HOME 未设置，无法选择用户安装前缀" 1

PREFIX="$HOME/.local"
PORT=3000
HOST=127.0.0.1
if [ -n "${XDG_DATA_HOME:-}" ] && valid_data_dir "$XDG_DATA_HOME/openwebcode"; then
    DATA_DIR="$XDG_DATA_HOME/openwebcode"
else
    DATA_DIR="$HOME/.local/share/openwebcode"
fi
WITH_SYSTEMD=0
USE_SYSTEM_NODE=0
ASSUME_YES=0
PREFIX_SET=0
PORT_SET=0
DATA_DIR_SET=0
HOST_SET=0
WITH_SYSTEMD_SET=0
USE_SYSTEM_NODE_SET=0

while [ $# -gt 0 ]; do
    case "$1" in
        --prefix)
            [ $# -ge 2 ] || die "--prefix 需要一个目录参数"
            PREFIX=$2
            PREFIX_SET=1
            shift 2
            ;;
        --prefix=*)
            PREFIX=${1#--prefix=}
            PREFIX_SET=1
            shift
            ;;
        --port)
            [ $# -ge 2 ] || die "--port 需要一个端口参数"
            PORT=$2
            PORT_SET=1
            shift 2
            ;;
        --port=*)
            PORT=${1#--port=}
            PORT_SET=1
            shift
            ;;
        --data-dir)
            [ $# -ge 2 ] || die "--data-dir 需要一个目录参数"
            DATA_DIR=$2
            DATA_DIR_SET=1
            shift 2
            ;;
        --data-dir=*)
            DATA_DIR=${1#--data-dir=}
            DATA_DIR_SET=1
            shift
            ;;
        --host)
            [ $# -ge 2 ] || die "--host 需要一个地址参数"
            HOST=$2
            HOST_SET=1
            shift 2
            ;;
        --host=*)
            HOST=${1#--host=}
            HOST_SET=1
            shift
            ;;
        --use-system-node)
            USE_SYSTEM_NODE=1
            USE_SYSTEM_NODE_SET=1
            shift
            ;;
        --with-systemd)
            WITH_SYSTEMD=1
            WITH_SYSTEMD_SET=1
            shift
            ;;
        --yes|-y)
            ASSUME_YES=1
            shift
            ;;
        --system|--with-desktop-entry)
            die "$1 尚未实现；该 tar.gz 目前只支持用户级 prefix 与 --with-systemd，未静默执行系统级或桌面集成操作"
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

# 包根目录 = 脚本所在目录（tar.gz 顶层即 install.sh + bin/ + server/ + web/ [+ node/]）
SRC_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
for d in bin server web; do
    if [ ! -d "$SRC_DIR/$d" ]; then
        die "包内容不完整（缺少 $d/），请在解压后的包根目录运行" 1
    fi
done

BUNDLED_NODE=0
if [ -x "$SRC_DIR/node/bin/node" ]; then
    BUNDLED_NODE=1
fi

INTERACTIVE=0
if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
    INTERACTIVE=1
fi

if [ "$INTERACTIVE" -eq 1 ]; then
    echo "OpenWebCode 安装配置（直接回车保留默认值；命令行传入的选项不会被询问）" >&2
    if [ "$PREFIX_SET" -eq 0 ]; then
        ask_until_valid "安装前缀" "$PREFIX" valid_prefix "请输入非根目录的绝对路径"
        PREFIX=$REPLY
    fi
    if [ "$PORT_SET" -eq 0 ]; then
        ask_until_valid "默认监听端口" "$PORT" normalise_port "端口必须是 1-65535 的十进制整数"
        PORT=$NORMALIZED_PORT
    fi
    if [ "$DATA_DIR_SET" -eq 0 ]; then
        ask_until_valid "默认数据目录" "$DATA_DIR" valid_data_dir "请输入非根目录的绝对路径"
        DATA_DIR=$REPLY
    fi
    if [ "$HOST_SET" -eq 0 ]; then
        while :; do
            ask_until_valid "默认监听地址" "$HOST" valid_host "请输入 DNS 名、IPv4 或未加方括号的 IPv6 地址"
            HOST=$REPLY
            if is_loopback_host "$HOST"; then break; fi
            echo "警告：非回环地址会把 OpenWebCode 暴露给网络；本安装器不会配置 HTTP 认证。" >&2
            ask_yes_no "确认使用 $HOST（仅应在受信网络或认证反向代理后使用）" no
            [ "$REPLY" = yes ] && break
        done
    fi
    if [ "$USE_SYSTEM_NODE_SET" -eq 0 ]; then
        if [ "$BUNDLED_NODE" -eq 1 ]; then
            ask_yes_no "使用系统 Node.js 而不复制包内运行时" no
            [ "$REPLY" = yes ] && USE_SYSTEM_NODE=1 || USE_SYSTEM_NODE=0
        else
            echo "包内没有可执行 node/bin/node；必须使用系统 Node.js。" >&2
            USE_SYSTEM_NODE=1
        fi
    fi
    if [ "$WITH_SYSTEMD_SET" -eq 0 ]; then
        ask_yes_no "写入用户级 systemd 服务文件（不会自动启用）" no
        [ "$REPLY" = yes ] && WITH_SYSTEMD=1 || WITH_SYSTEMD=0
    fi
fi

valid_prefix "$PREFIX" || die "非法 prefix: $PREFIX"
normalise_port "$PORT" || die "非法 port: $PORT（应为 1-65535 的十进制整数）"
PORT=$NORMALIZED_PORT
valid_data_dir "$DATA_DIR" || die "非法 data-dir: $DATA_DIR（应为非根目录的绝对路径）"
valid_host "$HOST" || die "非法 host: $HOST（应为 DNS 名、IPv4 或未加方括号的 IPv6）"

# 先创建并物理解析 prefix；这既让 /tmp/..、符号链接等输入归一，也确保后续
# rm -rf 的目标固定在解析后的 <prefix>/lib/openwebcode 下，而非调用者 CWD。
mkdir -p "$PREFIX" || die "无法创建 prefix: $PREFIX" 1
PREFIX=$(CDPATH= cd -P "$PREFIX" && pwd) || die "无法解析 prefix: $PREFIX" 1
valid_prefix "$PREFIX" || die "解析后的 prefix 非法: $PREFIX" 1

if [ "$USE_SYSTEM_NODE" -eq 0 ] && [ "$BUNDLED_NODE" -eq 0 ]; then
    echo "install.sh: 包内没有可执行 node/bin/node；改用系统 Node.js。" >&2
    USE_SYSTEM_NODE=1
fi

SYSTEM_NODE=''
if [ "$USE_SYSTEM_NODE" -eq 1 ]; then
    SYSTEM_NODE=$(command -v node 2>/dev/null || true)
    case "$SYSTEM_NODE" in
        /*) [ -x "$SYSTEM_NODE" ] || die "系统 node 不可执行: $SYSTEM_NODE" 1 ;;
        *) die "未找到可执行的系统 node；--use-system-node 需要 Node.js >= 20" 1 ;;
    esac
    if ! SYSTEM_NODE_VERSION=$("$SYSTEM_NODE" -p 'process.versions.node' 2>/dev/null); then
        die "无法读取系统 Node.js 版本: $SYSTEM_NODE" 1
    fi
    SYSTEM_NODE_MAJOR=${SYSTEM_NODE_VERSION%%.*}
    case "$SYSTEM_NODE_VERSION" in
        "$SYSTEM_NODE_MAJOR".*) ;;
        *) die "系统 node 返回了无效版本: $SYSTEM_NODE_VERSION" 1 ;;
    esac
    case "$SYSTEM_NODE_MAJOR" in
        ''|*[!0123456789]*) die "系统 node 返回了无效版本: $SYSTEM_NODE_VERSION" 1 ;;
    esac
    [ "${#SYSTEM_NODE_MAJOR}" -le 3 ] && [ "$SYSTEM_NODE_MAJOR" -ge 20 ] || \
        die "系统 Node.js 版本必须 >= 20（当前 $SYSTEM_NODE_VERSION）" 1
fi

if ! is_loopback_host "$HOST"; then
    echo "警告：OWC_HOST=$HOST 不是回环地址。安装器不会配置 HTTP 认证；请仅在受信网络或认证反向代理后使用。" >&2
fi

LIB_DIR="$PREFIX/lib/openwebcode"
mkdir -p "$PREFIX/lib" "$PREFIX/bin"
rm -rf "$LIB_DIR"
mkdir -p "$LIB_DIR"
cp -R "$SRC_DIR/bin" "$SRC_DIR/server" "$SRC_DIR/web" "$LIB_DIR/"
if [ "$USE_SYSTEM_NODE" -eq 0 ] && [ "$BUNDLED_NODE" -eq 1 ]; then
    cp -R "$SRC_DIR/node" "$LIB_DIR/"
fi
chmod +x "$LIB_DIR/bin/owc-exec" 2>/dev/null || true

# 启动脚本 <prefix>/bin/owc：环境变量显式设置时始终优先于安装时选择的默认值。
Q_LIB_DIR=$(shell_quote "$LIB_DIR")
Q_PORT=$(shell_quote "$PORT")
Q_DATA_DIR=$(shell_quote "$DATA_DIR")
Q_HOST=$(shell_quote "$HOST")
cat > "$PREFIX/bin/owc" <<EOF
#!/bin/sh
# OpenWebCode 启动脚本（由 packaging/install.sh 生成；重跑 install.sh 会覆盖）
OWC_HOME=$Q_LIB_DIR
export OWC_CORE_PATH="\$OWC_HOME/bin/owc-exec"
OWC_DEFAULT_PORT=$Q_PORT
OWC_DEFAULT_DATA_DIR=$Q_DATA_DIR
OWC_DEFAULT_HOST=$Q_HOST
: "\${OWC_PORT:=\$OWC_DEFAULT_PORT}"
: "\${OWC_DATA_DIR:=\$OWC_DEFAULT_DATA_DIR}"
: "\${OWC_HOST:=\$OWC_DEFAULT_HOST}"
export OWC_PORT OWC_DATA_DIR OWC_HOST
EOF
if [ "$USE_SYSTEM_NODE" -eq 1 ]; then
    Q_SYSTEM_NODE=$(shell_quote "$SYSTEM_NODE")
    printf '%s\n' "OWC_NODE=$Q_SYSTEM_NODE" >> "$PREFIX/bin/owc"
else
    cat >> "$PREFIX/bin/owc" <<'EOF'
OWC_NODE="$OWC_HOME/node/bin/node"
EOF
fi
cat >> "$PREFIX/bin/owc" <<'EOF'
# owc run ... 走 headless CLI；不带 run 则启动 server。
if [ "${1:-}" = "run" ]; then
    exec "$OWC_NODE" "$OWC_HOME/server/dist/cli.js" "$@"
fi
exec "$OWC_NODE" "$OWC_HOME/server/dist/index.js" "$@"
EOF
chmod +x "$PREFIX/bin/owc"

if [ "$WITH_SYSTEMD" -eq 1 ]; then
    # systemd ExecStart 的解析不与 shell 相同；对用��级 unit 限制为常见安全路径，
    # 避免空格/引号导致生成一个和安装路径不一致的服务。
    case "$PREFIX" in
        *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@%+=:,./-]*)
            die "--with-systemd 要求 prefix 不含空格、引号或其他 systemd 特殊字符" 1
            ;;
    esac
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
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

case "$HOST" in
    *:*) DISPLAY_HOST="[$HOST]" ;;
    *) DISPLAY_HOST=$HOST ;;
esac
echo "安装完成: $LIB_DIR"
echo "启动:     $PREFIX/bin/owc  （浏览器打开 http://$DISPLAY_HOST:$PORT）"
