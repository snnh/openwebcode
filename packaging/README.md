# 分发与打包

[中文](./README.md) | [English](./README.en.md)

本文面向想自己打包、部署或发布 OpenWebCode 的人。普通用户的安装步骤见[根 README](../README.md)。本文的命令和行为以 `packaging/` 下的脚本、`core/CMakeLists.txt` 的 CPack 段和 `.github/workflows/release.yml` 为准。

## 发布产物

打 `v*` tag（或在 Actions 手动触发 `release` 工作流并输入 tag）后，release.yml 产出：

| 产物 | 平台 | 说明 |
| --- | --- | --- |
| `openwebcode-<version>-windows-x64.msi` | Windows x64 | CPack/WiX 安装包 |
| `openwebcode-<version>-linux-x64.tar.gz` | Linux x86_64 | 运行时树 + 顶层 `install.sh`/`uninstall.sh` |
| `openwebcode-<version>-linux-arm64.tar.gz` | Linux aarch64 | 同上，`ubuntu-24.04-arm` 原生构建 |
| `openwebcode-<version>-linux-loongarch64.tar.gz` | Linux 龙芯 | 同上，x64 runner 交叉编译，不内置 Node.js |
| `install-online.sh` | Linux | `curl \| bash` 在线安装/更新脚本，按 `uname -m` 自动选架构 |
| `SHA256SUMS.txt` | 全平台 | 四个发行包的 SHA-256 校验和 |
| `bench-results-*.json` | 全平台 | 性能基准结果，供下一版做回归对比基线 |

`<version>` 是 tag 去掉前导 `v`（`v1.3.9` → `1.3.9`）。预发布 tag（如 `v1.4.0-beta.1`）的产物文件名带完整版本号，GitHub Release 自动标记 Pre-release。

## 包内布局

MSI 和 tar.gz 解开后是同一棵运行时树。staging 契约写在 `core/CMakeLists.txt` 的 CPack 注释里：

```
bin/owc-exec(.exe)      core 可执行文件（沙盒/文件操作后端）
bin/owc.cmd             Windows 启动脚本（仅 MSI，由 packaging/owc.cmd 转 CRLF 生成）
bin/owc-launch.cmd      Windows 安装结束页 Launch 复选框用的启动器（仅 MSI）
server/dist/            服务端编译产物，入口 dist/index.js
server/package.json     "type": "module" 声明（dist 为 ESM，必需）
server/node_modules/    生产依赖（npm prune --omit=dev 之后）
server/assets/          运行时资产
web/dist/               前端静态资源（server 按 server/dist/../../web/dist 解析托管）
node/                   固定版本 Node 运行时（Windows 只有 node.exe；Linux 是完整发行目录）
install.sh              Linux 安装脚本（仅 tar.gz，位于包顶层）
uninstall.sh            Linux 卸载脚本（仅 tar.gz，位于包顶层；安装时落盘为 <prefix>/bin/owc-uninstall）
```

bundled Node 版本固定在 release.yml 的 `env.NODE_DIST_VERSION`（当前 24.18.0），升级只改这一个常量；CI 下载后对照 nodejs.org 官方 `SHASUMS256.txt` 校验，不硬编码哈希。loongarch64 没有官方 Node 包，不创建 `node/`，`install.sh` 会自动改用系统 Node.js。

## 版本号机制

- `server/package.json` 的 `version` 存完整版本号（`web/package.json` 同步跟随）。
- `core/CMakeLists.txt` 的 `project(VERSION)` 只存数值基版本（`1.4.0-beta.1` 存 `1.4.0`）；它经 `configure_file` 生成 `version.h`，由 `core.ping` 上报，是 core 侧唯一版本来源。
- release.yml 两个平台 job 的第一步都做一致性校验：tag 去 `v` 后必须等于 server 和 web 的 `version`，其数值基版本必须等于 CMake 的 `project(VERSION)`，不一致直接失败。tag 推送和手动触发都校验。
- 调 CPack 时：`-DCPACK_PACKAGE_VERSION=<数值基版本>`（MSI ProductVersion 只接受数值），`-DCPACK_FULL_VERSION=<完整版本号>`（只用于产物文件名）。正式版两个值相同。

## Windows MSI

### 环境要求

