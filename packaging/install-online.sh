#!/bin/sh
# OpenWebCode 在线安装/更新脚本（Linux，POSIX sh；可 curl | bash 使用）
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
#   curl -fsSL ... | bash -s -- --version 0.6.0 --prefix /opt/openwebcode --yes
#
# 参数:
#   --version <x.y.z>    目标版本；缺省查询 GitHub Releases latest 的 tag_name
#                        （用 sed/grep 解析，不依赖 jq）
#   --prefix <dir>       安装前缀（绝对路径），默认用户级 ~/.local、root /usr/local；
#                        用于判定全新安装还是更新，并透传给包内 install.sh
#   --yes / -y           非交互；透传给 install.sh
#   --port/--host/--lan/--data-dir/--system/--with-systemd/--enable-service/
#   --open-firewall/--use-system-node
#                        原样透传给包内 install.sh（仅全新安装时生效）
#   -h, --help           显示本帮助
#
# 环境变量:
#   OWC_INSTALL_BASE_URL 覆盖下载基址（默认
#     https://github.com/snnh/openwebcode/releases/download/v<version>），
#     便于用 file:// 或镜像做本地测试。
#
# 行为:
#   1. 检查依赖：curl 或 wget、tar、sha256sum（或 shasum -a 256）；
#   2. 在 mktemp -d 工作目录下载 openwebcode-<version>-linux-x64.tar.gz 与
#      SHA256SUMS.txt，只取目标行做 sha256sum --check，失败即中止；
#   3. 解压到临时目录；
#   4. 若 <prefix>/lib/openwebcode/server/dist/index.js 已存在 → 更新模式：
#      整体替换 <prefix>/lib/openwebcode/ 内容为新版（保留 <prefix>/bin/owc
#      启动器与已写好的 systemd unit 不动），并提示重启方式；
#      否则 → 全新安装：调用包内 install.sh 并透传全部安装参数。
#   工作目录由 trap 清理。
set -eu

die() {
    echo "install-online.sh: $1" >&2
    exit "${2:-2}"
}

# 版本号须为 semver 形态：主版本为数字与点，可带一个 - 预发布后缀（字母数字
# 与点），如 1.0.0 或 1.0.0-beta.4；拒绝空串、空白与其他字符。
# test-install.sh 直接提取本函数做断言，修改时保持函数名与形态不变。
validate_version() {
    case $1 in
        ''|*[!0-9A-Za-z.-]*) return 1 ;;
    esac
    case $1 in
        *-*)
            case ${1%%-*} in ''|*[!0-9.]*|.*|*.|*..*) return 1 ;; esac
            case ${1#*-} in ''|*-*|*[!0-9A-Za-z.]*|.*|*.) return 1 ;; esac
            ;;
        *)
            case $1 in ''|*[!0-9.]*|.*|*.|*..*) return 1 ;; esac
            ;;
    esac
    return 0
}

usage() {
    cat >&2 <<'EOF'
用法: install-online.sh [--version <x.y.z>] [--prefix <dir>] [install.sh 选项...]

  --version <x.y.z>    目标版本，缺省查询 GitHub Releases latest
  --prefix <dir>       安装前缀（绝对路径），默认用户级 ~/.local、root /usr/local
  --yes, -y            非交互（透传给 install.sh）
  --port/--host/--lan/--data-dir/--system/--with-systemd/--enable-service/
  --open-firewall/--use-system-node
                       原样透传给包内 install.sh（仅全新安装生效）
  -h, --help           显示本帮助

环境变量 OWC_INSTALL_BASE_URL 可覆盖下载基址（默认
https://github.com/snnh/openwebcode/releases/download/v<version>）。

若 <prefix>/lib/openwebcode 已存在则进入更新模式：替换该目录内容为新版，
保留 <prefix>/bin/owc 启动器与 systemd unit，之后需重启服务生效。
EOF
}

[ -n "${HOME:-}" ] || die "HOME 未设置，无法选择默认安装前缀" 1

VERSION=''
if [ "$(id -u)" -eq 0 ]; then
    # root 默认系统级前缀，与 install.sh 的 default_prefix 一致（更新模式探测依赖它）
    PREFIX=/usr/local
else
    PREFIX="$HOME/.local"
fi

# 先完整扫描一遍参数，取出本脚本自己的 --version/--prefix（支持 --opt=value
# 与 --opt value 两种形式）；其余参数保持原顺序原样透传给 install.sh。
prev=''
for arg in "$@"; do
    case "$prev" in
        --version) VERSION=$arg ;;
        --prefix) PREFIX=$arg ;;
    esac
    case "$arg" in
        --version=*) VERSION=${arg#--version=} ;;
        --prefix=*) PREFIX=${arg#--prefix=} ;;
        -h|--help) usage; exit 0 ;;
    esac
    prev=$arg
done

# 从位置参数中剔除 --version/--prefix（含其值）；全新安装时由本脚本统一
# 重新传入 --prefix，其余参数保留原顺序与空白字符透传给 install.sh。
count=$#
while [ "$count" -gt 0 ]; do
    case "$1" in
        --version|--prefix)
            opt=$1
            shift
            # 连值一起剔除，计数也要多减一轮。
            if [ $# -gt 0 ]; then
                shift
                count=$((count - 1))
            else
                die "$opt 需要一个值"
            fi
            ;;
        --version=*|--prefix=*)
            shift
            ;;
        *)
            set -- "$@" "$1"
            shift
            ;;
    esac
    count=$((count - 1))
done

