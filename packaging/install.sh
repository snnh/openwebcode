#!/bin/sh
# OpenWebCode 安装脚本（Linux tar.gz 分发包用，POSIX sh）
#
# 用法（在解压后的包根目录执行）:
#   ./install.sh [--prefix <dir>] [--port <n>] [--data-dir <dir>] \
#     [--host <addr> | --lan] [--system] [--use-system-node] \
#     [--with-systemd] [--enable-service] [--open-firewall] [--yes]
#
# 未传 --yes 且 stdin/stdout 都是 TTY 时，会仅询问没有由命令行指定的选项。
# 这让直接运行时可配置，也不会让 CI、重定向或管道安装阻塞。
#
# 参数:
#   --prefix <dir>       安装前缀（绝对路径），默认用户级 ~/.local，root 为 /usr/local
#   --port <n>           启动器的 OWC_PORT 默认值（1-65535，默认 3000）
#   --data-dir <dir>     启动器的 OWC_DATA_DIR 默认值（绝对路径；默认用户级
#                        ${XDG_DATA_HOME:-~/.local/share}/openwebcode，root 为 /var/lib/openwebcode）
#   --host <addr>        启动器的 OWC_HOST 默认值（默认 127.0.0.1）
#   --lan                --host 0.0.0.0 的快捷方式（开启局域网访问；与 --host 互斥）
#   --system             显式系统级安装（需要 root；root 运行时本就走系统级默认路径）
#   --use-system-node    不复制包内 node/，安装时验证系统 Node.js >= 24
#   --with-systemd       写入 systemd unit（root → /etc/systemd/system，否则用户级；
#                        可用 OWC_SYSTEMD_UNIT_DIR 覆盖目标目录；不主动执行 systemctl）
#   --enable-service     隐含 --with-systemd，并执行 systemctl daemon-reload + enable --now
#   --open-firewall      非回环监听时放行防火墙端口（firewalld/ufw，仅 root）
#   --yes                静默安装；即使在 TTY 也不提问
#
# --with-desktop-entry 尚未实现；脚本会明确失败，绝不静默伪装为桌面集成。
#
# 动作:
#   1. 把包内运行时（bin/ server/ web/，以及可选的 node/）复制到
#      <prefix>/lib/openwebcode/（重跑整体覆盖，幂等）；
#   2. 生成启动脚本 <prefix>/bin/owc（已存在时提取既有变量作为本次默认值，
#      命令行显式参数仍最优先）；
#   3. 检测既有 systemd unit（root → /etc/systemd/system，否则用户级）：
#      同路径判定为更新——重写 unit 保留 enabled 状态、服务在运行则完成后重启，
#      交互模式只一次确认；不同路径交互三选（切换服务/仅装文件/中止），
#      非 TTY 打印警告并默认仅装文件；
#   4. --with-systemd 时写 systemd unit（含 NoNewPrivileges 加固，系统级再加
#      ProtectSystem=full + ReadWritePaths=<数据目录>）；--enable-service 时
#      立即启用并启动；交互模式仅当 systemd 真实可用才询问写服务；
#   5. 非回环监听且访问令牌已生成（如服务已启动）时，打印一键访问链接；
#      结尾检测 <prefix>/bin 是否在 PATH，不在则按用户 shell 给出 export 指引。
#
# 卸载：运行 <prefix>/bin/owc-uninstall（安装时由本脚本落盘），或发行包根目录的
# ./uninstall.sh；可加 --purge-data 一并删除数据目录，--remove-firewall 移除
# 防火墙规则（root）。手动卸载步骤:
#   用户级: rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc ~/.local/bin/owc-uninstall
#           rm -f  ~/.config/systemd/user/openwebcode.service
#           rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/openwebcode"   # 用户数据，按需
#   系统级: systemctl disable --now openwebcode
#           rm -f  /etc/systemd/system/openwebcode.service
#           rm -rf /usr/local/lib/openwebcode /usr/local/bin/owc /usr/local/bin/owc-uninstall
#           rm -rf /var/lib/openwebcode   # 用户数据，按需
set -eu