- Windows x64，PowerShell 5.1+；
- Node.js ≥ 20（只用于构建；包内 Node 由 `NODE_DIST_VERSION` 固定）；
- CMake ≥ 3.19（MSI 的 WiX 自定义命名空间由这个版本的 CPack 提供）；
- Visual Studio 2022 Build Tools（"使用 C++ 的桌面开发"）；
- WiX Toolset v3（`candle.exe`/`light.exe` 在 PATH 或 `WIX` 环境变量里）。

以下命令都在仓库根目录执行。

### 1. 构建并过测试门禁

```powershell
$ErrorActionPreference = "Stop"
$Version = "1.3.9"          # 完整版本号；预发布如 1.4.0-beta.1
$BaseVersion = ($Version -split "-")[0]
$NodeVersion = "24.18.0"    # 与 release.yml 的 NODE_DIST_VERSION 一致

npm --prefix server ci
npm --prefix server run build

cmake -S core -B build-debug -A x64
cmake --build build-debug --config Debug --parallel
ctest --test-dir build-debug -C Debug --output-on-failure
$env:OWC_CORE_PATH = (Resolve-Path "build-debug\Debug\owc-exec.exe").Path
npm --prefix server test
Remove-Item Env:OWC_CORE_PATH

npm --prefix web ci
npm --prefix web run build
npm --prefix web test
```

### 2. 裁剪依赖、构建 Release core、组装 staging

```powershell
# 测试通过后才能裁剪；这会移除 server 的 devDependencies，继续开发前重新 npm --prefix server ci
npm --prefix server prune --omit=dev
# @fastify/send 发布的测试 fixture 里有 WiX v3 代码页表示不了的目录名，运行时用不到，删掉
Remove-Item server\node_modules\@fastify\send\test -Recurse -Force -ErrorAction SilentlyContinue

cmake -S core -B build -A x64 -DCPACK_PACKAGE_VERSION=$BaseVersion -DCPACK_FULL_VERSION=$Version
cmake --build build --config Release --target owc-exec --parallel

# 必须从空 staging 开始，避免残留旧的 Vite 哈希资源或依赖
Remove-Item build\stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path build\stage\bin, build\stage\server, build\stage\web, build\stage\node | Out-Null

Copy-Item build\Release\owc-exec.exe build\stage\bin\
Copy-Item server\dist build\stage\server\dist -Recurse -Force
Copy-Item server\package.json build\stage\server\
Copy-Item server\node_modules build\stage\server\node_modules -Recurse -Force
Copy-Item server\assets build\stage\server\assets -Recurse -Force
Copy-Item web\dist build\stage\web\dist -Recurse -Force

# 下载并嵌入与 CI 相同的 Node 运行时
Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile build\node.zip
Expand-Archive build\node.zip -DestinationPath build\node-runtime -Force
Copy-Item "build\node-runtime\node-v$NodeVersion-win-x64\node.exe" build\stage\node\node.exe

# cmd.exe 按 OEM 代码页解析批处理：启动脚本必须是无 BOM 的 ASCII + CRLF
foreach ($f in "owc.cmd", "owc-launch.cmd") {
  $content = (Get-Content "packaging\$f" -Raw) -replace "`r?`n", "`r`n"
  [IO.File]::WriteAllText((Join-Path $PWD "build\stage\bin\$f"), $content, [Text.Encoding]::ASCII)
}
```

### 3. 校验 staging、冒烟、生成 MSI

```powershell
$Required = @(
  "build\stage\bin\owc-exec.exe",
  "build\stage\bin\owc.cmd",
  "build\stage\bin\owc-launch.cmd",
  "build\stage\server\dist\index.js",
  "build\stage\server\package.json",
  "build\stage\server\node_modules",
  "build\stage\server\assets",
  "build\stage\web\dist\index.html",
  "build\stage\node\node.exe"
)
$Missing = $Required | Where-Object { -not (Test-Path $_) }
if ($Missing) { throw "staging 缺少：$($Missing -join ', ')" }

# 可选冒烟：启动后访问 http://127.0.0.1:3210/api/health，确认后 Ctrl+C
$env:OWC_DATA_DIR = Join-Path $env:TEMP "openwebcode-package-smoke"
& build\stage\bin\owc.cmd
Remove-Item Env:OWC_DATA_DIR

cpack --config build\CPackConfig.cmake -G WIX -C Release
.\packaging\verify-wix-options.ps1 -MsiPath "openwebcode-$Version-windows-x64.msi"
Get-FileHash "openwebcode-$Version-windows-x64.msi" -Algorithm SHA256
```

