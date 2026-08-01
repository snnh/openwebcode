#!/bin/sh
# Portable smoke tests for packaging/install.sh. Run on Linux or Git Bash:
#   sh packaging/test-install.sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/owc-install-test.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT TERM

fail() {
    echo "test-install.sh: $1" >&2
    exit 1
}

make_package() {
    package_dir=$1
    mkdir -p "$package_dir/bin" "$package_dir/server/dist" "$package_dir/web/dist"
    cp "$SCRIPT_DIR/install.sh" "$package_dir/install.sh"
    cp "$SCRIPT_DIR/uninstall.sh" "$package_dir/uninstall.sh"
    printf '%s\n' '#!/bin/sh' 'exit 0' > "$package_dir/bin/owc-exec"
    chmod +x "$package_dir/bin/owc-exec"
    : > "$package_dir/server/dist/index.js"
    : > "$package_dir/server/dist/cli.js"
    : > "$package_dir/web/dist/index.html"
}

PACKAGE="$WORK_DIR/package"
PREFIX="$WORK_DIR/prefix with 'quote'"
DATA_DIR="$WORK_DIR/data dir"
make_package "$PACKAGE"
mkdir -p "$PACKAGE/node/bin"
printf '%s\n' \
    '#!/bin/sh' \
    'printf "%s|%s|%s\n" "$OWC_PORT" "$OWC_DATA_DIR" "$OWC_HOST" > "$TEST_OUT"' \
    > "$PACKAGE/node/bin/node"
chmod +x "$PACKAGE/node/bin/node"

# stdin/stdout are redirected deliberately: no --yes-like prompt is permitted
# in non-interactive automation. The supplied options must become launcher
# defaults, including paths that require shell quoting.
HOME="$WORK_DIR/home" "$PACKAGE/install.sh" \
    --prefix "$PREFIX" --port 04312 --data-dir "$DATA_DIR" --host localhost \
    < /dev/null > "$WORK_DIR/install.out" 2>&1
! grep -q '安装配置' "$WORK_DIR/install.out" || fail "non-TTY install prompted"
[ -x "$PREFIX/bin/owc" ] || fail "launcher was not installed"
[ -d "$PREFIX/lib/openwebcode/node" ] || fail "bundled Node.js was not copied"
sh -n "$PREFIX/bin/owc"
TEST_OUT="$WORK_DIR/launcher.env" "$PREFIX/bin/owc" run ignored
IFS= read -r ACTUAL < "$WORK_DIR/launcher.env"
[ "$ACTUAL" = "4312|$DATA_DIR|localhost" ] || fail "launcher defaults were not preserved: $ACTUAL"

# Environment variables still override the generated defaults at run time.
TEST_OUT="$WORK_DIR/launcher.override.env" \
OWC_PORT=4999 OWC_DATA_DIR="$WORK_DIR/override" OWC_HOST=127.0.0.1 \
    "$PREFIX/bin/owc" run ignored
IFS= read -r ACTUAL < "$WORK_DIR/launcher.override.env"
[ "$ACTUAL" = "4999|$WORK_DIR/override|127.0.0.1" ] || fail "runtime override was ignored: $ACTUAL"

# A package without bundled Node.js must work with --use-system-node only after
# validating a >=24 executable resolved from PATH, and must not copy node/.
SYSTEM_PACKAGE="$WORK_DIR/system-package"
SYSTEM_PREFIX="$WORK_DIR/system-prefix"
SYSTEM_BIN="$WORK_DIR/system-bin"
make_package "$SYSTEM_PACKAGE"
mkdir -p "$SYSTEM_BIN"
printf '%s\n' \
    '#!/bin/sh' \
    'if [ "${1:-}" = "-p" ]; then' \
    '    case "${2:-}" in' \
    '        process.versions.node) printf "24.18.0\n" ;;' \
    '        *) printf "%064d\n" 7 ;;' \
    '    esac' \
    '    exit 0' \
    'fi' \
    'exit 0' \
    > "$SYSTEM_BIN/node"