die() {
    echo "install.sh: $1" >&2
    exit "${2:-2}"
}

usage() {
    cat >&2 <<'EOF'
用法: ./install.sh [选项]

  --prefix <dir>       安装前缀（绝对路径），默认用户级 ~/.local，root 为 /usr/local
  --port <n>           启动器默认端口（1-65535，默认 3000）
  --data-dir <dir>     启动器默认数据目录（必须为绝对路径）
  --host <addr>        启动器默认监听地址（默认 127.0.0.1）
  --lan                开启局域网访问（等价 --host 0.0.0.0；与 --host 互斥）
  --system             显式系统级安装（需要 root）
  --use-system-node    使用系统 Node.js（安装时要求 >= 24）
  --with-systemd       写入 systemd 服务文件（root 写系统级，否则用户级），不自动启用
  --enable-service     写入并立即启用、启动 systemd 服务（systemctl enable --now）
  --open-firewall      非回环监听时放行防火墙端口（firewalld/ufw，仅 root）
  --yes, -y            不交互；适合 CI、脚本和重定向输入
  -h, --help           显示本帮助

未传 --yes 且 stdin/stdout 都是 TTY 时，脚本只询问未由命令行指定的选项。
命令行选项优先；生成的默认值仍可被运行时的 OWC_PORT、OWC_DATA_DIR、
OWC_HOST 环境变量覆盖。非回环监听的访问令牌由服务端首次启动时自动生成并
持久化（<数据目录>/access-token，0600），可用 OWC_ACCESS_TOKEN 显式覆盖。
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

IS_ROOT=${OWC_INSTALL_IS_ROOT:-}
if [ -z "$IS_ROOT" ]; then
    # OWC_INSTALL_IS_ROOT 仅作测试钩子（非 root 环境覆盖 root 分支）；正常安装勿设
    if [ "$(id -u)" -eq 0 ]; then IS_ROOT=1; else IS_ROOT=0; fi
fi

# 默认安装前缀/数据目录按 uid 分层：root 走系统级路径，普通用户走用户级路径。
# 函数在调用时读取 IS_ROOT，测试可覆盖该变量直接断言两个分支。
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

PREFIX=$(default_prefix)
PORT=3000
HOST=127.0.0.1
DATA_DIR=$(default_data_dir)
WITH_SYSTEMD=0
ENABLE_SERVICE=0
OPEN_FIREWALL=0
USE_SYSTEM_NODE=0
ASSUME_YES=0
SYSTEM_INSTALL=0
PREFIX_SET=0
PORT_SET=0
DATA_DIR_SET=0
HOST_SET=0
LAN_SET=0
WITH_SYSTEMD_SET=0
USE_SYSTEM_NODE_SET=0
OPEN_FIREWALL_SET=0

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
            [ "$LAN_SET" -eq 0 ] || die "--lan 与 --host 互斥"
            HOST=$2
            HOST_SET=1
            shift 2
            ;;
        --host=*)
            [ "$LAN_SET" -eq 0 ] || die "--lan 与 --host 互斥"
            HOST=${1#--host=}
            HOST_SET=1
            shift
            ;;
        --lan)
            [ "$HOST_SET" -eq 0 ] || die "--lan 与 --host 互斥"
            HOST=0.0.0.0
            HOST_SET=1
            LAN_SET=1
            shift
            ;;
        --system)
            [ "$IS_ROOT" -eq 1 ] || die "--system 需要 root（或用 sudo）；非 root 请直接运行，即为用户级安装"
            SYSTEM_INSTALL=1
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
        --enable-service)
            ENABLE_SERVICE=1
            WITH_SYSTEMD=1
            WITH_SYSTEMD_SET=1
            shift
            ;;
        --open-firewall)
            OPEN_FIREWALL=1
            OPEN_FIREWALL_SET=1
            shift
            ;;
        --yes|-y)
            ASSUME_YES=1
            shift
            ;;
        --with-desktop-entry)
            die "$1 尚未实现；该 tar.gz 目前只支持 prefix 安装与 systemd 集成，未静默执行桌面集成操作"
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