MSI 输出在仓库根目录。`verify-wix-options.ps1` 直接读 MSI 数据库，确认 Shell integration 选项页、条件化的桌面快捷方式/PATH 组件和 UAC 属性传递都在，CPack/WiX 模板变动不会让复选框悄悄消失。WiX 报字符编码错误时先确认 `@fastify/send/test` 已删除；界面仍是旧版本时整个删掉 `build/stage` 重组装，不要在旧目录上覆盖。

### 安装与选项页

- 双击安装，默认装到 `C:\Program Files\openwebcode`（需要管理员权限）。UpgradeCode 固定，可覆盖升级。例外：beta 与正式版的 ProductVersion 同为数值基版本（如 `1.4.0`），跨 beta↔正式直装可能提示"已安装另一版本"，需先卸载再装，这是 WiX 的已知限制。
- 始终创建开始菜单的 **OpenWebCode** 快捷方式（指向 `bin\owc.cmd`）。
- 安装目录页之后是 **Shell integration** 选项页，两个复选框默认勾选：创建桌面快捷方式、把 `<安装目录>\bin` 加入**运行安装程序的用户**的 `PATH`。选择会写入注册表（`HKCU\Software\OpenWebCode\Installer`），修复和覆盖升级时保持；不勾 PATH 时仍可直接运行安装目录里的 `bin\owc.cmd`。
- 结束页有默认勾选的 "Launch OpenWebCode" 复选框，勾选则运行 `bin\owc-launch.cmd`：最小化窗口启动 server，3 秒后用默认浏览器打开 `http://localhost:<端口>`。

### 卸载与数据清理

「设置 → 应用」里卸载即可。默认保留 `%USERPROFILE%\openwebcode` 和旧版默认目录 `%LOCALAPPDATA%\openwebcode` 里的全部用户数据。确认要删除默认数据时，在持有 MSI 文件的前提下显式执行：

```powershell
msiexec /x "openwebcode-<version>-windows-x64.msi" PURGE_DATA=1
```

这会同时清理新旧两个默认数据目录；不会动 `OWC_DATA_DIR` 指定的其他目录，也不会动工作区里的 `.owc/`。升级安装不会触发清理。安装器刻意没有"删除数据"图形复选框，避免让用户以为未实现的 UI 能控制这个破坏性操作。

维护注意：不要给 `WixRemoveFoldersEx` 追加第二个 WiX 排序条目（WiX v3 的 `RemoveFolderEx` 已自行排程）；`wix-patch.xml` 只在它之前按条件把私有目录属性从保留用的惰性路径替换成默认数据目录，保持默认卸载不清理数据。

## Linux tar.gz

### 手动打包

与 Windows 同一套测试门禁和生产依赖裁剪，区别是 core 单配置构建、Node 用完整 Linux 发行目录：

```sh
set -euo pipefail
VERSION=1.3.9              # 完整版本号；预发布如 1.4.0-beta.1
BASE_VERSION=${VERSION%%-*}
NODE_VERSION=24.18.0

npm --prefix server ci
npm --prefix server run build
cmake -S core -B build-debug -DCMAKE_BUILD_TYPE=Debug
cmake --build build-debug --parallel
ctest --test-dir build-debug --output-on-failure
OWC_CORE_PATH="$PWD/build-debug/owc-exec" npm --prefix server test

npm --prefix web ci
npm --prefix web run build
npm --prefix web test

npm --prefix server prune --omit=dev
rm -rf server/node_modules/@fastify/send/test

cmake -S core -B build -DCMAKE_BUILD_TYPE=Release \
  -DCPACK_PACKAGE_VERSION="$BASE_VERSION" -DCPACK_FULL_VERSION="$VERSION"
cmake --build build --target owc-exec --parallel

rm -rf build/stage
mkdir -p build/stage/{bin,server,web,node}
cp build/owc-exec build/stage/bin/
cp -r server/dist server/package.json server/node_modules server/assets build/stage/server/
cp -r web/dist build/stage/web/
# arm64 把 linux-x64 换成 linux-arm64；loongarch64 没有官方 Node 包，不要创建 build/stage/node
curl -fsSLo build/node.tar.gz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz"
tar -xzf build/node.tar.gz -C build/stage/node --strip-components=1

test -x build/stage/bin/owc-exec
test -x build/stage/node/bin/node
test -f build/stage/server/dist/index.js
test -f build/stage/web/dist/index.html

tar -czf "openwebcode-${VERSION}-linux-x64.tar.gz" \
  -C build/stage . \
  -C "$PWD/packaging" install.sh uninstall.sh
sha256sum "openwebcode-${VERSION}-linux-x64.tar.gz"
```

