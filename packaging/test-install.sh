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

# A non-loopback install must generate an OWC_ACCESS_TOKEN default in the
# launcher; the server refuses to start a non-loopback listener without one.
TOKEN_PREFIX="$WORK_DIR/token-prefix"
PATH="$SYSTEM_BIN:$PATH" HOME="$WORK_DIR/home" "$SYSTEM_PACKAGE/install.sh" \
    --yes --prefix "$TOKEN_PREFIX" --port 3002 --data-dir "$WORK_DIR/token-data" \
    --host 0.0.0.0 --use-system-node > "$WORK_DIR/token-install.out" 2>&1
sh -n "$TOKEN_PREFIX/bin/owc"
grep -E "OWC_DEFAULT_ACCESS_TOKEN='[0-9a-f]{64}'" "$TOKEN_PREFIX/bin/owc" >/dev/null || \
    fail "non-loopback install did not write an OWC_ACCESS_TOKEN default"
grep -q 'OWC_ALLOWED_ORIGINS' "$WORK_DIR/token-install.out" || \
    fail "non-loopback install did not mention OWC_ALLOWED_ORIGINS"

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

echo "install.sh smoke tests passed"