# 交互先只确定 prefix：既有安装检测（更新 vs 重装）要把 unit ExecStart 反推出的
# 前缀与解析后的 PREFIX 比对，其余选项的提问放在检测之后。
if [ "$INTERACTIVE" -eq 1 ]; then
    echo "OpenWebCode 安装配置（直接回车保留默认值；命令行传入的选项不会被询问）" >&2
    if [ "$IS_ROOT" -eq 1 ] && [ "$PREFIX_SET" -eq 0 ] && [ "$SYSTEM_INSTALL" -eq 0 ]; then
        ask_yes_no "检测到 root：进行系统级安装（默认 prefix /usr/local，服务以 root 运行）" yes
        if [ "$REPLY" = yes ]; then
            SYSTEM_INSTALL=1
        else
            die "已取消；如需自定义路径安装请显式传 --prefix/--data-dir" 1
        fi
    fi
    if [ "$PREFIX_SET" -eq 0 ]; then
        ask_until_valid "安装前缀" "$PREFIX" valid_prefix "请输入非根目录的绝对路径"
        PREFIX=$REPLY
    fi
fi

# 先创建并物理解析 prefix；这既让 /tmp/..、符号链接等输入归一，也确保后续
# rm -rf 的目标固定在解析后的 <prefix>/lib/openwebcode 下，而非调用者 CWD。
valid_prefix "$PREFIX" || die "非法 prefix: $PREFIX"
mkdir -p "$PREFIX" || die "无法创建 prefix: $PREFIX" 1
PREFIX=$(CDPATH= cd -P "$PREFIX" && pwd) || die "无法解析 prefix: $PREFIX" 1
valid_prefix "$PREFIX" || die "解析后的 prefix 非法: $PREFIX" 1

# ---- 既有安装检测（更新 vs 重装）----
# 按 uid 定位既有 unit（root → 系统级，否则用户级；OWC_SYSTEMD_UNIT_DIR 仅作
# 测试钩子覆盖目标目录），从 ExecStart=<prefix>/bin/owc 反推既有安装前缀。
if [ "$IS_ROOT" -eq 1 ]; then
    UNIT_DIR=${OWC_SYSTEMD_UNIT_DIR:-/etc/systemd/system}
    SYSTEMCTL="systemctl"
else
    UNIT_DIR=${OWC_SYSTEMD_UNIT_DIR:-"${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"}
    SYSTEMCTL="systemctl --user"
fi
EXISTING_UNIT=''
EXISTING_PREFIX=''
if [ -f "$UNIT_DIR/openwebcode.service" ]; then
    EXISTING_UNIT="$UNIT_DIR/openwebcode.service"
    exec_start=$(grep '^ExecStart=' "$EXISTING_UNIT" | head -n 1)
    exec_start=${exec_start#ExecStart=}
    case "$exec_start" in
        */bin/owc) EXISTING_PREFIX=${exec_start%/bin/owc} ;;
    esac
    # 与 PREFIX 同样物理解析，避免符号链接路径被误判为另一处安装
    if [ -n "$EXISTING_PREFIX" ] && [ -d "$EXISTING_PREFIX" ]; then
        EXISTING_PREFIX=$(CDPATH= cd -P "$EXISTING_PREFIX" && pwd) || EXISTING_PREFIX=''
    fi
fi