冒烟：解包到临时目录，`./install.sh --yes --prefix <临时前缀>`，启动 `<临时前缀>/bin/owc` 后访问 `/api/health`。仓库里还有不进发行包的脚本级回归：`sh packaging/test-install.sh`。

### install.sh

解包后在包根目录运行：

```sh
mkdir openwebcode && tar -xzf openwebcode-<version>-linux-x64.tar.gz -C openwebcode
cd openwebcode
./install.sh          # TTY 里交互询问未由命令行指定的项
~/.local/bin/owc
```

`install.sh` 把 `bin/`、`server/`、`web/`（以及可选的 `node/`）复制到 `<prefix>/lib/openwebcode/`（重跑整体覆盖，幂等），生成启动脚本 `<prefix>/bin/owc`，并把卸载器落盘为 `<prefix>/bin/owc-uninstall`。prefix 必须是绝对路径，创建后按物理路径解析，拒绝 `/`。

| 选项 | 行为 |
| --- | --- |
| `--prefix <dir>` | 安装前缀（绝对路径）。默认按 uid 分层：普通用户 `~/.local`，root `/usr/local`。 |
| `--port <1-65535>` | 启动器的 `OWC_PORT` 默认值（默认 3210；`04312` 规范化为 `4312`）。 |
| `--data-dir <dir>` | 启动器的 `OWC_DATA_DIR` 默认值（绝对路径，不能是 `/`）。默认普通用户 `${XDG_DATA_HOME:-~/.local/share}/openwebcode`，root `/var/lib/openwebcode`。 |
| `--host <addr>` | 启动器的 `OWC_HOST` 默认值（默认 `127.0.0.1`；接受 DNS 名、IPv4、不加方括号的 IPv6）。 |
| `--lan` | `--host 0.0.0.0` 的快捷方式，与 `--host` 互斥。 |
| `--system` | 显式系统级安装（需要 root；root 运行本就走系统级默认路径）。 |
| `--use-system-node` | 不复制包内 `node/`，安装时要求 PATH 里有 ≥ 24 的 Node.js。包内没有 `node/bin/node` 时自动走这个模式。 |
| `--with-systemd` | 写 systemd unit 但不启用：root 写 `/etc/systemd/system/openwebcode.service`，否则写用户级 `${XDG_CONFIG_HOME:-~/.config}/systemd/user/openwebcode.service`（目标目录可用 `OWC_SYSTEMD_UNIT_DIR` 覆盖）。prefix 含空格或 systemd 特殊字符时拒绝（更新/切换场景则保留旧 unit 不重写）。 |
| `--enable-service` | 隐含 `--with-systemd`，并执行 `systemctl daemon-reload && systemctl enable --now openwebcode`（用户级用 `systemctl --user`；未登录也开机自启还需 `loginctl enable-linger $USER`）。 |
| `--open-firewall` | 仅 root + 非回环监听：用 firewalld/ufw 放行端口，都没有则打印手动放行提示。 |
| `--yes` / `-y` | 不提问，适合 CI 和脚本。 |
| `--with-desktop-entry` | 未实现，脚本明确失败而不是伪装完成桌面集成。 |

交互行为：未传 `--yes` 且 stdin/stdout 都是 TTY 时，只询问没有由命令行指定的项——安装前缀（root 先确认是否系统级安装）、端口、数据目录、是否开启局域网访问或具体监听地址、是否用系统 Node.js、是否写 systemd unit 及是否立即启用（仅当 systemd 真实可用才问：root 看 `/run/systemd/system`，用户级看 `systemctl --user` 可用性）、root 非回环时的防火墙放行。非 TTY 不读输入，不会卡住 CI。安装写入的只是默认值，运行时显式设置的 `OWC_PORT`/`OWC_DATA_DIR`/`OWC_HOST` 仍然优先。