chmod +x "$SYSTEM_BIN/node"
PATH="$SYSTEM_BIN:$PATH" HOME="$WORK_DIR/home" "$SYSTEM_PACKAGE/install.sh" \
    --yes --prefix "$SYSTEM_PREFIX" --port 3001 --data-dir "$WORK_DIR/system-data" \
    --host 127.0.0.1 --use-system-node > "$WORK_DIR/system-install.out" 2>&1
[ ! -e "$SYSTEM_PREFIX/lib/openwebcode/node" ] || fail "--use-system-node copied bundled Node.js"
grep -F "OWC_NODE='$SYSTEM_BIN/node'" "$SYSTEM_PREFIX/bin/owc" >/dev/null || \
    fail "system Node.js path was not pinned in launcher"

# 非回环安装不再把令牌写进启动器：访问令牌由服务端首次启动自动生成并持久化到
# <数据目录>/access-token。启动器保持 755（不含秘密），输出引导用户查看访问链接。
TOKEN_PREFIX="$WORK_DIR/token-prefix"
PATH="$SYSTEM_BIN:$PATH" HOME="$WORK_DIR/home" "$SYSTEM_PACKAGE/install.sh" \
    --yes --prefix "$TOKEN_PREFIX" --port 3002 --data-dir "$WORK_DIR/token-data" \
    --host 0.0.0.0 --use-system-node > "$WORK_DIR/token-install.out" 2>&1
sh -n "$TOKEN_PREFIX/bin/owc"
if grep -q 'OWC_DEFAULT_ACCESS_TOKEN\|OWC_ACCESS_TOKEN=' "$TOKEN_PREFIX/bin/owc"; then
    fail "launcher must not embed an access token"
fi
case $(uname -s) in
    MINGW*|MSYS*|CYGWIN*) : ;;
    *)
        [ "$(stat -c %a "$TOKEN_PREFIX/bin/owc")" = "755" ] || \
            fail "launcher is not mode 755"
        ;;
esac
grep -q '访问令牌由服务端首次启动自动生成' "$WORK_DIR/token-install.out" || \
    fail "non-loopback install did not explain token auto-generation"
grep -q '访问链接' "$WORK_DIR/token-install.out" || \
    fail "non-loopback install did not point at the access link"

# --lan 是 --host 0.0.0.0 的快捷方式；与 --host 互斥。
LAN_PREFIX="$WORK_DIR/lan-prefix"
PATH="$SYSTEM_BIN:$PATH" HOME="$WORK_DIR/home" "$SYSTEM_PACKAGE/install.sh" \
    --yes --prefix "$LAN_PREFIX" --port 3003 --data-dir "$WORK_DIR/lan-data" \
    --lan --use-system-node > "$WORK_DIR/lan-install.out" 2>&1
grep -F "OWC_DEFAULT_HOST='0.0.0.0'" "$LAN_PREFIX/bin/owc" >/dev/null || \
    fail "--lan did not set the launcher host default to 0.0.0.0"
if HOME="$WORK_DIR/home" "$SYSTEM_PACKAGE/install.sh" --yes --prefix "$WORK_DIR/lan-conflict" \
    --port 3000 --data-dir "$DATA_DIR" --lan --host 127.0.0.1 > /dev/null 2>&1; then
    fail "--lan combined with --host was accepted"
fi

# 服务端已生成访问令牌时（如服务已启动），安装结尾直接打印一键访问链接。
LINK_PREFIX="$WORK_DIR/link-prefix"
LINK_DATA="$WORK_DIR/link-data"
mkdir -p "$LINK_DATA"
LINK_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
printf '%s\n' "$LINK_TOKEN" > "$LINK_DATA/access-token"
PATH="$SYSTEM_BIN:$PATH" HOME="$WORK_DIR/home" "$SYSTEM_PACKAGE/install.sh" \
    --yes --prefix "$LINK_PREFIX" --port 3004 --data-dir "$LINK_DATA" \
    --host 192.168.99.99 --use-system-node > "$WORK_DIR/link-install.out" 2>&1
grep -F "访问链接: http://192.168.99.99:3004/?token=$LINK_TOKEN" "$WORK_DIR/link-install.out" >/dev/null || \
    fail "install did not print the one-click access link"