UPDATE_MODE=0
SWITCH_SERVICE=0
WAS_ENABLED=0
WAS_ACTIVE=0
if [ -n "$EXISTING_UNIT" ]; then
    if command -v systemctl >/dev/null 2>&1; then
        [ "$($SYSTEMCTL is-enabled openwebcode 2>/dev/null || true)" = "enabled" ] && WAS_ENABLED=1
        [ "$($SYSTEMCTL is-active openwebcode 2>/dev/null || true)" = "active" ] && WAS_ACTIVE=1
    fi
    if [ -n "$EXISTING_PREFIX" ] && [ "$EXISTING_PREFIX" = "$PREFIX" ]; then
        # 同路径 → 更新：保留旧启动器变量（见下），重写 unit 但保留启用状态，
        # 服务在运行则安装完成后重启。非 TTY 不提问，只打印检测状态。
        UPDATE_MODE=1
        WITH_SYSTEMD=1
        echo "检测到同路径既有安装（$EXISTING_UNIT），按更新处理：保留启动器变量与既有服务配置。"
        if [ "$INTERACTIVE" -eq 1 ]; then
            ask_yes_no "检测到同路径既有安装，更新？" yes
            [ "$REPLY" = yes ] || die "已取消" 1
        fi
    elif [ "$INTERACTIVE" -eq 1 ]; then
        # 不同路径 → 三选：切换服务到本次路径 / 仅装文件 / 中止
        echo "检测到既有 systemd 服务指向其他安装路径: ${EXISTING_PREFIX:-未知}（$EXISTING_UNIT）" >&2
        echo "  1) 切换服务到本次路径 $PREFIX（重写 unit + daemon-reload，旧服务在运行则重启）" >&2
        echo "  2) 仅安装文件，不改动既有服务" >&2
        echo "  3) 中止安装" >&2
        while :; do
            printf '请选择 [1/2/3，默认 2]: ' >&2
            if ! IFS= read -r answer; then answer=2; fi
            case "$answer" in
                ''|2) break ;;
                1) SWITCH_SERVICE=1; WITH_SYSTEMD=1; break ;;
                3) die "已取消" 1 ;;
                *) echo "请输入 1、2 或 3。" >&2 ;;
            esac
        done
    elif [ "$WITH_SYSTEMD" -eq 0 ]; then
        # 非 TTY 默认仅装文件；显式 --with-systemd/--enable-service 才把服务切到新路径
        echo "警告：检测到既有 systemd 服务指向其他路径 ${EXISTING_PREFIX:-未知}，与本次前缀 $PREFIX 不同；默认仅安装文件，不改动既有服务（如需切换请显式传 --with-systemd）。" >&2
    fi
else
    echo "未检测到既有 systemd 服务，按全新安装处理。"
fi