非回环监听时 server 强制访问令牌认证：未显式设置 `OWC_ACCESS_TOKEN`（≥32 字符）时首次启动自动生成并持久化到 `<数据目录>/access-token`（0600），一键访问链接打印在 server 控制台和 设置 → 远程访问。安装结尾若令牌已生成（比如刚 `--enable-service` 启动了服务），脚本直接打印带 token 的访问链接。只应在受信网络或认证反向代理之后暴露。服务以 root 运行时，agent 执行的命令也是 root 权限，只跑可信任务。

重跑 `install.sh` 的更新语义：

- **既有安装判定**：按 uid 找既有 unit（root → 系统级，否则用户级），从 `ExecStart` 反推既有前缀。同路径判定为更新：交互模式只做一次确认，非 TTY 打印检测状态直接继续。不同路径时交互三选（切换服务到新路径 / 仅装文件不动服务 / 中止），非 TTY 打印警告并默认仅装文件，显式 `--with-systemd` 才切换。
- **启动器变量保留**：`<prefix>/bin/owc` 已存在时，提取既有 `OWC_DEFAULT_PORT`、`OWC_DEFAULT_DATA_DIR`、`OWC_DEFAULT_HOST`、`OWC_NODE` 作为本次默认值；命令行显式参数仍最优先。
- **unit 重写**：更新/切换会重写 unit，但用 `systemctl is-enabled` 探测保留启用状态（不会给没启用过的服务补 enable）；服务在运行则装完自动 restart。新写的 unit 一律带 `NoNewPrivileges=true`；系统级再加 `ProtectSystem=full`，数据目录经 `ReadWritePaths=` 保持可写。
- 结尾检测 `<prefix>/bin` 是否在 `PATH`，不在则按 `$SHELL` 推断 rc 文件（bash → `~/.bashrc`，zsh → `~/.zshrc`，其他 `~/.profile`）打印 `export PATH` 指引。

自动化安装示例：

```sh
./install.sh --yes --prefix "$HOME/.local" --port 3210 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1

# root 服务器一键安装：系统级路径 + 局域网访问 + 开机自启 + 防火墙放行
sudo ./install.sh --yes --system --lan --enable-service --open-firewall
```

### 卸载

运行安装时落盘的 `<prefix>/bin/owc-uninstall`（发行包根目录也有一份 `uninstall.sh`）：

```sh
~/.local/bin/owc-uninstall                    # 交互确认；数据目录默认保留
~/.local/bin/owc-uninstall --yes              # 不交互
~/.local/bin/owc-uninstall --yes --purge-data # 连同数据目录一起删
sudo /usr/local/bin/owc-uninstall --yes --purge-data --remove-firewall  # 系统级 + 移除防火墙规则
```

动作按序：systemd unit 存在时 `disable --now`（尽力而为）→ 删 unit → `daemon-reload`；`--remove-firewall` 时按启动器里的 `OWC_DEFAULT_PORT` 移除端口规则（仅 root）；删 `<prefix>/lib/openwebcode` 和 `<prefix>/bin/owc`；`--purge-data` 时删数据目录（拒绝 `/`、`$HOME` 和 prefix 本身）；最后删卸载器自身。`--prefix` 缺省为卸载器自身所在安装，从发行包根目录运行时回退到按 uid 分层的默认前缀；`--data-dir` 同样按 uid 分层。用户级安装如曾 `loginctl enable-linger`，卸载时会提示对应的 `disable-linger`。手动启动（非 systemd）的 owc 进程不在管理范围，先自行停止。

### install-online.sh（在线安装/更新）

不落盘的 `curl | bash` 脚本（POSIX sh），一条命令完成安装或升级：

```sh
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
# 指定版本和前缀，跳过交互：
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh \
  | bash -s -- --version 1.3.9 --prefix /opt/openwebcode --yes
```

流程：检查依赖（curl 或 wget、tar、sha256sum 或 shasum，不依赖 jq）→ 在 `mktemp -d` 临时目录下载 `openwebcode-<version>-linux-<arch>.tar.gz` 和 `SHA256SUMS.txt` → 只取目标行做 `sha256sum --check`（没有 sha256sum 时回落 `shasum -a 256`），失败即中止 → 解压 → 按 `<prefix>/lib/openwebcode/server/dist/index.js` 是否存在分两种模式。临时目录退出时自动清理。

