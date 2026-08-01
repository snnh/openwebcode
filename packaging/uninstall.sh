#!/bin/sh
# OpenWebCode 卸载脚本（Linux，POSIX sh）：撤销 install.sh 的全部动作。
#
# 用法:
#   ./uninstall.sh [--prefix <dir>] [--purge-data] [--data-dir <dir>] \
#     [--remove-firewall] [--yes]
#
# 安装时 install.sh 会把本脚本复制为 <prefix>/bin/owc-uninstall，可直接运行；
# 也可从发行包根目录运行 ./uninstall.sh。
#
# 参数:
#   --prefix <dir>       安装前缀（绝对路径）；缺省为卸载器自身所在安装
                       （<prefix>/bin/owc-uninstall 的 <prefix>），否则用户级
                       ~/.local、root /usr/local
#   --purge-data         同时删除数据目录（默认保留；非交互模式必须显式传入才会删除）
#   --data-dir <dir>     数据目录（绝对路径；默认用户级
#                        ${XDG_DATA_HOME:-~/.local/share}/openwebcode，root 为 /var/lib/openwebcode）
#   --remove-firewall    移除安装时放行的防火墙端口（firewalld/ufw，仅 root；
#                        端口从启动器 OWC_DEFAULT_PORT 解析）
#   --yes, -y            不交互；适合脚本
#   -h, --help           显示本帮助
#
# 动作（按序）:
#   1. 存在 systemd unit 时：systemctl disable --now（尽力而为）→ 删除 unit
#      → daemon-reload（root → /etc/systemd/system，否则用户级；目标目录可被
#      OWC_SYSTEMD_UNIT_DIR 覆盖）；
#   2. --remove-firewall 时移除防火墙端口规则；
#   3. 删除 <prefix>/lib/openwebcode 与 <prefix>/bin/owc；
#   4. --purge-data 时删除数据目录（交互模式会单独确认）；
#   5. 最后删除 <prefix>/bin/owc-uninstall 自身。
#
# 手动启动（非 systemd）的 owc 进程不在本脚本管理范围，请先自行停止。
set -eu

die() {
    echo "uninstall.sh: $1" >&2
    exit "${2:-2}"
}

usage() {
    cat >&2 <<'EOF'
用法: ./uninstall.sh [选项]

  --prefix <dir>       安装前缀（绝对路径）；缺省为卸载器自身所在安装
                       （<prefix>/bin/owc-uninstall 的 <prefix>），否则用户级
                       ~/.local、root /usr/local
  --purge-data         同时删除数据目录（默认保留）
  --data-dir <dir>     数据目录（绝对路径）
  --remove-firewall    移除安装时放行的防火墙端口（firewalld/ufw，仅 root）
  --yes, -y            不交互
  -h, --help           显示本帮助

删除内容：systemd unit（含停止/禁用服务）、<prefix>/lib/openwebcode、
<prefix>/bin/owc、<prefix>/bin/owc-uninstall；数据目录默认保留。
手动启动的 owc 进程请先自行停止。
EOF
}

valid_absolute_dir() {
    [ -n "$1" ] && [ "$1" != "/" ] || return 1
    case "$1" in
        /*) ;;
        *) return 1 ;;
    esac
    return 0
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

IS_ROOT=${OWC_INSTALL_IS_ROOT:-}
if [ -z "$IS_ROOT" ]; then
    # OWC_INSTALL_IS_ROOT 仅作测试钩子（与 install.sh 相同）；正常使用勿设
    if [ "$(id -u)" -eq 0 ]; then IS_ROOT=1; else IS_ROOT=0; fi
fi

default_prefix() {
    if [ "$IS_ROOT" -eq 1 ]; then
        printf '%s\n' /usr/local
    else
        printf '%s\n' "$HOME/.local"
    fi
}

default_data_dir() {
    if [ "$IS_ROOT" -eq 1 ]; then
        printf '%s\n' /var/lib/openwebcode
    elif [ -n "${XDG_DATA_HOME:-}" ]; then
        printf '%s\n' "$XDG_DATA_HOME/openwebcode"
    else
        printf '%s\n' "$HOME/.local/share/openwebcode"
    fi
}

[ -n "${HOME:-}" ] || die "HOME 未设置，无法选择默认前缀" 1

# 作为 <prefix>/bin/owc-uninstall 运行时，默认卸载自身所在安装；从发行包根目录
# 运行时回退到按 uid 分层的默认前缀。--prefix 始终优先。
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
case "$SCRIPT_DIR" in
    */bin) DEFAULT_PREFIX=${SCRIPT_DIR%/bin} ;;
    *) DEFAULT_PREFIX=$(default_prefix) ;;
esac

PREFIX=$DEFAULT_PREFIX
DATA_DIR=$(default_data_dir)
DATA_DIR_SET=0
PURGE_DATA=0
REMOVE_FIREWALL=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --prefix)
            [ $# -ge 2 ] || die "--prefix 需要一个目录参数"
            PREFIX=$2
            shift 2
            ;;
        --prefix=*)
            PREFIX=${1#--prefix=}
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
        --purge-data)
            PURGE_DATA=1
            shift
            ;;
        --remove-firewall)
            REMOVE_FIREWALL=1
            shift
            ;;
        --yes|-y)
            ASSUME_YES=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "uninstall.sh: 未知参数 $1" >&2
            usage
            exit 2
            ;;
    esac
done