# ---- 更新保留启动脚本变量 ----
# 启动器已存在时，提取既有 OWC_DEFAULT_PORT/OWC_DEFAULT_DATA_DIR/
# OWC_DEFAULT_HOST/OWC_NODE 作为本次默认值；命令行显式参数（*_SET）仍最优先。
launcher_var() {
    raw=$(sed -n "s/^$1=//p" "$2" | head -n 1)
    case "$raw" in
        \'*\')
            raw=${raw#\'}
            raw=${raw%\'}
            printf '%s' "$raw" | sed "s/'\\\\''/'/g"
            ;;
        \"*\")
            raw=${raw#\"}
            raw=${raw%\"}
            printf '%s' "$raw"
            ;;
        *) printf '%s' "$raw" ;;
    esac
}

SYSTEM_NODE=''
LAUNCHER="$PREFIX/bin/owc"
if [ -f "$LAUNCHER" ]; then
    preserved=$(launcher_var OWC_DEFAULT_PORT "$LAUNCHER")
    if [ "$PORT_SET" -eq 0 ] && [ -n "$preserved" ] && normalise_port "$preserved"; then
        PORT=$NORMALIZED_PORT
    fi
    preserved=$(launcher_var OWC_DEFAULT_DATA_DIR "$LAUNCHER")
    if [ "$DATA_DIR_SET" -eq 0 ] && [ -n "$preserved" ] && valid_data_dir "$preserved"; then
        DATA_DIR=$preserved
    fi
    preserved=$(launcher_var OWC_DEFAULT_HOST "$LAUNCHER")
    if [ "$HOST_SET" -eq 0 ] && [ -n "$preserved" ] && valid_host "$preserved"; then
        HOST=$preserved
    fi
    if [ "$USE_SYSTEM_NODE_SET" -eq 0 ]; then
        preserved=$(launcher_var OWC_NODE "$LAUNCHER")
        case "$preserved" in
            ''|*OWC_HOME*) : ;;  # 包内 node 形式（$OWC_HOME/node/bin/node），走默认逻辑
            *)
                if [ -x "$preserved" ]; then
                    USE_SYSTEM_NODE=1
                    SYSTEM_NODE=$preserved
                fi
                ;;
        esac
    fi
fi

# systemd 真实可用性：仅决定交互模式是否询问写服务；显式 --with-systemd 不受限。
systemd_available() {
    command -v systemctl >/dev/null 2>&1 || return 1
    if [ "$IS_ROOT" -eq 1 ]; then
        [ -d /run/systemd/system ]
    else
        systemctl --user show-environment >/dev/null 2>&1
    fi
}

# 其余交互提问。同路径更新只有上面一次确认，不再逐项提问。
if [ "$INTERACTIVE" -eq 1 ] && [ "$UPDATE_MODE" -eq 0 ]; then
    if [ "$PORT_SET" -eq 0 ]; then
        ask_until_valid "默认监听端口" "$PORT" normalise_port "端口必须是 1-65535 的十进制整数"
        PORT=$NORMALIZED_PORT
    fi
    if [ "$DATA_DIR_SET" -eq 0 ]; then
        ask_until_valid "默认数据目录" "$DATA_DIR" valid_data_dir "请输入非根目录的绝对路径"
        DATA_DIR=$REPLY
    fi
    if [ "$HOST_SET" -eq 0 ]; then
        ask_yes_no "开启局域网访问（监听 0.0.0.0；访问令牌由服务端首次启动自动生成）" no
        if [ "$REPLY" = yes ]; then
            HOST=0.0.0.0
        else
            while :; do
                ask_until_valid "默认监听地址" "$HOST" valid_host "请输入 DNS 名、IPv4 或未加方括号的 IPv6 地址"
                HOST=$REPLY
                if is_loopback_host "$HOST"; then break; fi
                echo "警告：非回环地址会把 OpenWebCode 暴露给网络；服务端会强制访问令牌认证（自动生成，OWC_ACCESS_TOKEN 可覆盖）。" >&2
                ask_yes_no "确认使用 $HOST（仅应在受信网络或认证反向代理后使用）" no
                [ "$REPLY" = yes ] && break
            done
        fi
    fi
    if [ "$USE_SYSTEM_NODE_SET" -eq 0 ] && [ -z "$SYSTEM_NODE" ]; then
        if [ "$BUNDLED_NODE" -eq 1 ]; then
            ask_yes_no "使用系统 Node.js 而不复制包内运行时" no
            [ "$REPLY" = yes ] && USE_SYSTEM_NODE=1 || USE_SYSTEM_NODE=0
        else
            echo "包内没有可执行 node/bin/node；必须使用系统 Node.js。" >&2
            USE_SYSTEM_NODE=1
        fi
    fi
    if [ "$WITH_SYSTEMD_SET" -eq 0 ] && [ -z "$EXISTING_UNIT" ]; then
        if systemd_available; then
            if [ "$IS_ROOT" -eq 1 ]; then
                systemd_kind="系统级 systemd 服务（/etc/systemd/system）"
            else
                systemd_kind="用户级 systemd 服务"
            fi
            ask_yes_no "写入 $systemd_kind 文件" no
            if [ "$REPLY" = yes ]; then
                WITH_SYSTEMD=1
                ask_yes_no "立即启用并启动该服务（systemctl enable --now）" yes
                [ "$REPLY" = yes ] && ENABLE_SERVICE=1
            fi
        else
            echo "未检测到可用的 systemd，跳过服务安装提问（之后可用 --with-systemd 显式写入 unit）。"
        fi
    fi
    if [ "$IS_ROOT" -eq 1 ] && ! is_loopback_host "$HOST" && [ "$OPEN_FIREWALL_SET" -eq 0 ]; then
        if command -v firewall-cmd >/dev/null 2>&1 || command -v ufw >/dev/null 2>&1; then
            ask_yes_no "在防火墙放行端口 $PORT/tcp（firewalld/ufw）" yes
            [ "$REPLY" = yes ] && OPEN_FIREWALL=1
        fi
    fi
fi

normalise_port "$PORT" || die "非法 port: $PORT（应为 1-65535 的十进制整数）"
PORT=$NORMALIZED_PORT
valid_data_dir "$DATA_DIR" || die "非法 data-dir: $DATA_DIR（应为非根目录的绝对路径）"
valid_host "$HOST" || die "非法 host: $HOST（应为 DNS 名、IPv4 或未加方括号的 IPv6）"
if [ "$ENABLE_SERVICE" -eq 1 ]; then
    command -v systemctl >/dev/null 2>&1 || die "--enable-service 需要 systemctl" 1
fi
if [ "$OPEN_FIREWALL" -eq 1 ]; then
    [ "$IS_ROOT" -eq 1 ] || die "--open-firewall 需要 root" 1
    is_loopback_host "$HOST" && die "--open-firewall 仅在非回环监听（--lan/--host）时有意义"
fi

if [ "$USE_SYSTEM_NODE" -eq 0 ] && [ "$BUNDLED_NODE" -eq 0 ]; then
    echo "install.sh: 包内没有可执行 node/bin/node；改用系统 Node.js。" >&2
    USE_SYSTEM_NODE=1
fi

# SYSTEM_NODE 非空表示沿用旧启动器 pin 的系统 node（安装时已校验过，不再重复校验）。
if [ "$USE_SYSTEM_NODE" -eq 1 ] && [ -z "$SYSTEM_NODE" ]; then
    SYSTEM_NODE=$(command -v node 2>/dev/null || true)
    case "$SYSTEM_NODE" in
        /*) [ -x "$SYSTEM_NODE" ] || die "系统 node 不可执行: $SYSTEM_NODE" 1 ;;
        *) die "未找到可执行的系统 node；--use-system-node 需要 Node.js >= 24" 1 ;;
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
    [ "${#SYSTEM_NODE_MAJOR}" -le 3 ] && [ "$SYSTEM_NODE_MAJOR" -ge 24 ] || \
        die "系统 Node.js 版本必须 >= 24（当前 $SYSTEM_NODE_VERSION）" 1
fi

if ! is_loopback_host "$HOST"; then
    # server 对非回环监听强制访问令牌认证：未显式 OWC_ACCESS_TOKEN 时，服务端
    # 首次启动自动生成并持久化到 <数据目录>/access-token（0600），控制台与
    # 设置页都会展示一键访问链接；OWC_ALLOWED_ORIGINS 缺省同源自动放行。
    echo "提示：非回环监听（$HOST）。访问令牌由服务端首次启动自动生成；访问链接会打印在服务端控制台，也可在 设置 → 远程访问 查看/扫码。" >&2
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
# OpenWebCode 启动脚本（由 packaging/install.sh 生成；重跑 install.sh 保留既有变量设置）
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
chmod 755 "$PREFIX/bin/owc"

# 卸载器随安装落盘为 <prefix>/bin/owc-uninstall（包内没有该文件时跳过）
if [ -f "$SRC_DIR/uninstall.sh" ]; then
    cp "$SRC_DIR/uninstall.sh" "$PREFIX/bin/owc-uninstall"
    chmod 755 "$PREFIX/bin/owc-uninstall"
fi

if [ "$WITH_SYSTEMD" -eq 1 ]; then
    # systemd ExecStart 的解析不与 shell 相同；对 unit 限制为常见安全路径，
    # 避免空格/引号导致生成一个和安装路径不一致的服务。更新/切换场景既有 unit
    # 已指向该路径，写不动就保留旧 unit，不让整个安装失败。
    case "$PREFIX" in
        *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@%+=:,./-]*)
            if [ "$UPDATE_MODE" -eq 1 ] || [ "$SWITCH_SERVICE" -eq 1 ]; then
                echo "警告：prefix 含空格或 systemd 特殊字符，跳过 unit 重写（既有 unit 保持不变）。" >&2
                WITH_SYSTEMD=0
            else
                die "--with-systemd 要求 prefix 不含空格、引号或其他 systemd 特殊字符" 1
            fi
            ;;
    esac
fi
if [ "$WITH_SYSTEMD" -eq 1 ]; then
    mkdir -p "$UNIT_DIR"
    # 新写 unit 一律加 NoNewPrivileges；系统级再加 ProtectSystem=full，数据目录
    # 经 ReadWritePaths 保持可写（data-dir 含特殊字符时退化为仅 NoNewPrivileges）。
    SYSTEM_HARDENING=''
    if [ "$IS_ROOT" -eq 1 ]; then
        case "$DATA_DIR" in
            *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@%+=:,./-]*)
                echo "警告：data-dir 含 systemd 特殊字符，系统级 unit 仅启用 NoNewPrivileges。" >&2
                ;;
            *)
                SYSTEM_HARDENING=$(printf 'ProtectSystem=full\nReadWritePaths=%s' "$DATA_DIR")
                ;;
        esac
    fi
    if [ "$IS_ROOT" -eq 1 ]; then
        {
            cat <<EOF
[Unit]
Description=OpenWebCode server
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=$PREFIX/bin/owc
Restart=on-failure
NoNewPrivileges=true
EOF
            if [ -n "$SYSTEM_HARDENING" ]; then
                printf '%s\n' "$SYSTEM_HARDENING"
            fi
            cat <<EOF

[Install]
WantedBy=multi-user.target
EOF
        } > "$UNIT_DIR/openwebcode.service"
    else
        cat > "$UNIT_DIR/openwebcode.service" <<EOF
[Unit]
Description=OpenWebCode server
After=network-online.target

[Service]
ExecStart=$PREFIX/bin/owc
Restart=on-failure
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
    fi
    echo "已写入 $UNIT_DIR/openwebcode.service"
    if [ "$UPDATE_MODE" -eq 1 ] || [ "$SWITCH_SERVICE" -eq 1 ]; then
        # 更新/切换：保留既有启用状态（仅原本 enabled 才重新 enable，不胡乱
        # enable 未启用过的服务）；服务在运行则重启使新版本生效。
        if command -v systemctl >/dev/null 2>&1; then
            $SYSTEMCTL daemon-reload || echo "install.sh: 警告：daemon-reload 失败" >&2
            if [ "$WAS_ENABLED" -eq 1 ] || [ "$ENABLE_SERVICE" -eq 1 ]; then
                $SYSTEMCTL enable openwebcode || echo "install.sh: 警告：enable 失败" >&2
            fi
            if [ "$WAS_ACTIVE" -eq 1 ]; then
                if $SYSTEMCTL restart openwebcode; then
                    echo "服务已重启：$SYSTEMCTL status openwebcode 查看状态"
                else
                    echo "install.sh: 警告：服务重启失败，请手动执行 $SYSTEMCTL restart openwebcode" >&2
                fi
            elif [ "$ENABLE_SERVICE" -eq 1 ]; then
                $SYSTEMCTL start openwebcode || echo "install.sh: 警告：服务启动失败" >&2
                echo "服务已启动：$SYSTEMCTL status openwebcode 查看状态"
            else
                echo "服务未在运行，未触发重启；下次启动即使用新版本。"
            fi
        else
            echo "未检测到 systemctl；unit 已更新，请在 systemd 环境执行 daemon-reload 后按需重启服务。"
        fi
    elif [ "$ENABLE_SERVICE" -eq 1 ]; then
        # 启用并立即启动；服务启动后服务端会生成访问令牌（非回环时下方打印链接）
        $SYSTEMCTL daemon-reload
        $SYSTEMCTL enable --now openwebcode
        echo "服务已启用并启动：$SYSTEMCTL status openwebcode 查看状态"
        if [ "$IS_ROOT" -eq 0 ]; then
            echo "提示：未登录也开机自启需执行 loginctl enable-linger $USER"
        fi
    else
        echo "启用服务: $SYSTEMCTL daemon-reload && $SYSTEMCTL enable --now openwebcode"
    fi
fi

if [ "$OPEN_FIREWALL" -eq 1 ]; then
    if command -v firewall-cmd >/dev/null 2>&1; then
        firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null
        firewall-cmd --reload >/dev/null
        echo "防火墙已放行（firewalld）：$PORT/tcp"
    elif command -v ufw >/dev/null 2>&1; then
        ufw allow "$PORT/tcp" >/dev/null
        echo "防火墙已放行（ufw）：$PORT/tcp"
    else
        echo "未检测到 firewalld/ufw；请手动放行 $PORT/tcp。" >&2
    fi
fi

case "$HOST" in
    *:*) DISPLAY_HOST="[$HOST]" ;;
    *) DISPLAY_HOST=$HOST ;;
esac

# 非回环监听：服务端首次启动会生成 <数据目录>/access-token。服务已随
# --enable-service 启动时稍等其出现；拿到则直接打印一键访问链接。
ACCESS_TOKEN=''
if ! is_loopback_host "$HOST"; then
    TOKEN_FILE="$DATA_DIR/access-token"
    if [ "$ENABLE_SERVICE" -eq 1 ] && [ ! -f "$TOKEN_FILE" ]; then
        tries=0
        while [ "$tries" -lt 10 ] && [ ! -f "$TOKEN_FILE" ]; do
            sleep 0.5 2>/dev/null || sleep 1
            tries=$((tries + 1))
        done
    fi
    if [ -f "$TOKEN_FILE" ]; then
        candidate=$(tr -d '[:space:]' < "$TOKEN_FILE")
        if [ "${#candidate}" -eq 64 ]; then
            case "$candidate" in
                *[!0-9a-f]*) ;;
                *) ACCESS_TOKEN=$candidate ;;
            esac
        fi
    fi
fi

echo "安装完成: $LIB_DIR"
echo "启动:     $PREFIX/bin/owc  （浏览器打开 http://$DISPLAY_HOST:$PORT）"
if ! is_loopback_host "$HOST"; then
    if [ -n "$ACCESS_TOKEN" ]; then
        case "$HOST" in
            0.0.0.0|::)
                LAN_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
                if [ -z "$LAN_IPS" ] && command -v ip >/dev/null 2>&1; then
                    LAN_IPS=$(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}' || true)
                fi
                if [ -n "$LAN_IPS" ]; then
                    printf '%s\n' "$LAN_IPS" | while IFS= read -r ip; do
                        echo "访问链接: http://$ip:$PORT/?token=$ACCESS_TOKEN"
                    done
                else
                    echo "访问链接: http://<本机局域网IP>:$PORT/?token=$ACCESS_TOKEN"
                fi
                ;;
            *)
                echo "访问链接: http://$DISPLAY_HOST:$PORT/?token=$ACCESS_TOKEN"
                ;;
        esac
    else
        echo "访问令牌: 服务端首次启动时自动生成；访问链接见服务端控制台或 设置 → 远程访问。"
    fi
fi

# <prefix>/bin 不在 PATH 时，按用户 shell（$SHELL 推断 rc 文件）给出 export 指引
case ":$PATH:" in
    *":$PREFIX/bin:"*) : ;;
    *)
        echo "提示：$PREFIX/bin 不在 PATH 中，无法直接运行 owc。"
        shell_name=${SHELL:-}
        shell_name=${shell_name##*/}
        rc_file='~/.profile'
        case "$shell_name" in
            bash) rc_file='~/.bashrc' ;;
            zsh) rc_file='~/.zshrc' ;;
        esac
        echo "可将以下行加入 $rc_file 后重开终端："
        echo "  export PATH=\"$PREFIX/bin:\$PATH\""
        ;;
esac