架构按 `uname -m` 映射：`x86_64→x64`、`aarch64→arm64`、`loongarch64→loongarch64`，其他架构明确报错。

| 选项 | 行为 |
| --- | --- |
| `--version <x.y.z>` | 目标版本（semver 形态，可带一个预发布后缀）；缺省查询 GitHub Releases latest 的 `tag_name`（sed/grep 解析）。 |
| `--prefix <dir>` | 安装前缀，默认普通用户 `~/.local`、root `/usr/local`；用来判定全新安装还是更新，全新安装时透传给包内 `install.sh`。 |
| `--yes` / `--port` / `--host` / `--lan` / `--data-dir` / `--system` / `--with-systemd` / `--enable-service` / `--open-firewall` / `--use-system-node` | 原样透传给包内 `install.sh`，仅全新安装生效；更新模式不重建启动器，会提示这些参数被忽略。 |

- **全新安装**：调用解出的 `install.sh`，行为与离线安装一致。
- **更新**：整体替换 `<prefix>/lib/openwebcode/` 内容为新版，保留 `<prefix>/bin/owc` 启动器和已写好的 systemd unit，数据目录不动。既有启动器 pin 了系统 Node.js（`OWC_NODE` 非包内形式）时跳过 `node/` 复制（约 100MB 冗余，同时清掉旧的冗余目录）。目标目录不可写时明确报错（可能需要 sudo）。完成后按实际 unit 位置提示重启：系统级 `systemctl restart openwebcode`（非 root 提示加 `sudo`），用户级 `systemctl --user restart openwebcode`，没有 unit 则提示手动重启 owc。

下载基址可用 `OWC_INSTALL_BASE_URL` 覆盖（默认 `https://github.com/snnh/openwebcode/releases/download/v<version>`），便于镜像或 `file://` 本地测试。

## owc 启动脚本

Linux 的 `<prefix>/bin/owc`（install.sh 生成）和 Windows 的 `bin\owc.cmd` 做同样的事：

1. 设 `OWC_CORE_PATH` 指向包内 `owc-exec`——server 默认按源码树相对位置找 core，安装布局必须显式指定；
2. 端口和监听地址：显式设置的 `OWC_PORT`/`OWC_HOST` 优先，否则用安装时写入的默认值（初始 3210 / `127.0.0.1`）；
3. 数据目录：显式 `OWC_DATA_DIR` 优先；未设置时 Linux 用安装时写入的默认值（初始 `${XDG_DATA_HOME:-~/.local/share}/openwebcode`），Windows 注入 `%USERPROFILE%\openwebcode`。只有绕过启动器直接跑 `node server/dist/index.js` 时才落到 server 旁的 `../.openwebcode`。`server-settings.json` 固定在启动/设置目录；环境变量未设时，其中保存的 `dataDir` 在重启后选择业务数据目录。`OWC_DATA_DIR` 和 `dataDir` 都建议用绝对路径。

运行时优先用包内 `node/`。Linux 在安装时判定：包内缺失或 `--use-system-node` 时把启动器绑定到系统 Node.js（安装时校验 ≥ 24），不做运行时回落；Windows 的 `owc.cmd` 在包内 `node\node.exe` 缺失时打印警告并回落 PATH 里的 `node`。

`owc run ...` 走 headless CLI（`server/dist/cli.js`），其他参数启动 server。

Windows 特有的两个脚本行为：

- `owc.cmd` 做一次性数据目录迁移：`OWC_DATA_DIR` 未显式设置、旧默认目录 `%LOCALAPPDATA%\openwebcode` 存在且新默认目录不存在时，把旧目录移到 `%USERPROFILE%\openwebcode`（`move` 失败回落 `robocopy /E /MOVE`），不阻塞启动。server 启动失败（如端口被占）时 `pause` 保留控制台；`owc run` 路径不 pause。
- `owc-launch.cmd` 只服务 MSI 结束页的 Launch 复选框：最小化启动 `owc.cmd`，等 3 秒后打开 `http://localhost:%OWC_PORT%`。