valid_absolute_dir "$PREFIX" || die "非法 prefix: $PREFIX（应为非根目录的绝对路径）"
valid_absolute_dir "$DATA_DIR" || die "非法 data-dir: $DATA_DIR（应为非根目录的绝对路径）"
if [ "$REMOVE_FIREWALL" -eq 1 ]; then
    [ "$IS_ROOT" -eq 1 ] || die "--remove-firewall 需要 root" 1
fi

INTERACTIVE=0
if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
    INTERACTIVE=1
fi

# 物理解析 prefix，确保 rm -rf 的目标固定。
if [ ! -d "$PREFIX" ]; then
    die "prefix 不存在: $PREFIX（未发现 OpenWebCode 安装）" 1
fi
PREFIX=$(CDPATH= cd -P "$PREFIX" && pwd) || die "无法解析 prefix: $PREFIX" 1
valid_absolute_dir "$PREFIX" || die "解析后的 prefix 非法: $PREFIX" 1

LIB_DIR="$PREFIX/lib/openwebcode"
LAUNCHER="$PREFIX/bin/owc"
SELF="$PREFIX/bin/owc-uninstall"
if [ ! -d "$LIB_DIR" ] && [ ! -f "$LAUNCHER" ]; then
    die "未在 $PREFIX 发现 OpenWebCode 安装（缺少 lib/openwebcode 与 bin/owc）" 1
fi

if [ "$INTERACTIVE" -eq 1 ]; then
    ask_yes_no "卸载 $PREFIX 下的 OpenWebCode（停止并移除 systemd 服务、删除运行时与启动器）" yes
    [ "$REPLY" = yes ] || die "已取消" 1
    if [ "$PURGE_DATA" -eq 0 ] && [ -d "$DATA_DIR" ]; then
        ask_yes_no "同时删除数据目录 $DATA_DIR（会话、设置、令牌全部丢失）" no
        [ "$REPLY" = yes ] && PURGE_DATA=1
    fi
fi

# 1. systemd：先停服务再删 unit，最后 daemon-reload；systemctl 缺失时只删文件
if [ "$IS_ROOT" -eq 1 ]; then
    UNIT_DIR=${OWC_SYSTEMD_UNIT_DIR:-/etc/systemd/system}
    SYSTEMCTL="systemctl"
else
    UNIT_DIR=${OWC_SYSTEMD_UNIT_DIR:-"${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"}
    SYSTEMCTL="systemctl --user"
fi
if [ -f "$UNIT_DIR/openwebcode.service" ]; then
    if command -v systemctl >/dev/null 2>&1; then
        $SYSTEMCTL disable --now openwebcode 2>/dev/null || \
            echo "uninstall.sh: 警告：停止/禁用服务失败（可能本就不在运行），继续移除 unit" >&2
    fi
    rm -f "$UNIT_DIR/openwebcode.service"
    if command -v systemctl >/dev/null 2>&1; then
        $SYSTEMCTL daemon-reload 2>/dev/null || true
    fi
    echo "已移除 systemd 服务: $UNIT_DIR/openwebcode.service"
fi

# 2. 防火墙：仅在 --remove-firewall 时移除安装时放行的端口
if [ "$REMOVE_FIREWALL" -eq 1 ]; then
    PORT=''
    if [ -f "$LAUNCHER" ]; then
        PORT=$(sed -n "s/^OWC_DEFAULT_PORT='\\([0-9][0-9]*\\)'.*/\\1/p" "$LAUNCHER")
    fi
    if [ -z "$PORT" ]; then
        echo "uninstall.sh: 警告：无法从启动器解析端口，跳过防火墙规则移除" >&2
    elif command -v firewall-cmd >/dev/null 2>&1; then
        firewall-cmd --permanent --remove-port="$PORT/tcp" >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        echo "防火墙规则已移除（firewalld）：$PORT/tcp"
    elif command -v ufw >/dev/null 2>&1; then
        ufw delete allow "$PORT/tcp" >/dev/null 2>&1 || true
        echo "防火墙规则已移除（ufw）：$PORT/tcp"
    else
        echo "未检测到 firewalld/ufw；如有手动放行的 $PORT/tcp 请自行清理。" >&2
    fi
fi

# 3. 运行时与启动器
rm -rf "$LIB_DIR"
rm -f "$LAUNCHER"
echo "已删除: $LIB_DIR"
echo "已删除: $LAUNCHER"

# 4. 数据目录（默认保留；多重防护：非 /、非 HOME、非 prefix、绝对路径）
if [ "$PURGE_DATA" -eq 1 ]; then
    if [ "$DATA_DIR" = "$HOME" ] || [ "$DATA_DIR" = "$PREFIX" ] || [ "$DATA_DIR" = "/" ]; then
        die "拒绝删除危险路径: $DATA_DIR" 1
    fi
    if [ -d "$DATA_DIR" ]; then
        rm -rf "$DATA_DIR"
        echo "已删除数据目录: $DATA_DIR"
    else
        echo "数据目录不存在，跳过: $DATA_DIR"
    fi
else
    [ -d "$DATA_DIR" ] && echo "数据目录已保留: $DATA_DIR（如需删除用 --purge-data）"
fi

# 5. 自身：rm 必须是脚本最后一条命令——shell 边读边执行，此后再有需要读取的
# 行就会截断。运行自发行包根目录时 $SELF 不存在，rm -f 为空操作。
if [ -f "$SELF" ]; then
    echo "将删除卸载器自身: $SELF"
fi
echo "卸载完成。手动启动的 owc 进程如有残留请自行停止。"
rm -f "$SELF"