# 未显式 --open-firewall 时不得出现防火墙动作。
if grep -q '防火墙已放行' "$WORK_DIR/link-install.out"; then
    fail "firewall was touched without --open-firewall"
fi

# 默认 prefix/数据目录按 uid 分层：root 系统级、普通用户用户级。
# 直接提取 default_prefix/default_data_dir 函数测试（同 validate_version 的方式）。
sed -n '/^default_prefix() {/,/^}/p' "$SCRIPT_DIR/install.sh" > "$WORK_DIR/defaults.sh"
sed -n '/^default_data_dir() {/,/^}/p' "$SCRIPT_DIR/install.sh" >> "$WORK_DIR/defaults.sh"
[ -s "$WORK_DIR/defaults.sh" ] || fail "could not extract default_prefix/default_data_dir"
DEFAULTS=$(IS_ROOT=0 HOME=/home/u XDG_DATA_HOME= . "$WORK_DIR/defaults.sh" && default_prefix && default_data_dir && IS_ROOT=1 && default_prefix && default_data_dir)
[ "$DEFAULTS" = "/home/u/.local
/home/u/.local/share/openwebcode
/usr/local
/var/lib/openwebcode" ] || fail "uid-based defaults wrong: $DEFAULTS"

# root 分支的 systemd unit：系统级目录 + 系统级 unit 内容（经 OWC_INSTALL_IS_ROOT
# 与 OWC_SYSTEMD_UNIT_DIR 覆盖，无需真 root）；未传 --enable-service 时不启用服务。
UNIT_PREFIX="$WORK_DIR/unit-prefix"
UNIT_DIR="$WORK_DIR/units"
PATH="$SYSTEM_BIN:$PATH" HOME="$WORK_DIR/home" \
OWC_INSTALL_IS_ROOT=1 OWC_SYSTEMD_UNIT_DIR="$UNIT_DIR" "$SYSTEM_PACKAGE/install.sh" \
    --yes --prefix "$UNIT_PREFIX" --port 3005 --data-dir "$WORK_DIR/unit-data" \
    --host 127.0.0.1 --use-system-node --with-systemd > "$WORK_DIR/unit-install.out" 2>&1
[ -f "$UNIT_DIR/openwebcode.service" ] || fail "systemd unit was not written"
grep -q '^Wants=network-online.target$' "$UNIT_DIR/openwebcode.service" || \
    fail "system unit is missing Wants=network-online.target"
grep -q '^WantedBy=multi-user.target$' "$UNIT_DIR/openwebcode.service" || \
    fail "system unit is not WantedBy=multi-user.target"
grep -F "ExecStart=$UNIT_PREFIX/bin/owc" "$UNIT_DIR/openwebcode.service" >/dev/null || \
    fail "system unit ExecStart does not point at the launcher"
grep -q '启用服务: systemctl daemon-reload && systemctl enable --now openwebcode' "$WORK_DIR/unit-install.out" || \
    fail "system install did not print the system-level enable hint"
if grep -q '服务已启用并启动' "$WORK_DIR/unit-install.out"; then
    fail "service was enabled without --enable-service"
fi

# Strict option validation must fail before any destructive copy.
if HOME="$WORK_DIR/home" "$PACKAGE/install.sh" --yes --prefix relative \
    --port 3000 --data-dir "$DATA_DIR" --host 127.0.0.1 > /dev/null 2>&1; then
    fail "relative prefix was accepted"
fi
if HOME="$WORK_DIR/home" "$PACKAGE/install.sh" --yes --prefix /tmp/.. \
    --port 3000 --data-dir "$DATA_DIR" --host 127.0.0.1 > /dev/null 2>&1; then
    fail "root-equivalent prefix was accepted"
fi
if HOME="$WORK_DIR/home" "$PACKAGE/install.sh" --yes --prefix "$WORK_DIR/invalid-port" \
    --port 0 --data-dir "$DATA_DIR" --host 127.0.0.1 > /dev/null 2>&1; then
    fail "invalid port was accepted"
fi

# install-online.sh 的版本校验须接受 semver 预发布（当前发布线为
# 1.0.0-beta.x，latest 查询路径剥 v 后也会得到该形态），同时拒绝明显非法
# 输入。直接提取脚本中的 validate_version 函数测试，不经网络下载。
sed -n '/^validate_version() {/,/^}/p' "$SCRIPT_DIR/install-online.sh" > "$WORK_DIR/validate.sh"
[ -s "$WORK_DIR/validate.sh" ] || fail "could not extract validate_version from install-online.sh"
(. "$WORK_DIR/validate.sh" && validate_version "1.0.0-beta.5") || fail "1.0.0-beta.5 was rejected"
(. "$WORK_DIR/validate.sh" && validate_version "1.0.0") || fail "1.0.0 was rejected"
if (. "$WORK_DIR/validate.sh" && validate_version "not a version"); then
    fail "garbage version string was accepted"
fi

# ---- uninstall.sh：完整撤销安装（systemd unit、运行时、启动器、卸载器自身） ----
UNINST_PREFIX="$WORK_DIR/uninst-prefix"
UNINST_DATA="$WORK_DIR/uninst-data"
UNINST_UNITS="$WORK_DIR/uninst-units"
PATH="$SYSTEM_BIN:$PATH" HOME="$WORK_DIR/home" \
OWC_INSTALL_IS_ROOT=1 OWC_SYSTEMD_UNIT_DIR="$UNINST_UNITS" "$SYSTEM_PACKAGE/install.sh" \
    --yes --prefix "$UNINST_PREFIX" --port 3006 --data-dir "$UNINST_DATA" \
    --host 127.0.0.1 --use-system-node --with-systemd > /dev/null 2>&1
[ -x "$UNINST_PREFIX/bin/owc-uninstall" ] || fail "uninstaller was not installed"
mkdir -p "$UNINST_DATA"
: > "$UNINST_DATA/marker"
HOME="$WORK_DIR/home" \
OWC_INSTALL_IS_ROOT=1 OWC_SYSTEMD_UNIT_DIR="$UNINST_UNITS" \
    "$UNINST_PREFIX/bin/owc-uninstall" --yes --data-dir "$UNINST_DATA" > "$WORK_DIR/uninstall.out" 2>&1
[ ! -e "$UNINST_PREFIX/lib/openwebcode" ] || fail "uninstall left lib/openwebcode behind"
[ ! -e "$UNINST_PREFIX/bin/owc" ] || fail "uninstall left the launcher behind"
[ ! -e "$UNINST_PREFIX/bin/owc-uninstall" ] || fail "uninstall left the uninstaller itself behind"
[ ! -e "$UNINST_UNITS/openwebcode.service" ] || fail "uninstall left the systemd unit behind"
[ -f "$UNINST_DATA/marker" ] || fail "uninstall removed data without --purge-data"

# --purge-data 才删除数据目录；对未安装路径必须报错。
PATH="$SYSTEM_BIN:$PATH" HOME="$WORK_DIR/home" \
OWC_INSTALL_IS_ROOT=1 OWC_SYSTEMD_UNIT_DIR="$UNINST_UNITS" "$SYSTEM_PACKAGE/install.sh" \
    --yes --prefix "$UNINST_PREFIX" --port 3006 --data-dir "$UNINST_DATA" \
    --host 127.0.0.1 --use-system-node > /dev/null 2>&1
HOME="$WORK_DIR/home" \
OWC_INSTALL_IS_ROOT=1 OWC_SYSTEMD_UNIT_DIR="$UNINST_UNITS" \
    "$UNINST_PREFIX/bin/owc-uninstall" --yes --data-dir "$UNINST_DATA" --purge-data > /dev/null 2>&1
[ ! -e "$UNINST_DATA" ] || fail "--purge-data did not remove the data directory"
if HOME="$WORK_DIR/home" "$SYSTEM_PACKAGE/uninstall.sh" --yes --prefix "$WORK_DIR/no-such-install" > /dev/null 2>&1; then
    fail "uninstall accepted a prefix without an installation"
fi

echo "install.sh smoke tests passed"