## 开发期间快速更新 staging

只适合已有完整 staging 的本地联调，不能代替正式打包：

```powershell
npm --prefix server run build
npm --prefix web run build
Copy-Item -Recurse -Force server\dist\* build\stage\server\dist\
Copy-Item -Recurse -Force web\dist\* build\stage\web\dist\
```

server 模块在进程启动时加载，复制后必须重启 `build\stage\bin\owc.cmd`；Vite 入口带哈希，界面没更新就 `Ctrl+F5`。正式发布必须从空目录重建 staging，确保 `server/node_modules/` 只有生产依赖。

## 发布流程（release.yml）

- **触发**：推送 `v*` tag，或 Actions 手动触发 `release` 并输入 tag（tag 不存在时基于当前提交创建）。`concurrency` 为 `cancel-in-progress: false`，发布流程不可打断。手动触发有两个开关：`skip_performance_tests`（跳过性能基准，tag 触发不允许）和 `bootstrap_benchmark_baseline`（仅首次建立基线时允许无上一版本基线）。
- **版本校验**：两个平台 job 的第一步执行，tag 推送和手动触发都跑，规则见上文「版本号机制」。
- **测试门禁**：Windows 和 Linux x64/arm64 各自跑 core ctest、以真实 `owc-exec` 跑 server 测试、web 构建和测试。发布 job 要求 Windows、Linux 和 benchmark 全绿。
- **Windows job**：测试 → `npm prune --omit=dev` → Release core → 组装 `build/stage/`（Node win-x64 zip 对照官方 `SHASUMS256.txt` 校验后取 `node.exe`，`owc.cmd`/`owc-launch.cmd` 转 CRLF）→ `cpack -G WIX` → `verify-wix-options.ps1` → `msiexec` 静默安装 + `/api/health` 冒烟 + 卸载 → 上传 MSI。
- **Linux job**：按 `arch: [x64, arm64, loongarch64]` 矩阵出包。x64/arm64 原生构建（arm64 用 `ubuntu-24.04-arm` runner），测试后组装 staging（Node linux-<arch> tar.gz 同样校验后整树解入 `node/`），`tar -C stage . -C packaging install.sh uninstall.sh` 打包，临时前缀 `./install.sh --yes` 安装 + `/api/health` 冒烟。loongarch64 在 x64 runner 上用 `gcc-14-loongarch64-linux-gnu` 交叉编译（`core/toolchains/loongarch64-linux-gnu.cmake`），跳过 ctest/server 测试和冒烟，用 `file` 确认产物是 loongarch64 ELF，不内置 `node/`。
- **benchmark job**：默认是发布的硬依赖，含两层判定——相对回归对比是警告级（`compare.mjs` 回归超 15% 只告警不阻断）；各 bench 脚本内置的绝对验收门禁未通过则 job 失败并阻断发布，属预期行为。当前构建缺任何一个基准场景结果也判失败。没有上一 release 基线或基线下载失败时告警并跳过对比（不阻断），除非显式开了 `bootstrap_benchmark_baseline`。结果以 `bench-results-*.json` 随发布资产上传，供下一版下载做基线。手动发布显式开 `skip_performance_tests` 时整个 job 跳过，该次 release 不含基准 JSON。
- **release job**：下载全部产物并核对齐全 → 生成 `SHA256SUMS.txt` 并自检 → 从 `CHANGELOG.md` 提取 `## [<version>]` 段落做发布说明（缺失或为空直接失败，先补 CHANGELOG 再发版）→ `softprops/action-gh-release@v2` 创建 Release（非草稿；版本号带 `-` 时标 Pre-release；`target_commitish` 固定为触发本次运行的提交）。上传的文件：MSI、三个 tar.gz、`SHA256SUMS.txt`、`packaging/install-online.sh`、基准 JSON（如有）。

### 发版步骤

先推已审核的提交，确认 `CHANGELOG.md` 有对应段落、版本号四方一致，然后：

```sh
git tag -a v1.3.9 -m "OpenWebCode v1.3.9"
git push origin v1.3.9
```

也可以在 Actions 里手动运行 `release` 输入 `v1.3.9`。发布后核对：Release 里的文件名和 `SHA256SUMS.txt`、MSI 安装/卸载、tar.gz 安装和 `/api/health`。