case "$PREFIX" in
    /*) ;;
    *) die "非法 prefix: $PREFIX（应为绝对路径）" ;;
esac

# 依赖检查：下载工具、tar、校验工具。
CURL=''
WGET=''
if command -v curl >/dev/null 2>&1; then
    CURL=$(command -v curl)
elif command -v wget >/dev/null 2>&1; then
    WGET=$(command -v wget)
else
    die "需要 curl 或 wget 来下载发行包" 1
fi
command -v tar >/dev/null 2>&1 || die "需要 tar 来解压发行包" 1
SHA256_TOOL=''
if command -v sha256sum >/dev/null 2>&1; then
    SHA256_TOOL=sha256sum
elif command -v shasum >/dev/null 2>&1; then
    SHA256_TOOL=shasum
else
    die "需要 sha256sum 或 shasum 来校验发行包完整性" 1
fi

fetch() {
    # $1 = URL，$2 = 目标文件；curl/wget 均支持 http(s):// 与 file://。
    if [ -n "$CURL" ]; then
        "$CURL" -fsSL -o "$2" "$1"
    else
        "$WGET" -q -O "$2" "$1"
    fi
}

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/owc-online-install.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT TERM

# 版本缺省时查询 GitHub Releases latest 的 tag_name（不依赖 jq）。
if [ -z "$VERSION" ]; then
    echo "查询最新版本..."
    fetch "https://api.github.com/repos/snnh/openwebcode/releases/latest" \
        "$WORK_DIR/latest.json" || die "无法查询最新版本，请用 --version 显式指定" 1
    TAG=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$WORK_DIR/latest.json" | head -n 1)
    [ -n "$TAG" ] || die "无法从 GitHub Releases 响应解析 tag_name" 1
    VERSION=${TAG#v}
fi
validate_version "$VERSION" || die "非法版本号: $VERSION"

BASE_URL=${OWC_INSTALL_BASE_URL:-"https://github.com/snnh/openwebcode/releases/download/v$VERSION"}
TARBALL="openwebcode-$VERSION-linux-x64.tar.gz"

echo "下载 OpenWebCode v$VERSION ..."
fetch "$BASE_URL/$TARBALL" "$WORK_DIR/$TARBALL" || \
    die "下载失败: $BASE_URL/$TARBALL" 1
fetch "$BASE_URL/SHA256SUMS.txt" "$WORK_DIR/SHA256SUMS.txt" || \
    die "下载失败: $BASE_URL/SHA256SUMS.txt" 1

echo "校验 SHA-256 ..."
# 只取目标行的校验和，避免校验和文件里其它条目干扰；[ *] 同时兼容
# sha256sum 的文本模式（两空格）与 Windows 环境的二进制模式（" *"）输出。
grep "[ *]$TARBALL\$" "$WORK_DIR/SHA256SUMS.txt" > "$WORK_DIR/checksum.txt" || \
    die "SHA256SUMS.txt 中缺少 $TARBALL 的校验行" 1
if [ "$SHA256_TOOL" = sha256sum ]; then
    (CDPATH= cd "$WORK_DIR" && sha256sum --check checksum.txt) || \
        die "SHA-256 校验失败，发行包可能已损坏或被篡改" 1
else
    (CDPATH= cd "$WORK_DIR" && shasum -a 256 --check checksum.txt) || \
        die "SHA-256 校验失败，发行包可能已损坏或被篡改" 1
fi

echo "解压 ..."
mkdir "$WORK_DIR/pkg"
tar -xzf "$WORK_DIR/$TARBALL" -C "$WORK_DIR/pkg" || die "解压失败" 1
EXTRACT_DIR="$WORK_DIR/pkg"
[ -f "$EXTRACT_DIR/server/dist/index.js" ] || \
    die "发行包内容不完整（缺少 server/dist/index.js）" 1

# 与 install.sh 相同：prefix 存在时先物理解析，确保更新替换的目标固定。
if [ -d "$PREFIX" ]; then
    PREFIX=$(CDPATH= cd -P "$PREFIX" && pwd) || die "无法解析 prefix: $PREFIX" 1
fi
LIB_DIR="$PREFIX/lib/openwebcode"

if [ -f "$LIB_DIR/server/dist/index.js" ]; then
    # 更新模式：整体替换 lib/openwebcode 内容；保留 bin/owc 与 systemd unit。
    echo "检测到已有安装: $LIB_DIR"
    echo "执行更新（保留启动器 $PREFIX/bin/owc 与 systemd unit；数据目录不受影响）..."
    if [ ! -w "$LIB_DIR" ] || [ ! -w "$(dirname "$LIB_DIR")" ]; then
        die "目标目录不可写: $LIB_DIR（可能需要 sudo 运行，或检查目录属主与权限）" 1
    fi
    if [ $# -gt 0 ]; then
        echo "install-online.sh: 更新模式不重建启动器，安装参数（$*）被忽略" >&2
    fi
    rm -rf "$LIB_DIR"
    mkdir -p "$LIB_DIR"
    for d in bin server web node; do
        if [ -d "$EXTRACT_DIR/$d" ]; then
            cp -R "$EXTRACT_DIR/$d" "$LIB_DIR/"
        fi
    done
    chmod +x "$LIB_DIR/bin/owc-exec" 2>/dev/null || true
    echo "更新完成: $LIB_DIR"
    UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/openwebcode.service"
    if [ -f "$UNIT" ]; then
        echo "检测到 systemd 用户服务，重启生效: systemctl --user restart openwebcode"
    else
        echo "请重启正在运行的 owc 服务使新版本生效。"
    fi
else
    # 全新安装：交给包内 install.sh，透传全部安装参数。
    echo "全新安装到 $PREFIX ..."
    [ -x "$EXTRACT_DIR/install.sh" ] || die "发行包内容不完整（缺少 install.sh）" 1
    "$EXTRACT_DIR/install.sh" --prefix "$PREFIX" "$@"
fi
